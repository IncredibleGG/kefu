"""開放 API(/api/ext/v1)的 API key 認證。

與坐席工作台的 JWT(deps.get_current_principal)並行、互不影響:
- JWT 走 `Authorization: Bearer <jwt>`,解析出 staff/tenant/roles。
- API key 走 `Authorization: Bearer <api_key>` 或 `X-Api-Key: <api_key>`,以雜湊比對
  定位租戶,注入 tenant_id(無 staff 概念)。

金鑰模型:
- 明文格式 ``kefu_<token_urlsafe>``;建立時回傳一次,之後只存 SHA-256 雜湊。
- 認證時對呈遞的金鑰算 SHA-256,於 api_key 表以 key_hash 精確比對(indexed),
  命中且 is_active 者取其 tenant_id。比對用 hmac.compare_digest 防時間旁路。
- 命中後順手更新 last_used_at(獨立提交,不干擾端點自身交易)。

本檔為新增檔,未改動 deps.py / security.py 既有內容。
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db

# 明文金鑰前綴;實際金鑰形如 kefu_<random>
_KEY_PREFIX = "kefu_"
# key_prefix 欄位保存的可見長度(前綴 + 隨機頭段,足以辨識、不足以還原)
_PREFIX_STORE_LEN = 12


# --------------------------------------------------------------------------- #
# 金鑰產生 / 雜湊(供 apikeys.py 建立、ext 認證共用)
# --------------------------------------------------------------------------- #
def hash_api_key(raw: str) -> str:
    """對明文金鑰算 SHA-256 hexdigest(存庫與比對皆用此)。"""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def generate_api_key() -> tuple[str, str, str]:
    """產生一把新金鑰,回傳 ``(明文, key_prefix, key_hash)``。

    明文僅回傳這一次;呼叫端只可落庫 key_prefix 與 key_hash。
    """
    raw = f"{_KEY_PREFIX}{secrets.token_urlsafe(32)}"
    return raw, raw[:_PREFIX_STORE_LEN], hash_api_key(raw)


def verify_api_key(raw: str, key_hash: str) -> bool:
    """以定速比對驗證明文金鑰是否對應某雜湊。"""
    return hmac.compare_digest(hash_api_key(raw), key_hash)


def mask_key(key_prefix: str) -> str:
    """列表顯示用遮罩:僅露前綴,其餘以 … 表示。"""
    return f"{key_prefix}…"


# --------------------------------------------------------------------------- #
# 認證脈絡 + 依賴
# --------------------------------------------------------------------------- #
@dataclass
class ApiKeyContext:
    """通過 API key 認證後的呼叫脈絡;所有查詢一律以 tenant_id 隔離。"""

    tenant_id: uuid.UUID
    api_key_id: uuid.UUID


def _extract_key(authorization: str | None, x_api_key: str | None) -> str | None:
    """從 ``Authorization: Bearer <key>`` 或 ``X-Api-Key`` 取出呈遞的金鑰。"""
    if x_api_key:
        return x_api_key.strip()
    if authorization and authorization.lower().startswith("bearer "):
        return authorization.split(" ", 1)[1].strip()
    return None


async def get_api_key_context(
    db: Annotated[AsyncSession, Depends(get_db)],
    authorization: Annotated[str | None, Header()] = None,
    x_api_key: Annotated[str | None, Header(alias="X-Api-Key")] = None,
) -> ApiKeyContext:
    """FastAPI 依賴:驗證 API key、定位租戶並注入 tenant_id。

    失敗一律 401(不洩漏是金鑰不存在還是被撤銷)。
    """
    raw = _extract_key(authorization, x_api_key)
    if not raw:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing api key")

    # 延遲 import:避免 core 於載入期依賴 models(與既有 core 檔的分層一致)
    from app.models.webhook import ApiKey

    key_hash = hash_api_key(raw)
    row = (
        await db.execute(
            select(ApiKey).where(
                ApiKey.key_hash == key_hash,
                ApiKey.is_active.is_(True),
                ApiKey.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid api key")

    # 更新最後使用時間(獨立提交,失敗不影響認證結果)
    try:
        row.last_used_at = datetime.now(UTC)
        await db.commit()
    except Exception:  # noqa: BLE001 - last_used_at 僅為稽核,失敗降級
        await db.rollback()

    return ApiKeyContext(tenant_id=row.tenant_id, api_key_id=row.id)


# 供 ext 路由使用的型別別名(對照 deps.CurrentStaff)
CurrentApiKey = Annotated[ApiKeyContext, Depends(get_api_key_context)]
