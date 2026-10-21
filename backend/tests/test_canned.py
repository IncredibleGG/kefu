"""罐頭訊息 / 快捷回覆(canned)測試。

分兩層:
1. 一律執行:純模型序列化 / 可見性,不需資料庫。
2. 需要資料庫:CRUD、短碼前綴查詢、共享 vs 個人可見性、租戶隔離;
   若 settings.database_url 無法連線(或缺 pgvector)則自動跳過。
"""
from __future__ import annotations

import uuid

import pytest

# ============================ 一律執行:純單元 ============================

def test_serialize_shared_flag():
    from app.api.v1.canned import _serialize
    from app.models.canned import CannedResponse

    shared = CannedResponse(
        tenant_id=uuid.uuid4(),
        title="問候",
        shortcut="hi",
        content="您好 {{visitor_name}}",
        owner_staff_id=None,
    )
    out = _serialize(shared)
    assert out["shared"] is True
    assert out["owner_staff_id"] is None
    # 變數佔位原樣保存,後端不替換
    assert out["content"] == "您好 {{visitor_name}}"

    staff_id = uuid.uuid4()
    personal = CannedResponse(
        tenant_id=uuid.uuid4(),
        title="我的",
        shortcut="me",
        content="x",
        owner_staff_id=staff_id,
    )
    p = _serialize(personal)
    assert p["shared"] is False
    assert p["owner_staff_id"] == str(staff_id)


# ============================ 需要資料庫:整合測試 ============================

async def _engine_or_skip():
    from sqlalchemy.ext.asyncio import create_async_engine

    import app.models  # noqa: F401  確保所有 model 已註冊(含 canned)
    from app.core.config import settings
    from app.core.db import Base

    engine = create_async_engine(settings.database_url)
    try:
        from sqlalchemy import text

        async with engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.run_sync(Base.metadata.create_all)
    except Exception as exc:  # noqa: BLE001
        await engine.dispose()
        pytest.skip(f"資料庫不可用,跳過整合測試:{exc}")
    return engine


async def _seed(engine):
    """建立租戶 + 兩名坐席,回傳 id 們。"""
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from app.models.iam import Staff
    from app.models.tenancy import Tenant

    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as db:
        tenant = Tenant(name="t", slug=f"t-{uuid.uuid4().hex[:8]}")
        db.add(tenant)
        await db.flush()
        s1 = Staff(
            tenant_id=tenant.id,
            email=f"{uuid.uuid4().hex[:8]}@x.com",
            password_hash="x",
            display_name="A1",
        )
        s2 = Staff(
            tenant_id=tenant.id,
            email=f"{uuid.uuid4().hex[:8]}@x.com",
            password_hash="x",
            display_name="A2",
        )
        db.add_all([s1, s2])
        await db.commit()
        return {"tenant_id": tenant.id, "staff1": s1.id, "staff2": s2.id}


def _token(staff_id, tenant_id) -> str:
    from app.core.security import create_access_token

    return create_access_token(
        {"sub": str(staff_id), "tenant_id": str(tenant_id), "roles": ["admin"]}
    )


