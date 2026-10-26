"""改密 / 重設密碼 / 2FA 變更後撤銷既發 access token(Staff.token_version + JWT ``tv`` claim)。

涵蓋:
1. 簽發:login / 2FA 綁定流程 / 改密回應的新 token 都帶目前的 ``tv``。
2. 撤銷:自助改密、忘記密碼重設、IAM 管理員改他人 / 本人改自己、2FA 啟用 / 停用 / 強制綁定
   後,變更前簽發的 token(含其他裝置、缺 claim 的舊 token)一律 401;發起變更的 session
   以回應中的新 token 續用。管理員改他人密碼不影響管理員自己的 token。
3. 相容:缺 ``tv`` claim 的舊 token 視為版本 0,版本未變前照常可用;claim 格式異常一律拒絕。
4. 平台超管守衛同樣比對版本。
5. ``/ws/agent``:舊 token 握手即 close(4401);已連線者於定期複查時 close(4401);新 token 可連。

資料庫用 SQLite 檔案(NullPool,REST 與 /ws/agent 的 SessionLocal 共用、跨 TestClient
執行緒安全),Redis 用內建假物件;不依賴外部 Postgres / Redis。
"""
from __future__ import annotations

import asyncio
import time
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.ext.compiler import compiles


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(type_, compiler, **kw):  # noqa: ANN001, ANN201
    return "TEXT"


@compiles(PGUUID, "sqlite")
def _compile_uuid_sqlite(type_, compiler, **kw):  # noqa: ANN001, ANN201
    return "CHAR(32)"


from fastapi import HTTPException  # noqa: E402
from sqlalchemy import insert, select  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

import app.models  # noqa: E402,F401
from app.api.v1 import auth as auth_api  # noqa: E402
from app.api.v1 import conversation as conv_api  # noqa: E402
from app.api.v1 import iam as iam_api  # noqa: E402
from app.api.v1.platform import require_platform_admin  # noqa: E402
from app.core.db import Base, get_db  # noqa: E402
from app.core.security import (  # noqa: E402
    create_access_token,
    decode_access_token,
    hash_password,
    token_version_matches,
)
from app.models.conversation import Channel  # noqa: E402
from app.models.iam import Permission, Role, Staff, role_permission, staff_role  # noqa: E402
from app.models.settings import TenantSettings  # noqa: E402
from app.models.tenancy import Organization, Tenant  # noqa: E402
from app.services import realtime, totp  # noqa: E402

_TABLES = [
    Tenant.__table__,
    Organization.__table__,
    Staff.__table__,
    Role.__table__,
    Permission.__table__,
    staff_role,
    role_permission,
    TenantSettings.__table__,
    Channel.__table__,
]

PASSWORD = "secret123"


# ============================ 假 Redis ============================

class _NeverPubSub:
    """訂閱端:listen 永遠阻塞(本檔不測事件轉發,只需 _pump 安靜掛著直到被 cancel)。"""

    async def subscribe(self, *chs: str) -> None:
        pass

    async def unsubscribe(self, *chs: str) -> None:
        pass

    async def aclose(self) -> None:
        pass

    async def listen(self):
        await asyncio.Event().wait()
        yield {}  # pragma: no cover


class _FakeRedis:
    """限流(incr/expire)+ presence(hash)+ 字串鍵 + publish;pubsub 永不出事件。"""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.counters: dict[str, int] = {}
        self.hashes: dict[str, dict[str, str]] = {}

    def pubsub(self) -> _NeverPubSub:
        return _NeverPubSub()

    async def incr(self, key):  # noqa: ANN001
        self.counters[key] = self.counters.get(key, 0) + 1
        return self.counters[key]

    async def expire(self, key, seconds):  # noqa: ANN001
        return True

    async def set(self, key, value, ex=None, nx=False):  # noqa: ANN001
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    async def get(self, key):  # noqa: ANN001
        return self.store.get(key)

    async def getdel(self, key):  # noqa: ANN001
        return self.store.pop(key, None)

    async def delete(self, *keys):  # noqa: ANN002
        return sum(1 for k in keys if self.store.pop(k, None) is not None)

    async def publish(self, channel, data):  # noqa: ANN001
        return 0

    async def hset(self, key, field, value):  # noqa: ANN001
        self.hashes.setdefault(key, {})[field] = value
        return 1

    async def hgetall(self, key):  # noqa: ANN001
        return dict(self.hashes.get(key, {}))

    async def hdel(self, key, *fields):  # noqa: ANN001, ANN002
        h = self.hashes.get(key, {})
        for f in fields:
            h.pop(f, None)
        if key in self.hashes and not self.hashes[key]:
            del self.hashes[key]
        return 1


