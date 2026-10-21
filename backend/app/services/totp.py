"""TOTP(RFC 6238)兩步驗證 —— 乾淨室,僅用標準庫(hmac / struct / base64 / os / time)。

不引入任何第三方相依(如 pyotp)。與主流驗證器 App(Google Authenticator、
Authy、1Password 等)相容:HMAC-SHA1、6 碼、30 秒週期、base32 密鑰。

對外 API:
- ``generate_secret()``            產生新的 base32 密鑰(存 Staff.totp_secret)。
- ``totp_now(secret)``             取當前時間窗的 6 碼(供測試 / 顯示)。
- ``verify(secret, code, window)`` 驗證使用者輸入的 code(容忍前後 window 個時間窗)。
- ``otpauth_uri(secret, account)`` 產生 ``otpauth://`` URI,供前端渲染 QR 或手動加入。

安全:code 比對一律走 ``hmac.compare_digest`` 常數時間比較,避免計時側信道。
"""
from __future__ import annotations

import base64
import hmac
import os
import struct
import time
from urllib.parse import quote, urlencode

# 預設參數(與主流驗證器 App 相容,勿隨意更動,否則既有綁定會失效)
DEFAULT_DIGITS = 6
DEFAULT_PERIOD = 30  # 秒
DEFAULT_ALGORITHM = "SHA1"


def generate_secret(length: int = 20) -> str:
    """產生新的 base32 密鑰(去除 ``=`` 補位,大寫)。

    length 為底層隨機位元組數;20 bytes(160 bits)為 RFC 4226 建議值,
    base32 編碼後約 32 字元,存於 ``Staff.totp_secret``(varchar64)綽綽有餘。
    """
    raw = os.urandom(length)
    return base64.b32encode(raw).decode("ascii").rstrip("=")


def _decode_secret(secret: str) -> bytes:
    """把 base32 密鑰解回位元組;容忍小寫、空白與缺少的 ``=`` 補位。"""
    normalized = secret.strip().replace(" ", "").replace("-", "").upper()
    # base32 需長度為 8 的倍數,補回 '='
    pad = (-len(normalized)) % 8
    normalized += "=" * pad
    return base64.b32decode(normalized, casefold=True)


def _hotp(key: bytes, counter: int, digits: int = DEFAULT_DIGITS) -> str:
    """HOTP(RFC 4226):對 8 位元組大端 counter 做 HMAC-SHA1 + 動態截斷。"""
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, "sha1").digest()
    offset = digest[-1] & 0x0F
    binary = (
        ((digest[offset] & 0x7F) << 24)
        | ((digest[offset + 1] & 0xFF) << 16)
        | ((digest[offset + 2] & 0xFF) << 8)
        | (digest[offset + 3] & 0xFF)
    )
    return str(binary % (10**digits)).zfill(digits)


def totp_now(
    secret: str,
    *,
    timestamp: float | None = None,
    period: int = DEFAULT_PERIOD,
    digits: int = DEFAULT_DIGITS,
) -> str:
    """回傳當前(或指定 timestamp)時間窗的 TOTP code。"""
    key = _decode_secret(secret)
    ts = time.time() if timestamp is None else timestamp
    counter = int(ts // period)
    return _hotp(key, counter, digits)


def verify(
    secret: str | None,
    code: str | None,
    window: int = 1,
    *,
    timestamp: float | None = None,
    period: int = DEFAULT_PERIOD,
    digits: int = DEFAULT_DIGITS,
) -> bool:
    """驗證使用者輸入的 code;容忍前後 ``window`` 個時間窗(時鐘漂移)。

    - secret / code 為空、格式不符(非純數字或長度不符)→ 直接 False。
    - 比對走常數時間比較,避免計時側信道。
    """
    if not secret or not code:
        return False
    cleaned = str(code).strip().replace(" ", "")
    if not cleaned.isdigit() or len(cleaned) != digits:
        return False
    try:
        key = _decode_secret(secret)
    except (ValueError, TypeError):
        return False
    ts = time.time() if timestamp is None else timestamp
    counter = int(ts // period)
    for offset in range(-window, window + 1):
        candidate_counter = counter + offset
        if candidate_counter < 0:
            continue
        if hmac.compare_digest(_hotp(key, candidate_counter, digits), cleaned):
            return True
    return False


def otpauth_uri(
    secret: str,
    account_name: str,
    *,
    issuer: str = "kefu",
    digits: int = DEFAULT_DIGITS,
    period: int = DEFAULT_PERIOD,
) -> str:
    """產生 ``otpauth://totp/...`` URI,供驗證器 App 掃碼或前端渲染 QR。

    label 依規範為 ``Issuer:account``,issuer 亦重複放入查詢參數以利相容。
    """
    label = quote(f"{issuer}:{account_name}")
    params = urlencode(
        {
            "secret": secret,
            "issuer": issuer,
            "algorithm": DEFAULT_ALGORITHM,
            "digits": digits,
            "period": period,
        }
    )
    return f"otpauth://totp/{label}?{params}"
