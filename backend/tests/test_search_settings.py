"""P0 全域搜尋 + 營業時間/離線設定 + AI 自動摘要 測試。

自足測試:以 SQLite(記憶體)取代 Postgres。透過 @compiles 讓 postgresql 的
UUID / JSONB 型別能在 SQLite 上建表;搜尋服務用真實 AsyncSession 驗 ILIKE 行為。
API 層以測試專屬 FastAPI app 掛路由並覆寫 get_db / get_current_principal 依賴。
"""
from __future__ import annotations

import os

os.environ.setdefault("KEFU_DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("KEFU_JWT_SECRET", "test-secret")

import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from fastapi import FastAPI, Header
from httpx import ASGITransport, AsyncClient
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.pool import StaticPool


@compiles(PgUUID, "sqlite")
def _uuid_sqlite(el, comp, **kw):  # pragma: no cover
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb_sqlite(el, comp, **kw):  # pragma: no cover
    return "JSON"


from app.api.v1 import search as search_api
from app.api.v1 import settings as settings_api
from app.api.v1.settings import compute_is_online
from app.core.db import Base
from app.core.deps import Principal, get_current_principal, get_db
from app.models.conversation import Channel, Message, Session
from app.models.settings import TenantSettings
from app.models.visitor import Contact, Visitor
from app.services import search as search_service
from app.services.search import make_snippet, normalize_pagination

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()

pytestmark = pytest.mark.asyncio


# --------------------------------------------------------------------------- #
# fixtures
# --------------------------------------------------------------------------- #
@pytest_asyncio.fixture
async def sessionmaker_():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(
            Base.metadata.create_all,
            tables=[
                Contact.__table__,
                Visitor.__table__,
                Channel.__table__,
                Session.__table__,
                Message.__table__,
                TenantSettings.__table__,
            ],
        )
    yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    await engine.dispose()


async def _seed(db, tenant_id):
    """建 channel/visitor/session/message/contact 各一組,回傳 ids。"""
    channel = Channel(tenant_id=tenant_id, type="web", name="w", config={"public_key": "pk"})
    db.add(channel)
    await db.flush()
    visitor = Visitor(
        tenant_id=tenant_id, channel_id=channel.id, external_id="tg-777", display_name="王小明"
    )
    db.add(visitor)
    await db.flush()
    session = Session(
        tenant_id=tenant_id,
        channel_id=channel.id,
        visitor_id=visitor.id,
        status="open",
        handler_type="ai",
        last_message_at=datetime.now(timezone.utc),
    )
    db.add(session)
    await db.flush()
    msg = Message(
        tenant_id=tenant_id,
        session_id=session.id,
        sender_type="visitor",
        content="我的訂單無法退款,請協助處理退貨流程",
    )
    db.add(msg)
    contact = Contact(tenant_id=tenant_id, name="陳大文", email="da@wen.com", phone="0912", note="VIP 客戶")
    db.add(contact)
    await db.commit()
    return {"channel": channel.id, "visitor": visitor.id, "session": session.id, "message": msg.id}


# --------------------------------------------------------------------------- #
# 純函式:snippet / pagination
# --------------------------------------------------------------------------- #
def test_make_snippet_highlights_hit():
    s = make_snippet("這是一段包含關鍵字退款的長文字內容", "退款")
    assert "[[退款]]" in s


def test_make_snippet_no_hit_returns_head():
    s = make_snippet("完全不相關的內容", "xyz")
    assert s.startswith("完全")


def test_make_snippet_empty():
    assert make_snippet("", "x") == ""
    assert make_snippet(None, "x") == ""


def test_normalize_pagination():
    assert normalize_pagination(1, 20) == (1, 20, 0)
    assert normalize_pagination(3, 10) == (3, 10, 20)
    assert normalize_pagination(0, 0) == (1, 20, 0)  # 非法值回預設
    assert normalize_pagination(1, 999)[1] == 50  # size 上限夾住


# --------------------------------------------------------------------------- #
# 服務層:global_search(真 sqlite)
# --------------------------------------------------------------------------- #
async def test_search_messages(sessionmaker_):
    async with sessionmaker_() as db:
        await _seed(db, TENANT_A)
    async with sessionmaker_() as db:
        res = await search_service.global_search(db, TENANT_A, "退款", type="messages")
    assert len(res["messages"]) == 1
    assert "[[退款]]" in res["messages"][0]["snippet"]
    assert "session_id" in res["messages"][0]
    assert res["sessions"] == [] and res["contacts"] == []


async def test_search_sessions_by_visitor(sessionmaker_):
    async with sessionmaker_() as db:
        await _seed(db, TENANT_A)
    async with sessionmaker_() as db:
        res = await search_service.global_search(db, TENANT_A, "小明", type="sessions")
    assert len(res["sessions"]) == 1
    assert res["sessions"][0]["visitor_name"] == "王小明"


async def test_search_contacts(sessionmaker_):
    async with sessionmaker_() as db:
        await _seed(db, TENANT_A)
    async with sessionmaker_() as db:
        res = await search_service.global_search(db, TENANT_A, "wen.com", type="contacts")
    assert len(res["contacts"]) == 1
    assert res["contacts"][0]["name"] == "陳大文"


async def test_search_all_types(sessionmaker_):
    async with sessionmaker_() as db:
        await _seed(db, TENANT_A)
    async with sessionmaker_() as db:
        # "退" 命中訊息(退款/退貨);其他型別視資料而定
        res = await search_service.global_search(db, TENANT_A, "退", type="all")
    assert res["type"] == "all"
    assert len(res["messages"]) == 1


async def test_search_tenant_isolation(sessionmaker_):
    async with sessionmaker_() as db:
        await _seed(db, TENANT_A)
    async with sessionmaker_() as db:
        res = await search_service.global_search(db, TENANT_B, "退款", type="messages")
    assert res["messages"] == []  # 別的租戶搜不到


async def test_search_empty_query_returns_empty(sessionmaker_):
    async with sessionmaker_() as db:
        await _seed(db, TENANT_A)
    async with sessionmaker_() as db:
        res = await search_service.global_search(db, TENANT_A, "   ", type="all")
    assert res["messages"] == [] and res["sessions"] == [] and res["contacts"] == []


async def test_search_wildcard_escaped(sessionmaker_):
    """含 % 的查詢不應變成萬用字元把全部撈出。"""
    async with sessionmaker_() as db:
        await _seed(db, TENANT_A)
    async with sessionmaker_() as db:
        res = await search_service.global_search(db, TENANT_A, "%", type="messages")
    assert res["messages"] == []


# --------------------------------------------------------------------------- #
# compute_is_online(純函式)
# --------------------------------------------------------------------------- #
def _bh(days, tz="UTC"):
    return {"timezone": tz, "days": days}


def test_is_online_none_means_always_open():
    assert compute_is_online(None) is True
    assert compute_is_online({}) is True
    assert compute_is_online({"timezone": "UTC"}) is True  # 無 days


def test_is_online_within_hours():
    # 週一 12:00 UTC,營業 09:00-18:00 → 營業中
    now = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc)  # 2026-09-21 是週一
    bh = _bh({"mon": [["09:00", "18:00"]]})
    assert compute_is_online(bh, now) is True


