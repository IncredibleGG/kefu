"""M8 routing API:分配規則設定、手動指派/搶單、佇列與坐席負載查詢。

掛載前綴(由整合方於 main.py 註冊):/api/v1/routing
所有查詢皆以 CurrentStaff.tenant_id 做租戶隔離,絕不信任用戶端傳入的 tenant_id。
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.models.conversation import Session
from app.models.routing import (
    DEFAULT_MAX_LOAD,
    VALID_STRATEGIES,
    RoutingPolicy,
)
from app.services import routing as routing_svc

router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class PolicyIn(BaseModel):
    """設定/更新一條分配策略。skill_group_id 省略 = 租戶預設策略。"""

    skill_group_id: uuid.UUID | None = None
    strategy: str = Field(default="least_load")
    max_load: int = Field(default=DEFAULT_MAX_LOAD, ge=1)


def _policy_out(p: RoutingPolicy) -> dict:
    return {
        "id": str(p.id),
        "skill_group_id": str(p.skill_group_id) if p.skill_group_id else None,
        "strategy": p.strategy,
        "max_load": p.max_load,
        "is_active": p.is_active,
    }


# ---------------------------------------------------------------------------
# 分配規則設定
# ---------------------------------------------------------------------------
@router.get("/policies")
async def list_policies(staff: CurrentStaff, db: DbSession):
    """列出本租戶所有分配策略。"""
    rows = (
        await db.execute(
            select(RoutingPolicy).where(
                RoutingPolicy.tenant_id == staff.tenant_id,
                RoutingPolicy.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    return ok([_policy_out(p) for p in rows])


@router.put("/policies")
async def upsert_policy(body: PolicyIn, staff: CurrentStaff, db: DbSession):
    """新增或更新某技能組(或租戶預設)的分配策略。"""
    staff.require("routing.manage")
    if body.strategy not in VALID_STRATEGIES:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"invalid strategy: {body.strategy}",
        )
    stmt = select(RoutingPolicy).where(
        RoutingPolicy.tenant_id == staff.tenant_id,
        RoutingPolicy.deleted_at.is_(None),
    )
    if body.skill_group_id is None:
        stmt = stmt.where(RoutingPolicy.skill_group_id.is_(None))
    else:
        stmt = stmt.where(RoutingPolicy.skill_group_id == body.skill_group_id)
    policy = (await db.execute(stmt)).scalar_one_or_none()

    if policy is None:
        policy = RoutingPolicy(
            tenant_id=staff.tenant_id,
            skill_group_id=body.skill_group_id,
            strategy=body.strategy,
            max_load=body.max_load,
        )
        db.add(policy)
    else:
        policy.strategy = body.strategy
        policy.max_load = body.max_load
    await db.commit()
    await db.refresh(policy)
    return ok(_policy_out(policy))


# ---------------------------------------------------------------------------
# 佇列與坐席負載查詢
# ---------------------------------------------------------------------------
@router.get("/queue")
async def get_queue(
    staff: CurrentStaff,
    db: DbSession,
    skill_group_id: uuid.UUID | None = None,
):
    """列出佇列中的會話(未分配),可選技能組過濾。"""
    sessions = await routing_svc.list_queue(db, staff.tenant_id, skill_group_id)
    data = [
        {
            "session_id": str(s.id),
            "skill_group_id": str(s.skill_group_id) if s.skill_group_id else None,
            "channel_id": str(s.channel_id),
            "created_at": s.created_at.isoformat() if s.created_at else None,
        }
        for s in sessions
    ]
    return ok({"count": len(data), "sessions": data})


@router.get("/agents/load")
async def get_agent_loads(
    staff: CurrentStaff,
    db: DbSession,
    skill_group_id: uuid.UUID | None = None,
):
    """列出候選在線坐席的目前負載與接待上限(供監控/手動指派決策)。"""
    loads = await routing_svc.agent_loads(db, staff.tenant_id, skill_group_id)
    return ok(
        [
            {
                "staff_id": str(a.staff_id),
                "current_load": a.current_load,
                "max_load": a.max_load,
                "available": a.available,
            }
            for a in loads
        ]
    )


# ---------------------------------------------------------------------------
# 指派 / 搶單
# ---------------------------------------------------------------------------
@router.post("/sessions/{session_id}/assign")
async def auto_assign(session_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """依規則自動分配一個會話;無可用坐席則入佇列(assigned_staff_id 為 null)。

    服務層 assign_session 對「不存在/非本租戶/已關閉」與「無可用坐席入佇列」都回
    None,若直接照它回覆,前兩種會被誤報成 queued:true(假入佇列)。故此端點先行
    校驗會話,將三種情形分流,並與手動指派(assign_to)回 404 的行為一致化:
      - 不存在(或非本租戶)→ 404。
      - 已關閉 → 400 SESSION_CLOSED(明確錯誤,不假裝入佇列)。
    通過校驗後,assign_session 回 None 才是真正的入佇列。
    """
    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="session not found")
    if session.status == "closed":
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content=err("SESSION_CLOSED", "會話已關閉,無法分配"),
        )

    assigned = await routing_svc.assign_session(db, staff.tenant_id, session_id)
    return ok(
        {
            "session_id": str(session_id),
            "assigned_staff_id": str(assigned) if assigned else None,
            "queued": assigned is None,
        }
    )


@router.post("/sessions/{session_id}/assign/{target_staff_id}")
async def assign_to(
    session_id: uuid.UUID,
    target_staff_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
):
    """手動把會話指派給指定坐席(需 routing.manage 權限)。"""
    staff.require("routing.manage")
    assigned = await routing_svc.manual_assign(
        db, staff.tenant_id, session_id, target_staff_id
    )
    if assigned is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="session or target staff not found / not assignable"
        )
    return ok({"session_id": str(session_id), "assigned_staff_id": str(assigned)})


@router.post("/sessions/{session_id}/claim")
async def claim(session_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """搶單:當前坐席主動認領一個(通常在佇列中的)會話。"""
    assigned = await routing_svc.manual_assign(
        db, staff.tenant_id, session_id, staff.staff_id
    )
    if assigned is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="session not found / not claimable"
        )
    return ok({"session_id": str(session_id), "assigned_staff_id": str(assigned)})
