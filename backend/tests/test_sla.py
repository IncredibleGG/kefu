"""SLA 測試。

兩層覆蓋(同 test_routing.py 風格,不依賴外部 Postgres/Redis):
  1. 純函式:compute_due / match_conditions / pick_policy / evaluate(due 計算與
     breach/at_risk 判定)——確定性強,直接驗算。
  2. 掃描器 scan / status_for_session ——跑在記憶體 SQLite 上(StaticPool 共用單一
     連線),用型別 shim 讓 pg 專屬型別(UUID/JSONB)在 SQLite 可用;realtime 以
     假 Redis client 注入,驗證新違約會發 sla.breach。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

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
import app.models.sla  # noqa: E402,F401  (註冊 sla mapper)
from app.models.conversation import Channel, Message, Session  # noqa: E402
from app.models.sla import SLAPolicy, SLATracking  # noqa: E402
from app.models.tag import Tag, TagRelation  # noqa: E402
from app.models.tenancy import Tenant  # noqa: E402
from app.models.visitor import Visitor  # noqa: E402
from app.services import realtime  # noqa: E402
from app.services import sla as svc  # noqa: E402

# 只建 SLA 測試需要的表(避開 knowledge 的 pgvector)
_TABLES = [
    t.__table__
    for t in (Tenant, Channel, Visitor, Session, Message, Tag, TagRelation, SLAPolicy, SLATracking)
]

T = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


def _mins(n: int) -> timedelta:
    return timedelta(minutes=n)


# =========================================================================== #
# 純函式:compute_due
# =========================================================================== #
def test_compute_due_adds_minutes():
    assert svc.compute_due(T, 30) == T + _mins(30)


def test_compute_due_none_inputs():
    assert svc.compute_due(None, 30) is None
    assert svc.compute_due(T, None) is None


def test_compute_due_treats_naive_as_utc():
    naive = datetime(2026, 1, 1, 12, 0, 0)
    due = svc.compute_due(naive, 10)
    assert due == T + _mins(10)
    assert due.tzinfo is not None  # 已補上 UTC


# =========================================================================== #
# 純函式:match_conditions
# =========================================================================== #
def test_match_empty_or_none_matches_all():
    assert svc.match_conditions(None, {"channel_type": "web"}) is True
    assert svc.match_conditions({}, {"channel_type": "web"}) is True


def test_match_scalar_equal_and_mismatch():
    assert svc.match_conditions({"channel_type": "telegram"}, {"channel_type": "telegram"}) is True
    assert svc.match_conditions({"channel_type": "telegram"}, {"channel_type": "web"}) is False


def test_match_expected_list_membership():
    ctx = {"channel_type": "web"}
    assert svc.match_conditions({"channel_type": ["telegram", "web"]}, ctx) is True
    assert svc.match_conditions({"channel_type": ["telegram"]}, ctx) is False


def test_match_tag_list_context():
    ctx = {"tag": ["vip", "urgent"]}
    assert svc.match_conditions({"tag": ["vip"]}, ctx) is True
    assert svc.match_conditions({"tag": ["gold"]}, ctx) is False


def test_match_missing_key_is_not_matched():
    # 條件指定了 ctx 沒有的鍵 → 保守判為不命中
    assert svc.match_conditions({"priority": "high"}, {"channel_type": "web"}) is False


def test_match_all_conditions_must_hold():
    ctx = {"channel_type": "telegram", "tag": ["vip"]}
    assert svc.match_conditions({"channel_type": "telegram", "tag": ["vip"]}, ctx) is True
    assert svc.match_conditions({"channel_type": "telegram", "tag": ["gold"]}, ctx) is False


# =========================================================================== #
# 純函式:pick_policy(依 priority 由高到低取第一條命中)
# =========================================================================== #
def test_pick_policy_prefers_higher_priority():
    lo = SLAPolicy(name="lo", conditions=None, first_response_minutes=30, resolution_minutes=120, priority=1)
    hi = SLAPolicy(name="hi", conditions=None, first_response_minutes=5, resolution_minutes=30, priority=9)
    assert svc.pick_policy([lo, hi], {"channel_type": "web"}) is hi


def test_pick_policy_falls_through_when_higher_not_matched():
    hi = SLAPolicy(
        name="hi", conditions={"channel_type": "telegram"}, first_response_minutes=5,
        resolution_minutes=30, priority=9,
    )
    lo = SLAPolicy(name="lo", conditions=None, first_response_minutes=30, resolution_minutes=120, priority=1)
    # 會話是 web:hi 不命中 → 落到 lo
    assert svc.pick_policy([hi, lo], {"channel_type": "web"}) is lo


def test_pick_policy_none_when_no_match():
    p = SLAPolicy(
        name="p", conditions={"channel_type": "telegram"}, first_response_minutes=5,
        resolution_minutes=30, priority=1,
    )
    assert svc.pick_policy([p], {"channel_type": "web"}) is None


# =========================================================================== #
# 純函式:evaluate(狀態 + 違約判定)
# =========================================================================== #
def test_evaluate_on_track():
    ev = svc.evaluate(
        created_at=T - _mins(10),
        first_response_due=T + _mins(50),
        resolution_due=T + _mins(110),
        first_response_at=None,
        resolved_at=None,
        now=T,
    )
    assert ev.status == "on_track"
    assert not ev.breached_first and not ev.breached_resolution


def test_evaluate_at_risk_near_first_response_due():
    # 已用 50/60 分鐘(0.83 ≥ 0.8)且尚未回應 → at_risk
    ev = svc.evaluate(
        created_at=T - _mins(50),
        first_response_due=T + _mins(10),
        resolution_due=T + _mins(70),
        first_response_at=None,
        resolved_at=None,
        now=T,
    )
    assert ev.first_state == "at_risk"
    assert ev.status == "at_risk"
    assert not ev.breached_first


def test_evaluate_breached_first_response_overdue():
    ev = svc.evaluate(
        created_at=T - _mins(70),
        first_response_due=T - _mins(10),  # 已過期且未回應
        resolution_due=T + _mins(50),
        first_response_at=None,
        resolved_at=None,
        now=T,
    )
    assert ev.breached_first is True
    assert ev.status == "breached"


def test_evaluate_first_response_met_when_answered_before_due():
    ev = svc.evaluate(
        created_at=T - _mins(20),
        first_response_due=T + _mins(10),
        resolution_due=T + _mins(100),
        first_response_at=T - _mins(5),  # 期限前已回應
        resolved_at=None,
        now=T,
    )
    assert ev.first_state == "met"
    assert not ev.breached_first
    assert ev.status == "on_track"  # 尚未結案、解決維度 on_track


def test_evaluate_resolution_met_when_closed_on_time():
    ev = svc.evaluate(
        created_at=T - _mins(30),
        first_response_due=T - _mins(20),
        resolution_due=T + _mins(10),
        first_response_at=T - _mins(25),  # 期限前回應
        resolved_at=T,  # 期限前結案
        now=T,
    )
    assert ev.status == "met"
    assert not ev.breached_first and not ev.breached_resolution


def test_evaluate_breached_resolution_when_closed_late():
    ev = svc.evaluate(
        created_at=T - _mins(130),
        first_response_due=T - _mins(120),
        resolution_due=T - _mins(10),  # 解決期限已過
        first_response_at=T - _mins(125),
        resolved_at=T,  # 逾時才結案
        now=T,
    )
    assert ev.breached_resolution is True
    assert ev.status == "breached"


def test_evaluate_no_due_is_none_state():
    ev = svc.evaluate(
        created_at=T,
        first_response_due=None,
        resolution_due=None,
        first_response_at=None,
        resolved_at=None,
        now=T,
    )
    assert ev.first_state == "none" and ev.resolution_state == "none"
    assert ev.status == "on_track"


# =========================================================================== #
# 假 Redis:記錄 publish 呼叫
# =========================================================================== #
class _FakeRedis:
    def __init__(self):
        self.published: list[tuple[str, str]] = []

    async def publish(self, channel, data):  # noqa: ANN001
        self.published.append((channel, data))


# =========================================================================== #
# 整合:scan / status_for_session(SQLite)
# =========================================================================== #
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


@pytest.fixture(autouse=True)
def _fake_realtime():
    """每個測試注入假 Redis,避免掃描器連真 Redis;結束還原。"""
    fake = _FakeRedis()
    realtime.set_client(fake)
    yield fake
    realtime.set_client(None)


async def _seed_tenant(db: AsyncSession, *, channel_type: str = "web") -> tuple:
    tid = uuid.uuid4()
    db.add(Tenant(id=tid, name="Acme", slug=f"acme-{tid.hex[:8]}"))
    ch = Channel(tenant_id=tid, type=channel_type, name="ch")
    db.add(ch)
    await db.flush()
    vis = Visitor(tenant_id=tid, channel_id=ch.id, external_id="v1")
    db.add(vis)
    await db.flush()
    return tid, ch.id, vis.id


async def _new_session(
    db: AsyncSession, tid, ch_id, vis_id, *, created_at, status="open", closed_at=None
) -> uuid.UUID:
    s = Session(
        tenant_id=tid,
        channel_id=ch_id,
        visitor_id=vis_id,
        status=status,
        handler_type="ai",
        created_at=created_at,
        closed_at=closed_at,
    )
    db.add(s)
    await db.flush()
    return s.id


async def _tracking(db: AsyncSession, sid) -> SLATracking | None:
    return (
        await db.execute(select(SLATracking).where(SLATracking.session_id == sid))
    ).scalar_one_or_none()


@pytest.mark.asyncio
async def test_scan_creates_tracking_and_flags_breach(db, _fake_realtime):
    now = datetime.now(timezone.utc)
    tid, ch, vis = await _seed_tenant(db)
    # 70 分鐘前開啟、無回應;首回應 30 分 → 已違約,解決 120 分 → 未違約
    sid = await _new_session(db, tid, ch, vis, created_at=now - _mins(70))
    db.add(SLAPolicy(tenant_id=tid, name="std", first_response_minutes=30, resolution_minutes=120))
    await db.commit()

    stats = await svc.scan(db, now=now)
    await db.commit()

    assert stats["scanned"] == 1 and stats["matched"] == 1 and stats["tracked"] == 1
    assert stats["breached"] == 1 and stats["new_breaches"] == 1
    row = await _tracking(db, sid)
    assert row is not None
    assert row.breached_first is True and row.breached_resolution is False
    assert row.status == "breached"
    # 發了一則 sla.breach 到坐席頻道
    assert any("agents" in ch_name and "sla.breach" in data for ch_name, data in _fake_realtime.published)


@pytest.mark.asyncio
async def test_scan_breach_not_re_notified(db, _fake_realtime):
    now = datetime.now(timezone.utc)
    tid, ch, vis = await _seed_tenant(db)
    await _new_session(db, tid, ch, vis, created_at=now - _mins(70))
    db.add(SLAPolicy(tenant_id=tid, name="std", first_response_minutes=30, resolution_minutes=120))
    await db.commit()

    await svc.scan(db, now=now)
    await db.commit()
    first_count = len(_fake_realtime.published)

    stats2 = await svc.scan(db, now=now)
    await db.commit()
    # 已標記的違約不再重複告警
    assert stats2["new_breaches"] == 0
    assert len(_fake_realtime.published) == first_count


@pytest.mark.asyncio
async def test_scan_first_response_recorded_from_message(db):
    now = datetime.now(timezone.utc)
    tid, ch, vis = await _seed_tenant(db)
    sid = await _new_session(db, tid, ch, vis, created_at=now - _mins(20))
    # 期限前 10 分鐘由 ai 回應
    db.add(
        Message(
            tenant_id=tid, session_id=sid, sender_type="ai", content="hi",
            created_at=now - _mins(15),
        )
    )
    db.add(SLAPolicy(tenant_id=tid, name="std", first_response_minutes=30, resolution_minutes=120))
    await db.commit()

    await svc.scan(db, now=now)
    await db.commit()
    row = await _tracking(db, sid)
    assert row.first_response_at is not None
    assert row.breached_first is False
    assert row.status == "on_track"


@pytest.mark.asyncio
async def test_scan_conditions_filter_channel_type(db):
    now = datetime.now(timezone.utc)
    tid, ch, vis = await _seed_tenant(db, channel_type="web")
    await _new_session(db, tid, ch, vis, created_at=now - _mins(70))
    # 規則只套 telegram → web 會話不命中
    db.add(
        SLAPolicy(
            tenant_id=tid, name="tg", conditions={"channel_type": "telegram"},
            first_response_minutes=5, resolution_minutes=30,
        )
    )
    await db.commit()

    stats = await svc.scan(db, now=now)
    await db.commit()
    assert stats["scanned"] == 1 and stats["matched"] == 0 and stats["tracked"] == 0


@pytest.mark.asyncio
async def test_scan_matches_by_tag(db):
    now = datetime.now(timezone.utc)
    tid, ch, vis = await _seed_tenant(db)
    sid = await _new_session(db, tid, ch, vis, created_at=now - _mins(70))
    tag = Tag(tenant_id=tid, name="vip")
    db.add(tag)
    await db.flush()
    db.add(TagRelation(tenant_id=tid, tag_id=tag.id, target_type="session", target_id=sid))
    db.add(
        SLAPolicy(
            tenant_id=tid, name="vip-sla", conditions={"tag": ["vip"]},
            first_response_minutes=30, resolution_minutes=120,
        )
    )
    await db.commit()

    stats = await svc.scan(db, now=now)
    await db.commit()
    assert stats["matched"] == 1
    assert (await _tracking(db, sid)).breached_first is True


@pytest.mark.asyncio
async def test_scan_finalizes_closed_session(db):
    now = datetime.now(timezone.utc)
    tid, ch, vis = await _seed_tenant(db)
    # 先建 open 會話並掃描,產生追蹤列
    sid = await _new_session(db, tid, ch, vis, created_at=now - _mins(10))
    db.add(
        Message(tenant_id=tid, session_id=sid, sender_type="human", content="hi", created_at=now - _mins(9))
    )
    db.add(SLAPolicy(tenant_id=tid, name="std", first_response_minutes=30, resolution_minutes=120))
    await db.commit()
    await svc.scan(db, now=now)
    await db.commit()

    # 會話結案(準時),再掃描 → 收尾定案為 met
    sess = (await db.execute(select(Session).where(Session.id == sid))).scalar_one()
    sess.status = "closed"
    sess.closed_at = now
    await db.commit()

    stats = await svc.scan(db, now=now + _mins(1))
    await db.commit()
    row = await _tracking(db, sid)
    assert row.resolved_at is not None
    assert row.status == "met"
    assert stats["met"] == 1


@pytest.mark.asyncio
async def test_scan_tenant_isolation(db):
    now = datetime.now(timezone.utc)
    t1, ch1, v1 = await _seed_tenant(db)
    t2, ch2, v2 = await _seed_tenant(db)
    s1 = await _new_session(db, t1, ch1, v1, created_at=now - _mins(70))
    # 只有租戶2 有規則 → 租戶1 會話不應被套用
    db.add(SLAPolicy(tenant_id=t2, name="std", first_response_minutes=30, resolution_minutes=120))
    await db.commit()

    stats = await svc.scan(db, now=now)
    await db.commit()
    assert await _tracking(db, s1) is None
    assert stats["matched"] == 0


@pytest.mark.asyncio
async def test_status_for_session_reads_tracking(db):
    now = datetime.now(timezone.utc)
    tid, ch, vis = await _seed_tenant(db)
    sid = await _new_session(db, tid, ch, vis, created_at=now - _mins(70))
    db.add(SLAPolicy(tenant_id=tid, name="std", first_response_minutes=30, resolution_minutes=120))
    await db.commit()
    await svc.scan(db, now=now)
    await db.commit()

    res = await svc.status_for_session(db, tid, sid)
    assert res["tracked"] is True
    assert res["status"] == "breached"
    assert res["breached_first"] is True
    assert res["first_response_remaining_seconds"] < 0  # 已逾時


@pytest.mark.asyncio
async def test_status_for_session_ephemeral_before_scan(db):
    now = datetime.now(timezone.utc)
    tid, ch, vis = await _seed_tenant(db)
    sid = await _new_session(db, tid, ch, vis, created_at=now - _mins(5))
    db.add(SLAPolicy(tenant_id=tid, name="std", first_response_minutes=30, resolution_minutes=120))
    await db.commit()

    # 尚未掃描,仍能即時算出暫態狀態
    res = await svc.status_for_session(db, tid, sid)
    assert res["tracked"] is True
    assert res["status"] in ("on_track", "at_risk")
    assert await _tracking(db, sid) is None  # 未落庫


@pytest.mark.asyncio
async def test_status_for_session_unknown_session(db):
    tid, _, _ = await _seed_tenant(db)
    await db.commit()
    res = await svc.status_for_session(db, tid, uuid.uuid4())
    assert res["tracked"] is False
    assert res["reason"] == "SLA_SESSION_NOT_FOUND"
