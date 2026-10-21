"""W7 audit API:稽核/操作日誌查詢。

註冊建議:app.include_router(audit.router, prefix="/api/v1/audit", tags=["audit"])

規則:
- 一律以 principal.tenant_id 過濾(租戶隔離,絕不信任前端傳入的 tenant_id)。
- 需 ``audit.view`` 權限(admin 依 Principal.require 規則直接放行)。
- 回應統一走 ok();結果倒序(最新在前)、分頁。
- 寫入端在中介層與各端點(app.services.audit.record),本檔僅查詢,不產生稽核。
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Query
from sqlalchemy import select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import ok
from app.models.audit import AuditLog
from app.models.iam import Staff
from app.services.iam import count_query, paginate_params

router = APIRouter()


def _audit_dict(a: AuditLog, actor_name: str | None = None) -> dict:
    return {
        "id": str(a.id),
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "actor_staff_id": str(a.actor_staff_id) if a.actor_staff_id else None,
        # 優先用落庫時記下的 actor_name;中介層未帶時以坐席現有顯示名回填
        "actor_name": a.actor_name or actor_name,
        "action": a.action,
        "target_type": a.target_type,
        "target_id": a.target_id,
        "ip": a.ip,
        "meta": a.meta,
    }


@router.get("")
async def list_audit(
    principal: CurrentStaff,
    db: DbSession,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    action: str | None = Query(None, description="動作模糊比對,如 'POST /api/v1/iam/staff'"),
    actor_staff_id: uuid.UUID | None = Query(None, description="依操作者坐席篩選"),
    target_type: str | None = Query(None, description="目標型別精確比對,如 'staff'"),
    start: datetime | None = Query(None, description="起始時間(含),ISO8601"),
    end: datetime | None = Query(None, description="結束時間(含),ISO8601"),
):
    """查詢稽核日誌:租戶隔離、可依動作/操作者/目標型別/時間區間篩選,分頁倒序。"""
    principal.require("audit.view")
    page, size, offset = paginate_params(page, size)

    stmt = select(AuditLog).where(AuditLog.tenant_id == principal.tenant_id)
    if action:
        stmt = stmt.where(AuditLog.action.ilike(f"%{action}%"))
    if actor_staff_id is not None:
        stmt = stmt.where(AuditLog.actor_staff_id == actor_staff_id)
    if target_type:
        stmt = stmt.where(AuditLog.target_type == target_type)
    if start is not None:
        stmt = stmt.where(AuditLog.created_at >= start)
    if end is not None:
        stmt = stmt.where(AuditLog.created_at <= end)

    total = await count_query(db, stmt)
    rows = (
        await db.execute(
            stmt.order_by(AuditLog.created_at.desc()).offset(offset).limit(size)
        )
    ).scalars().all()

    # 為本頁的操作者一次補上顯示名(避免 N 次查詢);已落庫 actor_name 者優先。
    actor_ids = {a.actor_staff_id for a in rows if a.actor_staff_id and not a.actor_name}
    name_map: dict[uuid.UUID, str] = {}
    if actor_ids:
        srows = (
            await db.execute(
                select(Staff.id, Staff.display_name).where(
                    Staff.id.in_(actor_ids), Staff.tenant_id == principal.tenant_id
                )
            )
        ).all()
        name_map = {sid: name for sid, name in srows}

    items = [_audit_dict(a, name_map.get(a.actor_staff_id)) for a in rows]
    return ok({"items": items, "total": total, "page": page, "size": size})
