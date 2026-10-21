"""自動化規則引擎測試。

兩層覆蓋:
  1. 純邏輯(無 DB,確定性強):match() 各運算子、evaluate_conditions 的 AND 語義、
     空條件必命中、未知運算子不命中,以及 get_catalog 結構。
  2. 引擎流程(記憶體 SQLite,StaticPool 共用單一連線):emit_event 依 priority
     排序、逐條比對、命中執行動作(add_tag / set_status / assign_skill_group /
     assign_staff / notify_agents / auto_reply)、租戶隔離、降級不拋、防遞迴。

僅測試本模組(automation);不依賴外部 Postgres 或 Redis(realtime / channel_out
以 monkeypatch 取代)。型別 shim 讓 pg 專屬型別(UUID / JSONB)於 SQLite 可用。
"""
from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy import func, select
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
from app.models.automation import AutomationRule  # noqa: E402
from app.models.conversation import Channel, Message, Session  # noqa: E402
from app.models.iam import SkillGroup, Staff  # noqa: E402
from app.models.tag import Tag, TagRelation  # noqa: E402
from app.models.tenancy import Tenant  # noqa: E402
from app.models.visitor import Visitor  # noqa: E402
from app.services import automation as svc  # noqa: E402

_TABLES = [
    t.__table__
    for t in (
        Tenant,
        Staff,
        SkillGroup,
        Channel,
        Visitor,
        Session,
        Message,
        Tag,
        TagRelation,
        AutomationRule,
    )
]


# ===========================================================================
# 純邏輯:match / evaluate_conditions / catalog(無 DB)
# ===========================================================================
def test_match_eq_ne():
    assert svc.match("eq", "open", "open") is True
    assert svc.match("eq", "open", "closed") is False
    assert svc.match("ne", "open", "closed") is True
    assert svc.match("ne", "open", "open") is False


def test_match_eq_normalizes_uuid():
    u = uuid.uuid4()
    # UUID 實際值可與其字串設定值相等
    assert svc.match("eq", u, str(u)) is True


def test_match_contains():
    assert svc.match("contains", "我要退款謝謝", "退款") is True
    assert svc.match("contains", "hello", "bye") is False
    # 序列成員判斷
    assert svc.match("contains", ["vip", "new"], "vip") is True
    assert svc.match("contains", None, "x") is False


def test_match_gt_lt():
    assert svc.match("gt", 5, 3) is True
    assert svc.match("gt", 2, 3) is False
    assert svc.match("lt", 2, 3) is True
    # 可轉數值的字串也能比較
    assert svc.match("gt", "5", "3") is True
    # 無法轉數值 → False,不拋
    assert svc.match("gt", "abc", 3) is False


def test_match_in():
    assert svc.match("in", "web", ["web", "telegram"]) is True
    assert svc.match("in", "email", ["web", "telegram"]) is False
    # expected 非清單 → False
    assert svc.match("in", "web", "web") is False


def test_match_unknown_op():
    assert svc.match("regex", "x", "x") is False


def test_evaluate_conditions_and_semantics():
    values = {"content": "我要退款", "channel_type": "web", "status": "open"}
    # 全部成立
    conds = [
        {"field": "content", "op": "contains", "value": "退款"},
        {"field": "channel_type", "op": "eq", "value": "web"},
    ]
    assert svc.evaluate_conditions(conds, values) is True
    # 有一條不成立 → False
    conds2 = conds + [{"field": "status", "op": "eq", "value": "closed"}]
    assert svc.evaluate_conditions(conds2, values) is False


def test_evaluate_conditions_empty_matches():
    assert svc.evaluate_conditions([], {"a": 1}) is True
    assert svc.evaluate_conditions(None, {}) is True


def test_evaluate_conditions_invalid_op_fails():
    assert svc.evaluate_conditions([{"field": "x", "op": "bad", "value": 1}], {"x": 1}) is False


def test_get_catalog_shape():
    cat = svc.get_catalog()
    events = {e["event"] for e in cat["events"]}
    ops = {o["op"] for o in cat["condition_ops"]}
    actions = {a["type"] for a in cat["action_types"]}
    assert {"message.visitor", "session.created", "session.closed", "session.transfer"} <= events
    assert {"eq", "ne", "contains", "gt", "lt", "in"} == ops
    assert {
        "add_tag",
        "assign_skill_group",
        "assign_staff",
        "set_status",
        "notify_agents",
        "auto_reply",
    } == actions
    assert any(f["field"] == "channel_type" for f in cat["condition_fields"])


