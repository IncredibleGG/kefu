"""第一方整合 / 插件 API:目錄 + 每租戶 on/off 開關與金鑰設定。

掛載前綴(整合者於 main.py 註冊):`/api/v1/integrations`
    app.include_router(integrations.router, prefix="/api/v1/integrations", tags=["integrations"])

端點:
- GET  `/api/v1/integrations/catalog`      目錄 + 本租戶各 key 的 enabled/config(機敏遮罩)。
- PUT  `/api/v1/integrations/{key}`        設 enabled + config(upsert;key 需在目錄內)。
- GET  `/api/v1/integrations/{key}/status` 單一整合的開關 / 是否已設定(輕量)。

權限:
- 寫入(PUT)需 ``settings.manage``(``Principal.require`` 對 admin 一律短路放行)。
- 讀取(catalog / status)需 ``conversation.view`` 或 ``report.view``(admin 短路)。

機敏處理:config_schema 標 ``secret: true`` 的欄位——落庫前以 ``app.core.crypto`` 靜態
加密,API 回傳時遮罩(只露頭尾),前端把遮罩值原樣送回或留空皆視為「不變更」,沿用
既有密文(對齊 channel.py 的既有慣例)。

消費入口:``is_integration_enabled(db, tenant_id, key)`` 供未來各整合埋點查詢開關,
這是「開關系統」對外的唯一消費 API(執行邏輯就緒前先查此開關再決定是否動作)。
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import crypto
from app.core.deps import CurrentStaff, DbSession, Principal
from app.core.response import err, ok
from app.models.integration import (
    CATALOG_BY_KEY,
    INTEGRATION_CATALOG,
    TenantIntegration,
    secret_field_keys,
)

router = APIRouter()

# 遮罩標記:回傳機敏值時只露頭尾,中間以此字元省略;前端送回含此字元者=不變更。
_MASK_MARKER = "…"


# --------------------------------------------------------------------------- #
# Pydantic schema
# --------------------------------------------------------------------------- #
class IntegrationUpdateIn(BaseModel):
    """PUT 內容:開關與 / 或設定;皆選填。

    - ``enabled``:給定則設定開關。
    - ``config``:給定則逐欄合併進既有設定(未列出的既有欄位保留)。機敏欄位留空或
      送回遮罩值視為「不變更」,沿用既有密文。
    """

    enabled: bool | None = None
    config: dict[str, Any] | None = None


# --------------------------------------------------------------------------- #
# 權限
# --------------------------------------------------------------------------- #
def _require_read(staff: Principal) -> None:
    """讀取權限:admin 或 conversation.view 或 report.view 其一即可。"""
    if (
        "admin" in staff.roles
        or "conversation.view" in staff.roles
        or "report.view" in staff.roles
    ):
        return
    raise HTTPException(
        status.HTTP_403_FORBIDDEN,
        detail="missing permission: conversation.view or report.view",
    )


def _require_write(staff: Principal) -> None:
    """寫入權限:settings.manage(``require`` 對 admin 自動放行)。"""
    staff.require("settings.manage")


# --------------------------------------------------------------------------- #
# 機敏欄位:遮罩 / 「留空或遮罩沿用」
# --------------------------------------------------------------------------- #
def _mask_secret(value: str | None) -> str | None:
    """遮罩敏感字串,只露頭尾便於辨識(對齊 channel_out.mask_secret 慣例)。"""
    if not value:
        return value
    if len(value) <= 8:
        return "****"
    return f"{value[:4]}{_MASK_MARKER}{value[-4:]}"


def _mask_config(integration_key: str, config: dict[str, Any] | None) -> dict[str, Any]:
    """回傳遮罩過機敏欄位的 config 複本,供 API 回應。

    機敏欄位值可能為靜態加密(``enc::``)或舊明文,一律先解密再遮罩尾碼,故回應
    永遠不含 ``enc::`` 前綴,也不含完整明文。
    """
    if not config:
        return {}
    secret_keys = secret_field_keys(integration_key)
    masked: dict[str, Any] = {}
    for k, v in config.items():
        if k in secret_keys and v is not None:
            plain = crypto.decrypt(v) if isinstance(v, str) else v
            masked[k] = _mask_secret(str(plain)) if plain is not None else plain
        else:
            masked[k] = v
    return masked


def _resolve_secret(new_val: Any, prev_enc: Any) -> Any:
    """機敏欄位落庫:留空或送回遮罩值(含 ``…``)一律沿用既有密文;否則加密新值。"""
    if new_val is None:
        return prev_enc
    if isinstance(new_val, str):
        if new_val == "" or _MASK_MARKER in new_val:
            return prev_enc
        return crypto.encrypt(new_val)
    return new_val


# --------------------------------------------------------------------------- #
# 序列化
# --------------------------------------------------------------------------- #
def _is_configured(integration_key: str, config: dict[str, Any] | None) -> bool:
    """是否已備妥必填設定(供 UI 顯示「已設定 / 未設定」)。以原始 config(未遮罩)判定。"""
    entry = CATALOG_BY_KEY.get(integration_key)
    if not entry:
        return False
    schema = entry.get("config_schema") or []
    required_keys = [f["key"] for f in schema if f.get("required")]
    if not required_keys:
        return True
    if not config:
        return False
    return all(config.get(k) for k in required_keys)


def _serialize(entry: dict[str, Any], row: TenantIntegration | None) -> dict[str, Any]:
    """合併目錄項與該租戶狀態列;config 機敏遮罩。row 為 None 表示租戶尚未設定(預設停用)。"""
    raw_config = row.config if row else None
    return {
        "key": entry["key"],
        "name": entry["name"],
        "description": entry["description"],
        "category": entry["category"],
        "requires_config": entry.get("requires_config", False),
        "config_schema": entry.get("config_schema") or [],
        "enabled": bool(row.enabled) if row else False,
        "config": _mask_config(entry["key"], raw_config),
        "configured": _is_configured(entry["key"], raw_config),
        "updated_at": row.updated_at.isoformat() if row and row.updated_at else None,
    }


# --------------------------------------------------------------------------- #
# DB 取用
# --------------------------------------------------------------------------- #
async def _get_row(
    db: AsyncSession, tenant_id: uuid.UUID, integration_key: str
) -> TenantIntegration | None:
    return (
        await db.execute(
            select(TenantIntegration).where(
                TenantIntegration.tenant_id == tenant_id,
                TenantIntegration.integration_key == integration_key,
                TenantIntegration.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


# --------------------------------------------------------------------------- #
# 消費入口:供未來各整合埋點查詢「此租戶是否啟用了某整合」
# --------------------------------------------------------------------------- #
async def is_integration_enabled(
    db: AsyncSession, tenant_id: uuid.UUID, key: str
) -> bool:
    """某租戶是否已啟用某整合(開關系統的消費 API)。

    key 不在目錄內、租戶未設定、或該列 enabled=False 皆回 False。未來各整合的執行
    點(如新會話派送、事件上報)只需先 ``await is_integration_enabled(...)`` 再決定是否
    動作,即完成「按租戶 on/off」的接線。
    """
    if key not in CATALOG_BY_KEY:
        return False
    row = await _get_row(db, tenant_id, key)
    return bool(row and row.enabled)


# --------------------------------------------------------------------------- #
# 端點
# --------------------------------------------------------------------------- #
@router.get("/catalog")
async def get_catalog(staff: CurrentStaff, db: DbSession):
    """整合目錄 + 本租戶各 key 的 enabled / config(機敏遮罩)。"""
    _require_read(staff)
    rows = (
        await db.execute(
            select(TenantIntegration).where(
                TenantIntegration.tenant_id == staff.tenant_id,
                TenantIntegration.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    by_key = {r.integration_key: r for r in rows}
    return ok(
        {"integrations": [_serialize(entry, by_key.get(entry["key"])) for entry in INTEGRATION_CATALOG]}
    )


@router.put("/{key}")
async def put_integration(key: str, body: IntegrationUpdateIn, staff: CurrentStaff, db: DbSession):
    """設定某整合的開關與設定(upsert)。key 需在目錄內。"""
    _require_write(staff)
    entry = CATALOG_BY_KEY.get(key)
    if entry is None:
        return JSONResponse(
            status_code=404, content=err("INTEGRATION_NOT_FOUND", f"整合不存在:{key}")
        )

    row = await _get_row(db, staff.tenant_id, key)
    if row is None:
        row = TenantIntegration(tenant_id=staff.tenant_id, integration_key=key)
        db.add(row)

    if body.enabled is not None:
        row.enabled = body.enabled

    if body.config is not None:
        secret_keys = secret_field_keys(key)
        merged: dict[str, Any] = dict(row.config or {})
        for field_key, value in body.config.items():
            if field_key in secret_keys:
                # 機敏欄位:先套「留空/遮罩沿用」,再靜態加密(encrypt 對 None/已加密值冪等)。
                merged[field_key] = _resolve_secret(value, merged.get(field_key))
            else:
                merged[field_key] = value
        row.config = merged

    await db.commit()
    await db.refresh(row)
    return ok(_serialize(entry, row))


@router.get("/{key}/status")
async def get_status(key: str, staff: CurrentStaff, db: DbSession):
    """單一整合的輕量狀態:開關 / 是否需設定 / 是否已備妥必填設定。"""
    _require_read(staff)
    entry = CATALOG_BY_KEY.get(key)
    if entry is None:
        return JSONResponse(
            status_code=404, content=err("INTEGRATION_NOT_FOUND", f"整合不存在:{key}")
        )
    row = await _get_row(db, staff.tenant_id, key)
    return ok(
        {
            "key": key,
            "enabled": bool(row.enabled) if row else False,
            "requires_config": entry.get("requires_config", False),
            "configured": _is_configured(key, row.config if row else None),
        }
    )
