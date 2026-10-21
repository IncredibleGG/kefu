"""Telegram 入站媒體補水(hydrate):把佔位訊息換成真實本站附件。

`parse_update` 只做結構解析(同步、無 I/O),對 photo/document/voice 等附件僅記下
``meta.file_id`` 與佔位字串(如 ``[image]`` / ``[file]``)。本模組補上入站的實際
下載:用 bot_token(於 DB 靜態加密,取用前 decrypt)呼叫 Bot API getFile 取
``file_path`` → 組下載 URL → 交給 `media_store.download_and_store` 存進本站上傳目錄,
再把 inbound 的 content_type/meta/text 回寫為真實附件(本站 URL)。

用法(由渠道 webhook 端在 parse_update 之後、ingest_inbound 之前呼叫)::

    inbound = parse_update(update)
    if inbound is not None:
        inbound = await hydrate_media(inbound, channel.config)
    await ingest_inbound(db, tenant_id, channel_id, inbound)

任何失敗(缺 token、getFile 出錯、下載失敗)都**回傳原 inbound**,即維持既有佔位
行為——不拋例外、不丟訊息、不影響文字訊息路徑。
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from app.core import crypto
from app.services import media_store
from app.services.telegram.client import TelegramClient
from app.services.telegram.webhook import NormalizedInbound

logger = logging.getLogger("kefu.telegram.media")

# parse_update 對無說明文字的媒體所用的佔位字串;回寫時視為可被本站 URL 取代。
_PLACEHOLDERS = {"[image]", "[file]"}


def _apply_stored(inbound: NormalizedInbound, stored_url: str, meta: dict[str, Any]) -> NormalizedInbound:
    """把下載結果回寫進 inbound:meta 記本站 URL;佔位/純檔名的 text 換成本站 URL。"""
    new_meta = dict(meta)
    new_meta["url"] = stored_url          # 附件正規位置(本站可存取 URL)
    new_meta["media_url"] = stored_url    # 別名,方便前端/坐席台取用
    new_meta["media_stored"] = True
    inbound.meta = new_meta
    # 只有「佔位字串」或「純檔名後援(無真正說明文字)」才用本站 URL 取代;
    # 若使用者有附上 caption,保留原文,附件走 meta。
    if inbound.text in _PLACEHOLDERS or inbound.text == meta.get("file_name"):
        inbound.text = stored_url
    return inbound


async def hydrate_media(
    inbound: NormalizedInbound,
    channel_config: dict[str, Any] | None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> NormalizedInbound:
    """下載 Telegram 入站附件並回寫真實本站 URL;失敗回原 inbound(降級為佔位)。"""
    meta = inbound.meta or {}
    file_id = meta.get("file_id")
    # 僅處理帶 file_id 的媒體訊息;文字訊息(無 file_id)原樣通過。
    if inbound.content_type not in ("image", "file") or not file_id:
        return inbound

    # bot_token 於 DB 靜態加密(enc::),取用前解密;舊明文 decrypt 原樣回傳。
    token = crypto.decrypt((channel_config or {}).get("bot_token"))
    if not token:
        logger.warning("telegram 入站媒體缺 bot_token,維持佔位(file_id=%s)", file_id)
        return inbound

    try:
        client = TelegramClient(token, transport=transport)
        info = await client.get_file(file_id)
        file_path = (info or {}).get("file_path")
        if not file_path:
            return inbound
        # 下載 URL 內含 token(Telegram 檔案協定要求),切勿記錄此 URL。
        download_url = client.file_download_url(file_path)
        stored_url = await media_store.download_and_store(
            download_url,
            filename_hint=meta.get("file_name") or file_path.rsplit("/", 1)[-1],
            transport=transport,
        )
        if not stored_url:
            return inbound
        return _apply_stored(inbound, stored_url, meta)
    except Exception:  # TelegramError / ValueError / 其他:一律降級
        logger.warning("telegram 入站媒體下載失敗,維持佔位(file_id=%s)", file_id, exc_info=True)
        return inbound
