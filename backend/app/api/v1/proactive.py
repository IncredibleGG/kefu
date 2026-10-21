"""主動式訊息(proactive messages)API:規則 CRUD + widget 公開端點。

掛載前綴(整合者於 main.py 註冊):`/api/v1/proactive`
    from app.api.v1 import proactive
    app.include_router(proactive.router, prefix="/api/v1/proactive", tags=["proactive"])

端點:
- POST   `/api/v1/proactive`                    建立規則(admin / `proactive.manage`)
- GET    `/api/v1/proactive`                    列出本租戶規則(可選 channel_id / is_active 過濾)
- GET    `/api/v1/proactive/{rule_id}`          取單筆
- PATCH  `/api/v1/proactive/{rule_id}`          更新(部分)
- DELETE `/api/v1/proactive/{rule_id}`          軟刪
- GET    `/api/v1/proactive/public/{channel_key}`  **公開**(無 JWT):回該渠道 is_active
         規則(不含機敏欄位),widget 端評估觸發。

規則:管理端一律以 principal.tenant_id 過濾;公開端以 channel_key(渠道 public_key)
定位渠道,回傳「channel_id 為該渠道 或 為 NULL(全渠道通用)」且 is_active 的規則。
所有回應走 ok()/err() 信封。
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import or_, select

from app.api.v1.channel import _channel_by_public_key
from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.models.conversation import Channel
from app.models.proactive import FREQUENCIES, MODES, TRIGGER_TYPES, ProactiveRule

router = APIRouter()


# --------------------------------------------------------------------------- #
# Pydantic schemas
# --------------------------------------------------------------------------- #
class TriggerIn(BaseModel):
    """觸發條件。type 必填且須為支援型別;params 由前端依 type 解讀。"""

    type: str
    params: dict[str, Any] = Field(default_factory=dict)


class ProactiveCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    trigger: TriggerIn
    message: str = Field(min_length=1)
    mode: str = "show_bubble"
    frequency: str = "once_per_session"
    priority: int = 0
    is_active: bool = True
    # 選填:綁定單一渠道;省略 = 全渠道通用
    channel_id: uuid.UUID | None = None


class ProactiveUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    trigger: TriggerIn | None = None
    message: str | None = Field(default=None, min_length=1)
    mode: str | None = None
    frequency: str | None = None
    priority: int | None = None
    is_active: bool | None = None
    channel_id: uuid.UUID | None = None


# --------------------------------------------------------------------------- #
# 驗證 / 序列化
# --------------------------------------------------------------------------- #
def _validate_enums(*, trigger: TriggerIn | None, mode: str | None, frequency: str | None) -> str | None:
    """回傳錯誤訊息(不合法時);皆合法回 None。"""
    if trigger is not None and trigger.type not in TRIGGER_TYPES:
        return f"不支援的 trigger.type:{trigger.type}(可用:{', '.join(TRIGGER_TYPES)})"
    if mode is not None and mode not in MODES:
        return f"不支援的 mode:{mode}(可用:{', '.join(MODES)})"
    if frequency is not None and frequency not in FREQUENCIES:
        return f"不支援的 frequency:{frequency}(可用:{', '.join(FREQUENCIES)})"
    return None


def _serialize(r: ProactiveRule) -> dict:
    """管理端完整輸出。"""
    return {
        "id": str(r.id),
        "name": r.name,
        "channel_id": str(r.channel_id) if r.channel_id else None,
        "trigger": r.trigger,
        "message": r.message,
        "mode": r.mode,
        "frequency": r.frequency,
        "priority": r.priority,
        "is_active": r.is_active,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


def _public_serialize(r: ProactiveRule) -> dict:
    """widget 可讀的公開子集(不含 name / channel_id / tenant_id / 時戳等內部欄位)。"""
    return {
        "id": str(r.id),
        "trigger": r.trigger,
        "message": r.message,
        "mode": r.mode,
        "frequency": r.frequency,
        "priority": r.priority,
    }


async def _get_owned(db, staff, rule_id: uuid.UUID) -> ProactiveRule | None:
    return (
        await db.execute(
            select(ProactiveRule).where(
                ProactiveRule.id == rule_id,
                ProactiveRule.tenant_id == staff.tenant_id,
                ProactiveRule.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


async def _channel_belongs_to_tenant(db, tenant_id, channel_id: uuid.UUID) -> bool:
    row = (
        await db.execute(
            select(Channel.id).where(
                Channel.id == channel_id,
                Channel.tenant_id == tenant_id,
                Channel.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    return row is not None


# --------------------------------------------------------------------------- #
# CRUD(需 JWT + admin/proactive.manage)
# --------------------------------------------------------------------------- #
@router.post("")
async def create_rule(body: ProactiveCreate, staff: CurrentStaff, db: DbSession):
    staff.require("proactive.manage")
    msg = _validate_enums(trigger=body.trigger, mode=body.mode, frequency=body.frequency)
    if msg:
        return JSONResponse(status_code=400, content=err("PROACTIVE_INVALID", msg))
    if body.channel_id is not None and not await _channel_belongs_to_tenant(
        db, staff.tenant_id, body.channel_id
    ):
        return JSONResponse(status_code=400, content=err("PROACTIVE_BAD_CHANNEL", "channel_id 不屬於本租戶"))

    rule = ProactiveRule(
        tenant_id=staff.tenant_id,
        name=body.name,
        channel_id=body.channel_id,
        trigger=body.trigger.model_dump(),
        message=body.message,
        mode=body.mode,
        frequency=body.frequency,
        priority=body.priority,
        is_active=body.is_active,
    )
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return ok(_serialize(rule))


@router.get("")
async def list_rules(
    staff: CurrentStaff,
    db: DbSession,
    channel_id: uuid.UUID | None = None,
    is_active: bool | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    conds = [
        ProactiveRule.tenant_id == staff.tenant_id,
        ProactiveRule.deleted_at.is_(None),
    ]
    if channel_id is not None:
        conds.append(ProactiveRule.channel_id == channel_id)
    if is_active is not None:
        conds.append(ProactiveRule.is_active.is_(is_active))
    rows = (
        await db.execute(
            select(ProactiveRule)
            .where(*conds)
            .order_by(ProactiveRule.priority.desc(), ProactiveRule.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
    ).scalars().all()
    return ok({"items": [_serialize(r) for r in rows], "limit": limit, "offset": offset})


@router.get("/public/{channel_key}")
async def public_rules(channel_key: str, db: DbSession):
    """widget 依 channel_key(渠道 public_key)取該渠道啟用中的主動式訊息規則。

    回傳:channel_id 為該渠道 或 為 NULL(全渠道通用)、且 is_active 的規則,
    依 priority 由高到低排序;僅含公開子集(不含機敏欄位)。渠道不存在回 404。
    """
    channel = await _channel_by_public_key(db, channel_key)
    if channel is None:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "渠道不存在"))
    rows = (
        await db.execute(
            select(ProactiveRule)
            .where(
                ProactiveRule.tenant_id == channel.tenant_id,
                ProactiveRule.is_active.is_(True),
                ProactiveRule.deleted_at.is_(None),
                or_(
                    ProactiveRule.channel_id == channel.id,
                    ProactiveRule.channel_id.is_(None),
                ),
            )
            .order_by(ProactiveRule.priority.desc(), ProactiveRule.created_at.asc())
        )
    ).scalars().all()
    return ok([_public_serialize(r) for r in rows])


@router.get("/{rule_id}")
async def get_rule(rule_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    r = await _get_owned(db, staff, rule_id)
    if r is None:
        return JSONResponse(status_code=404, content=err("PROACTIVE_NOT_FOUND", "規則不存在"))
    return ok(_serialize(r))


@router.patch("/{rule_id}")
async def update_rule(rule_id: uuid.UUID, body: ProactiveUpdate, staff: CurrentStaff, db: DbSession):
    staff.require("proactive.manage")
    r = await _get_owned(db, staff, rule_id)
    if r is None:
        return JSONResponse(status_code=404, content=err("PROACTIVE_NOT_FOUND", "規則不存在"))

    msg = _validate_enums(trigger=body.trigger, mode=body.mode, frequency=body.frequency)
    if msg:
        return JSONResponse(status_code=400, content=err("PROACTIVE_INVALID", msg))

    data = body.model_dump(exclude_unset=True)
    if "channel_id" in data:
        if data["channel_id"] is not None and not await _channel_belongs_to_tenant(
            db, staff.tenant_id, data["channel_id"]
        ):
            return JSONResponse(status_code=400, content=err("PROACTIVE_BAD_CHANNEL", "channel_id 不屬於本租戶"))
        r.channel_id = data["channel_id"]
    if "trigger" in data and body.trigger is not None:
        r.trigger = body.trigger.model_dump()
    if "name" in data:
        r.name = data["name"]
    if "message" in data:
        r.message = data["message"]
    if "mode" in data and data["mode"] is not None:
        r.mode = data["mode"]
    if "frequency" in data and data["frequency"] is not None:
        r.frequency = data["frequency"]
    if "priority" in data and data["priority"] is not None:
        r.priority = data["priority"]
    if "is_active" in data and data["is_active"] is not None:
        r.is_active = data["is_active"]

    await db.commit()
    await db.refresh(r)
    return ok(_serialize(r))


@router.delete("/{rule_id}")
async def delete_rule(rule_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    staff.require("proactive.manage")
    r = await _get_owned(db, staff, rule_id)
    if r is None:
        return JSONResponse(status_code=404, content=err("PROACTIVE_NOT_FOUND", "規則不存在"))
    r.deleted_at = datetime.now(UTC)
    r.is_active = False
    await db.commit()
    return ok({"id": str(rule_id), "deleted": True})
