"""Meta(WhatsApp / Facebook)入站媒體補水(hydrate)。

`parse_whatsapp` / `parse_facebook` 只做結構解析,對媒體僅記下識別:
- WhatsApp:``meta.media_id``(需再向 Graph API 換取實際下載 URL)。
- Facebook Messenger:``meta.attachment_url``(webhook 已直接給出 CDN 附件 URL)。
兩者的訊息 text 皆為佔位字串 ``[媒體]``(或後援檔名)。

本模組補上入站的實際下載,並把 inbound 回寫為真實本站附件:

- WhatsApp:access_token(DB 靜態加密,取用前 decrypt)→ ``GET /<media_id>`` 取
  ``url`` / ``mime_type`` → 帶 ``Authorization: Bearer <token>`` 下載該 url →
  `media_store.download_and_store` 存本站。
- Facebook:Messenger 附件 URL 為預簽的 lookaside 連結,直接下載(免帶 token)→
  `media_store.download_and_store` 存本站。

用法(由渠道 webhook 端在 parse_* 之後、ingest_inbound 之前,逐筆呼叫)::

    for inbound in parse_whatsapp(payload):      # 或 parse_facebook
        inbound = await hydrate_media(inbound, channel.config)
        await ingest_inbound(db, tenant_id, channel_id, inbound)

任何失敗都**回傳原 inbound**(維持既有佔位行為)——不拋例外、不丟訊息、不影響
文字訊息路徑。
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from app.core import crypto
from app.services import media_store
from app.services.meta.graph import GRAPH_API_ROOT, GRAPH_API_VERSION, graph_get
from app.services.telegram import NormalizedInbound

logger = logging.getLogger("kefu.meta.media")

# parse_* 對無說明文字的媒體所用的佔位字串;回寫時視為可被本站 URL 取代。
_PLACEHOLDER = "[媒體]"


def _apply_stored(inbound: NormalizedInbound, stored_url: str, meta: dict[str, Any]) -> NormalizedInbound:
    """把下載結果回寫進 inbound:meta 記本站 URL;佔位/純檔名的 text 換成本站 URL。"""
    new_meta = dict(meta)
    new_meta["url"] = stored_url
    new_meta["media_url"] = stored_url
    new_meta["media_stored"] = True
    inbound.meta = new_meta
    if inbound.text == _PLACEHOLDER or inbound.text == meta.get("file_name"):
        inbound.text = stored_url
    return inbound


async def _hydrate_whatsapp(
    inbound: NormalizedInbound,
    channel_config: dict[str, Any],
    meta: dict[str, Any],
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> NormalizedInbound:
    media_id = meta.get("media_id")
    if inbound.content_type not in ("image", "file") or not media_id:
        return inbound
    # access_token 於 DB 靜態加密,取用前解密。
    token = crypto.decrypt(channel_config.get("access_token"))
    if not token:
        logger.warning("whatsapp 入站媒體缺 access_token,維持佔位(media_id=%s)", media_id)
        return inbound

    auth = {"Authorization": f"Bearer {token}"}
    # 1) 以 media_id 向 Graph API 換取實際下載 URL 與 mime_type。
    info = await graph_get(
        f"{GRAPH_API_ROOT}/{GRAPH_API_VERSION}/{media_id}",
        headers=auth,
        transport=transport,
    )
    media_url = (info or {}).get("url")
    if not media_url:
        return inbound
    # 2) 帶同一 Bearer 下載媒體(WhatsApp 媒體 URL 須帶授權標頭)。
    stored_url = await media_store.download_and_store(
        media_url,
        headers=auth,
        filename_hint=meta.get("file_name"),
        content_type_hint=(info or {}).get("mime_type"),
        transport=transport,
    )
    if not stored_url:
        return inbound
    return _apply_stored(inbound, stored_url, meta)


async def _hydrate_facebook(
    inbound: NormalizedInbound,
    meta: dict[str, Any],
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> NormalizedInbound:
    attachment_url = meta.get("attachment_url")
    if inbound.content_type not in ("image", "file") or not attachment_url:
        return inbound
    # Messenger 附件為預簽 lookaside URL,直接下載(不帶 token)。
    stored_url = await media_store.download_and_store(
        attachment_url,
        filename_hint=meta.get("file_name"),
        transport=transport,
    )
    if not stored_url:
        return inbound
    return _apply_stored(inbound, stored_url, meta)


async def hydrate_media(
    inbound: NormalizedInbound,
    channel_config: dict[str, Any] | None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> NormalizedInbound:
    """下載 WhatsApp / Facebook 入站附件並回寫本站 URL;失敗回原 inbound(降級)。

    依 ``inbound.meta['provider']`` 分派;非媒體或無識別時原樣通過。
    """
    meta = inbound.meta or {}
    provider = meta.get("provider")
    cfg = channel_config or {}
    try:
        if provider == "whatsapp":
            return await _hydrate_whatsapp(inbound, cfg, meta, transport=transport)
        if provider == "facebook":
            return await _hydrate_facebook(inbound, meta, transport=transport)
        return inbound
    except Exception:  # MetaError / 網路 / 其他:一律降級
        logger.warning(
            "meta 入站媒體下載失敗,維持佔位(provider=%s)", provider, exc_info=True
        )
        return inbound
