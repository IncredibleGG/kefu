"""平台超級管理員 API(跨租戶管理)——「平台方 / 轉售者」層級,凌駕單一租戶。

註冊建議(整合者掛載,本模組不碰 main.py):
    app.include_router(platform.router, prefix="/api/v1/platform", tags=["platform"])

本模組自成一體的平台認證:
- 不依賴 app.core.deps.CurrentStaff(那是租戶範圍的 Principal),因為平台端點必須
  跨租戶,查詢**不受單一 tenant_id 限制**。
- ``require_platform_admin`` 直接讀 ``Authorization: Bearer``,以
  ``app.core.security.decode_access_token`` 解 JWT,檢查 payload 的
  ``is_platform_admin`` 為真;否則回 403(缺 token / token 失效回 401)。
- **假設整合者於登入簽發 JWT 時,已對 Staff.is_platform_admin 為真者放入
  ``is_platform_admin: true`` claim**(見檔尾整合備註)。

所有端點皆需 ``require_platform_admin``,回應統一走 ok()/err() 信封。
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, insert, select

from app.core.deps import DbSession
from app.core.response import err, ok
from app.core.security import decode_access_token, hash_password
from app.models.billing import Plan, Subscription
from app.models.conversation import Session
from app.models.iam import Role, Staff, staff_role
from app.models.tenancy import Tenant
from app.services import plans as plan_svc
from app.services.iam import count_query, paginate_params, seed_default_permissions

router = APIRouter()


# =========================================================================== #
# 平台認證(自成一體,不依賴租戶範圍的 CurrentStaff)
# =========================================================================== #
@dataclass
class PlatformPrincipal:
    """通過平台認證的呼叫者。跨租戶,不綁定單一 tenant_id。"""

    claims: dict[str, Any]
    staff_id: uuid.UUID | None = None


async def require_platform_admin(
    db: DbSession,
    authorization: Annotated[str | None, Header()] = None,
) -> PlatformPrincipal:
    """平台超管守衛:讀 Bearer JWT + **每請求回查 DB 現況**,確認呼叫者仍是有效超管。

    - 缺 / 非 Bearer → 401。
    - token 無效 / 過期 → 401。
    - JWT 無 ``is_platform_admin`` claim、或 ``sub`` 缺失/非法 → 403。
    - **回查 Staff 現況**:必須 is_active、未軟刪、且**當前** is_platform_admin 為真;
      任一不符 → 403。這樣被降權 / 停用 / 軟刪的超管於下一個請求立即失效,不必等
      24h token 過期(撤銷即時生效)。對齊 deps.get_current_principal 的租戶級回查,
      但平台超管為最高權限,故此處回查後才放行(不僅信任 claim)。
    刻意不解析 / 不要求 tenant_id:平台端點跨租戶運作。
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    payload = decode_access_token(authorization.split(" ", 1)[1])
    if not payload:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token")
    if not payload.get("is_platform_admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="platform admin required")
    sub = payload.get("sub")
    staff_id: uuid.UUID | None = None
    if sub:
        try:
            staff_id = uuid.UUID(str(sub))
        except ValueError:
            staff_id = None
    if staff_id is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="platform admin required")
    # 每請求回查:token 內的 is_platform_admin 只是 claim,權限撤銷後仍殘留於未過期
    # token,故以 DB 現況為準。
    staff = (
        await db.execute(
            select(Staff).where(
                Staff.id == staff_id,
                Staff.is_active.is_(True),
                Staff.deleted_at.is_(None),
                Staff.is_platform_admin.is_(True),
            )
        )
    ).scalar_one_or_none()
    if staff is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="platform admin required")
    return PlatformPrincipal(claims=payload, staff_id=staff_id)


PlatformAdmin = Annotated[PlatformPrincipal, Depends(require_platform_admin)]


# =========================================================================== #
# Pydantic schema
# =========================================================================== #
class TenantProvisionIn(BaseModel):
    """開通新租戶所需:租戶基本資料 + 第一個 admin 坐席的登入帳密。"""

    name: str = Field(min_length=1, max_length=200)
    slug: str = Field(min_length=1, max_length=100)
    admin_email: str = Field(min_length=3, max_length=255)
    admin_password: str = Field(min_length=6, max_length=128)
    admin_display_name: str | None = Field(default=None, max_length=200)
    branding: dict | None = None
    llm_config: dict | None = None


