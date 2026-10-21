"""坐席罐頭訊息 / 快捷回覆 API(CRUD + 前綴查詢）。

路由前綴由整合者掛在 /api/v1/canned。所有查詢一律以 principal.tenant_id 隔離;
成功走 response.ok 信封,查無資料回 err("not_found", ...)。

可見性:坐席可見「全租戶共享(owner_staff_id 為空）」與「自己私人」兩類罐頭;
其他坐席的私人罐頭一律不可見。內容含 ``{{變數}}`` 佔位,後端原樣存取,
變數替換由前端負責。
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.models.canned import CannedResponse

router = APIRouter()


# ---------- Pydantic 輸入/輸出 ----------
class CannedCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    shortcut: str = Field(min_length=1, max_length=50)
    content: str = ""
    skill_group_id: uuid.UUID | None = None
    # True → 建立為全租戶共享;False（預設）→ 建立為本坐席私人
    shared: bool = False


class CannedUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    shortcut: str | None = Field(default=None, min_length=1, max_length=50)
    content: str | None = None
    skill_group_id: uuid.UUID | None = None


def _serialize(c: CannedResponse) -> dict:
    return {
        "id": str(c.id),
        "title": c.title,
        "shortcut": c.shortcut,
        "content": c.content,
        "skill_group_id": str(c.skill_group_id) if c.skill_group_id else None,
        "owner_staff_id": str(c.owner_staff_id) if c.owner_staff_id else None,
        "shared": c.owner_staff_id is None,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }


def _visible_cond(staff):
    """可見性條件:全租戶共享 或 本坐席私人。"""
    return or_(
        CannedResponse.owner_staff_id.is_(None),
        CannedResponse.owner_staff_id == staff.staff_id,
    )


async def _get_visible(db, staff, canned_id: uuid.UUID) -> CannedResponse | None:
    return (
        await db.execute(
            select(CannedResponse).where(
                CannedResponse.id == canned_id,
                CannedResponse.tenant_id == staff.tenant_id,
                CannedResponse.deleted_at.is_(None),
                _visible_cond(staff),
            )
        )
    ).scalar_one_or_none()


async def _get_owned_editable(db, staff, canned_id: uuid.UUID) -> CannedResponse | None:
    """取得本坐席可「編輯」的罐頭:自己的私人,或共享罐頭(共享由租戶內任一坐席可維護)。

    其他坐席的私人罐頭不可編輯(視為查無)。
    """
    return await _get_visible(db, staff, canned_id)


# ---------- 建立 ----------
@router.post("")
async def create_canned(body: CannedCreate, staff: CurrentStaff, db: DbSession):
    owner_staff_id = None if body.shared else staff.staff_id
    # 短碼在同擁有者範圍內唯一
    dup = (
        await db.execute(
            select(func.count())
            .select_from(CannedResponse)
            .where(
                CannedResponse.tenant_id == staff.tenant_id,
                CannedResponse.shortcut == body.shortcut,
                CannedResponse.owner_staff_id.is_(None)
                if owner_staff_id is None
                else CannedResponse.owner_staff_id == owner_staff_id,
                CannedResponse.deleted_at.is_(None),
            )
        )
    ).scalar_one()
    if dup:
        return err("conflict", "shortcut already exists in this scope")

    c = CannedResponse(
        tenant_id=staff.tenant_id,
        title=body.title,
        shortcut=body.shortcut,
        content=body.content,
        skill_group_id=body.skill_group_id,
        owner_staff_id=owner_staff_id,
    )
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return ok(_serialize(c))


# ---------- 列表 / 前綴查詢(供前端 `/` 觸發）----------
@router.get("")
async def list_canned(
    staff: CurrentStaff,
    db: DbSession,
    shortcut_prefix: str | None = Query(default=None, description="短碼前綴,供 `/` 觸發即時查詢"),
    q: str | None = Query(default=None, description="標題 / 內容模糊搜尋"),
    skill_group_id: uuid.UUID | None = None,
    scope: str = Query(default="all", pattern="^(all|shared|mine)$"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """罐頭清單。預設回傳本坐席可見(共享 + 個人）者。

    - shortcut_prefix:短碼前綴查詢(前端輸入 `/ab` → prefix=ab),依短碼排序。
    - scope:all(預設)/ shared(僅共享)/ mine(僅個人)。
    """
    conds = [
        CannedResponse.tenant_id == staff.tenant_id,
        CannedResponse.deleted_at.is_(None),
    ]
    if scope == "shared":
        conds.append(CannedResponse.owner_staff_id.is_(None))
    elif scope == "mine":
        conds.append(CannedResponse.owner_staff_id == staff.staff_id)
    else:
        conds.append(_visible_cond(staff))

    if shortcut_prefix:
        conds.append(CannedResponse.shortcut.ilike(f"{shortcut_prefix}%"))
    if q:
        like = f"%{q}%"
        conds.append(CannedResponse.title.ilike(like) | CannedResponse.content.ilike(like))
    if skill_group_id is not None:
        conds.append(CannedResponse.skill_group_id == skill_group_id)

    total = (
        await db.execute(select(func.count()).select_from(CannedResponse).where(*conds))
    ).scalar_one()
    rows = (
        await db.execute(
            select(CannedResponse)
            .where(*conds)
            .order_by(CannedResponse.shortcut.asc(), CannedResponse.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
    ).scalars().all()
    return ok(
        {
            "items": [_serialize(c) for c in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    )


# ---------- 單筆讀取 ----------
@router.get("/{canned_id}")
async def get_canned(canned_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    c = await _get_visible(db, staff, canned_id)
    if c is None:
        return err("not_found", "canned response not found")
    return ok(_serialize(c))


# ---------- 更新 ----------
@router.patch("/{canned_id}")
async def update_canned(
    canned_id: uuid.UUID, body: CannedUpdate, staff: CurrentStaff, db: DbSession
):
    c = await _get_owned_editable(db, staff, canned_id)
    if c is None:
        return err("not_found", "canned response not found")

    # 若改短碼,檢查同擁有者範圍內唯一
    if body.shortcut is not None and body.shortcut != c.shortcut:
        dup = (
            await db.execute(
                select(func.count())
                .select_from(CannedResponse)
                .where(
                    CannedResponse.tenant_id == staff.tenant_id,
                    CannedResponse.shortcut == body.shortcut,
                    CannedResponse.owner_staff_id.is_(None)
                    if c.owner_staff_id is None
                    else CannedResponse.owner_staff_id == c.owner_staff_id,
                    CannedResponse.id != c.id,
                    CannedResponse.deleted_at.is_(None),
                )
            )
        ).scalar_one()
        if dup:
            return err("conflict", "shortcut already exists in this scope")

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(c, field, value)
    await db.commit()
    await db.refresh(c)
    return ok(_serialize(c))


# ---------- 軟刪 ----------
@router.delete("/{canned_id}")
async def delete_canned(canned_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    c = await _get_owned_editable(db, staff, canned_id)
    if c is None:
        return err("not_found", "canned response not found")
    c.deleted_at = datetime.now(UTC)
    await db.commit()
    return ok({"id": str(canned_id), "deleted": True})
