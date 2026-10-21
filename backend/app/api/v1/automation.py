"""自動化規則引擎 API:規則 CRUD + 目錄(catalog)。

掛載前綴(由整合方於 main.py 註冊):/api/v1/automation
- 查詢類(list / get / catalog):一般坐席即可,一律以 CurrentStaff.tenant_id 隔離。
- 管理類(create / update / delete):需 ``automation.manage`` 權限(admin 亦可)。

成功走 response.ok 信封;錯誤一律 raise HTTPException(正確狀態碼, detail={code,message}),
由全域處理器包成統一信封並保留狀態碼(查無資料 → 404 not_found,輸入不合法 →
400 bad_request)。絕不信任用戶端傳入的 tenant_id。
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import ok
from app.models.automation import (
    ACTION_TYPES,
    CONDITION_OPS,
    DEFAULT_PRIORITY,
    TRIGGER_EVENTS,
    AutomationRule,
)
from app.services import automation as automation_svc

router = APIRouter()


# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #
class ConditionIn(BaseModel):
    field: str = Field(min_length=1, max_length=100)
    op: str
    value: Any = None


class ActionIn(BaseModel):
    type: str
    params: dict = Field(default_factory=dict)


class RuleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    trigger_event: str
    conditions: list[ConditionIn] = Field(default_factory=list)
    actions: list[ActionIn] = Field(default_factory=list)
    is_active: bool = True
    priority: int = DEFAULT_PRIORITY


class RuleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    trigger_event: str | None = None
    conditions: list[ConditionIn] | None = None
    actions: list[ActionIn] | None = None
    is_active: bool | None = None
    priority: int | None = None


def _serialize(r: AutomationRule) -> dict:
    return {
        "id": str(r.id),
        "name": r.name,
        "trigger_event": r.trigger_event,
        "conditions": r.conditions or [],
        "actions": r.actions or [],
        "is_active": r.is_active,
        "priority": r.priority,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


def _validate(
    trigger_event: str | None,
    conditions: list[ConditionIn] | None,
    actions: list[ActionIn] | None,
) -> str | None:
    """驗證觸發事件 / 條件運算子 / 動作型別;不合法回錯誤訊息,否則 None。"""
    if trigger_event is not None and trigger_event not in TRIGGER_EVENTS:
        return f"invalid trigger_event: {trigger_event}"
    for cond in conditions or []:
        if cond.op not in CONDITION_OPS:
            return f"invalid condition op: {cond.op}"
    for action in actions or []:
        if action.type not in ACTION_TYPES:
            return f"invalid action type: {action.type}"
    return None


# --------------------------------------------------------------------------- #
# 目錄(供前端規則建構器)
# --------------------------------------------------------------------------- #
@router.get("/catalog")
async def get_catalog(staff: CurrentStaff):
    """回傳可用的 events / condition 欄位與運算子 / action 型別清單。"""
    return ok(automation_svc.get_catalog())


# --------------------------------------------------------------------------- #
# CRUD
# --------------------------------------------------------------------------- #
@router.get("/rules")
async def list_rules(
    staff: CurrentStaff,
    db: DbSession,
    trigger_event: str | None = None,
    is_active: bool | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    """列出本租戶的規則(依 priority 升冪),可選事件 / 啟用狀態過濾。"""
    conds = [
        AutomationRule.tenant_id == staff.tenant_id,
        AutomationRule.deleted_at.is_(None),
    ]
    if trigger_event is not None:
        conds.append(AutomationRule.trigger_event == trigger_event)
    if is_active is not None:
        conds.append(AutomationRule.is_active.is_(is_active))

    total = (
        await db.execute(select(func.count()).select_from(AutomationRule).where(*conds))
    ).scalar_one()
    rows = (
        await db.execute(
            select(AutomationRule)
            .where(*conds)
            .order_by(AutomationRule.priority.asc(), AutomationRule.created_at.asc())
            .offset(offset)
            .limit(limit)
        )
    ).scalars().all()
    return ok(
        {
            "items": [_serialize(r) for r in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    )


@router.get("/rules/{rule_id}")
async def get_rule(rule_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """單筆規則(租戶隔離)。"""
    r = await _get_owned(db, staff, rule_id)
    if r is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "automation rule not found"},
        )
    return ok(_serialize(r))


@router.post("/rules")
async def create_rule(body: RuleCreate, staff: CurrentStaff, db: DbSession):
    """建立規則(需 automation.manage)。"""
    staff.require("automation.manage")
    invalid = _validate(body.trigger_event, body.conditions, body.actions)
    if invalid:
        raise HTTPException(
            status_code=400, detail={"code": "bad_request", "message": invalid}
        )

    r = AutomationRule(
        tenant_id=staff.tenant_id,
        name=body.name,
        trigger_event=body.trigger_event,
        conditions=[c.model_dump() for c in body.conditions],
        actions=[a.model_dump() for a in body.actions],
        is_active=body.is_active,
        priority=body.priority,
    )
    db.add(r)
    await db.commit()
    await db.refresh(r)
    return ok(_serialize(r))


@router.patch("/rules/{rule_id}")
async def update_rule(
    rule_id: uuid.UUID, body: RuleUpdate, staff: CurrentStaff, db: DbSession
):
    """更新規則(需 automation.manage)。只更新有帶的欄位。"""
    staff.require("automation.manage")
    r = await _get_owned(db, staff, rule_id)
    if r is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "automation rule not found"},
        )

    invalid = _validate(body.trigger_event, body.conditions, body.actions)
    if invalid:
        raise HTTPException(
            status_code=400, detail={"code": "bad_request", "message": invalid}
        )

    data = body.model_dump(exclude_unset=True)
    if "name" in data:
        r.name = data["name"]
    if "trigger_event" in data:
        r.trigger_event = data["trigger_event"]
    if "conditions" in data and body.conditions is not None:
        r.conditions = [c.model_dump() for c in body.conditions]
    if "actions" in data and body.actions is not None:
        r.actions = [a.model_dump() for a in body.actions]
    if "is_active" in data:
        r.is_active = data["is_active"]
    if "priority" in data:
        r.priority = data["priority"]

    await db.commit()
    await db.refresh(r)
    return ok(_serialize(r))


@router.delete("/rules/{rule_id}")
async def delete_rule(rule_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """軟刪規則(需 automation.manage)。"""
    staff.require("automation.manage")
    r = await _get_owned(db, staff, rule_id)
    if r is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "automation rule not found"},
        )
    r.deleted_at = datetime.now(UTC)
    await db.commit()
    return ok({"id": str(rule_id), "deleted": True})


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
async def _get_owned(db, staff, rule_id: uuid.UUID) -> AutomationRule | None:
    return (
        await db.execute(
            select(AutomationRule).where(
                AutomationRule.id == rule_id,
                AutomationRule.tenant_id == staff.tenant_id,
                AutomationRule.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