async def _client(engine):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from app.api.v1 import canned
    from app.core.db import get_db

    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _get_db():
        async with maker() as s:
            yield s

    app = FastAPI()
    app.include_router(canned.router, prefix="/api/v1/canned")
    app.dependency_overrides[get_db] = _get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_crud_and_prefix_query():
    engine = await _engine_or_skip()
    try:
        ids = await _seed(engine)
        h1 = {"Authorization": f"Bearer {_token(ids['staff1'], ids['tenant_id'])}"}
        async with await _client(engine) as c:
            # 建立個人罐頭
            r = await c.post(
                "/api/v1/canned",
                json={"title": "歡迎", "shortcut": "welcome", "content": "嗨 {{visitor_name}}"},
                headers=h1,
            )
            assert r.status_code == 200 and r.json()["ok"] is True
            cid = r.json()["data"]["id"]
            assert r.json()["data"]["shared"] is False
            assert r.json()["data"]["content"] == "嗨 {{visitor_name}}"

            # 建立共享罐頭
            r = await c.post(
                "/api/v1/canned",
                json={"title": "退款", "shortcut": "refund", "content": "退款流程...", "shared": True},
                headers=h1,
            )
            assert r.json()["data"]["shared"] is True

            # 前綴查詢:`/wel` → 命中 welcome
            r = await c.get("/api/v1/canned?shortcut_prefix=wel", headers=h1)
            items = r.json()["data"]["items"]
            assert len(items) == 1 and items[0]["shortcut"] == "welcome"

            # 讀取單筆
            r = await c.get(f"/api/v1/canned/{cid}", headers=h1)
            assert r.json()["data"]["title"] == "歡迎"

            # 更新
            r = await c.patch(f"/api/v1/canned/{cid}", json={"title": "歡迎詞"}, headers=h1)
            assert r.json()["data"]["title"] == "歡迎詞"

            # 短碼衝突(同擁有者範圍)→ conflict
            r = await c.post(
                "/api/v1/canned",
                json={"title": "重複", "shortcut": "welcome", "content": "x"},
                headers=h1,
            )
            assert r.json()["ok"] is False and r.json()["error"]["code"] == "conflict"

            # 軟刪
            r = await c.delete(f"/api/v1/canned/{cid}", headers=h1)
            assert r.json()["data"]["deleted"] is True
            r = await c.get(f"/api/v1/canned/{cid}", headers=h1)
            assert r.json()["ok"] is False
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_visibility_shared_vs_personal():
    """坐席看得到共享 + 自己的私人,看不到別人的私人。"""
    engine = await _engine_or_skip()
    try:
        ids = await _seed(engine)
        h1 = {"Authorization": f"Bearer {_token(ids['staff1'], ids['tenant_id'])}"}
        h2 = {"Authorization": f"Bearer {_token(ids['staff2'], ids['tenant_id'])}"}
        async with await _client(engine) as c:
            # staff1 建個人 + 共享
            await c.post(
                "/api/v1/canned",
                json={"title": "私人1", "shortcut": "p1", "content": "x"},
                headers=h1,
            )
            await c.post(
                "/api/v1/canned",
                json={"title": "共享", "shortcut": "sh", "content": "x", "shared": True},
                headers=h1,
            )

            # staff2 看得到共享,但看不到 staff1 的私人
            r = await c.get("/api/v1/canned", headers=h2)
            shortcuts = {i["shortcut"] for i in r.json()["data"]["items"]}
            assert "sh" in shortcuts
            assert "p1" not in shortcuts

            # staff1 兩者皆可見
            r = await c.get("/api/v1/canned", headers=h1)
            shortcuts = {i["shortcut"] for i in r.json()["data"]["items"]}
            assert {"sh", "p1"} <= shortcuts

            # scope=mine 只回自己私人;scope=shared 只回共享
            r = await c.get("/api/v1/canned?scope=mine", headers=h1)
            assert {i["shortcut"] for i in r.json()["data"]["items"]} == {"p1"}
            r = await c.get("/api/v1/canned?scope=shared", headers=h1)
            assert {i["shortcut"] for i in r.json()["data"]["items"]} == {"sh"}
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_tenant_isolation():
    engine = await _engine_or_skip()
    try:
        ids = await _seed(engine)
        h1 = {"Authorization": f"Bearer {_token(ids['staff1'], ids['tenant_id'])}"}
        other = {"Authorization": f"Bearer {_token(uuid.uuid4(), uuid.uuid4())}"}
        async with await _client(engine) as c:
            r = await c.post(
                "/api/v1/canned",
                json={"title": "共享", "shortcut": "x", "content": "x", "shared": True},
                headers=h1,
            )
            cid = r.json()["data"]["id"]
            # 別的租戶看不到、取不到
            r = await c.get("/api/v1/canned", headers=other)
            assert r.json()["data"]["total"] == 0
            r = await c.get(f"/api/v1/canned/{cid}", headers=other)
            assert r.json()["ok"] is False
    finally:
        await engine.dispose()
