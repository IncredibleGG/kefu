"""IMAP 收信(乾淨室,僅用標準庫 imaplib)。

阻塞式 imaplib 一律以 ``asyncio.to_thread`` 包成 async,供 async 呼叫端使用。
設計要點:
- 以 UID 命令收信,序號在資料夾變動時仍穩定。
- 用 ``BODY.PEEK[]`` 抓信「不」自動設 \\Seen;是否標記已讀由呼叫端在成功入站後
  另行呼叫 ``mark_seen`` 決定 —— 這樣暫時降級(seam 未就緒)時信不會被吃掉,下輪可重試。

cfg 為渠道 config 的 ``imap`` 子區:host / port / ssl / user / pass / folder。
"""
from __future__ import annotations

import asyncio
import imaplib
import logging
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from app.core import crypto
from app.services.email.errors import EmailError

logger = logging.getLogger("kefu.email.imap")

_DEFAULT_TIMEOUT = 30.0


@dataclass
class RawEmail:
    """一封未讀信的原始位元組與其 UID(標記已讀時用)。"""

    uid: str
    raw: bytes


def _connect(cfg: dict[str, Any]) -> imaplib.IMAP4:
    """依 cfg 建立並登入 IMAP 連線;任何失敗都轉成 EmailError。"""
    host = cfg.get("host")
    if not host:
        raise EmailError("IMAP host 未設定")
    use_ssl = bool(cfg.get("ssl", True))
    port = int(cfg.get("port") or (993 if use_ssl else 143))
    try:
        if use_ssl:
            conn: imaplib.IMAP4 = imaplib.IMAP4_SSL(host, port, timeout=_DEFAULT_TIMEOUT)
        else:
            conn = imaplib.IMAP4(host, port, timeout=_DEFAULT_TIMEOUT)
    except (OSError, imaplib.IMAP4.error) as exc:
        raise EmailError(f"IMAP 連線失敗:{exc}") from exc

    user = cfg.get("user")
    if user:
        try:
            # pass 於 DB 靜態加密,登入前解密後才交給 IMAP 伺服器(舊明文相容)。
            conn.login(user, crypto.decrypt(cfg.get("pass")) or "")
        except imaplib.IMAP4.error as exc:
            _safe_logout(conn)
            raise EmailError(f"IMAP 登入失敗:{exc}") from exc
    return conn


def _safe_logout(conn: imaplib.IMAP4) -> None:
    try:
        conn.logout()
    except Exception:  # 關閉失敗無關緊要
        pass


def _select_folder(conn: imaplib.IMAP4, cfg: dict[str, Any]) -> None:
    folder = cfg.get("folder") or "INBOX"
    typ, _ = conn.select(folder)
    if typ != "OK":
        raise EmailError(f"IMAP 無法選取資料夾:{folder}")


def _fetch_unseen_sync(cfg: dict[str, Any], limit: int) -> list[RawEmail]:
    conn = _connect(cfg)
    out: list[RawEmail] = []
    try:
        _select_folder(conn, cfg)
        typ, data = conn.uid("search", None, "UNSEEN")
        if typ != "OK":
            raise EmailError("IMAP 搜尋未讀信失敗")
        uids = data[0].split() if data and data[0] else []
        if limit:
            uids = uids[:limit]
        for uid in uids:
            typ, msg_data = conn.uid("fetch", uid, "(BODY.PEEK[])")
            if typ != "OK" or not msg_data:
                continue
            raw = next(
                (p[1] for p in msg_data if isinstance(p, tuple) and len(p) >= 2 and p[1]),
                None,
            )
            if raw is None:
                continue
            uid_str = uid.decode() if isinstance(uid, bytes) else str(uid)
            out.append(RawEmail(uid=uid_str, raw=raw))
    finally:
        _safe_logout(conn)
    return out


def _mark_seen_sync(cfg: dict[str, Any], uids: Sequence[str]) -> None:
    if not uids:
        return
    conn = _connect(cfg)
    try:
        _select_folder(conn, cfg)
        for uid in uids:
            conn.uid("store", uid, "+FLAGS", r"(\Seen)")
    finally:
        _safe_logout(conn)


def _check_sync(cfg: dict[str, Any]) -> None:
    conn = _connect(cfg)
    try:
        _select_folder(conn, cfg)
    finally:
        _safe_logout(conn)


# --------------------------------------------------------------------------- #
# async 包裝(阻塞式 imaplib 丟到執行緒池)
# --------------------------------------------------------------------------- #
async def fetch_unseen(cfg: dict[str, Any], limit: int = 50) -> list[RawEmail]:
    """抓未讀新信(不標記已讀)。"""
    return await asyncio.to_thread(_fetch_unseen_sync, cfg, limit)


async def mark_seen(cfg: dict[str, Any], uids: Iterable[str]) -> None:
    """把指定 UID 標記為已讀,避免下輪重複收取。"""
    await asyncio.to_thread(_mark_seen_sync, cfg, list(uids))


async def check_imap(cfg: dict[str, Any]) -> None:
    """連線測試:連線 + 登入 + 選取資料夾;失敗拋 EmailError。"""
    await asyncio.to_thread(_check_sync, cfg)
