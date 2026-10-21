"""M5 channel — Telegram 子套件(乾淨室自寫 Bot API client)。

僅依 Telegram 官方公開協定實作,未複製任何第三方原始碼。
對外匯出:
- TelegramClient:Bot API 用戶端(sendMessage/sendPhoto/getFile/getMe/setWebhook…)
- TelegramError:Bot API 回傳錯誤時拋出
- parse_update / should_ignore_update:webhook update 歸一化與群組過濾
- hydrate_media:入站媒體補水(getFile→下載→回寫本站附件),於 parse_update 之後呼叫
"""
from __future__ import annotations

from app.services.telegram.client import TelegramClient, TelegramError
from app.services.telegram.media import hydrate_media
from app.services.telegram.webhook import (
    NormalizedInbound,
    parse_update,
    should_ignore_update,
    verify_secret,
)

__all__ = [
    "NormalizedInbound",
    "TelegramClient",
    "TelegramError",
    "hydrate_media",
    "parse_update",
    "should_ignore_update",
    "verify_secret",
]
