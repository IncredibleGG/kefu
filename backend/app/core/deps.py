"""Shared FastAPI dependencies — the auth/tenancy contract every module uses.

Protected route pattern:

    from app.core.deps import CurrentStaff

    @router.get("/things")
    async def list_things(staff: CurrentStaff, db: DbSession):
        # staff.tenant_id is guaranteed; scope all queries by it.
        ...
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.security import decode_access_token

DbSession = Annotated[AsyncSession, Depends(get_db)]

# 撤銷檢查因 DB 故障而無法判定時的哨符:此時保守放行(避免限流/認證基礎設施
# 故障拖垮整個已認證 API;JWT 本身已驗簽通過)。
_REVOCATION_UNKNOWN = object()


@dataclass
class Principal:
    """The authenticated caller, resolved from the JWT. Never trust client-sent tenant_id."""

    staff_id: uuid.UUID
    tenant_id: uuid.UUID
    roles: list[str]

    def require(self, permission: str) -> None:
        """Raise 403 unless the principal holds the permission (or is admin)."""
        if "admin" in self.roles or permission in self.roles:
            return
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail=f"missing permission: {permission}")


async def _load_revocation_state(db: AsyncSession, staff_id: uuid.UUID):
    """單一 select 取回撤銷判定所需狀態,供每請求即時撤銷檢查。

    回傳:
    - ``(staff_active, staff_deleted_at, tenant_active)`` 元組(找到坐席);
    - ``None``:查無此坐席列(非撤銷狀態——本系統的刪除為軟刪,列仍在且帶
      ``deleted_at``,故「列不存在」多為測試/邊界,採不阻擋以維持既有 token 通過);
    - ``_REVOCATION_UNKNOWN``:DB 故障/查詢失敗,無法判定 ⇒ 保守放行。

    效能:一條 select、僅取所需三欄;以 outer join 一次帶出坐席與其租戶狀態。
    失敗時 rollback,避免污染本請求後續共用的 session 交易。
    """
    try:
        from app.models.iam import Staff
        from app.models.tenancy import Tenant

        return (
            await db.execute(
                select(Staff.is_active, Staff.deleted_at, Tenant.is_active)
                .outerjoin(Tenant, Tenant.id == Staff.tenant_id)
                .where(Staff.id == staff_id)
            )
        ).first()
    except Exception:
        try:
            await db.rollback()
        except Exception:
            pass
        return _REVOCATION_UNKNOWN


async def get_current_principal(
    db: DbSession,
    authorization: Annotated[str | None, Header()] = None,
) -> Principal:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    payload = decode_access_token(authorization.split(" ", 1)[1])
    if not payload:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token")
    try:
        principal = Principal(
            staff_id=uuid.UUID(payload["sub"]),
            tenant_id=uuid.UUID(payload["tenant_id"]),
            roles=list(payload.get("roles", [])),
        )
    except (KeyError, ValueError):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="malformed token claims")

    # 每請求重查 DB,支援即時撤銷:刪除/停用坐席或停用租戶後,既發 JWT 立即失效
    # (不必等 24h 過期)。JWT 已驗簽,這裡只加一層即時狀態核對。
    is_platform_admin = bool(payload.get("is_platform_admin"))
    state = await _load_revocation_state(db, principal.staff_id)
    if state is not _REVOCATION_UNKNOWN and state is not None:
        staff_active, staff_deleted_at, tenant_active = state
        # 坐席被軟刪或停用 ⇒ 撤銷。
        if staff_deleted_at is not None or not staff_active:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="account disabled")
        # 租戶被停用 ⇒ 撤銷。平台超管跨租戶運作、不綁單一租戶,故不因租戶停用而誤擋
        # (與 platform.require_platform_admin 的既有行為一致)。
        if not is_platform_admin and tenant_active is False:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="tenant suspended")
    return principal


CurrentStaff = Annotated[Principal, Depends(get_current_principal)]
