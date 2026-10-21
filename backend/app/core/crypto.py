"""資料庫機敏欄位的靜態加密(at-rest)工具。

用途:bot_token、webhook_secret、SMTP/IMAP 密碼、page/access token、BYO LLM key 等
存進 DB(Channel.config / Tenant.llm_config 等 JSONB)前先加密,取用時解密。

- 演算法:Fernet(對稱、含 HMAC 驗證),金鑰由 settings.secret_key 衍生;
  未設 secret_key 時退回由 jwt_secret 衍生(舊部署仍可運作)。
- 相容舊資料:未加密(無 ``enc::`` 前綴)的既有明文值,decrypt() 原樣回傳,
  故導入加密後既有渠道不會壞;下次寫入時才會轉為密文。
"""
from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings

_PREFIX = "enc::"


def _fernet() -> Fernet:
    raw = (settings.secret_key or settings.jwt_secret or "kefu-dev-secret").encode("utf-8")
    key = base64.urlsafe_b64encode(hashlib.sha256(raw).digest())
    return Fernet(key)


def encrypt(value: str | None) -> str | None:
    """加密字串;None/空字串原樣回傳。回傳帶 ``enc::`` 前綴的密文。"""
    if not value:
        return value
    if isinstance(value, str) and value.startswith(_PREFIX):
        return value  # 已是密文,不重複加密
    token = _fernet().encrypt(value.encode("utf-8")).decode("ascii")
    return _PREFIX + token


def decrypt(value: str | None) -> str | None:
    """解密;非密文(舊明文或空)原樣回傳,確保相容既有未加密資料。"""
    if not isinstance(value, str) or not value.startswith(_PREFIX):
        return value
    try:
        return _fernet().decrypt(value[len(_PREFIX):].encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return value  # 金鑰不符/損壞 → 保守回原值,不讓解密失敗拖垮流程


def is_encrypted(value: object) -> bool:
    return isinstance(value, str) and value.startswith(_PREFIX)
