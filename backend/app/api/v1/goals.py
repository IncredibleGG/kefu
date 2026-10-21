"""目標 / 銷售追蹤 API(對齊 LiveChat 的 Goals & Sales tracker)。

router 前綴由 main.py 掛為 ``/api/v1/goals``。全部:
- 依 ``staff.tenant_id`` 做租戶隔離(絕不信任前端傳入的 tenant_id);
- 讀取(list / summary)需 ``report.view``;寫入(create / update / delete)需 admin 或
  ``settings.manage``(``Principal.require`` 對 admin 一律放行,與 settings.py 一致);
- 回傳統一信封 ``ok(...)``。

Goal 定義要衡量的轉換(到達某網址 url / 自訂事件 event / 坐席手動標記 manual),
GoalConversion 記錄每次達成並歸因到當時的訪客/會話。url 型目標的自動比對於
channel.py 的 pageview 上報端點完成;manual 型由 ``POST /{id}/achieve`` 手動標記。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentStaff, DbSession, Principal
from app.core.response import err, ok
from app.models.conversation import Session
from app.models.goals import GOAL_KINDS, Goal, GoalConversion
from app.models.visitor import Visitor

router = APIRouter()


# --------------------------------------------------------------------------- #
# Pydantic schemas
# --------------------------------------------------------------------------- #
class GoalCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=160)
    kind: str = "url"  # url | event | manual
    # url 型放 {url_contains};event 型放 {event_name};manual 可留空
    config: dict[str, Any] | None = None
    value_cents: int = 0
    currency: str = Field(default="USD", max_length=10)
    is_active: bool = True


class GoalUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    kind: str | None = None
    config: dict[str, Any] | None = None
    value_cents: int | None = None
    currency: str | None = Field(default=None, max_length=10)
    is_active: bool | None = None


class GoalAchieveIn(BaseModel):
    """manual 型手動標記達成的可選歸因/覆寫欄位。"""

    session_id: uuid.UUID | None = None
    visitor_id: uuid.UUID | None = None
    # 未給則沿用 goal.value_cents
    value_cents: int | None = None


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #
def _serialize(goal: Goal) -> dict[str, Any]:
    return {
        "id": str(goal.id),
        "name": goal.name,
        "kind": goal.kind,
        "config": goal.config or {},
        "value_cents": goal.value_cents,
        "currency": goal.currency,
        "is_active": goal.is_active,
        "created_at": goal.created_at.isoformat() if goal.created_at else None,
    }


def _serialize_conversion(conv: GoalConversion) -> dict[str, Any]:
    return {
        "id": str(conv.id),
        "goal_id": str(conv.goal_id),
        "visitor_id": str(conv.visitor_id) if conv.visitor_id else None,
        "session_id": str(conv.session_id) if conv.session_id else None,
        "staff_id": str(conv.staff_id) if conv.staff_id else None,
        "value_cents": conv.value_cents,
        "occurred_at": conv.occurred_at.isoformat() if conv.occurred_at else None,
    }


def _invalid_value(value_cents: int | None) -> JSONResponse | None:
    """value_cents 若為負值回 400(GOAL_INVALID_VALUE);None 或 >=0 皆放行。

    銷售價值不可為負(對齊 LiveChat 的 Goals & Sales:達成只加值不扣值),
    負值會污染逐坐席 sales 排行與總額聚合,故於 create/update/achive 入口即擋。
    """
    if value_cents is not None and value_cents < 0:
        return JSONResponse(
            status_code=400,
            content=err("GOAL_INVALID_VALUE", "每次價值(value_cents)不可為負"),
        )
    return None


def _require_write(staff: Principal) -> None:
    """寫入權限:admin 或 settings.manage(require 對 admin 自動放行)。"""
    staff.require("settings.manage")


async def _get_owned_goal(
    db: AsyncSession, tenant_id: uuid.UUID, goal_id: uuid.UUID
) -> Goal | None:
    """取租戶自己的目標(tenant 過濾 + 未軟刪)。"""
    return (
        await db.execute(
            select(Goal).where(
                Goal.id == goal_id,
                Goal.tenant_id == tenant_id,
                Goal.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


# --------------------------------------------------------------------------- #
# 摘要聚合(需在 /{goal_id} 路由前宣告,避免 "summary" 被當成 goal_id)
# --------------------------------------------------------------------------- #
@router.get("/summary")
async def goals_summary(
    staff: CurrentStaff,
    db: DbSession,
    days: int = Query(default=30, ge=1, le=365, description="回溯天數"),
):
    """各目標近 N 天的達成次數與總價值。

    單一聚合查詢(outer join 於 ON 帶時間/租戶條件),無達成的目標仍以 0 呈現,
    全程 SQL 聚合、無 N+1;租戶隔離。
    """
    staff.require("report.view")
    since = datetime.now(timezone.utc) - timedelta(days=days)

    conv_count = func.count(GoalConversion.id)
    conv_sum = func.coalesce(func.sum(GoalConversion.value_cents), 0)
    rows = (
        await db.execute(
            select(
                Goal.id,
                Goal.name,
                Goal.kind,
                Goal.currency,
                Goal.value_cents,
                Goal.is_active,
                conv_count.label("conversions"),
                conv_sum.label("total_value_cents"),
            )
            .select_from(Goal)
            .outerjoin(
                GoalConversion,
                and_(
                    GoalConversion.goal_id == Goal.id,
                    GoalConversion.tenant_id == staff.tenant_id,
                    GoalConversion.deleted_at.is_(None),
                    GoalConversion.occurred_at >= since,
                ),
            )
            .where(Goal.tenant_id == staff.tenant_id, Goal.deleted_at.is_(None))
            .group_by(
                Goal.id,
                Goal.name,
                Goal.kind,
                Goal.currency,
                Goal.value_cents,
                Goal.is_active,
                Goal.created_at,
            )
            .order_by(Goal.created_at.desc())
        )
    ).all()

    return ok(
        {
            "days": days,
            "goals": [
                {
                    "id": str(gid),
                    "name": name,
                    "kind": kind,
                    "currency": currency,
                    "value_cents": int(value_cents),
                    "is_active": bool(is_active),
                    "conversions": int(conversions),
                    "total_value_cents": int(total_value_cents),
                }
                for gid, name, kind, currency, value_cents, is_active, conversions, total_value_cents in rows
            ],
        }
    )


# --------------------------------------------------------------------------- #
# Goal CRUD
# --------------------------------------------------------------------------- #
@router.get("")
async def list_goals(staff: CurrentStaff, db: DbSession):
    """列出本租戶的目標(最新在前)。"""
    staff.require("report.view")
    rows = (
        await db.execute(
            select(Goal)
            .where(Goal.tenant_id == staff.tenant_id, Goal.deleted_at.is_(None))
            .order_by(Goal.created_at.desc())
        )
    ).scalars().all()
    return ok([_serialize(g) for g in rows])


@router.post("")
async def create_goal(body: GoalCreate, staff: CurrentStaff, db: DbSession):
    """建立目標。kind 需為 url | event | manual。"""
    _require_write(staff)
    if body.kind not in GOAL_KINDS:
        return JSONResponse(
            status_code=400,
            content=err("GOAL_INVALID_KIND", f"不支援的目標型別:{body.kind}"),
        )
    if (invalid := _invalid_value(body.value_cents)) is not None:
        return invalid
    goal = Goal(
        tenant_id=staff.tenant_id,
        name=body.name.strip(),
        kind=body.kind,
        config=dict(body.config) if body.config else None,
        value_cents=body.value_cents,
        currency=body.currency,
        is_active=body.is_active,
    )
    db.add(goal)
    await db.commit()
    await db.refresh(goal)
    return ok(_serialize(goal))


@router.patch("/{goal_id}")
async def update_goal(
    goal_id: uuid.UUID, body: GoalUpdate, staff: CurrentStaff, db: DbSession
):
    """更新目標(部分欄位)。"""
    _require_write(staff)
    goal = await _get_owned_goal(db, staff.tenant_id, goal_id)
    if goal is None:
        return JSONResponse(status_code=404, content=err("GOAL_NOT_FOUND", "目標不存在"))
    if (invalid := _invalid_value(body.value_cents)) is not None:
        return invalid
    if body.kind is not None:
        if body.kind not in GOAL_KINDS:
            return JSONResponse(
                status_code=400,
                content=err("GOAL_INVALID_KIND", f"不支援的目標型別:{body.kind}"),
            )
        goal.kind = body.kind
    if body.name is not None:
        goal.name = body.name.strip()
    if body.config is not None:
        goal.config = dict(body.config)
    if body.value_cents is not None:
        goal.value_cents = body.value_cents
    if body.currency is not None:
        goal.currency = body.currency
    if body.is_active is not None:
        goal.is_active = body.is_active
    await db.commit()
    await db.refresh(goal)
    return ok(_serialize(goal))


@router.delete("/{goal_id}")
async def delete_goal(goal_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """刪除目標(軟刪,保留既有達成歷史;之後不再參與比對與摘要)。"""
    _require_write(staff)
    goal = await _get_owned_goal(db, staff.tenant_id, goal_id)
    if goal is None:
        return JSONResponse(status_code=404, content=err("GOAL_NOT_FOUND", "目標不存在"))
    goal.deleted_at = datetime.now(timezone.utc)
    goal.is_active = False
    await db.commit()
    return ok({"id": str(goal_id), "deleted": True})


# --------------------------------------------------------------------------- #
# 手動標記達成(manual 型)
# --------------------------------------------------------------------------- #
@router.post("/{goal_id}/achieve")
async def achieve_goal(
    goal_id: uuid.UUID, body: GoalAchieveIn, staff: CurrentStaff, db: DbSession
):
    """坐席手動標記某 manual 型目標達成 → 建一筆 GoalConversion。

    成交歸因當前坐席(``staff.staff_id``),供逐坐席 sales 排行。
    body 可帶 session_id / visitor_id 做歸因(需屬本租戶,否則 400 防跨租戶關聯)、
    value_cents 覆寫價值(未給沿用 goal.value_cents;負值回 GOAL_INVALID_VALUE)。

    權限:坐席日常操作,需 ``conversation.assign``(admin 由 require() 短路放行)。
    標記成交是坐席處理會話時的動作,語意與該碼相符且 agent 角色本就擁有;
    有別於 CRUD(create/update/delete)所需的較高 ``settings.manage``。
    此檢查擋掉空權限坐席未經授權寫入成交、污染逐坐席 sales 排行與銷售報表。
    """
    staff.require("conversation.assign")
    goal = await _get_owned_goal(db, staff.tenant_id, goal_id)
    if goal is None:
        return JSONResponse(status_code=404, content=err("GOAL_NOT_FOUND", "目標不存在"))
    if goal.kind != "manual":
        return JSONResponse(
            status_code=400,
            content=err("GOAL_NOT_MANUAL", "僅手動型目標可由坐席手動標記達成"),
        )
    if (invalid := _invalid_value(body.value_cents)) is not None:
        return invalid

    session_id: uuid.UUID | None = None
    if body.session_id is not None:
        session_id = (
            await db.execute(
                select(Session.id).where(
                    Session.id == body.session_id,
                    Session.tenant_id == staff.tenant_id,
                    Session.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if session_id is None:
            return JSONResponse(
                status_code=400, content=err("GOAL_SESSION_NOT_FOUND", "會話不存在或不屬本租戶")
            )

    visitor_id: uuid.UUID | None = None
    if body.visitor_id is not None:
        visitor_id = (
            await db.execute(
                select(Visitor.id).where(
                    Visitor.id == body.visitor_id,
                    Visitor.tenant_id == staff.tenant_id,
                    Visitor.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if visitor_id is None:
            return JSONResponse(
                status_code=400, content=err("GOAL_VISITOR_NOT_FOUND", "訪客不存在或不屬本租戶")
            )

    value_cents = body.value_cents if body.value_cents is not None else goal.value_cents
    # manual 型歸因當前坐席(標記達成者即成交坐席),供逐坐席 sales 排行。
    conv = GoalConversion(
        tenant_id=staff.tenant_id,
        goal_id=goal.id,
        visitor_id=visitor_id,
        session_id=session_id,
        staff_id=staff.staff_id,
        value_cents=value_cents,
    )
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return ok(_serialize_conversion(conv))
