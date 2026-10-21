"""SMTP 發信(乾淨室,僅用標準庫 smtplib / email)。

阻塞式 smtplib 一律以 ``asyncio.to_thread`` 包成 async。
連線策略(依 cfg.smtp):
- port 465 → 隱式 SSL(SMTP_SSL)。
- 其餘且 tls=True → 明文連線後 STARTTLS 升級。
- tls=False → 明文(僅供內網/測試)。

cfg 為渠道 config 的 ``smtp`` 子區:host / port / tls / user / pass / from。
"""
from __future__ import annotations

import asyncio
import logging
import smtplib
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from typing import Any

from app.core import crypto
from app.services.email.errors import EmailError

logger = logging.getLogger("kefu.email.smtp")

_DEFAULT_TIMEOUT = 30.0


def _build_message(
    cfg: dict[str, Any],
    to_addr: str,
    subject: str,
    body: str,
    from_addr: str | None,
) -> EmailMessage:
    sender = from_addr or cfg.get("from") or cfg.get("user")
    if not sender:
        raise EmailError("SMTP 寄件人(from / user)未設定")
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = to_addr
    msg["Subject"] = subject or ""
    msg["Date"] = formatdate(localtime=True)
    try:
        domain = sender.split("@", 1)[1] if "@" in sender else None
        msg["Message-ID"] = make_msgid(domain=domain)
    except Exception:
        msg["Message-ID"] = make_msgid()
    msg.set_content(body or "")
    return msg


def _connect(cfg: dict[str, Any]) -> smtplib.SMTP:
    host = cfg.get("host")
    if not host:
        raise EmailError("SMTP host 未設定")
    port = int(cfg.get("port") or 587)
    use_tls = bool(cfg.get("tls", True))
    try:
        if port == 465:
            server: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=_DEFAULT_TIMEOUT)
            server.ehlo()
        else:
            server = smtplib.SMTP(host, port, timeout=_DEFAULT_TIMEOUT)
            server.ehlo()
            if use_tls:
                server.starttls()
                server.ehlo()
    except (OSError, smtplib.SMTPException) as exc:
        raise EmailError(f"SMTP 連線失敗:{exc}") from exc

    user = cfg.get("user")
    if user:
        try:
            # pass 於 DB 靜態加密,登入前解密後才交給 SMTP 伺服器(舊明文相容)。
            server.login(user, crypto.decrypt(cfg.get("pass")) or "")
        except smtplib.SMTPException as exc:
            _safe_quit(server)
            raise EmailError(f"SMTP 登入失敗:{exc}") from exc
    return server


def _safe_quit(server: smtplib.SMTP) -> None:
    try:
        server.quit()
    except Exception:
        pass


def _send_sync(
    cfg: dict[str, Any],
    to_addr: str,
    subject: str,
    body: str,
    from_addr: str | None,
) -> None:
    if not to_addr:
        raise EmailError("SMTP 收件者未設定")
    msg = _build_message(cfg, to_addr, subject, body, from_addr)
    server = _connect(cfg)
    try:
        server.send_message(msg)
    except smtplib.SMTPException as exc:
        raise EmailError(f"SMTP 寄送失敗:{exc}") from exc
    finally:
        _safe_quit(server)


def _check_sync(cfg: dict[str, Any]) -> None:
    server = _connect(cfg)
    try:
        server.noop()
    finally:
        _safe_quit(server)


# --------------------------------------------------------------------------- #
# async 包裝
# --------------------------------------------------------------------------- #
async def send_email(
    cfg: dict[str, Any],
    to_addr: str,
    subject: str,
    body: str,
    *,
    from_addr: str | None = None,
) -> None:
    """寄出一封純文字信;失敗拋 EmailError(由呼叫端決定是否降級)。"""
    await asyncio.to_thread(_send_sync, cfg, to_addr, subject, body, from_addr)


async def check_smtp(cfg: dict[str, Any]) -> None:
    """連線測試:連線 + (STARTTLS) + 登入 + NOOP;失敗拋 EmailError。"""
    await asyncio.to_thread(_check_sync, cfg)