def test_is_online_outside_hours():
    now = datetime(2026, 9, 21, 20, 0, tzinfo=timezone.utc)  # 週一 20:00
    bh = _bh({"mon": [["09:00", "18:00"]]})
    assert compute_is_online(bh, now) is False


def test_is_online_closed_day():
    now = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)  # 週日
    bh = _bh({"mon": [["09:00", "18:00"]], "sun": []})
    assert compute_is_online(bh, now) is False


def test_is_online_timezone_applied():
    # 12:00 UTC = 20:00 Asia/Taipei(+8);台北營業 09:00-18:00 → 已打烊
    now = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc)
    bh = _bh({"mon": [["09:00", "18:00"]]}, tz="Asia/Taipei")
    assert compute_is_online(bh, now) is False


def test_is_online_cross_midnight():
    bh = _bh({"mon": [["22:00", "02:00"]]})
    # 週一 23:00 → 營業中
    assert compute_is_online(bh, datetime(2026, 9, 21, 23, 0, tzinfo=timezone.utc)) is True
    # 週二 01:00 → 屬週一跨午夜段延續,營業中
    assert compute_is_online(bh, datetime(2026, 9, 22, 1, 0, tzinfo=timezone.utc)) is True
    # 週二 03:00 → 已過,打烊
    assert compute_is_online(bh, datetime(2026, 9, 22, 3, 0, tzinfo=timezone.utc)) is False


def test_is_online_bad_timezone_falls_back_utc():
    now = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc)
    bh = _bh({"mon": [["09:00", "18:00"]]}, tz="Not/AZone")
    assert compute_is_online(bh, now) is True


# --------------------------------------------------------------------------- #
# API:search + settings(ASGITransport + 依賴覆寫)
# --------------------------------------------------------------------------- #
@pytest_asyncio.fixture
async def client(sessionmaker_):
    app = FastAPI()
    app.include_router(search_api.router, prefix="/api/v1/search")
    app.include_router(settings_api.router, prefix="/api/v1/settings")

    async def _get_db_override():
        async with sessionmaker_() as s:
            yield s

    async def _principal_override(x_tenant: str | None = Header(default=None)):
        tid = uuid.UUID(x_tenant) if x_tenant else TENANT_A
        return Principal(staff_id=uuid.uuid4(), tenant_id=tid, roles=["admin"])

    app.dependency_overrides[get_db] = _get_db_override
    app.dependency_overrides[get_current_principal] = _principal_override

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def _data(resp):
    body = resp.json()
    assert body["ok"] is True, body
    return body["data"]


