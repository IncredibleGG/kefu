"""Seed a demo tenant + admin staff + channels, so the system is testable.

Run:  python -m app.seed
Idempotent-ish: skips if the demo tenant slug already exists.

The admin password comes from KEFU_DEMO_ADMIN_PASSWORD; when it is not set a random
one is generated and printed once. The repo is public, so never commit a real password here.
"""
from __future__ import annotations

import asyncio
import os
import secrets

from sqlalchemy import select

from app.core.db import SessionLocal, init_db
from app.core.security import hash_password
from app.models.conversation import Channel
from app.models.iam import Role, Staff, staff_role
from app.models.tenancy import Tenant
from app.services.iam import seed_default_permissions

DEMO_EMAIL = "admin@demo.local"


async def main() -> None:
    await init_db()
    async with SessionLocal() as db:
        exists = (await db.execute(select(Tenant).where(Tenant.slug == "demo"))).scalar_one_or_none()
        if exists:
            print("demo tenant already seeded")
            return

        password = os.environ.get("KEFU_DEMO_ADMIN_PASSWORD") or secrets.token_urlsafe(12)

        tenant = Tenant(name="Demo Co", slug="demo", is_active=True)
        db.add(tenant)
        await db.flush()

        admin_role = Role(tenant_id=tenant.id, name="admin", is_system=True)
        db.add(admin_role)
        await db.flush()

        # 補齊預設權限碼 + 標準系統角色(agent/supervisor/reseller),與正式
        # 開通租戶一致;否則邀請坐席指派 agent 角色會 ROLE_NOT_FOUND。
        await seed_default_permissions(db, tenant.id)

        staff = Staff(
            tenant_id=tenant.id,
            email=DEMO_EMAIL,
            password_hash=hash_password(password),
            display_name="Demo Admin",
            status="offline",
            is_active=True,
        )
        db.add(staff)
        await db.flush()
        await db.execute(staff_role.insert().values(staff_id=staff.id, role_id=admin_role.id))

        db.add(
            Channel(
                tenant_id=tenant.id,
                type="web",
                name="Website Widget",
                # 公開 key 供 widget/pageview/event 等無 JWT 端點定位本渠道。
                config={"public_key": secrets.token_urlsafe(24)},
                is_active=True,
            )
        )
        db.add(
            Channel(
                tenant_id=tenant.id,
                type="telegram",
                name="Telegram Bot",
                config={"bot_token": ""},  # fill via /api/v1/channel later
                is_active=False,
            )
        )
        await db.commit()
        if os.environ.get("KEFU_DEMO_ADMIN_PASSWORD"):
            print(f"seeded demo tenant={tenant.id}  login: {DEMO_EMAIL} (password from KEFU_DEMO_ADMIN_PASSWORD)")
        else:
            print(f"seeded demo tenant={tenant.id}  login: {DEMO_EMAIL} / {password}")


if __name__ == "__main__":
    asyncio.run(main())