class SetPlanIn(BaseModel):
    """指派方案:以 plan_id 或 plan_code(擇一)指定該租戶名下的方案。"""

    plan_id: uuid.UUID | None = None
    plan_code: str | None = Field(default=None, max_length=60)
    byo_key: bool = False
    seats: int = Field(default=1, ge=1)


# =========================================================================== #
# 序列化
# =========================================================================== #
def _plan_brief(p: Plan | None) -> dict | None:
    if p is None:
        return None
    return {"id": str(p.id), "code": p.code, "name": p.name}


def _subscription_out(s: Subscription) -> dict:
    return {
        "id": str(s.id),
        "tenant_id": str(s.tenant_id),
        "plan_id": str(s.plan_id),
        "status": s.status,
        "byo_key": s.byo_key,
        "seats": s.seats,
    }


# =========================================================================== #
# 跨租戶聚合小工具(平台層:查詢不受單一 tenant_id 限制)
# =========================================================================== #
async def _latest_effective_subs(
    db, tenant_ids: list[uuid.UUID] | None = None
) -> dict[uuid.UUID, Subscription]:
    """回傳 {tenant_id: 最新一筆生效訂閱}。tenant_ids 為 None 時涵蓋所有租戶。

    生效 = 未刪除且 status 屬 EFFECTIVE_STATUSES;同租戶取 started_at 最新者。
    """
    conds = [
        Subscription.deleted_at.is_(None),
        Subscription.status.in_(plan_svc.EFFECTIVE_STATUSES),
    ]
    if tenant_ids is not None:
        if not tenant_ids:
            return {}
        conds.append(Subscription.tenant_id.in_(tenant_ids))
    rows = (
        await db.execute(
            select(Subscription).where(and_(*conds)).order_by(Subscription.started_at.desc())
        )
    ).scalars().all()
    latest: dict[uuid.UUID, Subscription] = {}
    for sub in rows:  # 已依 started_at desc 排序,首見即最新
        latest.setdefault(sub.tenant_id, sub)
    return latest


async def _plans_by_id(db, plan_ids: set[uuid.UUID]) -> dict[uuid.UUID, Plan]:
    if not plan_ids:
        return {}
    rows = (
        await db.execute(select(Plan).where(Plan.id.in_(plan_ids)))
    ).scalars().all()
    return {p.id: p for p in rows}