# ===========================================================================
# 引擎流程(記憶體 SQLite)
# ===========================================================================
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
    def __init__(self, tenant_id, channel_id, visitor_id, session_id):
        self.tenant_id = tenant_id
        self.channel_id = channel_id
        self.visitor_id = visitor_id
        self.session_id = session_id


async def _seed(db: AsyncSession, *, channel_type: str = "web", status: str = "open") -> World:
    tid = uuid.uuid4()
    db.add(Tenant(id=tid, name="Acme", slug=f"acme-{tid.hex[:8]}"))
    ch = Channel(tenant_id=tid, type=channel_type, name="ch")
    db.add(ch)
    await db.flush()
    vis = Visitor(tenant_id=tid, channel_id=ch.id, external_id="v1")
    db.add(vis)
    await db.flush()
    sess = Session(
        tenant_id=tid,
        channel_id=ch.id,
        visitor_id=vis.id,
        status=status,
        handler_type="ai",
    )
    db.add(sess)
    await db.flush()
    return World(tid, ch.id, vis.id, sess.id)


async def _add_rule(
    db: AsyncSession,
    w: World,
    *,
    event: str,
    actions: list[dict],
    conditions: list[dict] | None = None,
    priority: int = 100,
    is_active: bool = True,
    tenant_id=None,
) -> uuid.UUID:
    r = AutomationRule(
        tenant_id=tenant_id or w.tenant_id,
        name="r",
        trigger_event=event,
        conditions=conditions or [],
        actions=actions,
        is_active=is_active,
        priority=priority,
    )
    db.add(r)
    await db.flush()
    return r.id


async def _get_session(db: AsyncSession, sid: uuid.UUID) -> Session:
    return (await db.execute(select(Session).where(Session.id == sid))).scalar_one()


def _ctx(w: World, **extra) -> dict:
    ctx = {"session_id": str(w.session_id), "channel_id": str(w.channel_id)}
    ctx.update(extra)
    return ctx


@pytest.mark.asyncio
async def test_set_status_action(db):
    w = await _seed(db)
    await _add_rule(db, w, event="message.visitor", actions=[{"type": "set_status", "params": {"status": "queued"}}])
    await db.commit()

    await svc.emit_event(db, w.tenant_id, "message.visitor", _ctx(w, content="hi"))
    sess = await _get_session(db, w.session_id)
    assert sess.status == "queued"


@pytest.mark.asyncio
async def test_add_tag_action_idempotent(db):
    w = await _seed(db)
    await _add_rule(
        db, w, event="message.visitor",
        actions=[{"type": "add_tag", "params": {"name": "VIP"}}],
    )
    await db.commit()

    # 首次:建標籤 + 關聯
    await svc.emit_event(db, w.tenant_id, "message.visitor", _ctx(w, content="hi"))
    tag = (
        await db.execute(select(Tag).where(Tag.tenant_id == w.tenant_id, Tag.name == "VIP"))
    ).scalar_one()
    rel_count = (
        await db.execute(
            select(func.count())
            .select_from(TagRelation)
            .where(
                TagRelation.tenant_id == w.tenant_id,
                TagRelation.tag_id == tag.id,
                TagRelation.target_id == w.session_id,
            )
        )
    ).scalar_one()
    assert rel_count == 1

    # 再次觸發:不應重複建立關聯(冪等)
    await svc.emit_event(db, w.tenant_id, "message.visitor", _ctx(w, content="hi again"))
    rel_count2 = (
        await db.execute(
            select(func.count())
            .select_from(TagRelation)
            .where(TagRelation.tag_id == tag.id, TagRelation.target_id == w.session_id)
        )
    ).scalar_one()
    assert rel_count2 == 1


@pytest.mark.asyncio
async def test_assign_skill_group_and_staff(db):
    w = await _seed(db)
    sg = SkillGroup(tenant_id=w.tenant_id, name="sales")
    staff = Staff(
        tenant_id=w.tenant_id, email="a@x.test", password_hash="x", display_name="A"
    )
    db.add_all([sg, staff])
    await db.flush()
    await _add_rule(
        db, w, event="session.created",
        actions=[
            {"type": "assign_skill_group", "params": {"skill_group_id": str(sg.id)}},
            {"type": "assign_staff", "params": {"staff_id": str(staff.id)}},
        ],
    )
    await db.commit()

    await svc.emit_event(db, w.tenant_id, "session.created", _ctx(w))
    sess = await _get_session(db, w.session_id)
    assert sess.skill_group_id == sg.id
    assert sess.handler_staff_id == staff.id
    assert sess.handler_type == "human"
    assert sess.status == "open"


