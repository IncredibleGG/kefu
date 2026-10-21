"""AI 工作流編排 API(W6 自建首版):AIWorkflow CRUD + 手動觸發執行(測試)。

掛載前綴(由整合方於 main.py 註冊):/api/v1/workflows
- 查詢類(list / get / catalog):一般坐席即可,一律以 CurrentStaff.tenant_id 隔離。
- 管理類(create / update / delete / run):需 ``workflow.manage`` 權限(admin 亦可)。

回覆一律走 app.core.response 信封;查無資料回 err("not_found", ...),
輸入不合法回 err("bad_request", ...)。絕不信任用戶端傳入的 tenant_id。
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.models.ai_workflow import AIWorkflow
from app.services import workflow_engine

router = APIRouter()


# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #
class WorkflowCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=500)
    trigger: str = "manual"
    definition: dict[str, Any] | None = None
    is_active: bool = False


class WorkflowUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=500)
    trigger: str | None = None
    definition: dict[str, Any] | None = None
    is_active: bool | None = None


class RunIn(BaseModel):
    """手動觸發測試。ctx 為測試脈絡;dry_run 預設 True(不做副作用)。"""

    ctx: dict[str, Any] = Field(default_factory=dict)
    dry_run: bool = True


def _serialize(w: AIWorkflow) -> dict:
    return {
        "id": str(w.id),
        "name": w.name,
        "description": w.description,
        "trigger": w.trigger,
        "definition": w.definition or {},
        "is_active": w.is_active,
        "created_at": w.created_at.isoformat() if w.created_at else None,
        "updated_at": w.updated_at.isoformat() if w.updated_at else None,
    }


def _validate(trigger: str | None, definition: Any) -> str | None:
    """驗證觸發時機與 definition 基本結構;不合法回錯誤訊息,否則 None。"""
    if trigger is not None and trigger not in workflow_engine.TRIGGER_TYPES:
        return f"invalid trigger: {trigger}"
    return workflow_engine.validate_definition(definition)


# --------------------------------------------------------------------------- #
# 目錄(供前端節點編輯器)
# --------------------------------------------------------------------------- #
@router.get("/catalog")
async def get_catalog(staff: CurrentStaff):
    """回傳可用的節點型別 / 條件運算子 / 觸發時機清單。"""
    return ok(workflow_engine.get_catalog())


# --------------------------------------------------------------------------- #
# CRUD
# --------------------------------------------------------------------------- #
@router.get("")
async def list_workflows(
    staff: CurrentStaff,
    db: DbSession,
    is_active: bool | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    """列出本租戶的工作流(依建立時間新到舊),可選啟用狀態過濾。"""
    conds = [
        AIWorkflow.tenant_id == staff.tenant_id,
        AIWorkflow.deleted_at.is_(None),
    ]
    if is_active is not None:
        conds.append(AIWorkflow.is_active.is_(is_active))

    total = (
        await db.execute(select(func.count()).select_from(AIWorkflow).where(*conds))
    ).scalar_one()
    rows = (
        await db.execute(
            select(AIWorkflow)
            .where(*conds)
            .order_by(AIWorkflow.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
    ).scalars().all()
    return ok(
        {
            "items": [_serialize(w) for w in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    )


@router.get("/{workflow_id}")
async def get_workflow(workflow_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """單筆工作流(租戶隔離)。"""
    w = await _get_owned(db, staff, workflow_id)
    if w is None:
        return err("not_found", "workflow not found")
    return ok(_serialize(w))


@router.post("")
async def create_workflow(body: WorkflowCreate, staff: CurrentStaff, db: DbSession):
    """建立工作流(需 workflow.manage)。"""
    staff.require("workflow.manage")
    invalid = _validate(body.trigger, body.definition)
    if invalid:
        return err("bad_request", invalid)

    w = AIWorkflow(
        tenant_id=staff.tenant_id,
        name=body.name,
        description=body.description,
        trigger=body.trigger,
        definition=body.definition,
        is_active=body.is_active,
    )
    db.add(w)
    await db.commit()
    await db.refresh(w)
    return ok(_serialize(w))


@router.patch("/{workflow_id}")
async def update_workflow(
    workflow_id: uuid.UUID, body: WorkflowUpdate, staff: CurrentStaff, db: DbSession
):
    """更新工作流(需 workflow.manage)。只更新有帶的欄位。"""
    staff.require("workflow.manage")
    w = await _get_owned(db, staff, workflow_id)
    if w is None:
        return err("not_found", "workflow not found")

    data = body.model_dump(exclude_unset=True)
    invalid = _validate(
        data.get("trigger") if "trigger" in data else None,
        data.get("definition") if "definition" in data else None,
    )
    if invalid:
        return err("bad_request", invalid)

    if "name" in data:
        w.name = data["name"]
    if "description" in data:
        w.description = data["description"]
    if "trigger" in data:
        w.trigger = data["trigger"]
    if "definition" in data:
        w.definition = data["definition"]
    if "is_active" in data:
        w.is_active = data["is_active"]

    await db.commit()
    await db.refresh(w)
    return ok(_serialize(w))


@router.delete("/{workflow_id}")
async def delete_workflow(workflow_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """軟刪工作流(需 workflow.manage)。"""
    staff.require("workflow.manage")
    w = await _get_owned(db, staff, workflow_id)
    if w is None:
        return err("not_found", "workflow not found")
    w.deleted_at = datetime.now(UTC)
    await db.commit()
    return ok({"id": str(workflow_id), "deleted": True})


# --------------------------------------------------------------------------- #
# 手動觸發執行(測試)
# --------------------------------------------------------------------------- #
@router.post("/{workflow_id}/run")
async def run_workflow(
    workflow_id: uuid.UUID, body: RunIn, staff: CurrentStaff, db: DbSession
):
    """手動觸發執行(測試),回執行軌跡與結果(需 workflow.manage)。

    - dry_run(預設 True):不做任何副作用(不發訊息 / 不改會話 / 不寫標籤),
      只回「將會執行什麼」的軌跡;執行後 rollback 確保零副作用。
    - dry_run=False:須在 ctx 帶有效 session_id 才會真正產生副作用;成功後 commit。
      引擎全程降級不拋,故本端點不會因流程內錯誤而 500。
    """
    staff.require("workflow.manage")
    w = await _get_owned(db, staff, workflow_id)
    if w is None:
        return err("not_found", "workflow not found")

    # 合併 dry_run 到 ctx(ctx 內顯式設定優先);絕不信任用戶端 tenant_id
    ctx = dict(body.ctx or {})
    ctx.setdefault("dry_run", body.dry_run)

    result = await workflow_engine.run_workflow(db, w, ctx)

    # 副作用交易收尾:乾跑一律 rollback(丟棄任何 flush);實跑成功才 commit
    try:
        if result.get("dry_run"):
            await db.rollback()
        else:
            await db.commit()
    except Exception:
        await db.rollback()

    return ok({"workflow_id": str(workflow_id), "result": result})


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
async def _get_owned(db, staff, workflow_id: uuid.UUID) -> AIWorkflow | None:
    return (
        await db.execute(
            select(AIWorkflow).where(
                AIWorkflow.id == workflow_id,
                AIWorkflow.tenant_id == staff.tenant_id,
                AIWorkflow.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
