"""租戶開通共用邏輯(供平台超管開通、轉售商招募下游、自助註冊共用)。

一次建齊:Tenant + 預設權限/系統角色(admin/agent/supervisor/reseller) + 預設方案
+ Free 訂閱 + 第一個 admin 坐席。**不 commit**(交由呼叫端統一提交),回傳建立的物件。

轉售商招募下游時,傳入 ``reseller_tenant_id``(轉售商自身租戶 id,取自其 JWT),
讓下游的 Free 訂閱掛上該 reseller,之後即出現在該轉售商的「白牌轉售總覽」。
"""
from __future__ import annotations

import re
import uuid

from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.models.iam import Role, Staff, staff_role
from app.models.tenancy import Tenant
from app.services import plans as plan_svc
from app.services.iam import seed_default_permissions


def slugify(name: str) -> str:
    """把租戶名轉成 URL 友善 slug(小寫、非英數轉連字號)。"""
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").strip().lower()).strip("-")
    return s or "tenant"


async def unique_slug(db: AsyncSession, base: str) -> str:
    """確保 slug 全域唯一;衝突時附遞增序號。"""
    base = slugify(base)
    slug = base
    n = 1
    while (
        await db.execute(select(Tenant.id).where(Tenant.slug == slug))
    ).scalar_one_or_none() is not None:
        n += 1
        slug = f"{base}-{n}"
    return slug


async def provision_tenant(
    db: AsyncSession,
    *,
    name: str,
    admin_email: str,
    admin_password: str,
    admin_display_name: str | None = None,
    slug: str | None = None,
    reseller_tenant_id: uuid.UUID | None = None,
    branding: dict | None = None,
    llm_config: dict | None = None,
) -> tuple[Tenant, Staff]:
    """建立新租戶 + 第一個 admin 坐席(不 commit,呼叫端負責提交)。

    reseller_tenant_id 有值時,把下游 Free 訂閱掛上該轉售商。
    回傳 (tenant, admin_staff)。
    """
    real_slug = await unique_slug(db, slug or name)
    tenant = Tenant(
        name=name, slug=real_slug, branding=branding, llm_config=llm_config, is_active=True
    )
    db.add(tenant)
    await db.flush()  # 取得 tenant.id

    # 種預設權限碼 + 系統角色(agent/supervisor/reseller;admin 於下方另建)
    await seed_default_permissions(db, tenant.id)
    admin_role = Role(
        tenant_id=tenant.id, name="admin", description="系統管理員(全權)", is_system=True
    )
    db.add(admin_role)
    await db.flush()

    # 預設方案 + Free 訂閱;轉售商招募時掛上 reseller_tenant_id
    await plan_svc.seed_default_plans(db, tenant.id)
    sub = await plan_svc.ensure_free_subscription(db, tenant.id)
    if reseller_tenant_id is not None:
        sub.reseller_tenant_id = reseller_tenant_id

    admin_staff = Staff(
        tenant_id=tenant.id,
        email=admin_email,
        password_hash=hash_password(admin_password),
        display_name=admin_display_name or admin_email,
        status="offline",
        is_active=True,
        is_platform_admin=False,  # 租戶管理員,非平台超管
    )
    db.add(admin_staff)
    await db.flush()
    await db.execute(insert(staff_role).values(staff_id=admin_staff.id, role_id=admin_role.id))
    return tenant, admin_staff