@pytest.mark.asyncio
async def test_conditions_gate_execution(db):
    w = await _seed(db)
    # 只有內容含「退款」才加急
    await _add_rule(
        db, w, event="message.visitor",
        conditions=[{"field": "content", "op": "contains", "value": "退款"}],
        actions=[{"type": "set_status", "params": {"status": "queued"}}],
    )
    await db.commit()

    # 不含關鍵字 → 不動
    await svc.emit_event(db, w.tenant_id, "message.visitor", _ctx(w, content="你好"))
    assert (await _get_session(db, w.session_id)).status == "open"

    # 含關鍵字 → 命中
    await svc.emit_event(db, w.tenant_id, "message.visitor", _ctx(w, content="我要退款"))
    assert (await _get_session(db, w.session_id)).status == "queued"


@pytest.mark.asyncio
async def test_channel_type_condition_derived(db):
    """channel_type 由 session→channel 衍生,可作為條件欄位。"""
    w = await _seed(db, channel_type="telegram")
    await _add_rule(
        db, w, event="message.visitor",
        conditions=[{"field": "channel_type", "op": "eq", "value": "telegram"}],
        actions=[{"type": "set_status", "params": {"status": "queued"}}],
    )
    await db.commit()
    # context 不帶 channel_type,引擎自行由 channel 解析
    await svc.emit_event(db, w.tenant_id, "message.visitor", _ctx(w, content="x"))
    assert (await _get_session(db, w.session_id)).status == "queued"


@pytest.mark.asyncio
async def test_priority_ordering(db):
    """priority 升冪:數字小者先執行,後者覆蓋前者。"""
    w = await _seed(db)
    await _add_rule(db, w, event="message.visitor", priority=1, actions=[{"type": "set_status", "params": {"status": "queued"}}])
    await _add_rule(db, w, event="message.visitor", priority=2, actions=[{"type": "set_status", "params": {"status": "open"}}])
    await db.commit()
    await svc.emit_event(db, w.tenant_id, "message.visitor", _ctx(w, content="x"))
    # priority=2 後跑 → 最終 open
    assert (await _get_session(db, w.session_id)).status == "open"


@pytest.mark.asyncio
async def test_inactive_rule_skipped(db):
    w = await _seed(db)
    await _add_rule(db, w, event="message.visitor", is_active=False, actions=[{"type": "set_status", "params": {"status": "queued"}}])
    await db.commit()
    await svc.emit_event(db, w.tenant_id, "message.visitor", _ctx(w, content="x"))
    assert (await _get_session(db, w.session_id)).status == "open"


@pytest.mark.asyncio
async def test_tenant_isolation(db):
    w = await _seed(db)
    other_tid = uuid.uuid4()
    db.add(Tenant(id=other_tid, name="Other", slug=f"o-{other_tid.hex[:8]}"))
    # 規則掛在別的租戶
    await _add_rule(db, w, event="message.visitor", tenant_id=other_tid, actions=[{"type": "set_status", "params": {"status": "queued"}}])
    await db.commit()
    # 以 w 租戶發事件 → 別租戶規則不應套用
    await svc.emit_event(db, w.tenant_id, "message.visitor", _ctx(w, content="x"))
    assert (await _get_session(db, w.session_id)).status == "open"


@pytest.mark.asyncio
async def test_no_rules_noop(db):
    w = await _seed(db)
    await db.commit()
    # 無規則:不拋、不動
    await svc.emit_event(db, w.tenant_id, "message.visitor", _ctx(w, content="x"))
    assert (await _get_session(db, w.session_id)).status == "open"


