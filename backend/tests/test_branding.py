"""白牌自訂網域 + 依網域解析品牌 的測試。

分三層:
1) normalize_host 純函式測試 —— 不依賴 DB / 網路,一定會跑。
2) 公開品牌解析(mock DB)—— 以假的 DbSession 覆寫 get_db,驗證「找到回租戶品牌 /
   找不到回預設 / 無 host 回預設」,不需真資料庫。
3) 網域管理(真測試 DB)—— 綁定/列表/驗證(pending)/解綁,比照 test_iam 的 skip 慣例:
   連不上 DB 就整段 skip(需 PostgreSQL,因 JSONB/UUID)。
"""
from __future__ import annotations

import os
import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.api.v1.branding import normalize_host

TEST_DB_URL = (
    os.getenv("KEFU_TEST_DATABASE_URL")
    or os.getenv("KEFU_DATABASE_URL")
    or "postgresql+asyncpg://kefu:kefu@localhost:5432/kefu"
)


def _suffix() -> str:
    return uuid.uuid4().hex[:8]


# --------------------------------------------------------------------------- #
# 1) normalize_host 純函式
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Support.ClientA.com", "support.clienta.com"),          # 小寫
        ("www.example.com", "example.com"),                       # 去 www.
        ("support.clienta.com:8443", "support.clienta.com"),      # 去 port
        ("https://www.Support.ClientA.com:443/path?x=1", "support.clienta.com"),  # 全套
        ("HTTP://example.com/", "example.com"),                   # scheme + 尾斜線
        ("example.com.", "example.com"),                          # 去 FQDN 尾點
        ("user:pass@host.example.com", "host.example.com"),       # 去 userinfo
        ("  Support.ClientA.com  ", "support.clienta.com"),       # 去空白
        ("www.WWW.com", "www.com"),                               # 僅去開頭一個 www.
        ("", ""),                                                  # 空字串
        (None, ""),                                                # None
    ],
)
def test_normalize_host(raw, expected):
    assert normalize_host(raw) == expected


# --------------------------------------------------------------------------- #
# 2) 公開品牌解析(mock DB,無需真資料庫)
# --------------------------------------------------------------------------- #
class _FakeResult:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _FakeDB:
    """依呼叫順序回傳預先排好的結果(resolve_branding 最多查兩次:先 domain 再 tenant)。"""

    def __init__(self, results):
        self._results = list(results)
        self._i = 0

    async def execute(self, _stmt):
        r = self._results[self._i]
        self._i += 1
        return _FakeResult(r)


def _make_client(results):
    """建一個只掛 public_router 的 app,並把 get_db 覆寫成回傳排定結果的 _FakeDB。"""
    from fastapi import FastAPI

    from app.api.v1 import branding as branding_api
    from app.core.db import get_db

    app = FastAPI()
    app.include_router(branding_api.public_router, prefix="/api/v1/public")

    async def _override_get_db():
        yield _FakeDB(results)

    app.dependency_overrides[get_db] = _override_get_db
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


