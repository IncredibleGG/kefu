"""Password hashing and JWT encode/decode."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
from jose import JWTError, jwt

from app.core.config import settings

# bcrypt caps input at 72 bytes; truncate defensively (passlib is avoided because
# it crashes with modern bcrypt releases).


def _prep(raw: str) -> bytes:
    return raw.encode("utf-8")[:72]


def hash_password(raw: str) -> str:
    return bcrypt.hashpw(_prep(raw), bcrypt.gensalt()).decode("utf-8")


def verify_password(raw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(_prep(raw), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def create_access_token(claims: dict[str, Any]) -> str:
    """claims must include: sub (staff_id), tenant_id, roles (list[str]).

    正式 access token 標記 token_type=access,且不得帶 purpose(用途型權杖如
    2FA challenge / 密碼重設 token 才帶 purpose,見 api/v1/auth.py)。
    """
    to_encode = claims.copy()
    to_encode.setdefault("token_type", "access")
    to_encode["exp"] = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes)
    return jwt.encode(to_encode, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict[str, Any] | None:
    """解出並驗證 access token。**帶 purpose claim 的用途型權杖一律拒絕**——
    否則 2FA challenge / 密碼重設 token 可被當成正式 session token 使用(繞過 2FA)。
    """
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return None
    # 用途型權杖(purpose=2fa / pwreset 等)不得作為 access token
    if payload.get("purpose") is not None:
        return None
    return payload
