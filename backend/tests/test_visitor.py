"""M4 訪客 / CRM / 標籤 測試。

自足測試:以 SQLite(記憶體)取代 Postgres。透過 @compiles 讓 postgresql 的
UUID / JSONB 型別能在 SQLite 上建表;並以測試專屬的 FastAPI app 掛上 visitor.router,
覆寫 get_db 與 get_current_principal 依賴(用 X-Tenant 標頭模擬不同租戶)。
"""
from __future__ import annotations

import os

# 必須在匯入 app 之前設定,讓 app.core.db 的 module 級 engine 走 sqlite(不需 asyncpg)
os.environ.setdefault("KEFU_DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("KEFU_JWT_SECRET", "test-secret")

import uuid

import pytest
import pytest_asyncio
from fastapi import FastAPI, Header
from httpx import ASGITransport, AsyncClient
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.pool import StaticPool


@compiles(PgUUID, "sqlite")
def _uuid_sqlite(el, comp, **kw):  # pragma: no cover - 測試環境型別對應
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb_sqlite(el, comp, **kw):  # pragma: no cover
    return "JSON"


from app.api.v1 import visitor as visitor_api
from app.core.db import Base
from app.core.deps import Principal, get_current_principal, get_db
from app.models.conversation import Channel, Session
from app.models.tag import Tag, TagRelation
from app.models.visitor import Contact, Visitor
from app.services.visitor import get_or_create_visitor

TENANT_A = uuid.uuid4()
TENANT_B = uuid.uuid4()

pytestmark = pytest.mark.asyncio


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
                Tag.__table__,
                TagRelation.__table__,
                Channel.__table__,
                Session.__table__,
            ],
        )
    yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture
async def client(sessionmaker_):
    app = FastAPI()
    app.include_router(visitor_api.router, prefix="/api/v1/visitor")

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


# ---------------------------------------------------------------------------
# 服務層:get_or_create_visitor
# ---------------------------------------------------------------------------
async def test_get_or_create_visitor_dedup_and_contact(sessionmaker_):
    channel_id = uuid.uuid4()
    async with sessionmaker_() as db:
        v1 = await get_or_create_visitor(db, TENANT_A, channel_id, "tg-100", display_name="Ann")
        v2 = await get_or_create_visitor(db, TENANT_A, channel_id, "tg-100")
        # 同渠道 + 同 external_id → 同一訪客
        assert v1.id == v2.id
        # 順帶建立並關聯了 Contact
        assert v1.contact_id is not None
        contact = await db.get(Contact, v1.contact_id)
        assert contact is not None and contact.tenant_id == TENANT_A


async def test_get_or_create_visitor_refreshes_name(sessionmaker_):
    channel_id = uuid.uuid4()
    async with sessionmaker_() as db:
        await get_or_create_visitor(db, TENANT_A, channel_id, "tg-1", display_name="Old")
        v = await get_or_create_visitor(db, TENANT_A, channel_id, "tg-1", display_name="New")
        assert v.display_name == "New"


async def test_get_or_create_visitor_tenant_scoped(sessionmaker_):
    channel_id = uuid.uuid4()
    async with sessionmaker_() as db:
        va = await get_or_create_visitor(db, TENANT_A, channel_id, "same-ext")
        vb = await get_or_create_visitor(db, TENANT_B, channel_id, "same-ext")
        # 不同租戶即使 external_id 相同也是不同訪客
        assert va.id != vb.id


# ---------------------------------------------------------------------------
# 聯絡人 CRM
# ---------------------------------------------------------------------------
async def test_contact_crud(client):
    created = _data(
        await client.post(
            "/api/v1/visitor/contacts",
            json={"name": "Bob", "email": "b@x.com", "attributes": {"vip": True}},
        )
    )
    cid = created["id"]
    assert created["attributes"] == {"vip": True}

    got = _data(await client.get(f"/api/v1/visitor/contacts/{cid}"))
    assert got["name"] == "Bob"
    assert got["visitors"] == [] and got["tags"] == []

    patched = _data(
        await client.patch(
            f"/api/v1/visitor/contacts/{cid}", json={"phone": "123", "note": "重要客戶"}
        )
    )
    assert patched["phone"] == "123" and patched["note"] == "重要客戶"

    deleted = _data(await client.delete(f"/api/v1/visitor/contacts/{cid}"))
    assert deleted["deleted"] is True
    assert (await client.get(f"/api/v1/visitor/contacts/{cid}")).status_code == 404


