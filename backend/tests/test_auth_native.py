"""原生 App 認證改造測試(docs/NATIVE-CLIENTS.md §4.1)。

涵蓋:
- 登入:email 不分大小寫、選填 tenant slug、多租戶同密碼回 requires_tenant_selection
  (密碼不符時不揭露租戶)、新限流鍵 login:{ip}:{email} / login-ip:{ip}。
- /auth/me 回 tenant{id,name,slug};邀請 / 重設連結回絕對網址 invite_link / reset_link;
  忘記密碼 email 不分大小寫。
- Google OAuth:Web 流程 state + cookie 防 login CSRF;原生 PKCE(client=native)起點驗證、
  回呼發一次性 code、/sso/exchange 兌換(sha256 驗證、單次使用、重新驗帳號/租戶/IP/2FA、限流)。
- SAML:原生 RelayState nonce → 一次性 code;既有 Web ACS 行為不變。

跑在記憶體 SQLite(StaticPool)+ 型別 shim;Redis 以假物件經 realtime.set_client 注入。
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import uuid
from urllib.parse import parse_qs, urlparse

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.pool import StaticPool


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(type_, compiler, **kw):  # noqa: ANN001, ANN201
    return "TEXT"


@compiles(PGUUID, "sqlite")
def _compile_uuid_sqlite(type_, compiler, **kw):  # noqa: ANN001, ANN201
    return "CHAR(32)"


from app.api.v1 import auth as auth_api  # noqa: E402
from app.api.v1 import saml as saml_api  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.core.db import Base, get_db  # noqa: E402
from app.core.security import create_access_token, decode_access_token, hash_password  # noqa: E402
import app.models  # noqa: E402,F401
from app.models.iam import Permission, Role, Staff, role_permission, staff_role  # noqa: E402
from app.models.settings import TenantSettings  # noqa: E402
from app.models.sso import TenantSSOConfig  # noqa: E402
from app.models.tenancy import Organization, Tenant  # noqa: E402
from app.services import realtime  # noqa: E402

_TABLES = [
    Tenant.__table__,
    Organization.__table__,
    Staff.__table__,
    Role.__table__,
    Permission.__table__,
    staff_role,
    role_permission,
    TenantSettings.__table__,
    TenantSSOConfig.__table__,
]

NATIVE_REDIRECT = "kefu://auth/callback"


# =========================================================================== #
# 假 Redis:限流(incr/expire)+ SSO 暫存(set/get/getdel)
# =========================================================================== #
class _FakeRedis:
    def __init__(self):
        self.store: dict[str, str] = {}
        self.counters: dict[str, int] = {}
        self.ttl: dict[str, int] = {}

    async def incr(self, key):  # noqa: ANN001
        self.counters[key] = self.counters.get(key, 0) + 1
        return self.counters[key]

    async def expire(self, key, seconds):  # noqa: ANN001
        self.ttl[key] = seconds
        return True

    async def set(self, key, value, ex=None, nx=False):  # noqa: ANN001
        if nx and key in self.store:
            return None
        self.store[key] = value
        if ex is not None:
            self.ttl[key] = ex
        return True

    async def get(self, key):  # noqa: ANN001
        return self.store.get(key)

    async def getdel(self, key):  # noqa: ANN001
        return self.store.pop(key, None)

    async def publish(self, channel, data):  # noqa: ANN001
        return 0


class _BrokenRedis:
    async def _boom(self, *a, **kw):  # noqa: ANN002, ANN003
        raise ConnectionError("redis down")

    incr = expire = set = get = getdel = publish = _boom


@pytest.fixture(autouse=True)
def fake_redis():
    fake = _FakeRedis()
    realtime.set_client(fake)
    yield fake
    realtime.set_client(None)


@pytest.fixture(autouse=True)
def _sso_env(monkeypatch):
    monkeypatch.delenv("KEFU_FRONTEND_BASE", raising=False)
    monkeypatch.delenv("KEFU_GOOGLE_REDIRECT", raising=False)
    monkeypatch.setenv("KEFU_GOOGLE_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("KEFU_GOOGLE_CLIENT_SECRET", "test-client-secret")
    monkeypatch.setattr(settings, "native_redirect_uris", NATIVE_REDIRECT)


@pytest_asyncio.fixture
async def env():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=_TABLES))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(auth_api.router, prefix="/api/v1/auth")
    app.include_router(saml_api.router, prefix="/api/v1/saml")

    async def _override_get_db():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_db] = _override_get_db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client, factory
    await engine.dispose()


async def _tenant(factory, name: str, slug: str, *, active: bool = True) -> uuid.UUID:
    async with factory() as db:
        t = Tenant(name=name, slug=slug, is_active=active)
        db.add(t)
        await db.commit()
        return t.id


async def _staff(factory, tenant_id, email: str, password: str = "secret123", **kw) -> uuid.UUID:
    async with factory() as db:
        s = Staff(
            tenant_id=tenant_id,
            email=email,
            password_hash=hash_password(password),
            display_name=email,
            status="offline",
            is_active=kw.pop("is_active", True),
            **kw,
        )
        db.add(s)
        await db.commit()
        return s.id


async def _update_staff(factory, staff_id, **values) -> None:
    async with factory() as db:
        row = await db.get(Staff, staff_id)
        for k, v in values.items():
            setattr(row, k, v)
        await db.commit()


async def _set_policy(factory, tenant_id, *, require_2fa=False, allowlist=None) -> None:
    async with factory() as db:
        db.add(
            TenantSettings(tenant_id=tenant_id, require_2fa=require_2fa, login_ip_allowlist=allowlist)
        )
        await db.commit()


def _pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


def _qs(location: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlparse(location).query).items()}


# =========================================================================== #
# 登入:email 不分大小寫 / tenant slug / 多租戶選擇 / 限流
# =========================================================================== #
@pytest.mark.asyncio
async def test_login_email_case_insensitive(env):
    client, factory = env
    tid = await _tenant(factory, "Acme", "acme")
    sid = await _staff(factory, tid, "Alice@Example.com")

    r = await client.post("/api/v1/auth/login", json={"email": "  alice@EXAMPLE.com ", "password": "secret123"})
    body = r.json()
    assert r.status_code == 200 and body["ok"] is True
    assert body["data"]["staff_id"] == str(sid)
    assert decode_access_token(body["data"]["access_token"])["tenant_id"] == str(tid)


@pytest.mark.asyncio
async def test_login_multi_tenant_requires_selection_then_tenant(env):
    client, factory = env
    t1 = await _tenant(factory, "Beta Co", "beta")
    t2 = await _tenant(factory, "Alpha Co", "alpha")
    await _staff(factory, t1, "bob@example.com")
    s2 = await _staff(factory, t2, "BOB@example.com")

    r = await client.post("/api/v1/auth/login", json={"email": "bob@example.com", "password": "secret123"})
    data = r.json()["data"]
    assert r.status_code == 200
    assert data["requires_tenant_selection"] is True
    assert "access_token" not in data
    # 依租戶名排序、只含 slug/name
    assert data["tenants"] == [{"slug": "alpha", "name": "Alpha Co"}, {"slug": "beta", "name": "Beta Co"}]

    r = await client.post(
        "/api/v1/auth/login",
        json={"email": "bob@example.com", "password": "secret123", "tenant": "ALPHA"},
    )
    data = r.json()["data"]
    assert data["staff_id"] == str(s2)
    assert decode_access_token(data["access_token"])["tenant_id"] == str(t2)


@pytest.mark.asyncio
async def test_login_wrong_password_never_reveals_tenants(env):
    client, factory = env
    t1 = await _tenant(factory, "One", "one")
    t2 = await _tenant(factory, "Two", "two")
    await _staff(factory, t1, "carol@example.com")
    await _staff(factory, t2, "carol@example.com")

    r = await client.post("/api/v1/auth/login", json={"email": "carol@example.com", "password": "wrong"})
    assert r.status_code == 401
    assert "tenants" not in r.text and "one" not in json.dumps(r.json().get("data"))


@pytest.mark.asyncio
async def test_login_password_disambiguates_and_tenant_filter(env):
    client, factory = env
    t1 = await _tenant(factory, "One", "one")
    t2 = await _tenant(factory, "Two", "two")
    await _staff(factory, t1, "dan@example.com", password="pw-one-111")
    s2 = await _staff(factory, t2, "dan@example.com", password="pw-two-222")

    # 密碼只在一個租戶正確 → 直接登入,不需選擇
    r = await client.post("/api/v1/auth/login", json={"email": "dan@example.com", "password": "pw-two-222"})
    assert r.json()["data"]["staff_id"] == str(s2)

    # 指定 tenant 時只在該租戶比對:密碼屬於別的租戶 → 401
    r = await client.post(
        "/api/v1/auth/login",
        json={"email": "dan@example.com", "password": "pw-two-222", "tenant": "one"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_login_selection_skips_suspended_tenant(env):
    client, factory = env
    t1 = await _tenant(factory, "Live", "live")
    t2 = await _tenant(factory, "Dead", "dead", active=False)
    s1 = await _staff(factory, t1, "erin@example.com")
    await _staff(factory, t2, "erin@example.com")
    r = await client.post("/api/v1/auth/login", json={"email": "erin@example.com", "password": "secret123"})
    assert r.json()["data"]["staff_id"] == str(s1)


@pytest.mark.asyncio
async def test_login_rate_limit_keys(env, fake_redis):
    client, factory = env
    tid = await _tenant(factory, "Acme", "acme")
    await _staff(factory, tid, "frank@example.com")

    for _ in range(10):
        r = await client.post("/api/v1/auth/login", json={"email": "Frank@example.com", "password": "bad"})
        assert r.status_code == 401
    r = await client.post("/api/v1/auth/login", json={"email": "frank@example.com", "password": "secret123"})
    assert r.status_code == 429

    ip = "127.0.0.1"
    assert fake_redis.counters[f"rl:login:{ip}:frank@example.com"] == 11
    assert fake_redis.ttl[f"rl:login:{ip}:frank@example.com"] == 300
    assert fake_redis.counters[f"rl:login-ip:{ip}"] == 11

    # 其他 email 不受單帳號限流影響(IP 上限 200)
    r = await client.post("/api/v1/auth/login", json={"email": "other@example.com", "password": "x"})
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_login_ip_limit_200(env, fake_redis):
    client, _ = env
    fake_redis.counters["rl:login-ip:127.0.0.1"] = 200
    r = await client.post("/api/v1/auth/login", json={"email": "x@example.com", "password": "x"})
    assert r.status_code == 429


# =========================================================================== #
# /me、邀請 / 重設連結、忘記密碼
# =========================================================================== #
def _auth_headers(staff_id, tenant_id, roles=("admin",)) -> dict:
    token = create_access_token({"sub": str(staff_id), "tenant_id": str(tenant_id), "roles": list(roles)})
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_me_includes_tenant(env):
    client, factory = env
    tid = await _tenant(factory, "Acme Inc", "acme")
    sid = await _staff(factory, tid, "gina@example.com")
    r = await client.get("/api/v1/auth/me", headers=_auth_headers(sid, tid))
    data = r.json()["data"]
    assert data["tenant"] == {"id": str(tid), "name": "Acme Inc", "slug": "acme"}
    assert data["email"] == "gina@example.com"


@pytest.mark.asyncio
async def test_invite_and_reset_links_absolute(env, monkeypatch):
    client, factory = env
    tid = await _tenant(factory, "Acme", "acme")
    sid = await _staff(factory, tid, "admin@example.com")
    async with factory() as db:
        db.add(Role(tenant_id=tid, name="agent", is_system=True))
        await db.commit()

    sent: list[str] = []

    async def _fake_invite_email(db, staff, link):  # noqa: ANN001
        sent.append(link)
        return False

    async def _fake_reset_email(db, staff, token):  # noqa: ANN001
        return False

    monkeypatch.setattr(auth_api, "_try_send_invite_email", _fake_invite_email)
    monkeypatch.setattr(auth_api, "_try_send_reset_email", _fake_reset_email)
    headers = _auth_headers(sid, tid)

    # 未設 KEFU_FRONTEND_BASE → 用反代感知的對外基底
    r = await client.post(
        "/api/v1/auth/invite",
        json={"email": "new@example.com"},
        headers={**headers, "X-Forwarded-Proto": "https", "X-Forwarded-Host": "kf.example.com"},
    )
    data = r.json()["data"]
    assert data["invite_url"].startswith("/accept-invite?token=")
    assert data["invite_link"] == f"https://kf.example.com{data['invite_url']}"
    assert sent == [data["invite_link"]]

    # email 不分大小寫的重複檢查
    r = await client.post("/api/v1/auth/invite", json={"email": "NEW@example.com"}, headers=headers)
    assert r.json()["error"]["code"] == "STAFF_EMAIL_TAKEN"

    # 設 KEFU_FRONTEND_BASE → 優先使用
    monkeypatch.setenv("KEFU_FRONTEND_BASE", "https://app.example.com/")
    new_id = data["staff_id"]
    r = await client.post(f"/api/v1/auth/invite/{new_id}/resend", headers=headers)
    data = r.json()["data"]
    assert data["invite_link"] == f"https://app.example.com{data['invite_url']}"

    r = await client.post(f"/api/v1/auth/staff/{sid}/reset-link", headers=headers)
    data = r.json()["data"]
    assert data["reset_url"].startswith("/reset-password?token=")
    assert data["reset_link"] == f"https://app.example.com{data['reset_url']}"


@pytest.mark.asyncio
async def test_forgot_password_case_insensitive(env, monkeypatch):
    client, factory = env
    tid = await _tenant(factory, "Acme", "acme")
    sid = await _staff(factory, tid, "Henry@Example.com")
    hits: list = []

    async def _fake_reset_email(db, staff, token):  # noqa: ANN001
        hits.append(staff.id)
        return True

    monkeypatch.setattr(auth_api, "_try_send_reset_email", _fake_reset_email)
    r = await client.post("/api/v1/auth/forgot-password", json={"email": "henry@example.COM"})
    assert r.json()["ok"] is True
    assert hits == [sid]


# =========================================================================== #
# Google OAuth:Web state + cookie
# =========================================================================== #
class _FakeGoogleResp:
    def __init__(self, data, status_code=200):
        self._data = data
        self.status_code = status_code

    def json(self):
        return self._data


def _patch_google(monkeypatch, email: str):
    import httpx

    class _FakeAsyncClient:
        def __init__(self, *a, **kw):  # noqa: ANN002, ANN003
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):  # noqa: ANN002
            return False

        async def post(self, url, data=None, **kw):  # noqa: ANN001, ANN003
            return _FakeGoogleResp({"access_token": "google-access"})

        async def get(self, url, headers=None, **kw):  # noqa: ANN001, ANN003
            return _FakeGoogleResp({"email": email, "email_verified": True})

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)


@pytest.mark.asyncio
async def test_google_web_start_sets_state_cookie(env, fake_redis):
    client, _ = env
    r = await client.get("/api/v1/auth/oauth/google/start")
    assert r.status_code == 302
    state = _qs(r.headers["location"])["state"]
    assert r.cookies.get("kefu_oauth_state") == state
    cookie_hdr = r.headers["set-cookie"].lower()
    assert "httponly" in cookie_hdr and "samesite=lax" in cookie_hdr
    record = json.loads(fake_redis.store[f"sso:state:{state}"])
    assert record == {"client": "web", "provider": "google"}
    assert fake_redis.ttl[f"sso:state:{state}"] == 600


@pytest.mark.asyncio
async def test_google_web_callback_requires_matching_state(env, monkeypatch):
    client, factory = env
    tid = await _tenant(factory, "Acme", "acme")
    await _staff(factory, tid, "ivy@example.com")
    _patch_google(monkeypatch, "IVY@example.com")

    # 沒有 state / cookie → 拒絕(login CSRF)
    r = await client.get("/api/v1/auth/oauth/google/callback", params={"code": "abc"})
    assert r.status_code == 302 and _qs(r.headers["location"])["sso_error"] == "OAUTH_STATE_INVALID"

    r = await client.get("/api/v1/auth/oauth/google/start")
    state = _qs(r.headers["location"])["state"]

    # state 與 cookie 不符 → 拒絕
    client.cookies.set("kefu_oauth_state", "x" * 43, path="/api/v1/auth/oauth")
    r = await client.get("/api/v1/auth/oauth/google/callback", params={"code": "abc", "state": state})
    assert _qs(r.headers["location"])["sso_error"] == "OAUTH_STATE_INVALID"
    client.cookies.clear()

    r = await client.get("/api/v1/auth/oauth/google/start")
    state = _qs(r.headers["location"])["state"]
    r = await client.get("/api/v1/auth/oauth/google/callback", params={"code": "abc", "state": state})
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("/login#sso_token=")
    assert decode_access_token(loc.split("#sso_token=", 1)[1])["tenant_id"] == str(tid)


@pytest.mark.asyncio
async def test_google_web_start_works_without_redis(env):
    client, _ = env
    realtime.set_client(_BrokenRedis())
    r = await client.get("/api/v1/auth/oauth/google/start")
    assert r.status_code == 302
    state = _qs(r.headers["location"])["state"]
    assert r.cookies.get("kefu_oauth_state") == state


# =========================================================================== #
# 原生 PKCE:Google
# =========================================================================== #
def _native_params(challenge: str, **over) -> dict:
    params = {
        "client": "native",
        "redirect_uri": NATIVE_REDIRECT,
        "state": "app-state-123",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    params.update(over)
    return params


@pytest.mark.asyncio
async def test_native_start_validation(env):
    client, _ = env
    _, challenge = _pkce()

    r = await client.get(
        "/api/v1/auth/oauth/google/start",
        params=_native_params(challenge, redirect_uri="kefu://auth/callback/evil"),
    )
    assert r.status_code == 200 and r.json()["error"]["code"] == "INVALID_REDIRECT_URI"

    r = await client.get(
        "/api/v1/auth/oauth/google/start",
        params=_native_params(challenge, redirect_uri="https://evil.example.com/cb"),
    )
    assert r.json()["error"]["code"] == "INVALID_REDIRECT_URI"

    r = await client.get("/api/v1/auth/oauth/google/start", params=_native_params(challenge, state=""))
    assert r.json()["error"]["code"] == "INVALID_STATE"

    r = await client.get(
        "/api/v1/auth/oauth/google/start", params=_native_params(challenge, code_challenge_method="plain")
    )
    assert r.status_code == 302
    assert r.headers["location"].startswith(NATIVE_REDIRECT + "?")
    assert _qs(r.headers["location"]) == {"sso_error": "INVALID_REQUEST", "state": "app-state-123"}

    r = await client.get("/api/v1/auth/oauth/google/start", params=_native_params("short"))
    assert _qs(r.headers["location"])["sso_error"] == "INVALID_REQUEST"


@pytest.mark.asyncio
async def test_native_start_disabled_and_redis_down(env, monkeypatch):
    client, _ = env
    _, challenge = _pkce()
    monkeypatch.delenv("KEFU_GOOGLE_CLIENT_ID")
    r = await client.get("/api/v1/auth/oauth/google/start", params=_native_params(challenge))
    assert _qs(r.headers["location"]) == {"sso_error": "SSO_DISABLED", "state": "app-state-123"}

    monkeypatch.setenv("KEFU_GOOGLE_CLIENT_ID", "cid")
    realtime.set_client(_BrokenRedis())
    r = await client.get("/api/v1/auth/oauth/google/start", params=_native_params(challenge))
    assert _qs(r.headers["location"])["sso_error"] == "SSO_UNAVAILABLE"


async def _native_google_login(client, fake_redis, challenge: str) -> str:
    """跑原生 start → callback,回 deep link Location。"""
    r = await client.get("/api/v1/auth/oauth/google/start", params=_native_params(challenge))
    assert r.status_code == 302
    assert "set-cookie" not in r.headers  # 原生不種 cookie
    google_qs = _qs(r.headers["location"])
    nonce = google_qs["state"]
    assert nonce != "app-state-123"  # 送往 Google 的是伺服器 nonce,不是 app_state
    record = json.loads(fake_redis.store[f"sso:state:{nonce}"])
    assert record["client"] == "native" and record["code_challenge"] == challenge
    assert record["redirect_uri"] == NATIVE_REDIRECT and record["app_state"] == "app-state-123"
    r = await client.get("/api/v1/auth/oauth/google/callback", params={"code": "g-code", "state": nonce})
    assert r.status_code == 302
    assert f"sso:state:{nonce}" not in fake_redis.store  # 單次使用
    return r.headers["location"]


@pytest.mark.asyncio
async def test_native_google_full_flow_and_exchange(env, fake_redis, monkeypatch):
    client, factory = env
    tid = await _tenant(factory, "Acme", "acme")
    sid = await _staff(factory, tid, "jack@example.com")
    _patch_google(monkeypatch, "jack@example.com")
    verifier, challenge = _pkce()

    loc = await _native_google_login(client, fake_redis, challenge)
    assert loc.startswith(NATIVE_REDIRECT + "?")
    assert "sso_token" not in loc and "access_token" not in loc  # JWT 不進 deep link
    q = _qs(loc)
    assert q["state"] == "app-state-123"
    code = q["code"]
    assert fake_redis.ttl[f"sso:code:{code}"] == 60

    r = await client.post("/api/v1/auth/sso/exchange", json={"code": code, "code_verifier": verifier})
    data = r.json()["data"]
    assert r.json()["ok"] is True
    assert data["staff_id"] == str(sid) and data["token_type"] == "bearer"
    assert data["is_platform_admin"] is False
    assert decode_access_token(data["access_token"])["sub"] == str(sid)

    # 重放 → 無效
    r = await client.post("/api/v1/auth/sso/exchange", json={"code": code, "code_verifier": verifier})
    assert r.json()["error"]["code"] == "INVALID_CODE"


@pytest.mark.asyncio
async def test_native_exchange_wrong_verifier_burns_code(env, fake_redis, monkeypatch):
    client, factory = env
    tid = await _tenant(factory, "Acme", "acme")
    await _staff(factory, tid, "kim@example.com")
    _patch_google(monkeypatch, "kim@example.com")
    verifier, challenge = _pkce()
    code = _qs(await _native_google_login(client, fake_redis, challenge))["code"]

    other_verifier, _ = _pkce()
    r = await client.post("/api/v1/auth/sso/exchange", json={"code": code, "code_verifier": other_verifier})
    assert r.json()["error"]["code"] == "INVALID_CODE_VERIFIER"
    r = await client.post("/api/v1/auth/sso/exchange", json={"code": code, "code_verifier": verifier})
    assert r.json()["error"]["code"] == "INVALID_CODE"


@pytest.mark.asyncio
async def test_native_callback_policy_errors_redirect_to_app(env, fake_redis, monkeypatch):
    client, factory = env
    tid = await _tenant(factory, "Acme", "acme")
    await _staff(factory, tid, "leo@example.com")
    await _set_policy(factory, tid, allowlist=["10.0.0.0/8"])
    _patch_google(monkeypatch, "leo@example.com")
    _, challenge = _pkce()
    loc = await _native_google_login(client, fake_redis, challenge)
    assert loc.startswith(NATIVE_REDIRECT + "?")
    assert _qs(loc) == {"sso_error": "LOGIN_IP_BLOCKED", "state": "app-state-123"}


@pytest.mark.asyncio
async def test_native_callback_unknown_user(env, fake_redis, monkeypatch):
    client, _ = env
    _patch_google(monkeypatch, "nobody@example.com")
    _, challenge = _pkce()
    loc = await _native_google_login(client, fake_redis, challenge)
    assert _qs(loc) == {"sso_error": "SSO_NOT_INVITED", "state": "app-state-123"}


@pytest.mark.asyncio
async def test_native_exchange_revalidates_account(env, fake_redis, monkeypatch):
    client, factory = env
    tid = await _tenant(factory, "Acme", "acme")
    sid = await _staff(factory, tid, "mia@example.com")
    _patch_google(monkeypatch, "mia@example.com")

    async def _code() -> tuple[str, str]:
        verifier, challenge = _pkce()
        return _qs(await _native_google_login(client, fake_redis, challenge))["code"], verifier

    # 回呼後被停用 → 兌換失敗
    code, verifier = await _code()
    await _update_staff(factory, sid, is_active=False)
    r = await client.post("/api/v1/auth/sso/exchange", json={"code": code, "code_verifier": verifier})
    assert r.json()["error"]["code"] == "SSO_NOT_INVITED"
    await _update_staff(factory, sid, is_active=True)

    # 回呼後租戶被停用
    code, verifier = await _code()
    async with factory() as db:
        (await db.get(Tenant, tid)).is_active = False
        await db.commit()
    r = await client.post("/api/v1/auth/sso/exchange", json={"code": code, "code_verifier": verifier})
    assert r.json()["error"]["code"] == "TENANT_SUSPENDED"
    async with factory() as db:
        (await db.get(Tenant, tid)).is_active = True
        await db.commit()

    # 回呼後組織開啟強制 2FA
    code, verifier = await _code()
    await _set_policy(factory, tid, require_2fa=True)
    r = await client.post("/api/v1/auth/sso/exchange", json={"code": code, "code_verifier": verifier})
    assert r.json()["error"]["code"] == "TWOFA_ENROLL_REQUIRED"


@pytest.mark.asyncio
async def test_native_exchange_ip_allowlist_rechecked(env, fake_redis):
    client, factory = env
    tid = await _tenant(factory, "Acme", "acme")
    sid = await _staff(factory, tid, "ned@example.com")
    await _set_policy(factory, tid, allowlist=["10.0.0.0/8"])
    verifier, challenge = _pkce()
    code = secrets.token_urlsafe(32)
    fake_redis.store[f"sso:code:{code}"] = json.dumps(
        {"staff_id": str(sid), "tenant_id": str(tid), "code_challenge": challenge}
    )
    r = await client.post("/api/v1/auth/sso/exchange", json={"code": code, "code_verifier": verifier})
    assert r.json()["error"]["code"] == "LOGIN_IP_BLOCKED"


@pytest.mark.asyncio
async def test_native_exchange_rate_limited(env, fake_redis):
    client, _ = env
    verifier, _ = _pkce()
    for _ in range(30):
        r = await client.post(
            "/api/v1/auth/sso/exchange", json={"code": secrets.token_urlsafe(32), "code_verifier": verifier}
        )
        assert r.json()["error"]["code"] == "INVALID_CODE"
    r = await client.post(
        "/api/v1/auth/sso/exchange", json={"code": secrets.token_urlsafe(32), "code_verifier": verifier}
    )
    assert r.status_code == 429
    assert fake_redis.counters["rl:sso-exchange-ip:127.0.0.1"] == 31


@pytest.mark.asyncio
async def test_native_callback_rejects_tampered_redirect(env, fake_redis, monkeypatch):
    """Redis record 的 redirect_uri 若已不在白名單(設定變更 / 竄改)→ 不導向該網址。"""
    client, _ = env
    _patch_google(monkeypatch, "x@example.com")
    nonce = secrets.token_urlsafe(32)
    fake_redis.store[f"sso:state:{nonce}"] = json.dumps(
        {"client": "native", "provider": "google", "redirect_uri": "https://evil.example.com/cb",
         "app_state": "s", "code_challenge": "c" * 43}
    )
    r = await client.get("/api/v1/auth/oauth/google/callback", params={"code": "g", "state": nonce})
    assert r.headers["location"].startswith("/login?")
    assert _qs(r.headers["location"])["sso_error"] == "OAUTH_STATE_INVALID"


# =========================================================================== #
# 原生 PKCE:SAML
# =========================================================================== #
async def _saml_tenant(factory, slug: str = "corp") -> uuid.UUID:
    tid = await _tenant(factory, "Corp", slug)
    async with factory() as db:
        db.add(
            TenantSSOConfig(
                tenant_id=tid,
                saml_enabled=True,
                saml_idp_sso_url="https://idp.example.com/sso",
                saml_idp_x509_cert="dummy",
            )
        )
        await db.commit()
    return tid


def _patch_saml_ok(monkeypatch, email: str):
    def _fake_verify(xml_bytes, cfg):  # noqa: ANN001
        return saml_api._SamlResult(email=email, name_id=email, issuer="idp", mode="full"), ""

    monkeypatch.setattr(saml_api, "_verify_and_extract", _fake_verify)


_SAML_FORM = {"SAMLResponse": base64.b64encode(b"<Response/>").decode()}


@pytest.mark.asyncio
async def test_saml_native_flow(env, fake_redis, monkeypatch):
    client, factory = env
    tid = await _saml_tenant(factory)
    sid = await _staff(factory, tid, "olga@example.com")
    _patch_saml_ok(monkeypatch, "olga@example.com")
    verifier, challenge = _pkce()

    r = await client.get("/api/v1/saml/login/corp", params=_native_params(challenge))
    assert r.status_code == 302 and r.headers["location"].startswith("https://idp.example.com/sso?")
    relay = _qs(r.headers["location"])["RelayState"]
    assert relay != "corp"
    record = json.loads(fake_redis.store[f"sso:state:{relay}"])
    assert record["provider"] == "saml" and record["tenant_slug"] == "corp"

    r = await client.post("/api/v1/saml/acs/corp", data={**_SAML_FORM, "RelayState": relay})
    loc = r.headers["location"]
    assert r.status_code == 302 and loc.startswith(NATIVE_REDIRECT + "?")
    q = _qs(loc)
    assert q["state"] == "app-state-123" and "sso_token" not in loc

    r = await client.post("/api/v1/auth/sso/exchange", json={"code": q["code"], "code_verifier": verifier})
    assert r.json()["data"]["staff_id"] == str(sid)


@pytest.mark.asyncio
async def test_saml_native_errors_go_to_app(env, fake_redis, monkeypatch):
    client, factory = env
    await _saml_tenant(factory)
    _patch_saml_ok(monkeypatch, "ghost@example.com")
    _, challenge = _pkce()

    # 未啟用 SAML 的租戶 → 導回 App
    r = await client.get("/api/v1/saml/login/nope", params=_native_params(challenge))
    assert _qs(r.headers["location"]) == {"sso_error": "SSO_DISABLED", "state": "app-state-123"}

    r = await client.get("/api/v1/saml/login/corp", params=_native_params(challenge))
    relay = _qs(r.headers["location"])["RelayState"]
    r = await client.post("/api/v1/saml/acs/corp", data={**_SAML_FORM, "RelayState": relay})
    assert _qs(r.headers["location"]) == {"sso_error": "SSO_NOT_INVITED", "state": "app-state-123"}


@pytest.mark.asyncio
async def test_saml_native_nonce_bound_to_tenant(env, fake_redis, monkeypatch):
    client, factory = env
    await _saml_tenant(factory, "corp")
    tid2 = await _saml_tenant(factory, "other")
    await _staff(factory, tid2, "pat@example.com")
    _patch_saml_ok(monkeypatch, "pat@example.com")
    _, challenge = _pkce()
    r = await client.get("/api/v1/saml/login/corp", params=_native_params(challenge))
    relay = _qs(r.headers["location"])["RelayState"]
    # 拿 corp 的 nonce 打 other 的 ACS → 拒絕(導回 App)
    r = await client.post("/api/v1/saml/acs/other", data={**_SAML_FORM, "RelayState": relay})
    assert _qs(r.headers["location"]) == {"sso_error": "SAML_STATE_INVALID", "state": "app-state-123"}


@pytest.mark.asyncio
async def test_saml_web_flow_unchanged(env, fake_redis, monkeypatch):
    client, factory = env
    tid = await _saml_tenant(factory)
    await _staff(factory, tid, "quinn@example.com")
    _patch_saml_ok(monkeypatch, "quinn@example.com")

    r = await client.get("/api/v1/saml/login/corp")
    assert _qs(r.headers["location"])["RelayState"] == "corp"

    # SP 發起(RelayState=slug)與 IdP 發起(無 RelayState)皆維持以 fragment 帶 token 導回登入頁
    for form in ({**_SAML_FORM, "RelayState": "corp"}, _SAML_FORM):
        r = await client.post("/api/v1/saml/acs/corp", data=form)
        assert r.status_code == 302
        assert r.headers["location"].startswith("/login#sso_token=")
