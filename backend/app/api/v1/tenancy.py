"""M1 tenancy API:租戶(含白牌/ BYO-Key LLM 設定)與組織樹。

註冊建議:app.include_router(tenancy.router, prefix="/api/v1/tenancy", tags=["tenancy"])

規則:
- 所有查詢一律以 principal.tenant_id 過濾(租戶隔離);唯「建立租戶」為轉售/開通動作例外。
- 回應統一走 ok()/err();llm_config 回傳前一律遮罩金鑰。
- 軟刪:以 deleted_at 標記,查詢排除。
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.models.iam import Role
from app.models.tenancy import Organization, Tenant
from app.services.iam import mask_llm_config, seed_default_permissions

router = APIRouter()


# --------------------------------------------------------------------------- #
# Pydantic schema
# --------------------------------------------------------------------------- #
class TenantCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    slug: str = Field(min_length=1, max_length=100)
    branding: dict | None = None
    llm_config: dict | None = None


class TenantUpdateIn(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    branding: dict | None = None  # 傳入即整段覆寫白牌設定
    llm_config: dict | None = None  # 傳入即整段覆寫 BYO-Key 設定
    is_active: bool | None = None


class OrganizationCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    parent_id: uuid.UUID | None = None


class OrganizationUpdateIn(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    parent_id: uuid.UUID | None = None


# --------------------------------------------------------------------------- #
# 序列化
# --------------------------------------------------------------------------- #
def _tenant_dict(t: Tenant) -> dict:
    return {
        "id": str(t.id),
        "name": t.name,
        "slug": t.slug,
        "branding": t.branding,
        "llm_config": mask_llm_config(t.llm_config),  # 遮罩後回傳
        "is_active": t.is_active,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


def _org_dict(o: Organization) -> dict:
    return {
        "id": str(o.id),
        "name": o.name,
        "parent_id": str(o.parent_id) if o.parent_id else None,
        "tenant_id": str(o.tenant_id),
        "created_at": o.created_at.isoformat() if o.created_at else None,
    }


# --------------------------------------------------------------------------- #
# 租戶
# --------------------------------------------------------------------------- #
@router.post("/tenants")
async def create_tenant(body: TenantCreateIn, principal: CurrentStaff, db: DbSession):
    """建立新租戶(轉售/開通用)。同時種入預設權限碼與一個 admin 系統角色。"""
    principal.require("tenant.manage")

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
    await db.flush()

    # 開通即備妥權限種子與 admin 角色,方便後續建立坐席
    await seed_default_permissions(db, tenant.id)
    db.add(Role(tenant_id=tenant.id, name="admin", description="系統管理員(全權)", is_system=True))
    # 種預設方案(Free/Pro/Enterprise)並指派 Free 訂閱,讓新租戶可自助查看/升級方案
    from app.services import plans as _plans

    await _plans.seed_default_plans(db, tenant.id)
    await _plans.ensure_free_subscription(db, tenant.id)
    await db.commit()
    await db.refresh(tenant)
    return ok(_tenant_dict(tenant))


@router.get("/tenants/me")
async def get_my_tenant(principal: CurrentStaff, db: DbSession):
    """取得目前登入者所屬租戶。"""
    tenant = (
        await db.execute(select(Tenant).where(Tenant.id == principal.tenant_id))
    ).scalar_one_or_none()
    if not tenant:
        return err("TENANT_NOT_FOUND", "租戶不存在")
    return ok(_tenant_dict(tenant))


@router.get("/tenants/{tenant_id}")
async def get_tenant(tenant_id: uuid.UUID, principal: CurrentStaff, db: DbSession):
    """查詢租戶。僅允許查自己所屬租戶(避免跨租戶洩漏)。"""
    if tenant_id != principal.tenant_id:
        principal.require("tenant.manage")  # 非本租戶則需管理權(通常仍拒絕)
        if tenant_id != principal.tenant_id:
            return err("TENANT_FORBIDDEN", "不可查詢其他租戶")
    tenant = (
        await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    ).scalar_one_or_none()
    if not tenant:
        return err("TENANT_NOT_FOUND", "租戶不存在")
    return ok(_tenant_dict(tenant))


@router.patch("/tenants/{tenant_id}")
async def update_tenant(
    tenant_id: uuid.UUID, body: TenantUpdateIn, principal: CurrentStaff, db: DbSession
):
    """更新租戶:名稱、白牌 branding、llm_config(BYO-Key)、啟停用。僅限本租戶。"""
    principal.require("tenant.manage")
    if tenant_id != principal.tenant_id:
        return err("TENANT_FORBIDDEN", "不可修改其他租戶")

    tenant = (
        await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    ).scalar_one_or_none()
    if not tenant:
        return err("TENANT_NOT_FOUND", "租戶不存在")

    data = body.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        tenant.name = data["name"]
    if "branding" in data:
        tenant.branding = data["branding"]
    if "llm_config" in data:
        tenant.llm_config = data["llm_config"]  # 原文寫入 DB,回傳時遮罩
    if "is_active" in data and data["is_active"] is not None:
        tenant.is_active = data["is_active"]

    await db.commit()
    await db.refresh(tenant)
    return ok(_tenant_dict(tenant))


# --------------------------------------------------------------------------- #
# 組織樹(Organization)
# --------------------------------------------------------------------------- #
async def _get_org(db, tenant_id: uuid.UUID, org_id: uuid.UUID) -> Organization | None:
    return (
        await db.execute(
            select(Organization).where(
                Organization.id == org_id,
                Organization.tenant_id == tenant_id,
                Organization.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


@router.post("/organizations")
async def create_organization(
    body: OrganizationCreateIn, principal: CurrentStaff, db: DbSession
):
    principal.require("organization.manage")
    if body.parent_id is not None:
        parent = await _get_org(db, principal.tenant_id, body.parent_id)
        if not parent:
            return err("ORG_PARENT_NOT_FOUND", "上層組織不存在")

    org = Organization(tenant_id=principal.tenant_id, name=body.name, parent_id=body.parent_id)
    db.add(org)
    await db.commit()
    await db.refresh(org)
    return ok(_org_dict(org))


@router.get("/organizations")
async def list_organizations(
    principal: CurrentStaff,
    db: DbSession,
    tree: bool = Query(False, description="true 時回傳巢狀樹,否則回平面清單"),
):
    rows = (
        await db.execute(
            select(Organization).where(
                Organization.tenant_id == principal.tenant_id,
                Organization.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    flat = [_org_dict(o) for o in rows]
    if not tree:
        return ok({"items": flat, "total": len(flat)})

    # 組巢狀樹:每個節點加 children
    by_id = {d["id"]: {**d, "children": []} for d in flat}
    roots = []
    for node in by_id.values():
        pid = node["parent_id"]
        if pid and pid in by_id:
            by_id[pid]["children"].append(node)
        else:
            roots.append(node)
    return ok({"tree": roots, "total": len(flat)})


@router.get("/organizations/{org_id}")
async def get_organization(org_id: uuid.UUID, principal: CurrentStaff, db: DbSession):
    org = await _get_org(db, principal.tenant_id, org_id)
    if not org:
        return err("ORG_NOT_FOUND", "組織不存在")
    return ok(_org_dict(org))


@router.patch("/organizations/{org_id}")
async def update_organization(
    org_id: uuid.UUID, body: OrganizationUpdateIn, principal: CurrentStaff, db: DbSession
):
    principal.require("organization.manage")
    org = await _get_org(db, principal.tenant_id, org_id)
    if not org:
        return err("ORG_NOT_FOUND", "組織不存在")

    data = body.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        org.name = data["name"]
    if "parent_id" in data:
        new_parent = data["parent_id"]
        if new_parent is not None:
            if new_parent == org_id:
                return err("ORG_CYCLE", "組織不可以自己為上層")
            parent = await _get_org(db, principal.tenant_id, new_parent)
            if not parent:
                return err("ORG_PARENT_NOT_FOUND", "上層組織不存在")
            # 防環:新上層不可為本節點的後代
            if await _is_descendant(db, principal.tenant_id, ancestor=org_id, node_id=new_parent):
                return err("ORG_CYCLE", "不可將組織移到自己的子孫底下")
        org.parent_id = new_parent

    await db.commit()
    await db.refresh(org)
    return ok(_org_dict(org))


@router.delete("/organizations/{org_id}")
async def delete_organization(org_id: uuid.UUID, principal: CurrentStaff, db: DbSession):
    """軟刪組織;其直接子節點的 parent_id 由 DB 外鍵 SET NULL 提升為根。"""
    from datetime import datetime, timezone

    principal.require("organization.manage")
    org = await _get_org(db, principal.tenant_id, org_id)
    if not org:
        return err("ORG_NOT_FOUND", "組織不存在")
    org.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    return ok({"id": str(org_id), "deleted": True})


async def _is_descendant(db, tenant_id, ancestor: uuid.UUID, node_id: uuid.UUID) -> bool:
    """node_id 是否為 ancestor 的後代(往上追 parent 直到根)。"""
    current: uuid.UUID | None = node_id
    seen: set[uuid.UUID] = set()
    while current is not None and current not in seen:
        seen.add(current)
        node = await _get_org(db, tenant_id, current)
        if not node or node.parent_id is None:
            return False
        if node.parent_id == ancestor:
            return True
        current = node.parent_id
    return False
