"""Facebook Messenger Send API 用戶端(乾淨室自寫,依 Meta 官方公開協定)。

只實作 M5 所需:對指定 PSID 傳送文字訊息。使用 httpx.AsyncClient,可注入
自訂 transport 以利測試。

出站端點:``POST graph.facebook.com/<version>/me/messages``,以
``Authorization: Bearer <page_access_token>`` 認證(避免把 token 放進 URL/query)。
"""
from __future__ import annotations

from typing import Any

import httpx

from app.services.meta.graph import GRAPH_API_ROOT, GRAPH_API_VERSION, graph_post


class FacebookClient:
    """輕量 Facebook Messenger Send API 用戶端。

    參數:
        page_access_token:粉專的 page access token(送信憑證)。
        transport:可選,測試時注入 httpx.MockTransport。
        timeout:單次請求逾時秒數。
    """

    def __init__(
        self,
        page_access_token: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 30.0,
        api_root: str = GRAPH_API_ROOT,
        api_version: str = GRAPH_API_VERSION,
    ) -> None:
        if not page_access_token:
            raise ValueError("缺少 page_access_token")
        self._token = page_access_token
        self._transport = transport
        self._timeout = timeout
        self._base = f"{api_root.rstrip('/')}/{api_version}"

    async def send_text(
        self, recipient_id: str, text: str, *, messaging_type: str = "RESPONSE"
    ) -> dict[str, Any]:
        """傳送文字訊息給指定收件者 PSID(``recipient_id``)。"""
        url = f"{self._base}/me/messages"
        payload = {
            "recipient": {"id": str(recipient_id)},
            "messaging_type": messaging_type,
            "message": {"text": text},
        }
        return await graph_post(
            url,
            json_body=payload,
            headers={"Authorization": f"Bearer {self._token}"},
            transport=self._transport,
            timeout=self._timeout,
        )
