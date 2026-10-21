"""坐席巨集(Macro)CRUD:一組可一鍵套用的複合動作(回覆 / 改狀態 / 加標籤 / 指派 / 加備註)。

註冊建議:app.include_router(macros.router, prefix="/api/v1/macros", tags=["macros"])

規則:
- 巨集為「租戶共享」資源(model 無 owner 欄位),查詢一律以 principal.tenant_id 過濾。
- 需登入坐席(CurrentStaff);不另設專屬權限碼,同租戶坐席皆可管理。
- 回應統一走 ok()/err();軟刪以 deleted_at 標記。
- actions 結構由 services.macros.validate_macro_actions 把關(對齊 MACRO_ACTION_TYPES)。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.models.productivity import Macro
from app.services.macros import MacroValidationError, validate_macro_actions

router = APIRouter()


# --------------------------------------------------------------------------- #
# Pydantic schema
# --------------------------------------------------------------------------- #
class MacroCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=300)
    # 動作序列(見 services.macros);允許為空,可先建骨架再補
    actions: list = Field(default_factory=list)
    is_active: bool = True


class MacroUpdateIn(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=300)
    actions: list | None = None
    is_active: bool | None = None


# --------------------------------------------------------------------------- #
# 序列化 / 內部工具(全部租戶過濾)
# --------------------------------------------------------------------------- #
def _macro_dict(m: Macro) -> dict:
    return {
        "id": str(m.id),
        "name": m.name,
        "description": m.description,
        "actions": m.actions or [],
        "is_active": m.is_active,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


async def _get_macro(db, tenant_id, macro_id) -> Macro | None:
    return (
        await db.execute(
            select(Macro).where(
                Macro.id == macro_id,
                Macro.tenant_id == tenant_id,
                Macro.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


# =========================================================================== #
# CRUD
# =========================================================================== #
@router.get("")
async def list_macros(
    principal: CurrentStaff,
    db: DbSession,
    is_active: bool | None = Query(None, description="僅列啟用 / 停用者"),
    q: str | None = Query(None, description="以名稱模糊搜尋"),
):
    stmt = select(Macro).where(
        Macro.tenant_id == principal.tenant_id, Macro.deleted_at.is_(None)
    )
    if is_active is not None:
        stmt = stmt.where(Macro.is_active.is_(is_active))
    if q:
        stmt = stmt.where(Macro.name.ilike(f"%{q}%"))
    rows = (await db.execute(stmt.order_by(Macro.created_at.desc()))).scalars().all()
    return ok({"items": [_macro_dict(m) for m in rows], "total": len(rows)})


@router.post("")
async def create_macro(body: MacroCreateIn, principal: CurrentStaff, db: DbSession):
    try:
        actions = validate_macro_actions(body.actions)
    except MacroValidationError as e:
        return err("MACRO_INVALID_ACTIONS", str(e))

    dup = (
        await db.execute(
            select(Macro).where(
                Macro.tenant_id == principal.tenant_id,
                Macro.name == body.name,
                Macro.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if dup:
        return err("MACRO_NAME_TAKEN", f"巨集名已存在: {body.name}")

    macro = Macro(
        tenant_id=principal.tenant_id,
        name=body.name,
        description=body.description,
        actions=actions,
        is_active=body.is_active,
    )
    db.add(macro)
    await db.commit()
    await db.refresh(macro)
    return ok(_macro_dict(macro))


@router.get("/{macro_id}")
async def get_macro(macro_id: uuid.UUID, principal: CurrentStaff, db: DbSession):
    macro = await _get_macro(db, principal.tenant_id, macro_id)
    if not macro:
        return err("MACRO_NOT_FOUND", "巨集不存在")
    return ok(_macro_dict(macro))


@router.patch("/{macro_id}")
async def update_macro(
    macro_id: uuid.UUID, body: MacroUpdateIn, principal: CurrentStaff, db: DbSession
):
    macro = await _get_macro(db, principal.tenant_id, macro_id)
    if not macro:
        return err("MACRO_NOT_FOUND", "巨集不存在")

    data = body.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        macro.name = data["name"]
    if "description" in data:
        macro.description = data["description"]
    if "is_active" in data and data["is_active"] is not None:
        macro.is_active = data["is_active"]
    if "actions" in data and data["actions"] is not None:
        try:
            macro.actions = validate_macro_actions(data["actions"])
        except MacroValidationError as e:
            return err("MACRO_INVALID_ACTIONS", str(e))

    await db.commit()
    await db.refresh(macro)
    return ok(_macro_dict(macro))


@router.delete("/{macro_id}")
async def delete_macro(macro_id: uuid.UUID, principal: CurrentStaff, db: DbSession):
    """軟刪巨集。"""
    macro = await _get_macro(db, principal.tenant_id, macro_id)
    if not macro:
        return err("MACRO_NOT_FOUND", "巨集不存在")
    macro.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    return ok({"id": str(macro_id), "deleted": True})
