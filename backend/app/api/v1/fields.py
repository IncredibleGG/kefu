"""W5 自訂欄位定義 API:FieldDefinition CRUD(工單 / 聯絡人自訂欄位 schema)。

路由前綴由整合者掛在 /api/v1/fields。所有查詢一律以 principal.tenant_id 隔離;
成功回應統一走 response.ok 信封,錯誤沿用專案慣例以 HTTPException 拋出
(detail 帶 FIELD_ 前綴錯誤碼),與姊妹模組 ticket.py 風格一致。

權限:
- 讀取(list / get):任一登入坐席皆可(工單建立 / 詳情需讀定義來動態渲染欄位)。
- 寫入(create / update / delete):require("field.manage")(admin 角色亦通過)。

唯一性:同 tenant + entity 內 key 唯一,於服務層(_ensure_key_unique)檢查,
未加 DB 唯一約束(乾淨室,不動 migration / 既有表結構)。
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import ok
from app.models.productivity import FIELD_ENTITIES, FIELD_TYPES, FieldDefinition

router = APIRouter()

# 寫入權限碼(與 role.manage / staff.manage 等單數慣例一致;admin 角色亦通過)
_MANAGE_PERM = "field.manage"
# key 命名規則:英文開頭,僅允許英數與底線(供程式 / attributes JSON key 使用)
_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")


# ---------- Pydantic 輸入/輸出 ----------
class FieldCreate(BaseModel):
    entity: str = "ticket"
    key: str = Field(min_length=1, max_length=80)
    label: str = Field(min_length=1, max_length=160)
    field_type: str = "text"
    options: list[str] | None = None
    required: bool = False
    sort_order: int = 0


class FieldUpdate(BaseModel):
    # key / entity 不可改(改了會孤立既有 attributes 值);僅開放外觀與約束調整
    label: str | None = Field(default=None, min_length=1, max_length=160)
    field_type: str | None = None
    options: list[str] | None = None
    required: bool | None = None
    sort_order: int | None = None


def _serialize(f: FieldDefinition) -> dict:
    return {
        "id": str(f.id),
        "entity": f.entity,
        "key": f.key,
        "label": f.label,
        "field_type": f.field_type,
        "options": f.options or [],
        "required": f.required,
        "sort_order": f.sort_order,
        "created_at": f.created_at.isoformat() if f.created_at else None,
        "updated_at": f.updated_at.isoformat() if f.updated_at else None,
    }


def _validate_type_and_entity(entity: str | None, field_type: str | None) -> None:
    if entity is not None and entity not in FIELD_ENTITIES:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="FIELD_INVALID_ENTITY"
        )
    if field_type is not None and field_type not in FIELD_TYPES:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="FIELD_INVALID_TYPE"
        )


def _clean_options(field_type: str, options: list[str] | None) -> list[str] | None:
    """select 型才保留選項;去除空白與空項。其餘型別一律存 None。"""
    if field_type != "select":
        return None
    if not options:
        return []
    return [o.strip() for o in options if isinstance(o, str) and o.strip()]


async def _ensure_key_unique(
    db, tenant_id: uuid.UUID, entity: str, key: str, exclude_id: uuid.UUID | None = None
) -> None:
    """服務層唯一性檢查:同 tenant + entity 內 key 唯一(未軟刪者)。"""
    conds = [
        FieldDefinition.tenant_id == tenant_id,
        FieldDefinition.entity == entity,
        FieldDefinition.key == key,
        FieldDefinition.deleted_at.is_(None),
    ]
    if exclude_id is not None:
        conds.append(FieldDefinition.id != exclude_id)
    dup = (
        await db.execute(select(func.count()).select_from(FieldDefinition).where(*conds))
    ).scalar_one()
    if dup:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="FIELD_KEY_EXISTS")


async def _get_owned(db, tenant_id: uuid.UUID, field_id: uuid.UUID) -> FieldDefinition:
    f = (
        await db.execute(
            select(FieldDefinition).where(
                FieldDefinition.id == field_id,
                FieldDefinition.tenant_id == tenant_id,
                FieldDefinition.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="FIELD_NOT_FOUND")
    return f


# ---------- 建立 ----------
@router.post("")
async def create_field(body: FieldCreate, staff: CurrentStaff, db: DbSession):
    staff.require(_MANAGE_PERM)
    _validate_type_and_entity(body.entity, body.field_type)
    if not _KEY_RE.match(body.key):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="FIELD_INVALID_KEY")
    await _ensure_key_unique(db, staff.tenant_id, body.entity, body.key)

    f = FieldDefinition(
        tenant_id=staff.tenant_id,
        entity=body.entity,
        key=body.key,
        label=body.label,
        field_type=body.field_type,
        options=_clean_options(body.field_type, body.options),
        required=body.required,
        sort_order=body.sort_order,
    )
    db.add(f)
    await db.commit()
    await db.refresh(f)
    return ok(_serialize(f))


# ---------- 列表(依 entity 過濾,sort_order 升冪)----------
@router.get("")
async def list_fields(
    staff: CurrentStaff,
    db: DbSession,
    entity: str | None = Query(default=None, description="ticket | contact;不帶則全回"),
):
    conds = [
        FieldDefinition.tenant_id == staff.tenant_id,
        FieldDefinition.deleted_at.is_(None),
    ]
    if entity is not None:
        if entity not in FIELD_ENTITIES:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, detail="FIELD_INVALID_ENTITY"
            )
        conds.append(FieldDefinition.entity == entity)

    rows = (
        await db.execute(
            select(FieldDefinition)
            .where(*conds)
            .order_by(FieldDefinition.sort_order.asc(), FieldDefinition.created_at.asc())
        )
    ).scalars().all()
    return ok({"items": [_serialize(f) for f in rows], "total": len(rows)})


# ---------- 單筆讀取 ----------
@router.get("/{field_id}")
async def get_field(field_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    f = await _get_owned(db, staff.tenant_id, field_id)
    return ok(_serialize(f))


# ---------- 更新(不可改 entity / key)----------
@router.patch("/{field_id}")
async def update_field(
    field_id: uuid.UUID, body: FieldUpdate, staff: CurrentStaff, db: DbSession
):
    staff.require(_MANAGE_PERM)
    f = await _get_owned(db, staff.tenant_id, field_id)
    _validate_type_and_entity(None, body.field_type)

    if body.label is not None:
        f.label = body.label
    if body.field_type is not None:
        f.field_type = body.field_type
    if body.required is not None:
        f.required = body.required
    if body.sort_order is not None:
        f.sort_order = body.sort_order
    # options 與最終型別綁定:型別非 select 一律清為 None;傳入 options 則據以更新
    if body.field_type is not None or body.options is not None:
        f.options = _clean_options(f.field_type, body.options if body.options is not None else f.options)

    await db.commit()
    await db.refresh(f)
    return ok(_serialize(f))


# ---------- 軟刪 ----------
@router.delete("/{field_id}")
async def delete_field(field_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    staff.require(_MANAGE_PERM)
    f = await _get_owned(db, staff.tenant_id, field_id)
    f.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    return ok({"id": str(field_id), "deleted": True})
