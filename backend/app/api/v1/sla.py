"""SLA API:SLAPolicy CRUD(admin ``sla.manage``)、單會話 SLA 狀態、違約清單。

路由前綴由整合者掛在 ``/api/v1/sla``(見 main.py include_router)。
所有查詢一律以 CurrentStaff.tenant_id 隔離;CRUD 需 ``sla.manage`` 權限。
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import ok
from app.models.sla import VALID_SLA_TARGETS, SLAPolicy, SLATracking
from app.services import sla as sla_svc

router = APIRouter()


# --------------------------------------------------------------------------- #
# 序列化
# --------------------------------------------------------------------------- #
def _serialize_policy(p: SLAPolicy) -> dict:
    return {
        "id": str(p.id),
        "name": p.name,
        "target_type": getattr(p, "target_type", None) or "session",
        "conditions": p.conditions or {},
        "first_response_minutes": p.first_response_minutes,
        "resolution_minutes": p.resolution_minutes,
        "is_active": p.is_active,
        "priority": p.priority,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


def _serialize_tracking(t: SLATracking) -> dict:
    return {
        "id": str(t.id),
        "target_type": getattr(t, "target_type", None) or "session",
        "session_id": str(t.session_id) if t.session_id else None,
        "ticket_id": str(t.ticket_id) if getattr(t, "ticket_id", None) else None,
        "policy_id": str(t.policy_id) if t.policy_id else None,
        "status": t.status,
        "breached_first": t.breached_first,
        "breached_resolution": t.breached_resolution,
        "first_response_due": t.first_response_due.isoformat() if t.first_response_due else None,
        "resolution_due": t.resolution_due.isoformat() if t.resolution_due else None,
        "first_response_at": t.first_response_at.isoformat() if t.first_response_at else None,
        "resolved_at": t.resolved_at.isoformat() if t.resolved_at else None,
        "paused": getattr(t, "paused_at", None) is not None,
        "paused_at": t.paused_at.isoformat() if getattr(t, "paused_at", None) else None,
        "paused_total_seconds": getattr(t, "paused_total_seconds", 0) or 0,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


# --------------------------------------------------------------------------- #
# SLAPolicy CRUD(admin sla.manage)
# --------------------------------------------------------------------------- #
class SLAPolicyIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    # 套用目標:session(預設)| ticket
    target_type: str = Field(default="session")
    conditions: dict | None = None
    first_response_minutes: int = Field(ge=0)
    resolution_minutes: int = Field(ge=0)
    is_active: bool = True
    priority: int = 0


class SLAPolicyPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    target_type: str | None = None
    conditions: dict | None = None
    first_response_minutes: int | None = Field(default=None, ge=0)
    resolution_minutes: int | None = Field(default=None, ge=0)
    is_active: bool | None = None
    priority: int | None = None


def _validate_target_type(value: str) -> str:
    if value not in VALID_SLA_TARGETS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="SLA_INVALID_TARGET_TYPE")
    return value


@router.post("/policies")
async def create_policy(body: SLAPolicyIn, staff: CurrentStaff, db: DbSession):
    staff.require("sla.manage")
    policy = SLAPolicy(
        tenant_id=staff.tenant_id,
        name=body.name,
        target_type=_validate_target_type(body.target_type),
        conditions=body.conditions,
        first_response_minutes=body.first_response_minutes,
        resolution_minutes=body.resolution_minutes,
        is_active=body.is_active,
        priority=body.priority,
    )
    db.add(policy)
    await db.commit()
    await db.refresh(policy)
    return ok(_serialize_policy(policy))


@router.get("/policies")
async def list_policies(
    staff: CurrentStaff,
    db: DbSession,
    is_active: bool | None = None,
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
):
    conds = [SLAPolicy.tenant_id == staff.tenant_id, SLAPolicy.deleted_at.is_(None)]
    if is_active is not None:
        conds.append(SLAPolicy.is_active.is_(is_active))
    total = (
        await db.execute(select(func.count()).select_from(SLAPolicy).where(*conds))
    ).scalar_one()
    rows = (
        await db.execute(
            select(SLAPolicy)
            .where(*conds)
            .order_by(SLAPolicy.priority.desc(), SLAPolicy.created_at.desc())
            .offset((page - 1) * size)
            .limit(size)
        )
    ).scalars().all()
    return ok(
        {"items": [_serialize_policy(p) for p in rows], "total": total, "page": page, "size": size}
    )


async def _get_owned_policy(db: DbSession, tenant_id: uuid.UUID, policy_id: uuid.UUID) -> SLAPolicy:
    policy = (
        await db.execute(
            select(SLAPolicy).where(
                SLAPolicy.id == policy_id,
                SLAPolicy.tenant_id == tenant_id,
                SLAPolicy.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if policy is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="SLA_POLICY_NOT_FOUND")
    return policy


@router.get("/policies/{policy_id}")
async def get_policy(policy_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    policy = await _get_owned_policy(db, staff.tenant_id, policy_id)
    return ok(_serialize_policy(policy))


@router.patch("/policies/{policy_id}")
async def update_policy(
    policy_id: uuid.UUID, body: SLAPolicyPatch, staff: CurrentStaff, db: DbSession
):
    staff.require("sla.manage")
    policy = await _get_owned_policy(db, staff.tenant_id, policy_id)
    data = body.model_dump(exclude_unset=True)
    if data.get("target_type") is not None:
        _validate_target_type(data["target_type"])
    for field, value in data.items():
        if value is None and field in ("target_type",):
            # target_type 不可清為 NULL(NOT NULL 欄);None 視為不改
            continue
        setattr(policy, field, value)
    await db.commit()
    await db.refresh(policy)
    return ok(_serialize_policy(policy))


@router.delete("/policies/{policy_id}")
async def delete_policy(policy_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    staff.require("sla.manage")
    policy = await _get_owned_policy(db, staff.tenant_id, policy_id)
    policy.deleted_at = func.now()
    policy.is_active = False
    await db.commit()
    return ok({"id": str(policy_id), "deleted": True})


# --------------------------------------------------------------------------- #
# 單會話 SLA 狀態
# --------------------------------------------------------------------------- #
@router.get("/sessions/{session_id}")
async def session_sla(session_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """該會話目前的 SLA 倒數/狀態(供坐席台顯示)。"""
    result = await sla_svc.status_for_session(db, staff.tenant_id, session_id)
    if not result.get("tracked") and result.get("reason") == "SLA_SESSION_NOT_FOUND":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="SLA_SESSION_NOT_FOUND")
    return ok(result)


# --------------------------------------------------------------------------- #
# 單工單 SLA 狀態
# --------------------------------------------------------------------------- #
@router.get("/tickets/{ticket_id}")
async def ticket_sla(ticket_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """該工單目前的 SLA 倒數/狀態(供工單台顯示)。"""
    result = await sla_svc.status_for_ticket(db, staff.tenant_id, ticket_id)
    if not result.get("tracked") and result.get("reason") == "SLA_TICKET_NOT_FOUND":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="SLA_TICKET_NOT_FOUND")
    return ok(result)


# --------------------------------------------------------------------------- #
# SLA 暫停 / 恢復(等待客戶時停表)
# --------------------------------------------------------------------------- #
@router.post("/tracking/{tracking_id}/pause")
async def pause_tracking(tracking_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """暫停某追蹤列的 SLA 時鐘(等待客戶回覆時停表)。冪等。需 sla.manage。"""
    staff.require("sla.manage")
    row = await sla_svc.pause_tracking(db, staff.tenant_id, tracking_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="SLA_TRACKING_NOT_FOUND")
    await db.commit()
    await db.refresh(row)
    return ok(_serialize_tracking(row))


@router.post("/tracking/{tracking_id}/resume")
async def resume_tracking(tracking_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """恢復某追蹤列的 SLA 時鐘,累計本段暫停時長。冪等。需 sla.manage。"""
    staff.require("sla.manage")
    row = await sla_svc.resume_tracking(db, staff.tenant_id, tracking_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="SLA_TRACKING_NOT_FOUND")
    await db.commit()
    await db.refresh(row)
    return ok(_serialize_tracking(row))


# --------------------------------------------------------------------------- #
# 違約清單(分頁)
# --------------------------------------------------------------------------- #
@router.get("/breaches")
async def list_breaches(
    staff: CurrentStaff,
    db: DbSession,
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
):
    """列出本租戶已違約(首回應或解決)的會話追蹤,依最近更新排序。"""
    conds = [
        SLATracking.tenant_id == staff.tenant_id,
        SLATracking.deleted_at.is_(None),
        or_(SLATracking.breached_first.is_(True), SLATracking.breached_resolution.is_(True)),
    ]
    total = (
        await db.execute(select(func.count()).select_from(SLATracking).where(*conds))
    ).scalar_one()
    rows = (
        await db.execute(
            select(SLATracking)
            .where(*conds)
            .order_by(SLATracking.updated_at.desc())
            .offset((page - 1) * size)
            .limit(size)
        )
    ).scalars().all()
    return ok(
        {"items": [_serialize_tracking(t) for t in rows], "total": total, "page": page, "size": size}
    )
