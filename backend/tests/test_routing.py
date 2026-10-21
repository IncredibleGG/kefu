"""M8 routing 測試。

兩層覆蓋:
  1. 純選人邏輯(least_load / round_robin / 上限判斷)——不碰 DB,確定性強。
  2. assign_session / manual_assign / list_queue / policy 回退等整合流程——
     跑在記憶體 SQLite 上(StaticPool 共用單一連線),用型別 shim 讓
     postgresql 專屬型別(UUID / JSONB)在 SQLite 也能建表與往返。

僅測試本模組(routing);不依賴外部 Postgres 或 Redis。
"""
from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.pool import StaticPool

# --- 測試專用型別 shim:讓 pg 專屬型別在 SQLite 上可用(不影響正式 pg 行為) ---


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(type_, compiler, **kw):  # noqa: ANN001, ANN201
    return "TEXT"


@compiles(PGUUID, "sqlite")
def _compile_uuid_sqlite(type_, compiler, **kw):  # noqa: ANN001, ANN201
    return "CHAR(32)"


from app.core.db import Base  # noqa: E402
import app.models  # noqa: E402,F401  (註冊核心 mapper)
import app.models.routing  # noqa: E402,F401  (註冊 routing mapper)
from app.models.conversation import Channel, Session  # noqa: E402
from app.models.iam import SkillGroup, Staff, staff_skillgroup  # noqa: E402
from app.models.routing import RoutingPolicy  # noqa: E402
from app.models.tenancy import Tenant  # noqa: E402
from app.models.visitor import Visitor  # noqa: E402
from app.services import routing as svc  # noqa: E402
from app.services.routing import AgentLoad  # noqa: E402

# 只建 routing 測試需要的表(避開 knowledge 的 pgvector)
_TABLES = [
    t.__table__ for t in (Tenant, Staff, SkillGroup, Channel, Session, Visitor, RoutingPolicy)
] + [staff_skillgroup]


# ---------------------------------------------------------------------------
# 純選人邏輯(無 DB)
# ---------------------------------------------------------------------------
def _ld(load: int, max_load: int = 3) -> AgentLoad:
    return AgentLoad(staff_id=uuid.uuid4(), current_load=load, max_load=max_load)


def test_agentload_available():
    assert _ld(0, 3).available is True
    assert _ld(2, 3).available is True
    assert _ld(3, 3).available is False  # 已達上限即不可用
    assert _ld(4, 3).available is False


def test_pick_least_load_prefers_lowest():
    a, b, c = _ld(2), _ld(0), _ld(1)
    assert svc._pick_least_load([a, b, c]) is b


def test_pick_least_load_none_when_all_full():
    assert svc._pick_least_load([_ld(3), _ld(5)]) is None
    assert svc._pick_least_load([]) is None


def test_pick_round_robin_rotates():
    # id 排序穩定,便於預期
    ids = sorted([uuid.uuid4() for _ in range(3)], key=lambda u: u.bytes)
    cands = [AgentLoad(staff_id=i, current_load=0, max_load=5) for i in ids]
    # 無游標 → 第一位
    assert svc._pick_round_robin(cands, None).staff_id == ids[0]
    # 游標在第一位 → 下一位
    assert svc._pick_round_robin(cands, ids[0]).staff_id == ids[1]
    # 游標在最後 → 繞回第一位
    assert svc._pick_round_robin(cands, ids[2]).staff_id == ids[0]


def test_pick_round_robin_skips_full():
    ids = sorted([uuid.uuid4() for _ in range(2)], key=lambda u: u.bytes)
    cands = [
        AgentLoad(staff_id=ids[0], current_load=5, max_load=5),  # 滿
        AgentLoad(staff_id=ids[1], current_load=0, max_load=5),
    ]
    # 只有第二位可用
    assert svc._pick_round_robin(cands, None).staff_id == ids[1]


# ---------------------------------------------------------------------------
# 整合流程(記憶體 SQLite)
# ---------------------------------------------------------------------------
@pytest_asyncio.fixture
async def db():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=_TABLES))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


class World:
    """一個測試租戶的種子資料容器。"""

    def __init__(self, tenant_id, channel_id, visitor_id, group_id):
        self.tenant_id = tenant_id
        self.channel_id = channel_id
        self.visitor_id = visitor_id
        self.group_id = group_id