async def _counts_by_tenant(db, model, tenant_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """對某租戶範圍模型(Staff / Session)依 tenant_id 聚合筆數(排除軟刪)。"""
    if not tenant_ids:
        return {}
    rows = (
        await db.execute(
            select(model.tenant_id, func.count())
            .where(model.tenant_id.in_(tenant_ids), model.deleted_at.is_(None))
            .group_by(model.tenant_id)
        )
    ).all()
    return {tid: int(cnt) for tid, cnt in rows}


async def _get_tenant(db, tenant_id: uuid.UUID) -> Tenant | None:
    return (
        await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    ).scalar_one_or_none()


# =========================================================================== #
# 租戶清單(跨租戶概況)
# =========================================================================== #
@router.get("/tenants")
async def list_tenants(
    _admin: PlatformAdmin,
    db: DbSession,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    q: str | None = Query(None, description="以 name / slug 模糊搜尋"),
    is_active: bool | None = Query(None, description="依啟用狀態過濾"),
):
    """列出**所有**租戶(跨租戶),含目前方案 / 坐席數 / 會話數概況。分頁 + 搜尋。"""
    page, size, offset = paginate_params(page, size)
    stmt = select(Tenant)
    if q:
        like = f"%{q}%"
        stmt = stmt.where((Tenant.name.ilike(like)) | (Tenant.slug.ilike(like)))
    if is_active is not None:
        stmt = stmt.where(Tenant.is_active.is_(is_active))

    total = await count_query(db, stmt)
    tenants = (
        await db.execute(stmt.order_by(Tenant.created_at.desc()).offset(offset).limit(size))
    ).scalars().all()

    tenant_ids = [t.id for t in tenants]
    seat_counts = await _counts_by_tenant(db, Staff, tenant_ids)
    session_counts = await _counts_by_tenant(db, Session, tenant_ids)
    subs = await _latest_effective_subs(db, tenant_ids)
    plans = await _plans_by_id(db, {s.plan_id for s in subs.values()})

    items = []
    for t in tenants:
        sub = subs.get(t.id)
        plan = plans.get(sub.plan_id) if sub else None
        items.append(
            {
                "id": str(t.id),
                "name": t.name,
                "slug": t.slug,
                "is_active": t.is_active,
                "created_at": t.created_at.isoformat() if t.created_at else None,
                "plan": _plan_brief(plan),
                "seat_count": seat_counts.get(t.id, 0),
                "session_count": session_counts.get(t.id, 0),
            }
        )
    return ok({"items": items, "total": total, "page": page, "size": size})


# =========================================================================== #
# 開通新租戶
# =========================================================================== #
@router.post("/tenants")
async def provision_tenant(body: TenantProvisionIn, _admin: PlatformAdmin, db: DbSession):
    """開通新租戶:建 Tenant + 種預設權限 / admin 角色 / 預設方案(Free 訂閱)
    + 建該租戶第一個 admin 坐席並指派 admin 角色。回新租戶與登入資訊(不回密碼)。
    """
    dup = (
        await db.execute(select(Tenant).where(Tenant.slug == body.slug))
    ).scalar_one_or_none()
    if dup:
        return err("TENANT_SLUG_TAKEN", f"slug 已被使用: {body.slug}")

    tenant = Tenant(
        name=body.name,
        slug=body.slug,
        branding=body.branding,
        llm_config=body.llm_config,
        is_active=True,
    )
    db.add(tenant)
    await db.flush()  # 取得 tenant.id

    # 種預設權限碼 + admin 系統角色(與 tenancy.create_tenant 一致)
    await seed_default_permissions(db, tenant.id)
    admin_role = Role(
        tenant_id=tenant.id, name="admin", description="系統管理員(全權)", is_system=True
    )
    db.add(admin_role)
    await db.flush()  # 取得 admin_role.id

    # 種預設方案(Free/Pro/Enterprise)並指派 Free 訂閱
    await plan_svc.seed_default_plans(db, tenant.id)
    await plan_svc.ensure_free_subscription(db, tenant.id)

    # 該租戶第一個 admin 坐席(租戶管理員,非平台超管 → is_platform_admin 保持 False)
    admin_staff = Staff(
        tenant_id=tenant.id,
        email=body.admin_email,
        password_hash=hash_password(body.admin_password),
        display_name=body.admin_display_name or body.admin_email,
        status="offline",
        is_active=True,
        is_platform_admin=False,  # 租戶管理員,非平台超管
    )
    db.add(admin_staff)
    await db.flush()  # 取得 admin_staff.id
    await db.execute(
        insert(staff_role).values(staff_id=admin_staff.id, role_id=admin_role.id)
    )

    await db.commit()
    await db.refresh(tenant)
    return ok(
        {
            "tenant": {
                "id": str(tenant.id),
                "name": tenant.name,
                "slug": tenant.slug,
                "is_active": tenant.is_active,
                "created_at": tenant.created_at.isoformat() if tenant.created_at else None,
            },
            "admin": {
                "staff_id": str(admin_staff.id),
                "email": admin_staff.email,
                "display_name": admin_staff.display_name,
                "role": "admin",
            },
        }
    )


# =========================================================================== #
# 停用 / 啟用租戶(只設旗標;登入攔停用由整合者處理)
# =========================================================================== #
async def _set_tenant_active(db, tenant_id: uuid.UUID, active: bool):
    tenant = await _get_tenant(db, tenant_id)
    if not tenant:
        return None
    tenant.is_active = active
    await db.commit()
    await db.refresh(tenant)
    return tenant


@router.patch("/tenants/{tenant_id}/suspend")
async def suspend_tenant(tenant_id: uuid.UUID, _admin: PlatformAdmin, db: DbSession):
    """停用租戶(Tenant.is_active=False)。整合者需於登入流程攔阻停用租戶的坐席。"""
    tenant = await _set_tenant_active(db, tenant_id, False)
    if tenant is None:
        return err("TENANT_NOT_FOUND", "租戶不存在")
    return ok({"id": str(tenant.id), "is_active": tenant.is_active})


@router.patch("/tenants/{tenant_id}/activate")
async def activate_tenant(tenant_id: uuid.UUID, _admin: PlatformAdmin, db: DbSession):
    """重新啟用租戶(Tenant.is_active=True)。"""
    tenant = await _set_tenant_active(db, tenant_id, True)
    if tenant is None:
        return err("TENANT_NOT_FOUND", "租戶不存在")
    return ok({"id": str(tenant.id), "is_active": tenant.is_active})


# =========================================================================== #
# 指派方案(用既有 plans/billing 邏輯切換該租戶訂閱)
# =========================================================================== #
@router.post("/tenants/{tenant_id}/set-plan")
async def set_tenant_plan(
    tenant_id: uuid.UUID, body: SetPlanIn, _admin: PlatformAdmin, db: DbSession
):
    """為指定租戶切換訂閱方案。方案須為該租戶名下(tenant_id 發行)的方案。

    切換方式與 billing.create_subscription 一致:新增一筆 status=active 的訂閱;
    生效方案解析(plans._effective_plan)取最新一筆,故新訂閱即生效。
    """
    if body.plan_id is None and not body.plan_code:
        return err("PLAN_REQUIRED", "需提供 plan_id 或 plan_code")

    tenant = await _get_tenant(db, tenant_id)
    if not tenant:
        return err("TENANT_NOT_FOUND", "租戶不存在")

    plan_conds = [Plan.tenant_id == tenant_id, Plan.deleted_at.is_(None)]
    if body.plan_id is not None:
        plan_conds.append(Plan.id == body.plan_id)
    else:
        plan_conds.append(Plan.code == body.plan_code)
    plan = (await db.execute(select(Plan).where(and_(*plan_conds)))).scalar_one_or_none()
    if not plan:
        return err("PLAN_NOT_FOUND", "方案不存在或不屬於該租戶")

    sub = Subscription(
        tenant_id=tenant_id,
        plan_id=plan.id,
        status="active",
        byo_key=body.byo_key,
        seats=body.seats,
    )
    db.add(sub)
    await db.commit()
    await db.refresh(sub)
    return ok({"subscription": _subscription_out(sub), "plan": _plan_brief(plan)})


# =========================================================================== #
# 平台總覽(跨租戶聚合)
# =========================================================================== #
@router.get("/overview")
async def platform_overview(_admin: PlatformAdmin, db: DbSession):
    """平台總覽:租戶數 / 啟用數 / 總坐席 / 總會話 / 各方案分佈(跨租戶)。"""
    tenant_rows = (await db.execute(select(Tenant.id, Tenant.is_active))).all()
    total_tenants = len(tenant_rows)
    active_tenants = sum(1 for _tid, is_active in tenant_rows if is_active)

    total_staff = int(
        (
            await db.execute(
                select(func.count()).select_from(Staff).where(Staff.deleted_at.is_(None))
            )
        ).scalar_one()
    )
    total_sessions = int(
        (
            await db.execute(
                select(func.count()).select_from(Session).where(Session.deleted_at.is_(None))
            )
        ).scalar_one()
    )

    subs = await _latest_effective_subs(db, tenant_ids=None)
    plans = await _plans_by_id(db, {s.plan_id for s in subs.values()})

    distribution: dict[str, int] = {}
    for _tid, is_active in tenant_rows:
        sub = subs.get(_tid)
        plan = plans.get(sub.plan_id) if sub else None
        code = plan.code if plan else "none"
        distribution[code] = distribution.get(code, 0) + 1

    return ok(
        {
            "tenants": {
                "total": total_tenants,
                "active": active_tenants,
                "inactive": total_tenants - active_tenants,
            },
            "staff_total": total_staff,
            "session_total": total_sessions,
            "plan_distribution": distribution,
        }
    )