@pytest.fixture(autouse=True)
def fake_redis():
    fake = _FakeRedis()
    realtime.set_client(fake)
    yield fake
    realtime.set_client(None)


# ============================ 測試環境 ============================

@pytest.fixture
def env(tmp_path, monkeypatch):
    """SQLite 檔案庫 + 掛 auth / iam REST 與 /ws/agent 的測試 app(共用同一個庫)。"""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    url = f"sqlite+aiosqlite:///{tmp_path / 'tv.db'}"
    engine = create_async_engine(url, poolclass=NullPool)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=_TABLES))

    asyncio.run(_create())
    monkeypatch.setattr(conv_api, "SessionLocal", maker)
    monkeypatch.setattr(conv_api, "WS_OFFLINE_GRACE_SECONDS", 0)

    async def _get_db():
        async with maker() as s:
            yield s

    app = FastAPI()
    app.include_router(auth_api.router, prefix="/api/v1/auth")
    app.include_router(iam_api.router, prefix="/api/v1/iam")
    app.include_router(conv_api.ws_router)
    app.dependency_overrides[get_db] = _get_db
    yield SimpleNamespace(client=TestClient(app), maker=maker)
    asyncio.run(engine.dispose())


def _run(env, fn):
    async def _do():
        async with env.maker() as db:
            return await fn(db)

    return asyncio.run(_do())


def _seed(env, *, platform_admin: bool = False, require_2fa: bool = False) -> SimpleNamespace:
    """一個租戶:admin 坐席(admin 角色)+ agent 坐席(無角色)。"""

    async def _do(db):
        tenant = Tenant(name="Acme", slug=f"acme-{uuid.uuid4().hex[:8]}", is_active=True)
        db.add(tenant)
        await db.flush()
        role = Role(tenant_id=tenant.id, name="admin", is_system=True)
        db.add(role)
        admin = Staff(
            tenant_id=tenant.id,
            email=f"admin-{uuid.uuid4().hex[:6]}@acme.test",
            password_hash=hash_password(PASSWORD),
            display_name="Admin",
            status="offline",
            is_active=True,
            is_platform_admin=platform_admin,
        )
        agent = Staff(
            tenant_id=tenant.id,
            email=f"agent-{uuid.uuid4().hex[:6]}@acme.test",
            password_hash=hash_password(PASSWORD),
            display_name="Agent",
            status="offline",
            is_active=True,
        )
        db.add_all([admin, agent])
        await db.flush()
        await db.execute(insert(staff_role).values(staff_id=admin.id, role_id=role.id))
        if require_2fa:
            db.add(TenantSettings(tenant_id=tenant.id, require_2fa=True))
        await db.commit()
        return SimpleNamespace(
            tenant_id=tenant.id,
            tenant_slug=tenant.slug,
            admin_id=admin.id,
            admin_email=admin.email,
            agent_id=agent.id,
            agent_email=agent.email,
        )

    return _run(env, _do)


def _token_version(env, staff_id) -> int:
    async def _do(db):
        return (await db.execute(select(Staff.token_version).where(Staff.id == staff_id))).scalar_one()

    return _run(env, _do)


def _login(env, email: str, password: str = PASSWORD) -> str:
    r = env.client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["data"]["access_token"]


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _me_status(env, token: str) -> int:
    return env.client.get("/api/v1/auth/me", headers=_bearer(token)).status_code


def _legacy_token(staff_id, tenant_id, roles=("admin",)) -> str:
    """本機制上線前的 token 形狀:無 tv claim。"""
    return create_access_token(
        {"sub": str(staff_id), "tenant_id": str(tenant_id), "roles": list(roles)}
    )


# ============================ 1. 簽發 ============================

def test_login_token_carries_token_version(env):
    w = _seed(env)
    payload = decode_access_token(_login(env, w.agent_email))
    assert payload["tv"] == 0


# ============================ 2. 撤銷 ============================

