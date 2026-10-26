"""M2 iam API:坐席 Staff、RBAC(Role/Permission)、技能組 SkillGroup。

註冊建議:app.include_router(iam.router, prefix="/api/v1/iam", tags=["iam"])

規則:
- 所有查詢一律以 principal.tenant_id 過濾(租戶隔離)。
- 權限檢查走 Principal.require(<code>);seed 提供預設權限碼清單。
- 回應統一走 ok()/err();軟刪以 deleted_at 標記。
- 坐席回傳一律不含 password_hash。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, insert, select

from app.api.v1.auth import _sign_access_token
from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.core.security import hash_password
from app.models.iam import (
    Permission,
    Role,
    SkillGroup,
    Staff,
    role_permission,
    staff_role,
    staff_skillgroup,
)
from app.services import presence
from app.services.iam import (
    VALID_STAFF_STATUS,
    count_query,
    mark_password_changed,
    paginate_params,
    seed_default_permissions,
)

router = APIRouter()


# --------------------------------------------------------------------------- #
# Pydantic schema
# --------------------------------------------------------------------------- #
class StaffCreateIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=6, max_length=128)
    display_name: str = Field(min_length=1, max_length=200)
    avatar_url: str | None = None
    organization_id: uuid.UUID | None = None
    role_ids: list[uuid.UUID] = Field(default_factory=list)


class StaffUpdateIn(BaseModel):
    display_name: str | None = Field(default=None, max_length=200)
    avatar_url: str | None = None
    organization_id: uuid.UUID | None = None
    is_active: bool | None = None
    # 坐席個人簽名檔(純文字;可含換行)。傳空字串或 null 皆視為清空。
    signature: str | None = None


class PasswordIn(BaseModel):
    new_password: str = Field(min_length=6, max_length=128)


class StatusIn(BaseModel):
    status: str = Field(description="online / busy / away / offline")


class RoleIdsIn(BaseModel):
    role_ids: list[uuid.UUID] = Field(default_factory=list)


class RoleCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=300)
    permission_codes: list[str] = Field(default_factory=list)


class RoleUpdateIn(BaseModel):
    name: str | None = Field(default=None, max_length=100)
    description: str | None = Field(default=None, max_length=300)


class PermissionCodesIn(BaseModel):
    codes: list[str] = Field(default_factory=list)


class PermissionCreateIn(BaseModel):
    code: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=300)


class SkillGroupCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=300)


class SkillGroupUpdateIn(BaseModel):
    name: str | None = Field(default=None, max_length=100)
    description: str | None = Field(default=None, max_length=300)


class StaffIdsIn(BaseModel):
    staff_ids: list[uuid.UUID] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# 序列化
# --------------------------------------------------------------------------- #
def _staff_dict(s: Staff, roles: list[dict] | None = None) -> dict:
    d = {
        "id": str(s.id),
        "email": s.email,
        "display_name": s.display_name,
        "avatar_url": s.avatar_url,
        "organization_id": str(s.organization_id) if s.organization_id else None,
        "status": s.status,
        "is_active": s.is_active,
        "signature": s.signature,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }
    if roles is not None:
        d["roles"] = roles
    return d


def _role_dict(r: Role, permissions: list[str] | None = None) -> dict:
    d = {
        "id": str(r.id),
        "name": r.name,
        "description": r.description,
        "is_system": r.is_system,
    }
    if permissions is not None:
        d["permissions"] = permissions
    return d


def _permission_dict(p: Permission) -> dict:
    return {"id": str(p.id), "code": p.code, "description": p.description}


def _skillgroup_dict(g: SkillGroup, members: list[dict] | None = None) -> dict:
    d = {"id": str(g.id), "name": g.name, "description": g.description}
    if members is not None:
        d["members"] = members
    return d


# --------------------------------------------------------------------------- #
# 內部小工具(全部租戶過濾)
# --------------------------------------------------------------------------- #
async def _get_staff(db, tenant_id, staff_id) -> Staff | None:
    return (
        await db.execute(
            select(Staff).where(
                Staff.id == staff_id,
                Staff.tenant_id == tenant_id,
                Staff.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


async def _operator_is_platform_admin(db, principal) -> bool:
    """操作者(principal)本身是否為平台超管;以持久欄位 Staff.is_platform_admin 為準。
    查無操作者記錄視為否(fail-closed)。"""
    op = await _get_staff(db, principal.tenant_id, principal.staff_id)
    return bool(op and op.is_platform_admin)


async def _forbid_platform_admin_target(db, principal, target: Staff) -> bool:
    """租戶級 staff.manage 操作(改資料 / 改密碼 / 刪除)是否應拒絕:目標為平台超管
    (is_platform_admin=True)且操作者非平台超管時拒絕,以防租戶級管理員提權奪取
    平台超管帳號。平台超管操作自己、或平台超管操作其他帳號皆放行。回傳 True 表示禁止。"""
    if not target.is_platform_admin:
        return False
    if target.id == principal.staff_id:
        return False  # 平台超管操作自己(如本人改密碼)
    return not await _operator_is_platform_admin(db, principal)


async def _get_role(db, tenant_id, role_id) -> Role | None:
    return (
        await db.execute(
            select(Role).where(
                Role.id == role_id, Role.tenant_id == tenant_id, Role.deleted_at.is_(None)
            )
        )
    ).scalar_one_or_none()


async def _get_skillgroup(db, tenant_id, group_id) -> SkillGroup | None:
    return (
        await db.execute(
            select(SkillGroup).where(
                SkillGroup.id == group_id,
                SkillGroup.tenant_id == tenant_id,
                SkillGroup.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


async def _roles_of_staff(db, tenant_id, staff_id) -> list[dict]:
    rows = (
        await db.execute(
            select(Role.id, Role.name)
            .join(staff_role, staff_role.c.role_id == Role.id)
            .where(staff_role.c.staff_id == staff_id, Role.tenant_id == tenant_id)
        )
    ).all()
    return [{"id": str(rid), "name": name} for rid, name in rows]


async def _permission_codes_of_role(db, tenant_id, role_id) -> list[str]:
    return list(
        (
            await db.execute(
                select(Permission.code)
                .join(role_permission, role_permission.c.permission_id == Permission.id)
                .where(role_permission.c.role_id == role_id, Permission.tenant_id == tenant_id)
            )
        ).scalars().all()
    )


# =========================================================================== #
# 坐席 Staff
# =========================================================================== #
@router.post("/staff")
async def create_staff(body: StaffCreateIn, principal: CurrentStaff, db: DbSession):
    principal.require("staff.manage")
    dup = (
        await db.execute(
            select(Staff).where(
                Staff.tenant_id == principal.tenant_id, Staff.email == body.email
            )
        )
    ).scalar_one_or_none()
    if dup:
        return err("STAFF_EMAIL_TAKEN", f"email 已存在: {body.email}")

    staff = Staff(
        tenant_id=principal.tenant_id,
        email=body.email,
        password_hash=hash_password(body.password),
        display_name=body.display_name,
        avatar_url=body.avatar_url,
        organization_id=body.organization_id,
        status="offline",
        is_active=True,
    )
    db.add(staff)
    await db.flush()

    # 指派初始角色(需屬同租戶)
    valid_roles = await _validate_role_ids(db, principal.tenant_id, body.role_ids)
    if valid_roles is None:
        return err("ROLE_NOT_FOUND", "role_ids 含不存在或跨租戶的角色")
    for rid in valid_roles:
        await db.execute(insert(staff_role).values(staff_id=staff.id, role_id=rid))

    await db.commit()
    await db.refresh(staff)
    roles = await _roles_of_staff(db, principal.tenant_id, staff.id)
    return ok(_staff_dict(staff, roles))


@router.get("/staff")
async def list_staff(
    principal: CurrentStaff,
    db: DbSession,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    q: str | None = Query(None, description="以 email/顯示名模糊搜尋"),
    is_active: bool | None = None,
    organization_id: uuid.UUID | None = None,
):
    principal.require("staff.view")
    page, size, offset = paginate_params(page, size)
    stmt = select(Staff).where(
        Staff.tenant_id == principal.tenant_id, Staff.deleted_at.is_(None)
    )
    if q:
        like = f"%{q}%"
        stmt = stmt.where((Staff.email.ilike(like)) | (Staff.display_name.ilike(like)))
    if is_active is not None:
        stmt = stmt.where(Staff.is_active.is_(is_active))
    if organization_id is not None:
        stmt = stmt.where(Staff.organization_id == organization_id)

    total = await count_query(db, stmt)
    rows = (
        await db.execute(stmt.order_by(Staff.created_at.desc()).offset(offset).limit(size))
    ).scalars().all()
    return ok({"items": [_staff_dict(s) for s in rows], "total": total, "page": page, "size": size})


@router.get("/staff/{staff_id}")
async def get_staff(staff_id: uuid.UUID, principal: CurrentStaff, db: DbSession):
    principal.require("staff.view")
    staff = await _get_staff(db, principal.tenant_id, staff_id)
    if not staff:
        return err("STAFF_NOT_FOUND", "坐席不存在")
    roles = await _roles_of_staff(db, principal.tenant_id, staff.id)
    return ok(_staff_dict(staff, roles))


@router.patch("/staff/{staff_id}")
async def update_staff(
    staff_id: uuid.UUID, body: StaffUpdateIn, principal: CurrentStaff, db: DbSession
):
    """更新坐席基本資料/指派組織/啟停用。"""
    principal.require("staff.manage")
    staff = await _get_staff(db, principal.tenant_id, staff_id)
    if not staff:
        return err("STAFF_NOT_FOUND", "坐席不存在")
    if await _forbid_platform_admin_target(db, principal, staff):
        return err("STAFF_PLATFORM_ADMIN_PROTECTED", "無權變更平台超級管理員帳號")

    data = body.model_dump(exclude_unset=True)
    if "display_name" in data and data["display_name"] is not None:
        staff.display_name = data["display_name"]
    if "avatar_url" in data:
        staff.avatar_url = data["avatar_url"]
    if "organization_id" in data:
        staff.organization_id = data["organization_id"]
    if "is_active" in data and data["is_active"] is not None:
        staff.is_active = data["is_active"]
    if "signature" in data:
        # 空字串正規化為 None(不附加簽名);其餘原樣保存
        sig = data["signature"]
        staff.signature = sig if (sig and sig.strip()) else None

    await db.commit()
    await db.refresh(staff)
    return ok(_staff_dict(staff))


@router.post("/staff/{staff_id}/password")
async def change_password(
    staff_id: uuid.UUID, body: PasswordIn, principal: CurrentStaff, db: DbSession
):
    """改密碼。管理者需 staff.manage;本人可改自己的密碼。

    成功即撤銷該坐席改密前簽發的所有 access token(遞增 token_version,其所有裝置須重新
    登入),並使其未用的密碼重設連結失效。本人改自己的密碼時,回應另帶新 ``access_token``
    供本次 session 續用;管理者改他人密碼時呼叫者自己的 token 不受影響,不回 token。
    """
    if staff_id != principal.staff_id:
        principal.require("staff.manage")
    staff = await _get_staff(db, principal.tenant_id, staff_id)
    if not staff:
        return err("STAFF_NOT_FOUND", "坐席不存在")
    if await _forbid_platform_admin_target(db, principal, staff):
        return err("STAFF_PLATFORM_ADMIN_PROTECTED", "無權重設平台超級管理員密碼")
    staff.password_hash = hash_password(body.new_password)
    await mark_password_changed(db, staff)
    await db.commit()
    data = {"id": str(staff_id), "password_changed": True}
    if staff_id == principal.staff_id:
        data["access_token"] = await _sign_access_token(db, staff)
        data["token_type"] = "bearer"
    return ok(data)


@router.patch("/staff/{staff_id}/status")
async def set_status(
    staff_id: uuid.UUID, body: StatusIn, principal: CurrentStaff, db: DbSession
):
    """設定坐席狀態(online/busy/away/offline)。本人或具 staff.manage 者可設。"""
    if staff_id != principal.staff_id:
        principal.require("staff.manage")
    if body.status not in VALID_STAFF_STATUS:
        return err("STAFF_INVALID_STATUS", f"狀態需為 {sorted(VALID_STAFF_STATUS)} 之一")
    staff = await _get_staff(db, principal.tenant_id, staff_id)
    if not staff:
        return err("STAFF_NOT_FOUND", "坐席不存在")
    staff.status = body.status
    # 手動 offline 另記 Redis 標記:DB 上自動離線與手動 offline 同為 'offline',
    # /ws/agent (重)連時據此不把手動 offline 改回 online。設 offline 先標記再 commit
    # (避免 commit 後、標記前的重連空窗);設其他狀態於 commit 後清除。Redis 不可用不擋設定。
    if body.status == "offline":
        await presence.set_manual_offline(staff_id, True)
    await db.commit()
    if body.status != "offline":
        await presence.set_manual_offline(staff_id, False)
    return ok({"id": str(staff_id), "status": staff.status})


@router.put("/staff/{staff_id}/roles")
async def set_staff_roles(
    staff_id: uuid.UUID, body: RoleIdsIn, principal: CurrentStaff, db: DbSession
):
    """整組覆寫某坐席的角色指派。"""
    principal.require("role.manage")
    staff = await _get_staff(db, principal.tenant_id, staff_id)
    if not staff:
        return err("STAFF_NOT_FOUND", "坐席不存在")
    valid = await _validate_role_ids(db, principal.tenant_id, body.role_ids)
    if valid is None:
        return err("ROLE_NOT_FOUND", "role_ids 含不存在或跨租戶的角色")

    await db.execute(delete(staff_role).where(staff_role.c.staff_id == staff_id))
    for rid in valid:
        await db.execute(insert(staff_role).values(staff_id=staff_id, role_id=rid))
    await db.commit()
    roles = await _roles_of_staff(db, principal.tenant_id, staff_id)
    return ok({"id": str(staff_id), "roles": roles})


@router.delete("/staff/{staff_id}")
async def delete_staff(staff_id: uuid.UUID, principal: CurrentStaff, db: DbSession):
    """軟刪坐席並停用。"""
    principal.require("staff.manage")
    staff = await _get_staff(db, principal.tenant_id, staff_id)
    if not staff:
        return err("STAFF_NOT_FOUND", "坐席不存在")
    if await _forbid_platform_admin_target(db, principal, staff):
        return err("STAFF_PLATFORM_ADMIN_PROTECTED", "無權刪除平台超級管理員帳號")
    staff.deleted_at = datetime.now(timezone.utc)
    staff.is_active = False
    await db.commit()
    return ok({"id": str(staff_id), "deleted": True})


async def _validate_role_ids(db, tenant_id, role_ids: list[uuid.UUID]) -> list[uuid.UUID] | None:
    """確認 role_ids 全屬本租戶且存在;回傳去重清單,任一不合法回 None。"""
    if not role_ids:
        return []
    unique = list(dict.fromkeys(role_ids))
    found = set(
        (
            await db.execute(
                select(Role.id).where(
                    Role.id.in_(unique),
                    Role.tenant_id == tenant_id,
                    Role.deleted_at.is_(None),
                )
            )
        ).scalars().all()
    )
    if len(found) != len(unique):
        return None
    return unique


# =========================================================================== #
# 角色 Role
# =========================================================================== #
@router.post("/roles")
async def create_role(body: RoleCreateIn, principal: CurrentStaff, db: DbSession):
    principal.require("role.manage")
    dup = (
        await db.execute(
            select(Role).where(
                Role.tenant_id == principal.tenant_id,
                Role.name == body.name,
                Role.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if dup:
        return err("ROLE_NAME_TAKEN", f"角色名已存在: {body.name}")

    role = Role(tenant_id=principal.tenant_id, name=body.name, description=body.description)
    db.add(role)
    await db.flush()

    if body.permission_codes:
        result = await _bind_permissions(db, principal.tenant_id, role.id, body.permission_codes)
        if result is None:
            return err("PERMISSION_NOT_FOUND", "permission_codes 含不存在的權限碼")
    await db.commit()
    codes = await _permission_codes_of_role(db, principal.tenant_id, role.id)
    return ok(_role_dict(role, codes))


@router.get("/roles")
async def list_roles(principal: CurrentStaff, db: DbSession):
    principal.require("role.view")
    rows = (
        await db.execute(
            select(Role)
            .where(Role.tenant_id == principal.tenant_id, Role.deleted_at.is_(None))
            .order_by(Role.name)
        )
    ).scalars().all()
    return ok({"items": [_role_dict(r) for r in rows], "total": len(rows)})


@router.get("/roles/{role_id}")
async def get_role(role_id: uuid.UUID, principal: CurrentStaff, db: DbSession):
    principal.require("role.view")
    role = await _get_role(db, principal.tenant_id, role_id)
    if not role:
        return err("ROLE_NOT_FOUND", "角色不存在")
    codes = await _permission_codes_of_role(db, principal.tenant_id, role_id)
    return ok(_role_dict(role, codes))


@router.patch("/roles/{role_id}")
async def update_role(
    role_id: uuid.UUID, body: RoleUpdateIn, principal: CurrentStaff, db: DbSession
):
    principal.require("role.manage")
    role = await _get_role(db, principal.tenant_id, role_id)
    if not role:
        return err("ROLE_NOT_FOUND", "角色不存在")
    if role.is_system:
        return err("ROLE_SYSTEM_READONLY", "系統角色不可修改")
    data = body.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        role.name = data["name"]
    if "description" in data:
        role.description = data["description"]
    await db.commit()
    await db.refresh(role)
    return ok(_role_dict(role))


@router.delete("/roles/{role_id}")
async def delete_role(role_id: uuid.UUID, principal: CurrentStaff, db: DbSession):
    principal.require("role.manage")
    role = await _get_role(db, principal.tenant_id, role_id)
    if not role:
        return err("ROLE_NOT_FOUND", "角色不存在")
    if role.is_system:
        return err("ROLE_SYSTEM_READONLY", "系統角色不可刪除")
    role.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    return ok({"id": str(role_id), "deleted": True})


@router.put("/roles/{role_id}/permissions")
async def set_role_permissions(
    role_id: uuid.UUID, body: PermissionCodesIn, principal: CurrentStaff, db: DbSession
):
    """整組覆寫角色綁定的權限碼。"""
    principal.require("role.manage")
    role = await _get_role(db, principal.tenant_id, role_id)
    if not role:
        return err("ROLE_NOT_FOUND", "角色不存在")
    await db.execute(delete(role_permission).where(role_permission.c.role_id == role_id))
    if body.codes:
        result = await _bind_permissions(db, principal.tenant_id, role_id, body.codes)
        if result is None:
            return err("PERMISSION_NOT_FOUND", "codes 含不存在的權限碼")
    await db.commit()
    codes = await _permission_codes_of_role(db, principal.tenant_id, role_id)
    return ok({"id": str(role_id), "permissions": codes})


async def _bind_permissions(db, tenant_id, role_id, codes: list[str]) -> bool | None:
    """依權限碼綁定到角色(呼叫端負責先清空)。碼不存在回 None。"""
    unique = list(dict.fromkeys(codes))
    rows = (
        await db.execute(
            select(Permission.id, Permission.code).where(
                Permission.tenant_id == tenant_id, Permission.code.in_(unique)
            )
        )
    ).all()
    found = {code: pid for pid, code in rows}
    if len(found) != len(unique):
        return None
    for code in unique:
        await db.execute(
            insert(role_permission).values(role_id=role_id, permission_id=found[code])
        )
    return True


# =========================================================================== #
# 權限 Permission
# =========================================================================== #
@router.get("/permissions")
async def list_permissions(principal: CurrentStaff, db: DbSession):
    principal.require("role.view")
    rows = (
        await db.execute(
            select(Permission)
            .where(Permission.tenant_id == principal.tenant_id)
            .order_by(Permission.code)
        )
    ).scalars().all()
    return ok({"items": [_permission_dict(p) for p in rows], "total": len(rows)})


@router.post("/permissions")
async def create_permission(body: PermissionCreateIn, principal: CurrentStaff, db: DbSession):
    principal.require("role.manage")
    dup = (
        await db.execute(
            select(Permission).where(
                Permission.tenant_id == principal.tenant_id, Permission.code == body.code
            )
        )
    ).scalar_one_or_none()
    if dup:
        return err("PERMISSION_CODE_TAKEN", f"權限碼已存在: {body.code}")
    perm = Permission(
        tenant_id=principal.tenant_id, code=body.code, description=body.description
    )
    db.add(perm)
    await db.commit()
    await db.refresh(perm)
    return ok(_permission_dict(perm))


@router.post("/permissions/seed")
async def seed_permissions(principal: CurrentStaff, db: DbSession):
    """為目前租戶補齊預設權限碼種子(已存在者略過)。"""
    principal.require("tenant.manage")
    created = await seed_default_permissions(db, principal.tenant_id)
    await db.commit()
    return ok({"created": created})


@router.delete("/permissions/{permission_id}")
async def delete_permission(permission_id: uuid.UUID, principal: CurrentStaff, db: DbSession):
    principal.require("role.manage")
    perm = (
        await db.execute(
            select(Permission).where(
                Permission.id == permission_id,
                Permission.tenant_id == principal.tenant_id,
            )
        )
    ).scalar_one_or_none()
    if not perm:
        return err("PERMISSION_NOT_FOUND", "權限不存在")
    # 硬刪:同時清掉角色綁定(權限表無軟刪語意)
    await db.execute(
        delete(role_permission).where(role_permission.c.permission_id == permission_id)
    )
    await db.delete(perm)
    await db.commit()
    return ok({"id": str(permission_id), "deleted": True})


# =========================================================================== #
# 技能組 SkillGroup
# =========================================================================== #
@router.post("/skill-groups")
async def create_skillgroup(body: SkillGroupCreateIn, principal: CurrentStaff, db: DbSession):
    principal.require("skillgroup.manage")
    dup = (
        await db.execute(
            select(SkillGroup).where(
                SkillGroup.tenant_id == principal.tenant_id,
                SkillGroup.name == body.name,
                SkillGroup.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if dup:
        return err("SKILLGROUP_NAME_TAKEN", f"技能組名已存在: {body.name}")
    group = SkillGroup(
        tenant_id=principal.tenant_id, name=body.name, description=body.description
    )
    db.add(group)
    await db.commit()
    await db.refresh(group)
    return ok(_skillgroup_dict(group))


@router.get("/skill-groups")
async def list_skillgroups(principal: CurrentStaff, db: DbSession):
    principal.require("skillgroup.view")
    rows = (
        await db.execute(
            select(SkillGroup)
            .where(SkillGroup.tenant_id == principal.tenant_id, SkillGroup.deleted_at.is_(None))
            .order_by(SkillGroup.name)
        )
    ).scalars().all()
    return ok({"items": [_skillgroup_dict(g) for g in rows], "total": len(rows)})


@router.get("/skill-groups/{group_id}")
async def get_skillgroup(group_id: uuid.UUID, principal: CurrentStaff, db: DbSession):
    principal.require("skillgroup.view")
    group = await _get_skillgroup(db, principal.tenant_id, group_id)
    if not group:
        return err("SKILLGROUP_NOT_FOUND", "技能組不存在")
    members = await _members_of_group(db, principal.tenant_id, group_id)
    return ok(_skillgroup_dict(group, members))


@router.patch("/skill-groups/{group_id}")
async def update_skillgroup(
    group_id: uuid.UUID, body: SkillGroupUpdateIn, principal: CurrentStaff, db: DbSession
):
    principal.require("skillgroup.manage")
    group = await _get_skillgroup(db, principal.tenant_id, group_id)
    if not group:
        return err("SKILLGROUP_NOT_FOUND", "技能組不存在")
    data = body.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        group.name = data["name"]
    if "description" in data:
        group.description = data["description"]
    await db.commit()
    await db.refresh(group)
    return ok(_skillgroup_dict(group))


@router.delete("/skill-groups/{group_id}")
async def delete_skillgroup(group_id: uuid.UUID, principal: CurrentStaff, db: DbSession):
    principal.require("skillgroup.manage")
    group = await _get_skillgroup(db, principal.tenant_id, group_id)
    if not group:
        return err("SKILLGROUP_NOT_FOUND", "技能組不存在")
    group.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    return ok({"id": str(group_id), "deleted": True})


@router.post("/skill-groups/{group_id}/members")
async def add_members(
    group_id: uuid.UUID, body: StaffIdsIn, principal: CurrentStaff, db: DbSession
):
    """把坐席加入技能組(已在組內者略過)。"""
    principal.require("skillgroup.manage")
    group = await _get_skillgroup(db, principal.tenant_id, group_id)
    if not group:
        return err("SKILLGROUP_NOT_FOUND", "技能組不存在")

    unique = list(dict.fromkeys(body.staff_ids))
    if unique:
        valid = set(
            (
                await db.execute(
                    select(Staff.id).where(
                        Staff.id.in_(unique),
                        Staff.tenant_id == principal.tenant_id,
                        Staff.deleted_at.is_(None),
                    )
                )
            ).scalars().all()
        )
        if len(valid) != len(unique):
            return err("STAFF_NOT_FOUND", "staff_ids 含不存在或跨租戶的坐席")
        already = set(
            (
                await db.execute(
                    select(staff_skillgroup.c.staff_id).where(
                        staff_skillgroup.c.skillgroup_id == group_id,
                        staff_skillgroup.c.staff_id.in_(unique),
                    )
                )
            ).scalars().all()
        )
        for sid in unique:
            if sid not in already:
                await db.execute(
                    insert(staff_skillgroup).values(skillgroup_id=group_id, staff_id=sid)
                )
        await db.commit()
    members = await _members_of_group(db, principal.tenant_id, group_id)
    return ok(_skillgroup_dict(group, members))


@router.delete("/skill-groups/{group_id}/members/{staff_id}")
async def remove_member(
    group_id: uuid.UUID, staff_id: uuid.UUID, principal: CurrentStaff, db: DbSession
):
    """把坐席移出技能組。"""
    principal.require("skillgroup.manage")
    group = await _get_skillgroup(db, principal.tenant_id, group_id)
    if not group:
        return err("SKILLGROUP_NOT_FOUND", "技能組不存在")
    await db.execute(
        delete(staff_skillgroup).where(
            staff_skillgroup.c.skillgroup_id == group_id,
            staff_skillgroup.c.staff_id == staff_id,
        )
    )
    await db.commit()
    members = await _members_of_group(db, principal.tenant_id, group_id)
    return ok(_skillgroup_dict(group, members))


async def _members_of_group(db, tenant_id, group_id) -> list[dict]:
    rows = (
        await db.execute(
            select(Staff.id, Staff.display_name, Staff.email)
            .join(staff_skillgroup, staff_skillgroup.c.staff_id == Staff.id)
            .where(
                staff_skillgroup.c.skillgroup_id == group_id,
                Staff.tenant_id == tenant_id,
                Staff.deleted_at.is_(None),
            )
        )
    ).all()
    return [{"id": str(sid), "display_name": name, "email": email} for sid, name, email in rows]
