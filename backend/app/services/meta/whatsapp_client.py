"""WhatsApp Cloud API 用戶端(乾淨室自寫,依 Meta 官方公開協定)。

只實作 M5 所需:傳送文字訊息。使用 httpx.AsyncClient,可注入自訂 transport
以利測試(不需真的連 graph.facebook.com)。

出站端點:``POST graph.facebook.com/<version>/{phone_number_id}/messages``,
以 ``Authorization: Bearer <access_token>`` 認證,避免把 token 放進 URL/query。
"""
from __future__ import annotations

from typing import Any

import httpx

from app.services.meta.graph import GRAPH_API_ROOT, GRAPH_API_VERSION, graph_post


class WhatsAppClient:
    """輕量 WhatsApp Cloud API 用戶端。

    參數:
        phone_number_id:WhatsApp Business 電話號碼 ID(送信主體)。
        access_token:permanent / system-user access token。
        transport:可選,測試時注入 httpx.MockTransport。
        timeout:單次請求逾時秒數。
    """

    def __init__(
        self,
        phone_number_id: str,
        access_token: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 30.0,
        api_root: str = GRAPH_API_ROOT,
        api_version: str = GRAPH_API_VERSION,
    ) -> None:
        if not phone_number_id:
            raise ValueError("缺少 phone_number_id")
        if not access_token:
            raise ValueError("缺少 access_token")
        self._phone_number_id = phone_number_id
        self._access_token = access_token
        self._transport = transport
        self._timeout = timeout
        self._base = f"{api_root.rstrip('/')}/{api_version}"

    async def send_text(self, to: str, text: str, *, preview_url: bool = False) -> dict[str, Any]:
        """傳送文字訊息給指定 wa_id(``to``)。"""
        url = f"{self._base}/{self._phone_number_id}/messages"
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": str(to),
            "type": "text",
            "text": {"preview_url": preview_url, "body": text},
        }
        return await graph_post(
            url,
            json_body=payload,
            headers={"Authorization": f"Bearer {self._access_token}"},
            transport=self._transport,
            timeout=self._timeout,
        )
