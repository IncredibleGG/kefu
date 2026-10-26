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


# access token 夾帶的坐席權杖版本 claim(對應 Staff.token_version)。
TOKEN_VERSION_CLAIM = "tv"


def token_version_matches(payload: dict[str, Any], current: int | None) -> bool:
    """token 的 tv claim 是否等於坐席目前的 token_version(不符即視為已撤銷)。

    - 缺 claim(本機制上線前簽發的舊 token)視為版本 0:部署後照常可用到過期,
      但該坐席一旦改密 / 重設 / 2FA 變更(版本 ≥ 1)即一併失效。
    - claim 非整數(含 bool)一律拒絕,不嘗試轉型。
    """
    claimed = payload.get(TOKEN_VERSION_CLAIM, 0)
    if type(claimed) is not int:
        return False
    return claimed == (current or 0)


def create_access_token(claims: dict[str, Any]) -> str:
    """claims must include: sub (staff_id), tenant_id, roles (list[str]), tv (token_version).

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