async def test_contact_block_unblock(client):
    cid = _data(await client.post("/api/v1/visitor/contacts", json={"name": "X"}))["id"]
    assert _data(await client.post(f"/api/v1/visitor/contacts/{cid}/block"))["is_blocked"] is True
    assert (
        _data(await client.post(f"/api/v1/visitor/contacts/{cid}/unblock"))["is_blocked"] is False
    )


async def test_contact_list_search_and_tag_filter(client):
    await client.post("/api/v1/visitor/contacts", json={"name": "Alice"})
    await client.post("/api/v1/visitor/contacts", json={"name": "Alberto"})
    await client.post("/api/v1/visitor/contacts", json={"name": "Zed"})
    rows = _data(await client.get("/api/v1/visitor/contacts", params={"q": "Al"}))
    names = sorted(r["name"] for r in rows)
    assert names == ["Alberto", "Alice"]


# ---------------------------------------------------------------------------
# 訪客 / 軌跡 / 封鎖 / AI 畫像(直接建資料再打 API)
# ---------------------------------------------------------------------------
async def _seed_visitor(sessionmaker_, tenant_id=TENANT_A):
    async with sessionmaker_() as db:
        v = await get_or_create_visitor(
            db, tenant_id, uuid.uuid4(), f"ext-{uuid.uuid4().hex[:6]}", display_name="V"
        )
        await db.commit()
        return v.id, v.channel_id


async def test_visitor_get_and_block(client, sessionmaker_):
    vid, _ = await _seed_visitor(sessionmaker_)
    got = _data(await client.get(f"/api/v1/visitor/visitors/{vid}"))
    assert got["contact"] is not None
    assert _data(await client.post(f"/api/v1/visitor/visitors/{vid}/block"))["is_blocked"] is True
    blocked = _data(await client.get("/api/v1/visitor/visitors", params={"is_blocked": True}))
    assert any(v["id"] == str(vid) for v in blocked)


async def test_visitor_ai_profile_merge_and_replace(client, sessionmaker_):
    vid, _ = await _seed_visitor(sessionmaker_)
    r1 = _data(
        await client.post(
            f"/api/v1/visitor/visitors/{vid}/ai-profile", json={"profile": {"intent": "buy"}}
        )
    )
    assert r1["ai_profile"] == {"intent": "buy"}
    r2 = _data(
        await client.post(
            f"/api/v1/visitor/visitors/{vid}/ai-profile", json={"profile": {"emotion": "happy"}}
        )
    )
    # 預設淺層合併,保留舊鍵
    assert r2["ai_profile"] == {"intent": "buy", "emotion": "happy"}
    r3 = _data(
        await client.post(
            f"/api/v1/visitor/visitors/{vid}/ai-profile",
            json={"profile": {"only": 1}, "replace": True},
        )
    )
    assert r3["ai_profile"] == {"only": 1}


async def test_visitor_timeline(client, sessionmaker_):
    # 直接建 channel + session,再查軌跡
    async with sessionmaker_() as db:
        ch = Channel(tenant_id=TENANT_A, type="telegram", name="TG")
        db.add(ch)
        await db.flush()
        v = await get_or_create_visitor(db, TENANT_A, ch.id, "tl-1", display_name="T")
        db.add(Session(tenant_id=TENANT_A, channel_id=ch.id, visitor_id=v.id, status="open"))
        await db.commit()
        vid = v.id
    tl = _data(await client.get(f"/api/v1/visitor/visitors/{vid}/timeline"))
    assert tl["source"]["channel_type"] == "telegram"
    assert len(tl["sessions"]) == 1


