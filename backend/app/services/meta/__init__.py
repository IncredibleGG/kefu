"""M5 channel — Meta 子套件(WhatsApp Cloud API + Facebook Messenger Send API)。

乾淨室自寫,僅依 Meta 官方公開協定實作,未複製任何第三方原始碼。結構仿既有
telegram 子套件。對外匯出:
- WhatsAppClient / FacebookClient:Graph API 出站用戶端(傳送文字)。
- MetaError:Graph API / HTTP / 解析失敗時拋出。
- verify_challenge / verify_signature:webhook GET 驗證握手、POST 簽章驗證。
- parse_whatsapp / parse_facebook:webhook payload → NormalizedInbound 批次。
- hydrate_media:入站媒體補水(依 media_id/附件 URL 下載→回寫本站附件),於 parse_* 之後呼叫。
"""
from __future__ import annotations

from app.services.meta.errors import MetaError
from app.services.meta.facebook_client import FacebookClient
from app.services.meta.media import hydrate_media
from app.services.meta.webhook import (
    parse_facebook,
    parse_whatsapp,
    verify_challenge,
    verify_signature,
)
from app.services.meta.whatsapp_client import WhatsAppClient

__all__ = [
    "FacebookClient",
    "MetaError",
    "WhatsAppClient",
    "hydrate_media",
    "parse_facebook",
    "parse_whatsapp",
    "verify_challenge",
    "verify_signature",
]
