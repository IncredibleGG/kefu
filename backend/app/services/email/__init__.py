"""M5 channel — Email 子套件(自架 IMAP 收 + SMTP 發,乾淨室,僅用標準庫)。

對外匯出:
- EmailError:IMAP / SMTP / 解析失敗時的統一例外。
- parse_email / ParsedEmail:原始郵件 → 渠道無關的解析結果。
- fetch_unseen / mark_seen / check_imap / RawEmail:IMAP 收信。
- send_email / check_smtp:SMTP 發信。
- poll_email:收信輪詢器(供排程器定時呼叫)。
- test_connection:一次測 IMAP + SMTP 連線(供設定端點)。
"""
from __future__ import annotations

from typing import Any

from app.services.email.errors import EmailError
from app.services.email.imap_client import (
    RawEmail,
    check_imap,
    fetch_unseen,
    mark_seen,
)
from app.services.email.parser import ParsedEmail, parse_email
from app.services.email.poller import poll_email
from app.services.email.smtp_client import check_smtp, send_email

__all__ = [
    "EmailError",
    "ParsedEmail",
    "RawEmail",
    "check_imap",
    "check_smtp",
    "fetch_unseen",
    "mark_seen",
    "parse_email",
    "poll_email",
    "send_email",
    "test_connection",
]


async def test_connection(config: dict[str, Any] | None) -> dict[str, Any]:
    """測試 email 渠道 config 的 IMAP + SMTP 連線,回傳各自結果。

    回傳:``{"imap": {"ok": bool, "error"?: str}, "smtp": {...}}``。
    兩者互不影響:一邊失敗仍會回報另一邊的結果。
    """
    config = config or {}
    imap_cfg = config.get("imap") or {}
    smtp_cfg = config.get("smtp") or {}

    result: dict[str, Any] = {}
    try:
        await check_imap(imap_cfg)
        result["imap"] = {"ok": True}
    except Exception as exc:  # EmailError 及任何底層例外都轉為結構化結果
        result["imap"] = {"ok": False, "error": str(exc)}
    try:
        await check_smtp(smtp_cfg)
        result["smtp"] = {"ok": True}
    except Exception as exc:
        result["smtp"] = {"ok": False, "error": str(exc)}
    return result