def test_change_password_revokes_old_tokens_and_keeps_changer_logged_in(env):
    w = _seed(env)
    device_a = _login(env, w.agent_email)
    device_b = _login(env, w.agent_email)
    legacy = _legacy_token(w.agent_id, w.tenant_id, roles=())
    assert {_me_status(env, t) for t in (device_a, device_b, legacy)} == {200}

    r = env.client.post(
        "/api/v1/auth/change-password",
        json={"old_password": PASSWORD, "new_password": "brand-new-1"},
        headers=_bearer(device_a),
    )
    body = r.json()
    assert body["ok"] is True and body["data"]["password_changed"] is True
    fresh = body["data"]["access_token"]
    assert body["data"]["token_type"] == "bearer"

    # 變更前簽發的 token 全數失效(發起變更的那個、其他裝置、缺 claim 的舊 token)
    for old in (device_a, device_b, legacy):
        resp = env.client.get("/api/v1/auth/me", headers=_bearer(old))
        assert resp.status_code == 401
        assert resp.json()["detail"] == "session revoked"
    # 發起變更的 session 以新 token 續用
    assert _me_status(env, fresh) == 200
    assert decode_access_token(fresh)["tv"] == 1 == _token_version(env, w.agent_id)
    # 新密碼登入所得 token 也帶新版本
    assert decode_access_token(_login(env, w.agent_email, "brand-new-1"))["tv"] == 1


def test_failed_change_password_does_not_revoke(env):
    w = _seed(env)
    tok = _login(env, w.agent_email)
    r = env.client.post(
        "/api/v1/auth/change-password",
        json={"old_password": "wrong-password", "new_password": "brand-new-1"},
        headers=_bearer(tok),
    )
    assert r.json()["error"]["code"] == "INVALID_OLD_PASSWORD"
    assert _token_version(env, w.agent_id) == 0
    assert _me_status(env, tok) == 200


def test_reset_password_revokes_old_tokens(env):
    w = _seed(env)
    admin_tok = _login(env, w.admin_email)
    agent_tok = _login(env, w.agent_email)

    link = env.client.post(f"/api/v1/auth/staff/{w.agent_id}/reset-link", headers=_bearer(admin_tok))
    reset_token = link.json()["data"]["reset_url"].split("token=", 1)[1]
    r = env.client.post(
        "/api/v1/auth/reset-password", json={"token": reset_token, "new_password": "reset-pass-1"}
    )
    assert r.json()["ok"] is True and r.json()["data"]["password_reset"] is True
    assert "access_token" not in r.json()["data"]  # 公開端點不發 token,改以新密碼登入

    assert _me_status(env, agent_tok) == 401
    assert _me_status(env, admin_tok) == 200  # 他人的 token 不受影響
    new_tok = _login(env, w.agent_email, "reset-pass-1")
    assert _me_status(env, new_tok) == 200
    assert decode_access_token(new_tok)["tv"] == 1


def test_admin_password_reset_revokes_target_only(env):
    w = _seed(env)
    admin_tok = _login(env, w.admin_email)
    agent_tok = _login(env, w.agent_email)

    r = env.client.post(
        f"/api/v1/iam/staff/{w.agent_id}/password",
        json={"new_password": "admin-set-1"},
        headers=_bearer(admin_tok),
    )
    assert r.json()["ok"] is True and r.json()["data"]["password_changed"] is True
    assert "access_token" not in r.json()["data"]  # 改他人密碼:不替對方發 token

    assert _me_status(env, agent_tok) == 401
    assert _me_status(env, admin_tok) == 200
    assert _token_version(env, w.admin_id) == 0

    async def _changed_at(db):
        return (
            await db.execute(select(Staff.password_changed_at).where(Staff.id == w.agent_id))
        ).scalar_one()

    # 與其他改密入口一致刷新 password_changed_at(先前的重設連結隨之失效)
    assert _run(env, _changed_at) is not None


def test_iam_self_password_change_returns_fresh_token(env):
    w = _seed(env)
    old = _login(env, w.admin_email)
    r = env.client.post(
        f"/api/v1/iam/staff/{w.admin_id}/password",
        json={"new_password": "self-set-1"},
        headers=_bearer(old),
    )
    fresh = r.json()["data"]["access_token"]
    assert _me_status(env, old) == 401
    assert _me_status(env, fresh) == 200