@pytest.mark.asyncio
async def test_resolve_branding_found():
    """host 命中 TenantDomain → 回該租戶品牌(取自 Tenant.branding + name/slug)。"""
    from app.models.tenancy import Tenant, TenantDomain

    tenant = Tenant(
        name="Client A Inc",
        slug="client-a",
        branding={
            "brand_name": "ClientA 客服中心",
            "logo_url": "https://cdn.clienta.com/logo.png",
            "primary_color": "#ff6600",
            "extra_token": "keep-me",
        },
        is_active=True,
    )
    domain = TenantDomain(tenant_id=uuid.uuid4(), domain="support.clienta.com", verified=True)

    async with _make_client([domain, tenant]) as client:
        resp = await client.get("/api/v1/public/branding", params={"host": "https://Support.ClientA.com:443/x"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    data = body["data"]
    assert data["is_default"] is False
    assert data["tenant_slug"] == "client-a"
    assert data["name"] == "ClientA 客服中心"           # brand_name 優先於 tenant.name
    assert data["logo_url"] == "https://cdn.clienta.com/logo.png"
    assert data["primary_color"] == "#ff6600"
    assert data["branding"]["extra_token"] == "keep-me"  # 完整白牌設定回傳
    assert data["verified"] is True


@pytest.mark.asyncio
async def test_resolve_branding_not_found_returns_default():
    """host 查無對應網域 → 回 kefu 預設品牌,HTTP 200 不報錯。"""
    async with _make_client([None]) as client:  # domain 查無,不會再查 tenant
        resp = await client.get("/api/v1/public/branding", params={"host": "unknown.example.com"})
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["is_default"] is True
    assert data["tenant_slug"] is None
    assert data["name"] == "kefu"
    assert data["primary_color"] == "#2563eb"


@pytest.mark.asyncio
async def test_resolve_branding_no_host_returns_default():
    """未帶 host → 直接回預設品牌(不查 DB)。"""
    async with _make_client([]) as client:  # 不應查 DB
        resp = await client.get("/api/v1/public/branding")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["is_default"] is True
    assert data["name"] == "kefu"


@pytest.mark.asyncio
async def test_resolve_branding_inactive_tenant_returns_default():
    """網域命中但租戶停用 → 回預設品牌。"""
    from app.models.tenancy import Tenant, TenantDomain

    tenant = Tenant(name="Off", slug="off", branding={}, is_active=False)
    domain = TenantDomain(tenant_id=uuid.uuid4(), domain="off.example.com", verified=True)
    async with _make_client([domain, tenant]) as client:
        resp = await client.get("/api/v1/public/branding", params={"host": "off.example.com"})
    data = resp.json()["data"]
    assert data["is_default"] is True


# --------------------------------------------------------------------------- #
# 3) 網域管理(真測試 DB;連不上則 skip)
# --------------------------------------------------------------------------- #
@pytest_asyncio.fixture
async def ctx():
    """建測試 app(掛 public + 管理兩個 router)+ 一個租戶與 admin token。"""
    from fastapi import FastAPI
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.api.v1 import branding as branding_api
    from app.core.db import Base, get_db
    from app.core.security import create_access_token
    from app.models.tenancy import Tenant, TenantDomain

    my_tables = [Tenant.__table__, TenantDomain.__table__]

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
        tenant = Tenant(
            name="Acme",
            slug=f"acme-{_suffix()}",
            branding={"brand_name": "Acme 客服", "primary_color": "#0af"},
            is_active=True,
        )
        db.add(tenant)
        await db.commit()
        tenant_id = tenant.id

    app = FastAPI()
    app.include_router(branding_api.public_router, prefix="/api/v1/public")
    app.include_router(branding_api.router, prefix="/api/v1/branding")

    async def _override_get_db():
        async with Session() as s:
            yield s

    app.dependency_overrides[get_db] = _override_get_db
    token = create_access_token(
        {"sub": str(uuid.uuid4()), "tenant_id": str(tenant_id), "roles": ["admin"]}
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client.headers["Authorization"] = f"Bearer {token}"
        yield client, tenant_id

    await engine.dispose()


@pytest.mark.asyncio
async def test_bind_list_verify_unbind_flow(ctx):
    client, tenant_id = ctx
    domain = f"support-{_suffix()}.clienta.com"

    # 綁定(帶大小寫/port,應被正規化)
    bind = (
        await client.post(
            "/api/v1/branding/domains",
            json={"domain": f"WWW.{domain}:8443", "is_primary": True},
        )
    ).json()
    assert bind["ok"] is True, bind
    d = bind["data"]
    assert d["domain"] == domain           # 已去 www./port/小寫
    assert d["is_primary"] is True
    assert d["verified"] is False
    assert d["verify_token"]
    assert d["dns_instructions"]["txt"]["host"] == f"_kefu-verify.{domain}"
    domain_id = d["id"]

    # 查重(同網域再綁 → 失敗)
    dup = (
        await client.post("/api/v1/branding/domains", json={"domain": domain})
    ).json()
    assert dup["ok"] is False
    assert dup["error"]["code"] == "DOMAIN_TAKEN"

    # 格式錯誤
    bad = (await client.post("/api/v1/branding/domains", json={"domain": "nodot"})).json()
    assert bad["error"]["code"] == "DOMAIN_INVALID"

    # 列表
    listed = (await client.get("/api/v1/branding/domains")).json()["data"]
    assert listed["total"] == 1
    assert listed["items"][0]["id"] == domain_id
    assert listed["items"][0]["verified"] is False
    assert listed["items"][0]["dns_instructions"]["cname"]["value"]  # 未驗證附 DNS 指示

    # 驗證(未安裝 dnspython 或查無 TXT → pending,不報錯)
    verify = (await client.post(f"/api/v1/branding/domains/{domain_id}/verify")).json()
    assert verify["ok"] is True
    assert verify["data"]["verified"] is False
    assert verify["data"]["status"] == "pending"

    # 公開解析:此網域命中本租戶品牌
    pub = (
        await client.get("/api/v1/public/branding", params={"host": domain})
    ).json()["data"]
    assert pub["is_default"] is False
    assert pub["tenant_slug"].startswith("acme-")
    assert pub["name"] == "Acme 客服"
    assert pub["primary_color"] == "#0af"

    # 解綁 → 可再綁同網域(硬刪釋放)
    dele = (await client.delete(f"/api/v1/branding/domains/{domain_id}")).json()
    assert dele["data"]["deleted"] is True
    rebind = (
        await client.post("/api/v1/branding/domains", json={"domain": domain})
    ).json()
    assert rebind["ok"] is True

    # 解綁後,公開解析回預設品牌(原 domain_id 已不存在;新綁的 domain 仍在,故用不同網域測)
    gone = (
        await client.get(
            "/api/v1/public/branding", params={"host": f"never-{_suffix()}.example.com"}
        )
    ).json()["data"]
    assert gone["is_default"] is True


@pytest.mark.asyncio
async def test_domain_tenant_isolation(ctx):
    """他租戶的網域不可被本租戶 verify/刪除。"""
    client, _ = ctx
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.models.tenancy import Tenant, TenantDomain

    engine = create_async_engine(TEST_DB_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as db:
        other = Tenant(name="Other", slug=f"other-{_suffix()}", is_active=True)
        db.add(other)
        await db.flush()
        d = TenantDomain(
            tenant_id=other.id, domain=f"other-{_suffix()}.example.com", verify_token="x"
        )
        db.add(d)
        await db.commit()
        other_domain_id = d.id
    await engine.dispose()

    # 本租戶(A)嘗試驗證 B 的網域 → 查無(被 tenant_id 過濾)
    resp = (await client.post(f"/api/v1/branding/domains/{other_domain_id}/verify")).json()
    assert resp["ok"] is False
    assert resp["error"]["code"] == "DOMAIN_NOT_FOUND"
    # 刪除亦然
    dele = (await client.delete(f"/api/v1/branding/domains/{other_domain_id}")).json()
    assert dele["error"]["code"] == "DOMAIN_NOT_FOUND"
