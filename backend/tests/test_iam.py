"""M1 tenancy + M2 iam 的 API 測試。

設計:不依賴 app/main.py 的 lifespan(避免 CREATE EXTENSION vector),
自組一個只掛本模組 router 的 FastAPI app,並覆寫 get_db 指向測試 DB。

測試 DB:優先讀 KEFU_TEST_DATABASE_URL,否則 KEFU_DATABASE_URL,否則本機預設。
連不上時整檔 skip(本模組表用到 JSONB/UUID,需 PostgreSQL;正式測試在遠端伺服器)。
"""
from __future__ import annotations

import os
import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

TEST_DB_URL = (
    os.getenv("KEFU_TEST_DATABASE_URL")
    or os.getenv("KEFU_DATABASE_URL")
    or "postgresql+asyncpg://kefu:kefu@localhost:5432/kefu"
)


def _suffix() -> str:
    return uuid.uuid4().hex[:8]


@pytest_asyncio.fixture
async def ctx():
    """建置測試 app + 一個租戶與 admin 坐席,回傳 (client, tenant_id, admin_id)。"""
    from fastapi import FastAPI
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.api.v1 import iam as iam_api
    from app.api.v1 import tenancy as tenancy_api
    from app.core.db import Base, get_db
    from app.core.security import create_access_token, hash_password
    from app.models.iam import (
        Permission,
        Role,
        SkillGroup,
        Staff,
        role_permission,
        staff_role,
        staff_skillgroup,
    )
    from app.models.tenancy import Organization, Tenant

    my_tables = [
        Tenant.__table__,
        Organization.__table__,
        Staff.__table__,
        Role.__table__,
        Permission.__table__,
        SkillGroup.__table__,
        staff_role,
        role_permission,
        staff_skillgroup,
    ]

    engine = create_async_engine(TEST_DB_URL)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(
                lambda c: Base.metadata.create_all(c, tables=my_tables, checkfirst=True)
            )
    except Exception as exc:  # DB 連不上 → skip
        await engine.dispose()
        pytest.skip(f"測試資料庫不可用: {exc}")

    Session = async_sessionmaker(engine, expire_on_commit=False)

    async with Session() as db:
        tenant = Tenant(name="Acme", slug=f"acme-{_suffix()}", is_active=True)
        db.add(tenant)
        await db.flush()
        admin = Staff(
            tenant_id=tenant.id,
            email=f"admin-{_suffix()}@acme.local",
            password_hash=hash_password("admin123"),
            display_name="Admin",
            status="offline",
            is_active=True,
        )
        db.add(admin)
        await db.commit()
        tenant_id, admin_id = tenant.id, admin.id

    app = FastAPI()
    app.include_router(tenancy_api.router, prefix="/api/v1/tenancy")
    app.include_router(iam_api.router, prefix="/api/v1/iam")

    async def _override_get_db():
        async with Session() as s:
            yield s

    app.dependency_overrides[get_db] = _override_get_db

    token = create_access_token(
        {"sub": str(admin_id), "tenant_id": str(tenant_id), "roles": ["admin"]}
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client.headers["Authorization"] = f"Bearer {token}"
        yield client, tenant_id, admin_id

    await engine.dispose()


# --------------------------------------------------------------------------- #
# 租戶:白牌 + BYO-Key 遮罩
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_tenant_branding_and_llm_masking(ctx):
    client, tenant_id, _ = ctx
    resp = await client.patch(
        f"/api/v1/tenancy/tenants/{tenant_id}",
        json={
            "branding": {"brand_name": "Acme 客服", "theme_color": "#0af", "subdomain": "acme"},
            "llm_config": {"provider": "openai", "api_key": "sk-secret-1234", "model": "gpt-5.5"},
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    # 白牌原樣保留
    assert data["branding"]["brand_name"] == "Acme 客服"
    # api_key 被遮罩、保留尾 4 碼;其餘欄位照常
    assert data["llm_config"]["api_key"] == "****1234"
    assert data["llm_config"]["provider"] == "openai"

    # 再次讀取仍為遮罩
    me = (await client.get("/api/v1/tenancy/tenants/me")).json()["data"]
    assert me["llm_config"]["api_key"] == "****1234"


# --------------------------------------------------------------------------- #
# 組織樹
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_organization_tree_and_cycle_guard(ctx):
    client, _, _ = ctx
    root = (
        await client.post("/api/v1/tenancy/organizations", json={"name": "總部"})
    ).json()["data"]
    child = (
        await client.post(
            "/api/v1/tenancy/organizations",
            json={"name": "客服部", "parent_id": root["id"]},
        )
    ).json()["data"]
    assert child["parent_id"] == root["id"]

    tree = (
        await client.get("/api/v1/tenancy/organizations", params={"tree": "true"})
    ).json()["data"]
    assert tree["total"] == 2
    assert tree["tree"][0]["children"][0]["id"] == child["id"]

    # 防環:把 root 掛到 child 底下應被拒
    cyc = await client.patch(
        f"/api/v1/tenancy/organizations/{root['id']}", json={"parent_id": child["id"]}
    )
    assert cyc.json()["ok"] is False
    assert cyc.json()["error"]["code"] == "ORG_CYCLE"


# --------------------------------------------------------------------------- #
# 坐席 CRUD + 改密碼 + 狀態
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_staff_crud_password_status(ctx):
    client, _, _ = ctx
    email = f"agent-{_suffix()}@acme.local"
    created = (
        await client.post(
            "/api/v1/iam/staff",
            json={"email": email, "password": "pass1234", "display_name": "客服小明"},
        )
    ).json()["data"]
    sid = created["id"]
    assert "password_hash" not in created  # 絕不外洩雜湊

    listed = (await client.get("/api/v1/iam/staff", params={"q": "小明"})).json()["data"]
    assert listed["total"] >= 1 and any(i["id"] == sid for i in listed["items"])

    # 改密碼
    pw = await client.post(f"/api/v1/iam/staff/{sid}/password", json={"new_password": "newpass1"})
    assert pw.json()["data"]["password_changed"] is True

    # 狀態:非法值被拒、合法值成功
    bad = await client.patch(f"/api/v1/iam/staff/{sid}/status", json={"status": "dancing"})
    assert bad.json()["error"]["code"] == "STAFF_INVALID_STATUS"
    good = await client.patch(f"/api/v1/iam/staff/{sid}/status", json={"status": "online"})
    assert good.json()["data"]["status"] == "online"

    # 軟刪
    dele = await client.delete(f"/api/v1/iam/staff/{sid}")
    assert dele.json()["data"]["deleted"] is True
    assert (await client.get(f"/api/v1/iam/staff/{sid}")).json()["error"]["code"] == "STAFF_NOT_FOUND"


# --------------------------------------------------------------------------- #
# RBAC:權限種子 + 角色綁權限 + 指派角色
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_rbac_roles_permissions(ctx):
    client, _, _ = ctx
    seeded = (await client.post("/api/v1/iam/permissions/seed")).json()["data"]
    assert seeded["created"] > 0
    perms = (await client.get("/api/v1/iam/permissions")).json()["data"]
    codes = {p["code"] for p in perms["items"]}
    assert {"tenant.manage", "conversation.assign", "report.view"} <= codes

    role = (
        await client.post(
            "/api/v1/iam/roles",
            json={
                "name": f"supervisor-{_suffix()}",
                "description": "組長",
                "permission_codes": ["conversation.view", "report.view"],
            },
        )
    ).json()["data"]
    assert set(role["permissions"]) == {"conversation.view", "report.view"}

    # 綁未知權限碼 → 失敗
    bad = await client.put(
        f"/api/v1/iam/roles/{role['id']}/permissions", json={"codes": ["nope.nope"]}
    )
    assert bad.json()["error"]["code"] == "PERMISSION_NOT_FOUND"

    # 覆寫權限
    upd = await client.put(
        f"/api/v1/iam/roles/{role['id']}/permissions", json={"codes": ["report.view"]}
    )
    assert upd.json()["data"]["permissions"] == ["report.view"]

    # 指派角色給坐席
    staff = (
        await client.post(
            "/api/v1/iam/staff",
            json={
                "email": f"a-{_suffix()}@acme.local",
                "password": "pass1234",
                "display_name": "A",
            },
        )
    ).json()["data"]
    assigned = await client.put(
        f"/api/v1/iam/staff/{staff['id']}/roles", json={"role_ids": [role["id"]]}
    )
    assert [r["id"] for r in assigned.json()["data"]["roles"]] == [role["id"]]


# --------------------------------------------------------------------------- #
# 技能組成員
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_skillgroup_membership(ctx):
    client, _, _ = ctx
    group = (
        await client.post("/api/v1/iam/skill-groups", json={"name": f"VIP-{_suffix()}"})
    ).json()["data"]
    staff = (
        await client.post(
            "/api/v1/iam/staff",
            json={
                "email": f"m-{_suffix()}@acme.local",
                "password": "pass1234",
                "display_name": "M",
            },
        )
    ).json()["data"]

    added = await client.post(
        f"/api/v1/iam/skill-groups/{group['id']}/members", json={"staff_ids": [staff["id"]]}
    )
    assert any(m["id"] == staff["id"] for m in added.json()["data"]["members"])

    removed = await client.delete(
        f"/api/v1/iam/skill-groups/{group['id']}/members/{staff['id']}"
    )
    assert removed.json()["data"]["members"] == []


# --------------------------------------------------------------------------- #
# 租戶隔離:不可讀到別租戶的組織
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_tenant_isolation(ctx):
    client, tenant_id, _ = ctx
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models.tenancy import Organization, Tenant

    engine = create_async_engine(TEST_DB_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as db:
        other = Tenant(name="Other", slug=f"other-{_suffix()}", is_active=True)
        db.add(other)
        await db.flush()
        org_b = Organization(tenant_id=other.id, name="他租戶部門")
        db.add(org_b)
        await db.commit()
        org_b_id = org_b.id
    await engine.dispose()

    # 用 A 租戶的 admin token 讀 B 租戶的組織 → 查無(被 tenant_id 過濾)
    resp = await client.get(f"/api/v1/tenancy/organizations/{org_b_id}")
    assert resp.json()["ok"] is False
    assert resp.json()["error"]["code"] == "ORG_NOT_FOUND"
