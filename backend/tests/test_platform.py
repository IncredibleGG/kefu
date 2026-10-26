"""平台超級管理員(跨租戶管理)測試 —— app/api/v1/platform.py。

原則同 test_plans.py / test_reporting_billing.py:不依賴外部 Postgres。
- ``require_platform_admin`` 用真實 JWT(create_access_token 簽發)驗 401/403/放行;
- 端點掛載以 router.routes 路徑集合 + 每條 route 皆掛 require_platform_admin 驗證;
- 各 handler 以輕量 fake async session 餵預定結果驗證信封與副作用;
- 開通租戶把種子服務(seed_permissions/seed_plans/ensure_free_subscription)以
  monkeypatch 換成 AsyncMock,聚焦驗證本模組自身的建立與角色指派流程。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.core.security import create_access_token
from app.models.billing import Plan, Subscription
from app.models.iam import Staff, Role
from app.models.tenancy import Tenant


# --------------------------------------------------------------------------- #
# fake async session:execute 依 _results 佇列 FIFO 回傳
# --------------------------------------------------------------------------- #
class _FakeResult:
    def __init__(self, objs: list):
        self._objs = list(objs)

    def scalar_one(self):
        return self._objs[0]

    def scalar_one_or_none(self):
        return self._objs[0] if self._objs else None

    def scalars(self):
        return self

    def all(self):
        return list(self._objs)


class _FakeSession:
    def __init__(self, results: list[list] | None = None):
        self._results = list(results or [])
        self.added: list = []
        self.flush_count = 0
        self.commit_count = 0

    async def execute(self, *_a, **_k):
        return _FakeResult(self._results.pop(0) if self._results else [])

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        self.flush_count += 1
        for obj in self.added:
            if getattr(obj, "id", None) is None:
                obj.id = uuid.uuid4()

    async def commit(self):
        self.commit_count += 1

    async def refresh(self, _obj):
        return None


def _principal():
    from app.api.v1.platform import PlatformPrincipal

    return PlatformPrincipal(claims={"is_platform_admin": True}, staff_id=uuid.uuid4())


def _tenant(name="Acme", slug="acme", is_active=True) -> Tenant:
    t = Tenant(name=name, slug=slug, is_active=is_active)
    t.id = uuid.uuid4()
    t.created_at = datetime.now(timezone.utc)
    return t


def _plan(tenant_id: uuid.UUID, code="pro") -> Plan:
    return Plan(id=uuid.uuid4(), tenant_id=tenant_id, code=code, name=code.title())


def _sub(tenant_id: uuid.UUID, plan_id: uuid.UUID) -> Subscription:
    return Subscription(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        plan_id=plan_id,
        status="active",
        started_at=datetime.now(timezone.utc),
    )


# =========================================================================== #
# require_platform_admin
# =========================================================================== #
@pytest.mark.asyncio
async def test_guard_missing_token_401():
    from fastapi import HTTPException

    from app.api.v1.platform import require_platform_admin

    with pytest.raises(HTTPException) as ei:
        await require_platform_admin(_FakeSession(), authorization=None)
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_guard_non_bearer_401():
    from fastapi import HTTPException

    from app.api.v1.platform import require_platform_admin

    with pytest.raises(HTTPException) as ei:
        await require_platform_admin(_FakeSession(), authorization="Token abc")
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_guard_invalid_token_401():
    from fastapi import HTTPException

    from app.api.v1.platform import require_platform_admin

    with pytest.raises(HTTPException) as ei:
        await require_platform_admin(_FakeSession(), authorization="Bearer not-a-jwt")
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_guard_without_claim_403():
    from fastapi import HTTPException

    from app.api.v1.platform import require_platform_admin

    token = create_access_token({"sub": str(uuid.uuid4()), "tenant_id": str(uuid.uuid4()), "roles": ["admin"]})
    with pytest.raises(HTTPException) as ei:
        await require_platform_admin(_FakeSession(), authorization=f"Bearer {token}")
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_guard_false_claim_403():
    from fastapi import HTTPException

    from app.api.v1.platform import require_platform_admin

    token = create_access_token({"sub": str(uuid.uuid4()), "is_platform_admin": False})
    with pytest.raises(HTTPException) as ei:
        await require_platform_admin(_FakeSession(), authorization=f"Bearer {token}")
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_guard_true_claim_passes_and_parses_sub():
    from app.api.v1.platform import require_platform_admin

    sid = uuid.uuid4()
    token = create_access_token({"sub": str(sid), "is_platform_admin": True})
    # DB 回查命中一個有效超管列(fake 只需帶 token_version;token 無 tv claim 視為版本 0)
    db = _FakeSession(results=[[SimpleNamespace(token_version=0)]])
    principal = await require_platform_admin(db, authorization=f"Bearer {token}")
    assert principal.staff_id == sid
    assert principal.claims["is_platform_admin"] is True


@pytest.mark.asyncio
async def test_guard_true_claim_without_sub_403():
    """無 sub 的超管 token 無法回查 Staff 現況 → 拒絕(撤銷不可驗證即不放行)。"""
    from fastapi import HTTPException

    from app.api.v1.platform import require_platform_admin

    token = create_access_token({"is_platform_admin": True})
    with pytest.raises(HTTPException) as ei:
        await require_platform_admin(_FakeSession(), authorization=f"Bearer {token}")
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_guard_revoked_admin_403():
    """claim 仍為 True,但 DB 現況查無有效超管列(被降權 / 停用 / 軟刪)→ 403(撤銷即時生效)。"""
    from fastapi import HTTPException

    from app.api.v1.platform import require_platform_admin

    token = create_access_token({"sub": str(uuid.uuid4()), "is_platform_admin": True})
    db = _FakeSession(results=[[]])  # 回查無符合列
    with pytest.raises(HTTPException) as ei:
        await require_platform_admin(db, authorization=f"Bearer {token}")
    assert ei.value.status_code == 403


# =========================================================================== #
# 路由掛載 + 全端點守衛
# =========================================================================== #
def test_router_exposes_all_platform_endpoints():
    from app.api.v1 import platform

    paths = {r.path for r in platform.router.routes}
    assert paths == {
        "/tenants",
        "/tenants/{tenant_id}/suspend",
        "/tenants/{tenant_id}/activate",
        "/tenants/{tenant_id}/set-plan",
        "/overview",
    }


def test_every_route_requires_platform_admin():
    from app.api.v1 import platform
    from app.api.v1.platform import require_platform_admin

    def _walk(dep) -> bool:
        for sub in dep.dependencies:
            if sub.call is require_platform_admin or _walk(sub):
                return True
        return False

    for route in platform.router.routes:
        assert _walk(route.dependant), f"{route.path} 未掛 require_platform_admin"


# =========================================================================== #
# 開通租戶
# =========================================================================== #
@pytest.mark.asyncio
async def test_provision_tenant_creates_tenant_admin_role_and_staff(monkeypatch):
    import app.api.v1.platform as plat
    from app.core.security import verify_password

    monkeypatch.setattr(plat, "seed_default_permissions", AsyncMock(return_value=0))
    monkeypatch.setattr(plat.plan_svc, "seed_default_plans", AsyncMock(return_value=[]))
    monkeypatch.setattr(plat.plan_svc, "ensure_free_subscription", AsyncMock(return_value=None))

    db = _FakeSession(results=[[]])  # slug 查重 → 無
    body = plat.TenantProvisionIn(
        name="Acme", slug="acme", admin_email="admin@acme.com", admin_password="secret123"
    )
    resp = await plat.provision_tenant(body, _principal(), db)

    assert resp["ok"] is True
    data = resp["data"]
    assert data["tenant"]["slug"] == "acme"
    assert data["admin"]["email"] == "admin@acme.com"
    assert data["admin"]["role"] == "admin"
    # 種子服務被以新租戶 id 呼叫
    plat.seed_default_permissions.assert_awaited_once()
    plat.plan_svc.seed_default_plans.assert_awaited_once()
    plat.plan_svc.ensure_free_subscription.assert_awaited_once()
    # 建立了 Tenant + admin Role + admin Staff
    kinds = {type(o).__name__ for o in db.added}
    assert {"Tenant", "Role", "Staff"} <= kinds
    role = next(o for o in db.added if isinstance(o, Role))
    assert role.name == "admin" and role.is_system is True
    staff = next(o for o in db.added if isinstance(o, Staff))
    # 密碼經雜湊、絕不回傳明文,且第一個坐席非平台超管
    assert staff.password_hash != "secret123"
    assert verify_password("secret123", staff.password_hash)
    assert staff.is_platform_admin is False
    assert "secret123" not in str(resp)


@pytest.mark.asyncio
async def test_provision_tenant_rejects_duplicate_slug():
    import app.api.v1.platform as plat

    db = _FakeSession(results=[[_tenant(slug="taken")]])  # slug 已存在
    body = plat.TenantProvisionIn(
        name="Dup", slug="taken", admin_email="a@b.com", admin_password="secret123"
    )
    resp = await plat.provision_tenant(body, _principal(), db)
    assert resp["ok"] is False
    assert resp["error"]["code"] == "TENANT_SLUG_TAKEN"
    assert db.added == []


# =========================================================================== #
# 停用 / 啟用
# =========================================================================== #
@pytest.mark.asyncio
async def test_suspend_sets_inactive():
    import app.api.v1.platform as plat

    t = _tenant(is_active=True)
    db = _FakeSession(results=[[t]])
    resp = await plat.suspend_tenant(t.id, _principal(), db)
    assert resp["ok"] is True
    assert resp["data"]["is_active"] is False
    assert t.is_active is False


@pytest.mark.asyncio
async def test_activate_sets_active():
    import app.api.v1.platform as plat

    t = _tenant(is_active=False)
    db = _FakeSession(results=[[t]])
    resp = await plat.activate_tenant(t.id, _principal(), db)
    assert resp["ok"] is True
    assert resp["data"]["is_active"] is True
    assert t.is_active is True


@pytest.mark.asyncio
async def test_suspend_missing_tenant_errors():
    import app.api.v1.platform as plat

    db = _FakeSession(results=[[]])
    resp = await plat.suspend_tenant(uuid.uuid4(), _principal(), db)
    assert resp["ok"] is False
    assert resp["error"]["code"] == "TENANT_NOT_FOUND"


# =========================================================================== #
# 指派方案
# =========================================================================== #
@pytest.mark.asyncio
async def test_set_plan_requires_plan_ref():
    import app.api.v1.platform as plat

    resp = await plat.set_tenant_plan(uuid.uuid4(), plat.SetPlanIn(), _principal(), _FakeSession())
    assert resp["ok"] is False
    assert resp["error"]["code"] == "PLAN_REQUIRED"


@pytest.mark.asyncio
async def test_set_plan_creates_subscription():
    import app.api.v1.platform as plat

    t = _tenant()
    p = _plan(t.id, code="enterprise")
    db = _FakeSession(results=[[t], [p]])  # 取租戶 → 取方案
    resp = await plat.set_tenant_plan(
        t.id, plat.SetPlanIn(plan_id=p.id, seats=5), _principal(), db
    )
    assert resp["ok"] is True
    assert resp["data"]["plan"]["code"] == "enterprise"
    sub = next(o for o in db.added if isinstance(o, Subscription))
    assert sub.tenant_id == t.id and sub.plan_id == p.id
    assert sub.status == "active" and sub.seats == 5


@pytest.mark.asyncio
async def test_set_plan_unknown_plan_errors():
    import app.api.v1.platform as plat

    t = _tenant()
    db = _FakeSession(results=[[t], []])  # 租戶存在,方案不存在
    resp = await plat.set_tenant_plan(
        t.id, plat.SetPlanIn(plan_code="ghost"), _principal(), db
    )
    assert resp["ok"] is False
    assert resp["error"]["code"] == "PLAN_NOT_FOUND"


@pytest.mark.asyncio
async def test_set_plan_missing_tenant_errors():
    import app.api.v1.platform as plat

    db = _FakeSession(results=[[]])  # 租戶不存在
    resp = await plat.set_tenant_plan(
        uuid.uuid4(), plat.SetPlanIn(plan_code="pro"), _principal(), db
    )
    assert resp["ok"] is False
    assert resp["error"]["code"] == "TENANT_NOT_FOUND"


# =========================================================================== #
# 租戶清單(跨租戶概況)
# =========================================================================== #
@pytest.mark.asyncio
async def test_list_tenants_aggregates_plan_and_counts():
    import app.api.v1.platform as plat

    t1 = _tenant(name="One", slug="one")
    t2 = _tenant(name="Two", slug="two")
    p1 = _plan(t1.id, code="pro")
    s1 = _sub(t1.id, p1.id)
    db = _FakeSession(
        results=[
            [2],                       # count_query → scalar_one
            [t1, t2],                  # 租戶頁
            [(t1.id, 3), (t2.id, 1)],  # 坐席數
            [(t1.id, 5)],              # 會話數(t2 無)
            [s1],                      # 生效訂閱
            [p1],                      # 方案
        ]
    )
    resp = await plat.list_tenants(_principal(), db, page=1, size=20, q=None, is_active=None)
    assert resp["ok"] is True
    assert resp["data"]["total"] == 2
    items = {i["slug"]: i for i in resp["data"]["items"]}
    assert items["one"]["plan"]["code"] == "pro"
    assert items["one"]["seat_count"] == 3
    assert items["one"]["session_count"] == 5
    assert items["two"]["plan"] is None
    assert items["two"]["seat_count"] == 1
    assert items["two"]["session_count"] == 0


# =========================================================================== #
# 平台總覽
# =========================================================================== #
@pytest.mark.asyncio
async def test_overview_aggregates_across_tenants():
    import app.api.v1.platform as plat

    t1 = _tenant(name="One", slug="one", is_active=True)
    t2 = _tenant(name="Two", slug="two", is_active=False)
    p1 = _plan(t1.id, code="pro")
    s1 = _sub(t1.id, p1.id)
    db = _FakeSession(
        results=[
            [(t1.id, True), (t2.id, False)],  # 租戶 (id, is_active)
            [7],                              # 總坐席 → scalar_one
            [42],                             # 總會話 → scalar_one
            [s1],                             # 生效訂閱(所有租戶)
            [p1],                             # 方案
        ]
    )
    resp = await plat.platform_overview(_principal(), db)
    assert resp["ok"] is True
    data = resp["data"]
    assert data["tenants"] == {"total": 2, "active": 1, "inactive": 1}
    assert data["staff_total"] == 7
    assert data["session_total"] == 42
    assert data["plan_distribution"] == {"pro": 1, "none": 1}