def test_2fa_enable_and_disable_rotate_tokens(env):
    w = _seed(env)
    other_device = _login(env, w.agent_email)
    tok = _login(env, w.agent_email)

    secret = env.client.post("/api/v1/auth/2fa/setup", headers=_bearer(tok)).json()["data"]["secret"]
    assert _me_status(env, tok) == 200  # 只產生密鑰尚未啟用:不撤銷
    r = env.client.post(
        "/api/v1/auth/2fa/enable", json={"code": totp.totp_now(secret)}, headers=_bearer(tok)
    )
    data = r.json()["data"]
    assert data["totp_enabled"] is True and data["recovery_codes"]
    after_enable = data["access_token"]
    assert _me_status(env, tok) == 401
    assert _me_status(env, other_device) == 401
    assert _me_status(env, after_enable) == 200

    r = env.client.post(
        "/api/v1/auth/2fa/disable", json={"password": PASSWORD}, headers=_bearer(after_enable)
    )
    data = r.json()["data"]
    assert data["totp_enabled"] is False
    after_disable = data["access_token"]
    assert _me_status(env, after_enable) == 401
    assert _me_status(env, after_disable) == 200
    assert _token_version(env, w.agent_id) == 2


def test_2fa_enforced_enrollment_revokes_pre_policy_tokens(env):
    w = _seed(env, require_2fa=True)
    pre_policy = _legacy_token(w.agent_id, w.tenant_id, roles=())
    assert _me_status(env, pre_policy) == 200

    r = env.client.post("/api/v1/auth/login", json={"email": w.agent_email, "password": PASSWORD})
    enroll = r.json()["data"]
    assert enroll["requires_2fa_enrollment"] is True
    r = env.client.post(
        "/api/v1/auth/2fa/enroll/verify",
        json={"challenge": enroll["enroll_challenge"], "code": totp.totp_now(enroll["secret"])},
    )
    fresh = r.json()["data"]["access_token"]
    assert decode_access_token(fresh)["tv"] == 1
    assert _me_status(env, pre_policy) == 401
    assert _me_status(env, fresh) == 200


# ============================ 3. 相容 / 格式 ============================

def test_legacy_token_without_claim_valid_until_version_changes(env):
    w = _seed(env)
    legacy = _legacy_token(w.agent_id, w.tenant_id, roles=())
    assert "tv" not in decode_access_token(legacy)
    assert _me_status(env, legacy) == 200

    async def _bump(db):
        from app.services.iam import bump_token_version

        staff = await db.get(Staff, w.agent_id)
        await bump_token_version(db, staff)
        await db.commit()

    _run(env, _bump)
    assert _me_status(env, legacy) == 401


@pytest.mark.parametrize("claim", ["0", True, 0.0, None, [0]])
def test_malformed_token_version_claim_rejected(env, claim):
    w = _seed(env)
    tok = create_access_token(
        {"sub": str(w.agent_id), "tenant_id": str(w.tenant_id), "roles": [], "tv": claim}
    )
    assert _me_status(env, tok) == 401


def test_token_version_matches_rules():
    assert token_version_matches({}, 0)
    assert token_version_matches({}, None)
    assert token_version_matches({"tv": 3}, 3)
    assert not token_version_matches({}, 1)
    assert not token_version_matches({"tv": 2}, 3)
    assert not token_version_matches({"tv": True}, 1)
    assert not token_version_matches({"tv": "3"}, 3)


def test_bump_token_version_is_cumulative(env):
    w = _seed(env)

    async def _bump_twice(db):
        from app.services.iam import bump_token_version

        staff = await db.get(Staff, w.agent_id)
        first = await bump_token_version(db, staff)
        second = await bump_token_version(db, staff)
        await db.commit()
        return first, second

    assert _run(env, _bump_twice) == (1, 2)
    assert _token_version(env, w.agent_id) == 2


# ============================ 4. 平台超管守衛 ============================

def test_platform_admin_guard_rejects_revoked_token(env):
    w = _seed(env, platform_admin=True)
    old = _login(env, w.admin_email)
    assert decode_access_token(old)["is_platform_admin"] is True

    async def _guard(token):
        async with env.maker() as db:
            return await require_platform_admin(db, authorization=f"Bearer {token}")

    assert asyncio.run(_guard(old)).staff_id == w.admin_id
    r = env.client.post(
        "/api/v1/auth/change-password",
        json={"old_password": PASSWORD, "new_password": "platform-new-1"},
        headers=_bearer(old),
    )
    fresh = r.json()["data"]["access_token"]
    with pytest.raises(HTTPException) as ei:
        asyncio.run(_guard(old))
    assert ei.value.status_code == 401
    assert asyncio.run(_guard(fresh)).staff_id == w.admin_id


