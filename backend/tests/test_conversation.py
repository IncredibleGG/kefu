"""M3 會話 + 即時 測試。

分兩層:
1. 一律執行:realtime 頻道命名 / 封包 / publish-subscribe 往返(以內建假 Redis),
   以及 /ws/agent 的 JWT 閘門。
2. 需要資料庫:REST 端點(列表 Tabs、送訊、handoff、結束)與服務層 seam,
   若 settings.database_url 無法連線則自動跳過。
"""
from __future__ import annotations

import asyncio
import uuid

import pytest

from app.services import realtime

# ============================ 假 Redis(pub/sub)============================

class _FakePubSub:
    def __init__(self, hub: _FakeRedis) -> None:
        self.hub = hub
        self.queue: asyncio.Queue = asyncio.Queue()
        self.channels: set[str] = set()

    async def subscribe(self, *chs: str) -> None:
        for c in chs:
            self.channels.add(c)
            self.hub.subs.setdefault(c, set()).add(self)

    async def unsubscribe(self, *chs: str) -> None:
        for c in chs:
            self.hub.subs.get(c, set()).discard(self)
            self.channels.discard(c)

    async def aclose(self) -> None:
        pass

    async def listen(self):
        while True:
            yield await self.queue.get()

    def _deliver(self, channel: str, data: str) -> None:
        self.queue.put_nowait({"type": "message", "channel": channel, "data": data})


class _FakeRedis:
    def __init__(self) -> None:
        self.subs: dict[str, set[_FakePubSub]] = {}

    def pubsub(self) -> _FakePubSub:
        return _FakePubSub(self)

    async def publish(self, channel: str, data: str) -> None:
        for ps in list(self.subs.get(channel, set())):
            ps._deliver(channel, data)


@pytest.fixture
def fake_redis():
    fake = _FakeRedis()
    realtime.set_client(fake)
    yield fake
    realtime.set_client(None)  # 還原,避免污染其他測試


# ============================ 一律執行:realtime 單元 ============================

def test_channel_names():
    t, s = "t1", "s1"
    assert realtime.session_channel(t, s) == "rt:t1:session:s1"
    assert realtime.agents_channel(t) == "rt:t1:agents"


def test_make_event_shape():
    evt = realtime.make_event("message.new", {"content": "hi"})
    assert evt["type"] == "message.new"
    assert evt["payload"] == {"content": "hi"}
    assert isinstance(evt["ts"], str) and evt["ts"]
    # payload 預設為空 dict
    assert realtime.make_event("x")["payload"] == {}


@pytest.mark.asyncio
async def test_publish_subscribe_roundtrip(fake_redis):
    t, s = "tenantA", "sess1"
    async with realtime.subscribe([realtime.session_channel(t, s)]) as events:
        await realtime.publish(t, s, realtime.make_event("message.new", {"content": "hello"}))
        evt = await asyncio.wait_for(events.__anext__(), timeout=1.0)
    assert evt["type"] == "message.new"
    assert evt["payload"]["content"] == "hello"


@pytest.mark.asyncio
async def test_agents_channel_isolated_from_session(fake_redis):
    """發到 session 頻道的事件不會漏到 agents 頻道。"""
    t, s = "tenantB", "sess2"
    async with realtime.subscribe([realtime.agents_channel(t)]) as agent_events:
        await realtime.publish(t, s, realtime.make_event("message.new"))
        await realtime.publish_agents(t, realtime.make_event("session.activity", {"session_id": s}))
        evt = await asyncio.wait_for(agent_events.__anext__(), timeout=1.0)
    assert evt["type"] == "session.activity"  # 只收到 agents 頻道那筆


# ============================ 一律執行:/ws/agent JWT 閘門 ============================

def _build_ws_app():
    from fastapi import FastAPI

    from app.api.v1 import conversation

    app = FastAPI()
    app.include_router(conversation.ws_router)
    return app


def test_ws_agent_rejects_bad_token():
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    client = TestClient(_build_ws_app())
    # 認證失敗改為「先 accept 再 close(4401)」,客戶端才看得到原因
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect("/ws/agent?token=not-a-jwt") as ws:
            ws.receive_text()
    assert exc_info.value.code == 4401


# ============================ 需要資料庫:整合測試 ============================

async def _engine_or_skip():
    """建立測試引擎並建表;若資料庫不可用(或缺 pgvector)則跳過。"""
    from sqlalchemy.ext.asyncio import create_async_engine

    import app.models
    from app.core.config import settings
    from app.core.db import Base

    engine = create_async_engine(settings.database_url)
    try:
        from sqlalchemy import text

        async with engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.run_sync(Base.metadata.create_all)
    except Exception as exc:
        await engine.dispose()
        pytest.skip(f"資料庫不可用,跳過整合測試:{exc}")
    return engine