async def _seed_world(db: AsyncSession, *, with_group: bool = True) -> World:
    tid = uuid.uuid4()
    db.add(Tenant(id=tid, name="Acme", slug=f"acme-{tid.hex[:8]}"))
    ch = Channel(tenant_id=tid, type="web", name="web")
    db.add(ch)
    await db.flush()
    vis = Visitor(tenant_id=tid, channel_id=ch.id, external_id="v1")
    db.add(vis)
    gid = None
    if with_group:
        g = SkillGroup(tenant_id=tid, name="sales")
        db.add(g)
        await db.flush()
        gid = g.id
    await db.flush()
    return World(tid, ch.id, vis.id, gid)


async def _add_agent(
    db: AsyncSession, w: World, *, status: str = "online", in_group: bool = True
) -> uuid.UUID:
    s = Staff(
        tenant_id=w.tenant_id,
        email=f"{uuid.uuid4().hex[:8]}@acme.test",
        password_hash="x",
        display_name="agent",
        status=status,
    )
    db.add(s)
    await db.flush()
    if in_group and w.group_id is not None:
        await db.execute(
            staff_skillgroup.insert().values(staff_id=s.id, skillgroup_id=w.group_id)
        )
    return s.id


async def _new_session(db: AsyncSession, w: World, *, status: str = "open") -> uuid.UUID:
    sess = Session(
        tenant_id=w.tenant_id,
        channel_id=w.channel_id,
        visitor_id=w.visitor_id,
        skill_group_id=w.group_id,
        status=status,
        handler_type="ai",
    )
    db.add(sess)
    await db.flush()
    return sess.id


async def _get_session(db: AsyncSession, sid: uuid.UUID) -> Session:
    return (await db.execute(select(Session).where(Session.id == sid))).scalar_one()


@pytest.mark.asyncio
async def test_assign_least_load_picks_free_agent(db):
    w = await _seed_world(db)
    busy = await _add_agent(db, w)
    free = await _add_agent(db, w)
    await db.commit()
    # 讓 busy 已接一個 open 人工會話
    s_busy = Session(
        tenant_id=w.tenant_id, channel_id=w.channel_id, visitor_id=w.visitor_id,
        skill_group_id=w.group_id, status="open", handler_type="human", handler_staff_id=busy,
    )
    db.add(s_busy)
    await db.commit()

    sid = await _new_session(db, w)
    await db.commit()

    assigned = await svc.assign_session(db, w.tenant_id, sid)
    assert assigned == free  # 負載較低者
    sess = await _get_session(db, sid)
    assert sess.handler_staff_id == free
    assert sess.handler_type == "human"
    assert sess.status == "open"


@pytest.mark.asyncio
async def test_assign_enqueues_when_all_at_capacity(db):
    w = await _seed_world(db)
    # 策略 max_load = 1
    db.add(RoutingPolicy(tenant_id=w.tenant_id, skill_group_id=w.group_id, strategy="least_load", max_load=1))
    agent = await _add_agent(db, w)
    await db.commit()
    # agent 已滿(1 個 open 人工會話)
    db.add(Session(
        tenant_id=w.tenant_id, channel_id=w.channel_id, visitor_id=w.visitor_id,
        skill_group_id=w.group_id, status="open", handler_type="human", handler_staff_id=agent,
    ))
    await db.commit()

    sid = await _new_session(db, w)
    await db.commit()
    assigned = await svc.assign_session(db, w.tenant_id, sid)
    assert assigned is None  # 入佇列
    sess = await _get_session(db, sid)
    assert sess.status == "queued"
    assert sess.handler_staff_id is None


@pytest.mark.asyncio
async def test_offline_agents_not_selected(db):
    w = await _seed_world(db)
    await _add_agent(db, w, status="offline")
    await _add_agent(db, w, status="away")
    await db.commit()
    sid = await _new_session(db, w)
    await db.commit()
    assert await svc.assign_session(db, w.tenant_id, sid) is None  # 無在線坐席 → 佇列