# ============================ 5. /ws/agent ============================

def _recv_until_closed(ws, timeout: float = 3.0) -> int | None:
    """持續 ping(主迴圈會回 pong,不會卡死)直到伺服器端關閉連線,回傳 close code;逾時回 None。"""
    from starlette.websockets import WebSocketDisconnect

    deadline = time.time() + timeout
    while time.time() < deadline:
        ws.send_json({"type": "ping"})
        try:
            ws.receive_json()
        except WebSocketDisconnect as exc:
            return exc.code
        time.sleep(0.02)
    return None


def _assert_handshake_4401(env, token: str) -> None:
    # 以 ping 迴圈等關閉(有逾時):若伺服器誤放行,測試會失敗而不是卡在 receive。
    with env.client.websocket_connect(f"/ws/agent?token={token}") as ws:
        assert _recv_until_closed(ws, timeout=1.0) == 4401


def _assert_ws_ok(env, token: str) -> None:
    with env.client.websocket_connect(f"/ws/agent?token={token}") as ws:
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"


def test_ws_connection_with_old_token_closed_4401_on_recheck(env, monkeypatch):
    """已連線的 /ws/agent 在改密後的定期複查以 4401 關閉;舊 token 重連被拒,新 token 可連。"""
    monkeypatch.setattr(conv_api, "WS_PRESENCE_REFRESH_SECONDS", 0.03)
    monkeypatch.setattr(conv_api, "WS_AUTH_RECHECK_TICKS", 1)
    w = _seed(env)
    old = _login(env, w.agent_email)

    with env.client.websocket_connect(f"/ws/agent?token={old}") as ws:
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"
        time.sleep(0.12)  # 期間已複查多次且皆通過 → 連線維持
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"

        r = env.client.post(
            "/api/v1/auth/change-password",
            json={"old_password": PASSWORD, "new_password": "ws-new-pass-1"},
            headers=_bearer(old),
        )
        fresh = r.json()["data"]["access_token"]
        assert _recv_until_closed(ws) == 4401

    _assert_handshake_4401(env, old)
    _assert_ws_ok(env, fresh)


def test_ws_handshake_rejects_token_revoked_by_reset(env):
    w = _seed(env)
    admin_tok = _login(env, w.admin_email)
    agent_tok = _login(env, w.agent_email)
    _assert_ws_ok(env, agent_tok)

    r = env.client.post(
        f"/api/v1/iam/staff/{w.agent_id}/password",
        json={"new_password": "admin-set-2"},
        headers=_bearer(admin_tok),
    )
    assert r.json()["ok"] is True
    _assert_handshake_4401(env, agent_tok)
    _assert_ws_ok(env, admin_tok)


def test_ws_recheck_unit_closes_on_version_mismatch(env, monkeypatch):
    """_presence_keepalive 單元層級:DB 版本已遞增 → 下一次複查即 close(4401)。"""
    from app.services import presence

    class _FakeWS:
        def __init__(self) -> None:
            from starlette.websockets import WebSocketState

            self._state = WebSocketState
            self.application_state = WebSocketState.CONNECTED
            self.closed_with: int | None = None

        async def close(self, code: int = 1000, reason=None):  # noqa: ANN001
            self.closed_with = code
            self.application_state = self._state.DISCONNECTED

    monkeypatch.setattr(conv_api, "WS_PRESENCE_REFRESH_SECONDS", 0.01)
    monkeypatch.setattr(conv_api, "WS_AUTH_RECHECK_TICKS", 1)
    w = _seed(env)
    tok = _login(env, w.agent_email)

    async def _bump(db):
        from app.services.iam import bump_token_version

        await bump_token_version(db, await db.get(Staff, w.agent_id))
        await db.commit()

    _run(env, _bump)
    ws = _FakeWS()
    conn = presence.Connection(staff_id=str(w.agent_id))
    asyncio.run(
        asyncio.wait_for(conv_api._presence_keepalive(conn, tok, ws, asyncio.Lock()), timeout=2)
    )
    assert ws.closed_with == 4401


def test_decoded_claim_is_int():
    """jose 解出的 tv 為 int(非 float / str),嚴格比對才不會誤判。"""
    tok = create_access_token({"sub": str(uuid.uuid4()), "tenant_id": str(uuid.uuid4()), "tv": 7})
    payload = decode_access_token(tok)
    assert type(payload["tv"]) is int and payload["tv"] == 7
