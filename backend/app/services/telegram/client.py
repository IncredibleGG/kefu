"""Telegram Bot API 用戶端(乾淨室自寫,依官方公開協定)。

只實作 M5 所需方法:getMe / sendMessage / sendPhoto / getFile / setWebhook /
deleteWebhook / getWebhookInfo。使用 httpx.AsyncClient;可注入自訂 transport
以利測試(不需真的連 api.telegram.org)。

避免 tgo 的坑:
- bot_token 不外洩:本類別不負責記錄 token,遮罩由 channel_out.mask_secret 處理。
- webhook 與 polling 不同時搶:本類別只提供方法,不自啟 polling loop;
  是否用 webhook 由 channel API 設定,polling 於本 MVP 不啟用。
"""
from __future__ import annotations

from typing import Any

import httpx

_API_ROOT = "https://api.telegram.org"


class TelegramError(RuntimeError):
    """Bot API 回傳 ok=false,或 HTTP 層錯誤時拋出。"""

    def __init__(self, description: str, *, error_code: int | None = None) -> None:
        super().__init__(description)
        self.description = description
        self.error_code = error_code


class TelegramClient:
    """輕量 Bot API 用戶端。

    參數:
        token:bot token(格式 `<bot_id>:<secret>`)。
        transport:可選,測試時注入 httpx.MockTransport。
        timeout:單次請求逾時秒數。
    """

    def __init__(
        self,
        token: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 30.0,
        api_root: str = _API_ROOT,
    ) -> None:
        if not token or ":" not in token:
            raise ValueError("非法的 Telegram bot token 格式")
        self._token = token
        self._base = f"{api_root}/bot{token}"
        self._transport = transport
        self._timeout = timeout

    # --- 內部:統一送出並拆封 Bot API 信封 ---
    async def _call(self, method: str, *, http_method: str = "POST", **params: Any) -> Any:
        # 濾掉 None 參數,避免送出無意義欄位
        payload = {k: v for k, v in params.items() if v is not None}
        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
            try:
                if http_method == "GET":
                    resp = await client.get(f"{self._base}/{method}", params=payload)
                else:
                    resp = await client.post(f"{self._base}/{method}", json=payload)
            except httpx.HTTPError as exc:  # 網路層錯誤
                raise TelegramError(f"HTTP 錯誤:{exc}") from exc

        try:
            body = resp.json()
        except ValueError as exc:
            raise TelegramError(f"回應非 JSON(HTTP {resp.status_code})") from exc

        if not body.get("ok", False):
            raise TelegramError(
                body.get("description", "unknown telegram error"),
                error_code=body.get("error_code"),
            )
        return body.get("result")

    # --- 公開方法 ---
    async def get_me(self) -> dict:
        """驗證 token 是否有效,回傳 bot 基本資訊。"""
        return await self._call("getMe", http_method="GET")

    async def send_message(
        self,
        chat_id: str | int,
        text: str,
        *,
        parse_mode: str | None = None,
        reply_to_message_id: int | None = None,
        disable_web_page_preview: bool | None = None,
    ) -> dict:
        """送出文字訊息。"""
        return await self._call(
            "sendMessage",
            chat_id=chat_id,
            text=text,
            parse_mode=parse_mode,
            reply_to_message_id=reply_to_message_id,
            disable_web_page_preview=disable_web_page_preview,
        )

    async def send_photo(
        self,
        chat_id: str | int,
        photo: str,
        *,
        caption: str | None = None,
        parse_mode: str | None = None,
    ) -> dict:
        """送出圖片(photo 可為 file_id 或 URL)。"""
        return await self._call(
            "sendPhoto", chat_id=chat_id, photo=photo, caption=caption, parse_mode=parse_mode
        )

    async def get_file(self, file_id: str) -> dict:
        """取得檔案資訊(含 file_path,可組出下載 URL)。"""
        return await self._call("getFile", http_method="GET", file_id=file_id)

    def file_download_url(self, file_path: str) -> str:
        """由 getFile 回傳的 file_path 組出下載 URL(含 token,勿外洩)。"""
        return f"{_API_ROOT}/file/bot{self._token}/{file_path}"

    async def set_webhook(
        self,
        url: str,
        *,
        secret_token: str | None = None,
        allowed_updates: list[str] | None = None,
        drop_pending_updates: bool | None = None,
        max_connections: int | None = None,
    ) -> bool:
        """設定 webhook。secret_token 會被 Telegram 於每次回呼放進
        `X-Telegram-Bot-Api-Secret-Token` 標頭,供我方驗證來源。"""
        result = await self._call(
            "setWebhook",
            url=url,
            secret_token=secret_token,
            allowed_updates=allowed_updates,
            drop_pending_updates=drop_pending_updates,
            max_connections=max_connections,
        )
        return bool(result)

    async def delete_webhook(self, *, drop_pending_updates: bool | None = None) -> bool:
        """移除 webhook(切回未設定狀態)。"""
        result = await self._call("deleteWebhook", drop_pending_updates=drop_pending_updates)
        return bool(result)

    async def get_webhook_info(self) -> dict:
        """查詢目前 webhook 設定狀態(除錯用)。"""
        return await self._call("getWebhookInfo", http_method="GET")
