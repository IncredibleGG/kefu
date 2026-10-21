"""/ws/agent 原生客戶端契約測試(docs/NATIVE-CLIENTS.md 4.2)。

涵蓋:
1. 認證失敗一律「先 accept 再 close(4401)」,含即時撤銷(停用/軟刪坐席、租戶停用、
   平台超管例外須 claim 與 DB 同時成立)。
2. 應用層心跳 ping → pong、app_state 前景回報、device_id / platform 登記。
3. 上線狀態:第一條連線才設 online(僅從 offline)、最後一條結束才設 offline
   (僅從 online),手動 busy/away 不被覆蓋;Redis 不可用時 fail-open。
4. 事件擴充:session.activity、session.assigned(handler_staff_id / actor)、
   handoff(from_staff_id / note),以及附件上傳的 handoff 不再洩漏到訪客會話頻道。

資料庫用 SQLite 檔案(NullPool,跨 TestClient 執行緒安全),Redis 用內建假物件;
不依賴外部 Postgres / Redis。
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.ext.compiler import compiles


# --- 測試專用型別 shim:讓 pg 專屬型別在 SQLite 上可用(與 test_routing 相同) ---
@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(type_, compiler, **kw):
    return "TEXT"


@compiles(PGUUID, "sqlite")
def _compile_uuid_sqlite(type_, compiler, **kw):
    return "CHAR(32)"


from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

import app.models
import app.models.routing  # noqa: F401
from app.api.v1 import conversation as conv_api
from app.core.db import Base
from app.core.security import create_access_token
from app.models.conversation import Channel, Message, Session
from app.models.iam import SkillGroup, Staff, staff_skillgroup
from app.models.routing import RoutingPolicy
from app.models.tenancy import Tenant
from app.models.visitor import Visitor
from app.services import conversation as conv_svc
from app.services import presence, realtime

_TABLES = [
    t.__table__
    for t in (Tenant, Staff, SkillGroup, Channel, Visitor, Session, Message, RoutingPolicy)
] + [staff_skillgroup]


# ============================ 假 Redis ============================

class _NeverPubSub:
    """訂閱端:listen 永遠阻塞(本檔不測轉發,只需 _pump 安靜掛著直到被 cancel)。"""

    async def subscribe(self, *chs: str) -> None:
        pass

    async def unsubscribe(self, *chs: str) -> None:
        pass

    async def aclose(self) -> None:
        pass

    async def listen(self):
        await asyncio.Event().wait()
        yield {}  # pragma: no cover


class FakeRedis:
    """hash(presence)+ publish 紀錄 + 永不出事件的 pubsub。"""

    def __init__(self) -> None:
        self.hashes: dict[str, dict[str, str]] = {}
        self.published: list[tuple[str, dict]] = []

    def pubsub(self) -> _NeverPubSub:
        return _NeverPubSub()

    async def publish(self, channel: str, data: str) -> int:
        self.published.append((channel, json.loads(data)))
        return 0

    async def hset(self, key, field, value):
        self.hashes.setdefault(key, {})[field] = value
        return 1

    async def hgetall(self, key):
        return dict(self.hashes.get(key, {}))

    async def hdel(self, key, *fields):
        h = self.hashes.get(key, {})
        for f in fields:
            h.pop(f, None)
        if key in self.hashes and not self.hashes[key]:
            del self.hashes[key]
        return 1

    async def expire(self, key, seconds):
        return True

    def events(self, channel: str, type_: str | None = None) -> list[dict]:
        return [e for c, e in self.published if c == channel and (type_ is None or e["type"] == type_)]


class RedisDownFake(FakeRedis):
    """模擬 Redis 指令失敗(presence 走 fail-open);pubsub 仍可掛著不出事件。"""

    async def hset(self, *a, **kw):
        raise ConnectionError("redis down")

    async def hgetall(self, *a, **kw):
        raise ConnectionError("redis down")

    async def hdel(self, *a, **kw):
        raise ConnectionError("redis down")


@pytest.fixture
def fake_redis():
    fake = FakeRedis()
    realtime.set_client(fake)
    yield fake
    realtime.set_client(None)


# ============================ SQLite 檔案資料庫 ============================

@pytest.fixture
def db_env(tmp_path, monkeypatch):
    """建表並把 /ws/agent 用的 SessionLocal 指向測試庫;離線寬限期設 0。"""
    url = f"sqlite+aiosqlite:///{tmp_path / 'ws.db'}"
    engine = create_async_engine(url, poolclass=NullPool)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=_TABLES))

    asyncio.run(_create())
    monkeypatch.setattr(conv_api, "SessionLocal", maker)
    monkeypatch.setattr(conv_api, "WS_OFFLINE_GRACE_SECONDS", 0)
    env = SimpleNamespace(engine=engine, maker=maker)
    yield env
    asyncio.run(engine.dispose())


def _seed(env, *, status="offline", staff_active=True, staff_deleted=False,
          tenant_active=True, platform_admin=False):
    async def _do():
        async with env.maker() as db:
            tid = uuid.uuid4()
            db.add(Tenant(id=tid, name="Acme", slug=f"acme-{tid.hex[:8]}", is_active=tenant_active))
            staff = Staff(
                tenant_id=tid,
                email=f"{uuid.uuid4().hex[:8]}@x.com",
                password_hash="x",
                display_name="Agent",
                status=status,
                is_active=staff_active,
                is_platform_admin=platform_admin,
                deleted_at=datetime.now(UTC) if staff_deleted else None,
            )
            ch = Channel(tenant_id=tid, type="web", name="web")
            db.add_all([staff, ch])
            await db.flush()
            vis = Visitor(tenant_id=tid, channel_id=ch.id, external_id="v1")
            db.add(vis)
            await db.flush()
            sess = Session(
                tenant_id=tid, channel_id=ch.id, visitor_id=vis.id, status="open", handler_type="ai"
            )
            db.add(sess)
            await db.commit()
            return SimpleNamespace(
                tenant_id=tid, staff_id=staff.id, session_id=sess.id, visitor_id=vis.id
            )

    return asyncio.run(_do())


def _status(env, staff_id) -> str:
    async def _do():
        async with env.maker() as db:
            return (await db.execute(select(Staff.status).where(Staff.id == staff_id))).scalar_one()

    return asyncio.run(_do())


def _token(staff_id, tenant_id, **extra) -> str:
    return create_access_token(
        {"sub": str(staff_id), "tenant_id": str(tenant_id), "roles": ["admin"], **extra}
    )


def _ws_client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(conv_api.ws_router)
    return TestClient(app)


def _wait_until(pred, timeout: float = 3.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return pred()


def _assert_closed_4401(client, url: str) -> None:
    from starlette.websockets import WebSocketDisconnect

    # websocket_connect 進入即代表 accept 成功(握手完成),隨即收到 close(4401)
    with pytest.raises(WebSocketDisconnect) as exc_info, client.websocket_connect(url) as ws:
        ws.receive_text()
    assert exc_info.value.code == 4401


# ============================ 1. 認證 / 撤銷 ============================

def test_auth_failures_accept_then_close_4401(fake_redis, db_env):
    client = _ws_client()
    w = _seed(db_env)
    _assert_closed_4401(client, "/ws/agent")  # 缺 token
    _assert_closed_4401(client, "/ws/agent?token=not-a-jwt")
    # 用途型權杖(2FA challenge 等)不得當 access token
    purpose = create_access_token(
        {"sub": str(w.staff_id), "tenant_id": str(w.tenant_id), "purpose": "2fa"}
    )
    _assert_closed_4401(client, f"/ws/agent?token={purpose}")
    # claims 不完整
    no_tenant = create_access_token({"sub": str(w.staff_id)})
    _assert_closed_4401(client, f"/ws/agent?token={no_tenant}")
    bad_sub = create_access_token({"sub": "nope", "tenant_id": str(w.tenant_id)})
    _assert_closed_4401(client, f"/ws/agent?token={bad_sub}")
    # token 的 tenant 與坐席實際租戶不符
    _assert_closed_4401(client, f"/ws/agent?token={_token(w.staff_id, uuid.uuid4())}")
    # 失敗連線不登記 presence、也不動 Staff.status
    assert fake_redis.hashes == {}
    assert _status(db_env, w.staff_id) == "offline"


@pytest.mark.parametrize(
    "seed_kwargs,claims",
    [
        ({"staff_active": False}, {}),
        ({"staff_deleted": True}, {}),
        ({"tenant_active": False}, {}),
        # 只有 claim、DB 已降權 → 不得以殘留 claim 繞過租戶停用
        ({"tenant_active": False, "platform_admin": False}, {"is_platform_admin": True}),
        # DB 是超管但 token 沒有 claim → 同 REST,不豁免
        ({"tenant_active": False, "platform_admin": True}, {}),
    ],
)
def test_revoked_accounts_are_rejected(fake_redis, db_env, seed_kwargs, claims):
    client = _ws_client()
    w = _seed(db_env, **seed_kwargs)
    _assert_closed_4401(client, f"/ws/agent?token={_token(w.staff_id, w.tenant_id, **claims)}")
    assert fake_redis.hashes == {}


def test_platform_admin_allowed_on_suspended_tenant(fake_redis, db_env):
    client = _ws_client()
    w = _seed(db_env, tenant_active=False, platform_admin=True)
    tok = _token(w.staff_id, w.tenant_id, is_platform_admin=True)
    with client.websocket_connect(f"/ws/agent?token={tok}") as ws:
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"


# ============================ 2. 心跳 / app_state / 登記 ============================

def test_ping_pong_app_state_and_presence_lifecycle(fake_redis, db_env):
    client = _ws_client()
    w = _seed(db_env)
    key = presence.presence_key(w.staff_id)
    tok = _token(w.staff_id, w.tenant_id)
    with client.websocket_connect(f"/ws/agent?token={tok}&device_id=dev-1&platform=iOS") as ws:
        ws.send_json({"type": "ping"})
        pong = ws.receive_json()
        assert pong["type"] == "pong"
        assert pong["payload"] == {}
        assert isinstance(pong["ts"], str) and pong["ts"]

        entries = fake_redis.hashes[key]
        assert len(entries) == 1
        entry = json.loads(next(iter(entries.values())))
        assert entry["device_id"] == "dev-1"
        assert entry["platform"] == "ios"
        assert entry["fg"] == 1
        assert _status(db_env, w.staff_id) == "online"

        # 背景:fg=0;非 bool 的 foreground、壞 JSON、非 dict 一律忽略且不斷線
        ws.send_json({"type": "app_state", "payload": {"foreground": False}})
        ws.send_json({"type": "app_state", "payload": {"foreground": "yes"}})
        ws.send_json({"type": "app_state", "payload": "x"})
        ws.send_text("not json")
        ws.send_json(["list"])
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"  # 前面的封包都已處理
        entry = json.loads(next(iter(fake_redis.hashes[key].values())))
        assert entry["fg"] == 0

        ws.send_json({"type": "app_state", "payload": {"foreground": True}})
        ws.send_json({"type": "ping"})
        ws.receive_json()
        entry = json.loads(next(iter(fake_redis.hashes[key].values())))
        assert entry["fg"] == 1

        ws.close()
        assert _wait_until(lambda: key not in fake_redis.hashes)
        assert _wait_until(lambda: _status(db_env, w.staff_id) == "offline")


def test_manual_busy_is_never_overridden(fake_redis, db_env):
    client = _ws_client()
    w = _seed(db_env, status="busy")
    key = presence.presence_key(w.staff_id)
    with client.websocket_connect(f"/ws/agent?token={_token(w.staff_id, w.tenant_id)}") as ws:
        ws.send_json({"type": "ping"})
        ws.receive_json()
        assert _status(db_env, w.staff_id) == "busy"  # 連上不改成 online
        ws.close()
        assert _wait_until(lambda: key not in fake_redis.hashes)
        time.sleep(0.1)
        assert _status(db_env, w.staff_id) == "busy"  # 斷線也不改成 offline


def test_offline_only_after_last_connection(fake_redis, db_env):
    client = _ws_client()
    w = _seed(db_env)
    key = presence.presence_key(w.staff_id)
    tok = _token(w.staff_id, w.tenant_id)
    with client.websocket_connect(f"/ws/agent?token={tok}&device_id=desk") as a:
        a.send_json({"type": "ping"})
        a.receive_json()
        with client.websocket_connect(f"/ws/agent?token={tok}&device_id=phone") as b:
            b.send_json({"type": "ping"})
            b.receive_json()
            assert len(fake_redis.hashes[key]) == 2
            assert _status(db_env, w.staff_id) == "online"
            b.close()
            assert _wait_until(lambda: len(fake_redis.hashes.get(key, {})) == 1)
            time.sleep(0.1)
            assert _status(db_env, w.staff_id) == "online"  # 還有一條連線 → 維持 online
        a.close()
        assert _wait_until(lambda: _status(db_env, w.staff_id) == "offline")


def test_redis_down_fails_open_to_old_behavior(db_env):
    fake = RedisDownFake()
    realtime.set_client(fake)
    try:
        client = _ws_client()
        w = _seed(db_env)
        with client.websocket_connect(f"/ws/agent?token={_token(w.staff_id, w.tenant_id)}") as ws:
            ws.send_json({"type": "ping"})
            assert ws.receive_json()["type"] == "pong"  # 心跳不受 Redis 影響
            assert _status(db_env, w.staff_id) == "online"  # 連上即上線
            ws.close()
            assert _wait_until(lambda: _status(db_env, w.staff_id) == "offline")  # 斷線即離線
    finally:
        realtime.set_client(None)


def test_agent_typing_still_forwarded(fake_redis, db_env):
    client = _ws_client()
    w = _seed(db_env)
    chan = realtime.session_channel(w.tenant_id, w.session_id)
    with client.websocket_connect(f"/ws/agent?token={_token(w.staff_id, w.tenant_id)}") as ws:
        ws.send_json({"type": "typing", "payload": {"session_id": str(w.session_id)}})
        ws.send_json({"type": "typing", "payload": {"session_id": str(uuid.uuid4())}})  # 非本租戶會話
        ws.send_json({"type": "ping"})
        ws.receive_json()
    typing = [e for c, e in fake_redis.published if e["type"] == "typing"]
    assert len(typing) == 1
    assert fake_redis.events(chan, "typing")[0]["payload"] == {
        "session_id": str(w.session_id),
        "sender_type": "human",
        "staff_id": str(w.staff_id),
    }


@pytest.mark.asyncio
async def test_offline_grace_period_skips_reconnect(fake_redis, monkeypatch):
    """寬限期內有新連線(切換會話重連)→ 不判離線;否則才改 offline(且只從 online)。"""
    calls: list[tuple] = []

    async def _record(staff_id, tenant_id, status, *, only_from=None):
        calls.append((status, only_from))

    monkeypatch.setattr(conv_api, "_set_staff_presence", _record)
    monkeypatch.setattr(conv_api, "WS_OFFLINE_GRACE_SECONDS", 0.1)
    tid = uuid.uuid4()

    a = presence.Connection(staff_id="s-grace")
    await presence.register(a)
    b = presence.Connection(staff_id="s-grace")

    async def _reconnect():
        await asyncio.sleep(0.02)
        await presence.register(b)

    await asyncio.gather(conv_api._presence_disconnected(a, tid), _reconnect())
    assert calls == []

    await conv_api._presence_disconnected(b, tid)
    assert calls == [("offline", "online")]


# ============================ 3. 事件擴充 ============================

@pytest.fixture
def mem_db(fake_redis, monkeypatch):
    """記憶體 SQLite(StaticPool)上的 AsyncSession,供服務層 / REST 測試。"""
    from sqlalchemy.pool import StaticPool

    async def _noop(*a, **kw):
        return None

    # 自動化 / webhook 為加值層,這裡不建它們的表
    monkeypatch.setattr(conv_svc, "_emit_automation", _noop)
    monkeypatch.setattr(conv_svc, "_deliver_webhook", _noop)
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    return engine


async def _mem_seed(engine, *, handler_staff=False):
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=_TABLES))
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as db:
        tid = uuid.uuid4()
        db.add(Tenant(id=tid, name="Acme", slug=f"acme-{tid.hex[:8]}"))
        staff = Staff(
            tenant_id=tid, email="a@x.com", password_hash="x", display_name="A", status="online"
        )
        other = Staff(
            tenant_id=tid, email="b@x.com", password_hash="x", display_name="B", status="online"
        )
        ch = Channel(tenant_id=tid, type="web", name="web")
        db.add_all([staff, other, ch])
        await db.flush()
        vis = Visitor(tenant_id=tid, channel_id=ch.id, external_id="v1")
        db.add(vis)
        await db.flush()
        sess = Session(
            tenant_id=tid,
            channel_id=ch.id,
            visitor_id=vis.id,
            status="open",
            handler_type="human" if handler_staff else "ai",
            handler_staff_id=staff.id if handler_staff else None,
        )
        db.add(sess)
        await db.commit()
        return maker, SimpleNamespace(
            tenant_id=tid, staff_id=staff.id, other_id=other.id, session_id=sess.id, visitor_id=vis.id
        )


def test_activity_preview_rules():
    assert conv_svc.activity_preview("hi  there\n you", "text") == "hi there you"
    assert conv_svc.activity_preview("x" * 200, "markdown") == "x" * 80
    assert conv_svc.activity_preview("/api/v1/channel/files/a.png", "image") == ""
    assert conv_svc.activity_preview("doc.pdf", "file") == ""
    assert conv_svc.activity_preview("fallback", "card") == ""
    assert conv_svc.activity_preview("", "text") == ""


@pytest.mark.asyncio
async def test_session_activity_payload_enriched(mem_db, fake_redis):
    maker, w = await _mem_seed(mem_db, handler_staff=True)
    try:
        async with maker() as db:
            msg = await conv_svc.add_message(
                db,
                w.tenant_id,
                w.session_id,
                sender_type="visitor",
                content="我的卡號 4111 1111 1111 1111 " + "很長" * 60,
                sender_id=w.visitor_id,
            )
            await db.commit()
        evts = fake_redis.events(realtime.agents_channel(w.tenant_id), "session.activity")
        assert len(evts) == 1
        p = evts[0]["payload"]
        assert p["session_id"] == str(w.session_id)
        assert p["last_message_at"]
        assert p["message_id"] == str(msg.id)
        assert p["sender_type"] == "visitor"
        assert p["content_type"] == "text"
        assert p["handler_type"] == "human"
        assert p["handler_staff_id"] == str(w.staff_id)
        assert p["status"] == "open"
        assert p["visitor_id"] == str(w.visitor_id)
        # 預覽:≤80 字,且已遮罩卡號(不含完整卡號)
        assert len(p["preview"]) <= 80
        assert "4111 1111 1111 1111" not in p["preview"]
        assert "4111111111111111" not in p["preview"]
        assert p["preview"].startswith("我的卡號 •••• •••• •••• 1111")
        # session.activity 只發坐席頻道,會話頻道仍是完整 message.new
        assert fake_redis.events(realtime.session_channel(w.tenant_id, w.session_id), "session.activity") == []
    finally:
        await mem_db.dispose()


@pytest.mark.asyncio
async def test_session_activity_non_text_has_empty_preview(mem_db, fake_redis):
    maker, w = await _mem_seed(mem_db)
    try:
        async with maker() as db:
            await conv_svc.add_message(
                db, w.tenant_id, w.session_id, sender_type="ai",
                content="/api/v1/channel/files/x.png", content_type="image",
            )
            await db.commit()
        p = fake_redis.events(realtime.agents_channel(w.tenant_id), "session.activity")[0]["payload"]
        assert p["preview"] == ""
        assert p["content_type"] == "image"
        assert p["sender_type"] == "ai"
        assert p["handler_type"] == "ai"
        assert p["handler_staff_id"] is None
    finally:
        await mem_db.dispose()


@pytest.mark.asyncio
async def test_session_assigned_auto_and_manual_actor(mem_db, fake_redis):
    from app.services import routing

    maker, w = await _mem_seed(mem_db)
    try:
        async with maker() as db:
            assigned = await routing.assign_session(db, w.tenant_id, w.session_id)
            assert assigned in {w.staff_id, w.other_id}
            # 主管手動指派:actor = 操作者
            await routing.manual_assign(
                db, w.tenant_id, w.session_id, w.other_id, actor_staff_id=w.staff_id
            )
            # 舊呼叫端未帶 actor:actor 為 None(操作者未知)
            await routing.manual_assign(db, w.tenant_id, w.session_id, w.staff_id)
        evts = fake_redis.events(realtime.agents_channel(w.tenant_id), "session.assigned")
        assert len(evts) == 3
        auto, manual, legacy = (e["payload"] for e in evts)
        assert auto["actor"] == "auto"
        assert auto["handler_staff_id"] == str(assigned)
        assert auto["staff_id"] == str(assigned)  # 既有欄位保留
        assert manual["actor"] == str(w.staff_id)
        assert manual["handler_staff_id"] == str(w.other_id)
        assert manual["strategy"] == "manual"
        assert legacy["actor"] is None
        assert legacy["handler_staff_id"] == str(w.staff_id)
    finally:
        await mem_db.dispose()


def _rest_client(maker, *routers):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from app.core.db import get_db

    async def _get_db():
        async with maker() as s:
            yield s

    app = FastAPI()
    for router, prefix in routers:
        app.include_router(router, prefix=prefix)
    app.dependency_overrides[get_db] = _get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_transfer_and_handoff_events_carry_origin(mem_db, fake_redis, monkeypatch):
    from app.services import automation, webhooks

    async def _noop(*a, **kw):
        return None

    monkeypatch.setattr(automation, "emit_event", _noop)
    monkeypatch.setattr(webhooks, "deliver_event", _noop)
    maker, w = await _mem_seed(mem_db, handler_staff=True)
    headers = {"Authorization": f"Bearer {_token(w.staff_id, w.tenant_id)}"}
    sid = str(w.session_id)
    try:
        async with _rest_client(maker, (conv_api.router, "/api/v1/conversation")) as c:
            r = await c.post(
                f"/api/v1/conversation/sessions/{sid}/transfer",
                json={"target_staff_id": str(w.other_id), "note": "請協助退款"},
                headers=headers,
            )
            assert r.json()["ok"] is True
            r = await c.post(
                f"/api/v1/conversation/sessions/{sid}/handoff",
                json={"action": "takeover"},
                headers=headers,
            )
            assert r.json()["ok"] is True
        evts = fake_redis.events(realtime.agents_channel(w.tenant_id), "handoff")
        assert len(evts) == 2
        transfer, takeover = (e["payload"] for e in evts)
        assert transfer["action"] == "transfer"
        assert transfer["from_staff_id"] == str(w.staff_id)
        assert transfer["previous_handler_staff_id"] == str(w.staff_id)
        assert transfer["handler_staff_id"] == str(w.other_id)
        assert transfer["target_staff_id"] == str(w.other_id)
        assert transfer["note"] == "請協助退款"
        assert takeover["action"] == "takeover"
        assert takeover["from_staff_id"] == str(w.staff_id)
        assert takeover["previous_handler_staff_id"] == str(w.other_id)
        assert takeover["handler_staff_id"] == str(w.staff_id)
        assert takeover["note"] is None
        # handoff 不進訪客會話頻道
        assert fake_redis.events(realtime.session_channel(w.tenant_id, w.session_id), "handoff") == []
    finally:
        await mem_db.dispose()


@pytest.mark.asyncio
async def test_attachment_claim_does_not_leak_to_visitor_channel(mem_db, fake_redis, monkeypatch):
    from app.api.v1 import attachments
    from app.services import channel_out, storage

    async def _save(file):
        return SimpleNamespace(id="abc.png", filename="a.png", media_type="image/png", size=3)

    async def _noop(*a, **kw):
        return None

    monkeypatch.setattr(storage, "save_upload", _save)
    monkeypatch.setattr(channel_out, "send_to_visitor", _noop)
    maker, w = await _mem_seed(mem_db)  # AI 接待中 → 上傳即認領
    headers = {"Authorization": f"Bearer {_token(w.staff_id, w.tenant_id)}"}
    try:
        async with _rest_client(maker, (attachments.router, "/api/v1/attachments")) as c:
            r = await c.post(
                f"/api/v1/attachments/sessions/{w.session_id}/upload",
                files={"file": ("a.png", b"png", "image/png")},
                headers=headers,
            )
            assert r.json()["ok"] is True
        session_chan = realtime.session_channel(w.tenant_id, w.session_id)
        agents_chan = realtime.agents_channel(w.tenant_id)
        # 訪客會話頻道只有 message.new,不含帶坐席 id 的 handoff
        assert [e["type"] for c, e in fake_redis.published if c == session_chan] == ["message.new"]
        handoff = fake_redis.events(agents_chan, "handoff")
        assert len(handoff) == 1
        p = handoff[0]["payload"]
        assert p["handler_staff_id"] == str(w.staff_id)
        assert p["from_staff_id"] == str(w.staff_id)
        assert p["previous_handler_staff_id"] is None
        activity = fake_redis.events(agents_chan, "session.activity")[0]["payload"]
        assert activity["content_type"] == "image"
        assert activity["preview"] == ""
        assert activity["handler_staff_id"] == str(w.staff_id)
    finally:
        await mem_db.dispose()
