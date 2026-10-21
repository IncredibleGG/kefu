"""開放 API 金鑰管理:建立(回明文一次)、列出(遮罩)、撤銷。

掛載前綴(整合方於 main.py 註冊):/api/v1/apikeys
權限:一律需 ``apikey.manage``(admin 亦可)。

金鑰只存 SHA-256 雜湊,明文僅在建立當下回傳一次(之後無法還原)。所有查詢一律以
CurrentStaff.tenant_id 隔離;絕不信任用戶端傳入的 tenant_id。
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.apikey_auth import generate_api_key, mask_key
from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.models.webhook import ApiKey

router = APIRouter()

_PERM = "apikey.manage"


# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #
class ApiKeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


def _serialize(k: ApiKey) -> dict:
    """列表 / 讀取用(遮罩,不含明文與雜湊)。"""
    return {
        "id": str(k.id),
        "name": k.name,
        "key_prefix": k.key_prefix,
        "key_masked": mask_key(k.key_prefix),
        "is_active": k.is_active,
        "last_used_at": k.last_used_at.isoformat() if k.last_used_at else None,
        "created_at": k.created_at.isoformat() if k.created_at else None,
    }


async def _get_owned(db, staff, key_id: uuid.UUID) -> ApiKey | None:
    return (
        await db.execute(
            select(ApiKey).where(
                ApiKey.id == key_id,
                ApiKey.tenant_id == staff.tenant_id,
                ApiKey.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


# --------------------------------------------------------------------------- #
# 端點
# --------------------------------------------------------------------------- #
@router.post("")
async def create_api_key(body: ApiKeyCreate, staff: CurrentStaff, db: DbSession):
    """建立 API 金鑰(需 apikey.manage)。回應含一次性明文 ``key``。"""
    staff.require(_PERM)
    raw, prefix, key_hash = generate_api_key()
    k = ApiKey(
        tenant_id=staff.tenant_id,
        name=body.name,
        key_prefix=prefix,
        key_hash=key_hash,
        is_active=True,
    )
    db.add(k)
    await db.commit()
    await db.refresh(k)
    data = _serialize(k)
    # 明文金鑰僅此一次回傳,提醒前端妥善保存
    data["key"] = raw
    return ok(data)


@router.get("")
async def list_api_keys(
    staff: CurrentStaff,
    db: DbSession,
    is_active: bool | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    """列出本租戶的 API 金鑰(遮罩;不含明文與雜湊)。"""
    staff.require(_PERM)
    conds = [ApiKey.tenant_id == staff.tenant_id, ApiKey.deleted_at.is_(None)]
    if is_active is not None:
        conds.append(ApiKey.is_active.is_(is_active))
    total = (
        await db.execute(select(func.count()).select_from(ApiKey).where(*conds))
    ).scalar_one()
    rows = (
        await db.execute(
            select(ApiKey)
            .where(*conds)
            .order_by(ApiKey.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
    ).scalars().all()
    return ok(
        {
            "items": [_serialize(k) for k in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    )


@router.post("/{key_id}/revoke")
async def revoke_api_key(key_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """撤銷金鑰(需 apikey.manage):停用並軟刪,之後認證即失效。"""
    staff.require(_PERM)
    k = await _get_owned(db, staff, key_id)
    if k is None:
        return err("not_found", "api key not found")
    k.is_active = False
    k.deleted_at = datetime.now(UTC)
    await db.commit()
    return ok({"id": str(key_id), "revoked": True})


@router.delete("/{key_id}")
async def delete_api_key(key_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """撤銷金鑰(DELETE 同義於 revoke;需 apikey.manage)。"""
    return await revoke_api_key(key_id, staff, db)