@pytest.mark.asyncio
async def test_round_robin_rotation(db):
    w = await _seed_world(db)
    db.add(RoutingPolicy(tenant_id=w.tenant_id, skill_group_id=w.group_id, strategy="round_robin", max_load=10))
    a1 = await _add_agent(db, w)
    a2 = await _add_agent(db, w)
    await db.commit()

    sid1 = await _new_session(db, w)
    await db.commit()
    first = await svc.assign_session(db, w.tenant_id, sid1)

    sid2 = await _new_session(db, w)
    await db.commit()
    second = await svc.assign_session(db, w.tenant_id, sid2)

    assert {first, second} == {a1, a2}  # 兩單分給不同坐席
    assert first != second


@pytest.mark.asyncio
async def test_tenant_isolation(db):
    w1 = await _seed_world(db)
    w2 = await _seed_world(db)
    await _add_agent(db, w2)  # 只有租戶2有坐席
    await db.commit()
    sid = await _new_session(db, w1)  # 租戶1的會話
    await db.commit()
    # 不得跨租戶指派 → 入佇列
    assert await svc.assign_session(db, w1.tenant_id, sid) is None


@pytest.mark.asyncio
async def test_manual_assign_ignores_capacity(db):
    w = await _seed_world(db)
    db.add(RoutingPolicy(tenant_id=w.tenant_id, skill_group_id=w.group_id, strategy="least_load", max_load=1))
    agent = await _add_agent(db, w)
    await db.commit()
    # agent 已滿
    db.add(Session(
        tenant_id=w.tenant_id, channel_id=w.channel_id, visitor_id=w.visitor_id,
        skill_group_id=w.group_id, status="open", handler_type="human", handler_staff_id=agent,
    ))
    sid = await _new_session(db, w)
    await db.commit()
    # 手動指派無視上限
    assert await svc.manual_assign(db, w.tenant_id, sid, agent) == agent
    sess = await _get_session(db, sid)
    assert sess.handler_staff_id == agent


@pytest.mark.asyncio
async def test_manual_assign_rejects_foreign_staff(db):
    w1 = await _seed_world(db)
    w2 = await _seed_world(db)
    foreign = await _add_agent(db, w2)
    sid = await _new_session(db, w1)
    await db.commit()
    assert await svc.manual_assign(db, w1.tenant_id, sid, foreign) is None


@pytest.mark.asyncio
async def test_list_queue(db):
    w = await _seed_world(db)
    q1 = await _new_session(db, w, status="queued")
    await _new_session(db, w, status="open")
    q2 = await _new_session(db, w, status="queued")
    await db.commit()
    queued = await svc.list_queue(db, w.tenant_id)
    ids = {s.id for s in queued}
    assert ids == {q1, q2}


@pytest.mark.asyncio
async def test_resolve_policy_falls_back_to_tenant_default(db):
    w = await _seed_world(db)
    # 只有租戶預設(skill_group_id=None)
    db.add(RoutingPolicy(tenant_id=w.tenant_id, skill_group_id=None, strategy="round_robin", max_load=7))
    await db.commit()
    p = await svc.resolve_policy(db, w.tenant_id, w.group_id)
    assert p is not None and p.strategy == "round_robin" and p.max_load == 7


@pytest.mark.asyncio
async def test_closed_session_not_assigned(db):
    w = await _seed_world(db)
    await _add_agent(db, w)
    sid = await _new_session(db, w, status="closed")
    await db.commit()
    assert await svc.assign_session(db, w.tenant_id, sid) is None


@pytest.mark.asyncio
async def test_llm_hook_used_then_reset(db):
    w = await _seed_world(db)
    db.add(RoutingPolicy(tenant_id=w.tenant_id, skill_group_id=w.group_id, strategy="llm", max_load=10))
    a1 = await _add_agent(db, w)
    a2 = await _add_agent(db, w)
    await db.commit()

    async def picker(tenant_id, session, candidates):
        # 永遠挑 a2
        return a2

    svc.set_llm_assigner(picker)
    try:
        sid = await _new_session(db, w)
        await db.commit()
        assert await svc.assign_session(db, w.tenant_id, sid) == a2
    finally:
        svc.set_llm_assigner(None)  # 還原,避免污染其他測試

    # 掛鉤清除後,llm 策略回退規則式(仍能分配)
    sid2 = await _new_session(db, w)
    await db.commit()
    assert await svc.assign_session(db, w.tenant_id, sid2) in {a1, a2}