async def test_search_api(client, sessionmaker_):
    async with sessionmaker_() as db:
        await _seed(db, TENANT_A)
    data = _data(await client.get("/api/v1/search", params={"q": "退款", "type": "messages"}))
    assert len(data["messages"]) == 1
    assert data["page"] == 1 and data["size"] == 20


async def test_search_api_empty_q(client):
    data = _data(await client.get("/api/v1/search", params={"q": ""}))
    assert data["messages"] == [] and data["sessions"] == [] and data["contacts"] == []


async def test_settings_get_default_then_put(client):
    # 尚未建立 → 回預設
    d0 = _data(await client.get("/api/v1/settings"))
    assert d0["prechat_enabled"] is False and d0["business_hours"] is None

    # PUT upsert
    payload = {
        "business_hours": {"timezone": "Asia/Taipei", "days": {"mon": [["09:00", "18:00"]]}},
        "offline_message": "目前非營業時間,請留言",
        "prechat_enabled": True,
        "prechat_fields": [{"key": "name", "label": "稱呼", "required": True}],
        "widget_theme": {"primary_color": "#2563eb", "welcome": "您好"},
        "timezone": "Asia/Taipei",
    }
    d1 = _data(await client.put("/api/v1/settings", json=payload))
    assert d1["prechat_enabled"] is True
    assert d1["offline_message"] == "目前非營業時間,請留言"

    # 再 GET 應持久化
    d2 = _data(await client.get("/api/v1/settings"))
    assert d2["widget_theme"]["primary_color"] == "#2563eb"
    assert d2["business_hours"]["days"]["mon"] == [["09:00", "18:00"]]


async def test_settings_public_endpoint(client, sessionmaker_, monkeypatch):
    # 先寫入設定(全天無 days → is_online True)
    await client.put(
        "/api/v1/settings",
        json={"offline_message": "留言給我們", "widget_theme": {"primary_color": "#111"}},
    )

    # 公開端以 channel_key 定位租戶:monkeypatch _channel_by_public_key 回傳 TENANT_A 的渠道
    from types import SimpleNamespace

    async def fake_lookup(db, key):
        return SimpleNamespace(id=uuid.uuid4(), tenant_id=TENANT_A, type="web")

    monkeypatch.setattr(settings_api, "_channel_by_public_key", fake_lookup)
    data = _data(await client.get("/api/v1/settings/public/pk"))
    assert data["is_online"] is True
    assert data["offline_message"] == "留言給我們"
    assert data["widget_theme"]["primary_color"] == "#111"
    # 公開端不應包含 tenant_id 等機敏鍵
    assert "tenant_id" not in data


async def test_settings_public_channel_not_found(client, monkeypatch):
    async def fake_lookup(db, key):
        return None

    monkeypatch.setattr(settings_api, "_channel_by_public_key", fake_lookup)
    resp = await client.get("/api/v1/settings/public/unknown")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "CHANNEL_NOT_FOUND"


# --------------------------------------------------------------------------- #
# dispatch.summarize_session(降級 + 正常)
# --------------------------------------------------------------------------- #
async def test_summarize_session_empty_returns_empty(sessionmaker_):
    from app.services import dispatch

    async with sessionmaker_() as db:
        out = await dispatch.summarize_session(db, TENANT_A, uuid.uuid4())
    assert out == ""


async def test_summarize_session_generates(sessionmaker_, monkeypatch):
    from app.services import dispatch
    from app.services.ai.agent import EffectiveConfig

    ids = None
    async with sessionmaker_() as db:
        ids = await _seed(db, TENANT_A)

    async def fake_resolve(db, tenant_id):
        return EffectiveConfig(provider="openai", model="gpt-5.5", api_key=None, system_prompt=None)

    class FakeProvider:
        async def chat(self, messages, *, model, **kw):
            # 確認 transcript 有帶入對話內容
            assert any("退款" in m.content for m in messages)
            return "訪客反映訂單無法退款。已協助說明退貨流程。"

    monkeypatch.setattr(dispatch, "resolve_config", fake_resolve)
    monkeypatch.setattr("app.services.llm.base.get_provider", lambda name, key: FakeProvider())

    async with sessionmaker_() as db:
        out = await dispatch.summarize_session(db, TENANT_A, ids["session"])
    assert "退款" in out


async def test_summarize_session_llm_failure_degrades(sessionmaker_, monkeypatch):
    from app.services import dispatch
    from app.services.ai.agent import EffectiveConfig

    async with sessionmaker_() as db:
        ids = await _seed(db, TENANT_A)

    async def fake_resolve(db, tenant_id):
        return EffectiveConfig(provider="openai", model="gpt-5.5", api_key=None, system_prompt=None)

    class BoomProvider:
        async def chat(self, *a, **k):
            raise RuntimeError("llm down")

    monkeypatch.setattr(dispatch, "resolve_config", fake_resolve)
    monkeypatch.setattr("app.services.llm.base.get_provider", lambda name, key: BoomProvider())

    async with sessionmaker_() as db:
        out = await dispatch.summarize_session(db, TENANT_A, ids["session"])
    assert out == ""  # 例外降級,不拋