@pytest.mark.asyncio
async def test_bad_action_degrades_not_raise(db):
    """單一動作參數不全(assign_staff 缺 staff_id)應降級,不影響其餘動作,不拋。"""
    w = await _seed(db)
    await _add_rule(
        db, w, event="message.visitor",
        actions=[
            {"type": "assign_staff", "params": {}},  # 缺 staff_id → 略過
            {"type": "set_status", "params": {"status": "queued"}},  # 仍應執行
        ],
    )
    await db.commit()
    await svc.emit_event(db, w.tenant_id, "message.visitor", _ctx(w, content="x"))
    sess = await _get_session(db, w.session_id)
    assert sess.status == "queued"  # 後一動作照跑
    assert sess.handler_staff_id is None


@pytest.mark.asyncio
async def test_auto_reply_uses_channel_out_without_recursion(db, monkeypatch):
    """auto_reply:add_message(sender_type="ai")落庫並發 message.new(web widget 由此收到),
    再經 channel_out.send_to_visitor 對外渠道送出(web 為 no-op,不重複)。

    防遞迴:add_message 的自動化 hook 只對 sender_type=="visitor" 觸發,ai 訊息不會再
    觸發 message.visitor → 只新增恰一則訊息、emit_event 不重入。
    """
    w = await _seed(db)
    calls: list[tuple] = []

    async def _fake_send(db_, tenant_id, session_id, text, content_type="text"):
        calls.append((str(session_id), text, content_type))

    from app.services import channel_out, realtime, webhooks

    monkeypatch.setattr(channel_out, "send_to_visitor", _fake_send)

    # realtime / webhook 以假物件取代(不依賴 Redis、SQLite 無 webhook 表)
    published: list[dict] = []

    async def _fake_publish(tenant_id, session_id, event):
        published.append(event)

    async def _fake_publish_agents(tenant_id, event):
        return None

    async def _fake_deliver(db_, tenant_id, event, payload):
        return None

    monkeypatch.setattr(realtime, "publish", _fake_publish)
    monkeypatch.setattr(realtime, "publish_agents", _fake_publish_agents)
    monkeypatch.setattr(webhooks, "deliver_event", _fake_deliver)

    # 記錄 emit_event 呼叫:若自動回覆的訊息再觸發 message.visitor,這裡會出現重入
    emitted: list[str] = []
    orig_emit = svc.emit_event

    async def _spy_emit(db_, tenant_id, event, context):
        emitted.append(event)
        await orig_emit(db_, tenant_id, event, context)

    monkeypatch.setattr(svc, "emit_event", _spy_emit)

    await _add_rule(
        db, w, event="message.visitor",
        actions=[{"type": "auto_reply", "params": {"text": "感謝您的來訊,專員將盡快回覆。"}}],
    )
    await db.commit()

    await svc.emit_event(db, w.tenant_id, "message.visitor", _ctx(w, content="哈囉"))

    # 對外渠道出站恰一次
    assert len(calls) == 1
    assert calls[0][0] == str(w.session_id)
    assert "專員" in calls[0][1]
    # 落庫恰一則 ai 訊息(不成環 → 不會重複新增)
    msgs = (
        await db.execute(select(Message).where(Message.session_id == w.session_id))
    ).scalars().all()
    assert len(msgs) == 1
    assert msgs[0].sender_type == "ai"
    assert msgs[0].content == "感謝您的來訊,專員將盡快回覆。"
    assert msgs[0].meta == {"source": "automation"}
    # web widget 經 message.new 收到恰一則(帶 message_id 供去重)
    new_events = [e for e in published if e["type"] == "message.new"]
    assert len(new_events) == 1
    assert new_events[0]["payload"]["sender_type"] == "ai"
    assert new_events[0]["payload"]["message_id"] == str(msgs[0].id)
    # emit_event 未被 ai 訊息重入
    assert emitted == ["message.visitor"]


@pytest.mark.asyncio
async def test_notify_agents_publishes(db, monkeypatch):
    w = await _seed(db)
    published: list[tuple] = []

    async def _fake_publish_agents(tenant_id, event):
        published.append((str(tenant_id), event))

    from app.services import realtime

    monkeypatch.setattr(realtime, "publish_agents", _fake_publish_agents)

    await _add_rule(
        db, w, event="session.closed",
        actions=[{"type": "notify_agents", "params": {"message": "會話已結束,請跟進"}}],
    )
    await db.commit()

    await svc.emit_event(db, w.tenant_id, "session.closed", _ctx(w, closed_by=None))
    assert len(published) == 1
    assert published[0][1]["type"] == "automation.notify"
    assert published[0][1]["payload"]["message"] == "會話已結束,請跟進"