async def _seed(engine):
    """建立一個租戶 + 坐席 + 渠道 + 訪客 + 一個 open 會話,回傳 id 們。"""
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from app.models.conversation import Channel, Session
    from app.models.iam import Staff
    from app.models.tenancy import Tenant
    from app.models.visitor import Visitor

    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as db:
        tenant = Tenant(name="t", slug=f"t-{uuid.uuid4().hex[:8]}")
        db.add(tenant)
        await db.flush()
        staff = Staff(
            tenant_id=tenant.id,
            email=f"{uuid.uuid4().hex[:8]}@x.com",
            password_hash="x",
            display_name="Agent",
        )
        channel = Channel(tenant_id=tenant.id, type="web", name="web")
        db.add_all([staff, channel])
        await db.flush()
        visitor = Visitor(tenant_id=tenant.id, channel_id=channel.id, external_id="v1")
        db.add(visitor)
        await db.flush()
        session = Session(
            tenant_id=tenant.id,
            channel_id=channel.id,
            visitor_id=visitor.id,
            status="open",
            handler_type="human",
        )
        db.add(session)
        await db.commit()
        return {
            "tenant_id": tenant.id,
            "staff_id": staff.id,
            "channel_id": channel.id,
            "visitor_id": visitor.id,
            "session_id": session.id,
        }


def _token(staff_id, tenant_id) -> str:
    from app.core.security import create_access_token

    return create_access_token(
        {"sub": str(staff_id), "tenant_id": str(tenant_id), "roles": ["admin"]}
    )


async def _client(engine):
    """建立含 conversation router 的臨時 app,並把 get_db 指向測試引擎。"""
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from app.api.v1 import conversation
    from app.core.db import get_db

    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _get_db():
        async with maker() as s:
            yield s

    app = FastAPI()
    app.include_router(conversation.router, prefix="/api/v1/conversation")
    app.dependency_overrides[get_db] = _get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_send_message_and_history(fake_redis):
    engine = await _engine_or_skip()
    try:
        ids = await _seed(engine)
        headers = {"Authorization": f"Bearer {_token(ids['staff_id'], ids['tenant_id'])}"}
        async with await _client(engine) as c:
            sid = str(ids["session_id"])
            # 送出一則訊息
            r = await c.post(
                f"/api/v1/conversation/sessions/{sid}/messages",
                json={"content": "你好"},
                headers=headers,
            )
            assert r.status_code == 200
            body = r.json()
            assert body["ok"] is True
            assert body["data"]["sender_type"] == "human"
            assert body["data"]["content"] == "你好"

            # 讀回歷史
            r = await c.get(f"/api/v1/conversation/sessions/{sid}", headers=headers)
            assert r.status_code == 200
            data = r.json()["data"]
            assert data["session"]["id"] == sid
            assert len(data["messages"]) == 1
            assert data["messages"][0]["content"] == "你好"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_tabs_mine_and_handoff_and_close(fake_redis):
    engine = await _engine_or_skip()
    try:
        ids = await _seed(engine)
        headers = {"Authorization": f"Bearer {_token(ids['staff_id'], ids['tenant_id'])}"}
        sid = str(ids["session_id"])
        async with await _client(engine) as c:
            # 起初未指派 → mine 應為空
            r = await c.get("/api/v1/conversation/sessions?tab=mine", headers=headers)
            assert r.json()["data"]["total"] == 0

            # 接管 → 指派給自己
            r = await c.post(
                f"/api/v1/conversation/sessions/{sid}/handoff",
                json={"action": "takeover"},
                headers=headers,
            )
            assert r.status_code == 200
            assert r.json()["data"]["handler_staff_id"] == str(ids["staff_id"])

            # 現在 mine 應含此會話
            r = await c.get("/api/v1/conversation/sessions?tab=mine", headers=headers)
            assert r.json()["data"]["total"] == 1

            # 結束會話
            r = await c.post(
                f"/api/v1/conversation/sessions/{sid}/close", headers=headers
            )
            assert r.status_code == 200
            assert r.json()["data"]["status"] == "closed"

            # online tab 不應再含已結束會話
            r = await c.get("/api/v1/conversation/sessions?tab=online", headers=headers)
            assert r.json()["data"]["total"] == 0
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_tenant_isolation_on_get(fake_redis):
    """以別的租戶 token 取會話應 404(tenant_id 過濾)。"""
    engine = await _engine_or_skip()
    try:
        ids = await _seed(engine)
        other_headers = {"Authorization": f"Bearer {_token(uuid.uuid4(), uuid.uuid4())}"}
        async with await _client(engine) as c:
            r = await c.get(
                f"/api/v1/conversation/sessions/{ids['session_id']}", headers=other_headers
            )
            assert r.status_code == 200
            assert r.json()["ok"] is False
            assert r.json()["error"]["code"] == "not_found"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_get_or_open_session_reuses_open(fake_redis):
    engine = await _engine_or_skip()
    try:
        from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

        from app.services.conversation import get_or_open_session

        ids = await _seed(engine)
        maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        async with maker() as db:
            s1 = await get_or_open_session(
                db, ids["tenant_id"], ids["channel_id"], ids["visitor_id"]
            )
            await db.commit()
            # 已有 open 會話 → 應重用同一個
            assert s1.id == ids["session_id"]

            s2 = await get_or_open_session(
                db, ids["tenant_id"], ids["channel_id"], ids["visitor_id"]
            )
            assert s2.id == s1.id
    finally:
        await engine.dispose()