# ---------------------------------------------------------------------------
# 跨渠道身份合併
# ---------------------------------------------------------------------------
async def test_merge_contacts(client, sessionmaker_):
    # 建兩個 contact,各掛一個 visitor
    async with sessionmaker_() as db:
        primary = Contact(tenant_id=TENANT_A, name="Primary")
        secondary = Contact(tenant_id=TENANT_A, email="sec@x.com")
        db.add_all([primary, secondary])
        await db.flush()
        v = await get_or_create_visitor(db, TENANT_A, uuid.uuid4(), "m-1")
        v.contact_id = secondary.id
        await db.commit()
        pid, sid = primary.id, secondary.id

    res = _data(
        await client.post(
            "/api/v1/visitor/contacts/merge",
            json={"primary_contact_id": str(pid), "merge_contact_ids": [str(sid)]},
        )
    )
    assert res["moved_visitors"] == 1
    # 被併聯絡人已軟刪
    assert (await client.get(f"/api/v1/visitor/contacts/{sid}")).status_code == 404
    # 主檔補上了被併者的 email,且訪客改掛主檔
    merged = _data(await client.get(f"/api/v1/visitor/contacts/{pid}"))
    assert merged["email"] == "sec@x.com"
    assert len(merged["visitors"]) == 1


async def test_merge_rejects_primary_in_list(client, sessionmaker_):
    cid = _data(await client.post("/api/v1/visitor/contacts", json={"name": "X"}))["id"]
    resp = await client.post(
        "/api/v1/visitor/contacts/merge",
        json={"primary_contact_id": cid, "merge_contact_ids": [cid]},
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# 標籤
# ---------------------------------------------------------------------------
async def test_tag_lifecycle_and_filter(client, sessionmaker_):
    tag = _data(
        await client.post("/api/v1/visitor/tags", json={"name": "VIP", "color": "#f00"})
    )
    tid = tag["id"]
    # 重複名稱衝突
    assert (await client.post("/api/v1/visitor/tags", json={"name": "VIP"})).status_code == 409

    vid, _ = await _seed_visitor(sessionmaker_)
    _data(
        await client.post(
            f"/api/v1/visitor/tags/{tid}/apply",
            json={"target_type": "visitor", "target_id": str(vid)},
        )
    )
    # 依標籤過濾訪客
    filtered = _data(
        await client.get("/api/v1/visitor/visitors", params={"tag_id": tid})
    )
    assert [v["id"] for v in filtered] == [str(vid)]
    # 目標身上的標籤
    tags_on = _data(await client.get(f"/api/v1/visitor/targets/visitor/{vid}/tags"))
    assert tags_on[0]["name"] == "VIP"
    # 標籤下的目標
    targets = _data(await client.get(f"/api/v1/visitor/tags/{tid}/targets"))
    assert targets == [{"target_type": "visitor", "target_id": str(vid)}]
    # 移除
    removed = _data(
        await client.post(
            f"/api/v1/visitor/tags/{tid}/remove",
            json={"target_type": "visitor", "target_id": str(vid)},
        )
    )
    assert removed["removed"] is True
    assert _data(await client.get(f"/api/v1/visitor/tags/{tid}/targets")) == []


async def test_tag_invalid_target_type(client):
    tid = _data(await client.post("/api/v1/visitor/tags", json={"name": "T"}))["id"]
    resp = await client.post(
        f"/api/v1/visitor/tags/{tid}/apply",
        json={"target_type": "bogus", "target_id": str(uuid.uuid4())},
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# 租戶隔離
# ---------------------------------------------------------------------------
async def test_tenant_isolation(client):
    # 以租戶 A 建 contact
    cid = _data(await client.post("/api/v1/visitor/contacts", json={"name": "A-only"}))["id"]
    # 租戶 B 看不到
    hdr = {"X-Tenant": str(TENANT_B)}
    assert (await client.get(f"/api/v1/visitor/contacts/{cid}", headers=hdr)).status_code == 404
    rows_b = _data(await client.get("/api/v1/visitor/contacts", headers=hdr))
    assert all(r["id"] != cid for r in rows_b)
