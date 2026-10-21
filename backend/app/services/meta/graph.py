"""Meta Graph API 共用 HTTP 呼叫(乾淨室,依官方公開協定)。

WhatsApp Cloud API 與 Facebook Send API 皆走 ``graph.facebook.com/<version>``,
回應信封語意一致(成功回結果物件,失敗回 ``{"error": {...}}``),故抽出共用的
``graph_post``:統一送出、拆封、錯誤轉 MetaError。可注入 httpx transport 以利測試。
"""
from __future__ import annotations

from typing import Any

import httpx

from app.services.meta.errors import MetaError

# graph.facebook.com 與 API 版本;client 可於建構時覆寫(利於測試 / 升版)。
GRAPH_API_ROOT = "https://graph.facebook.com"
GRAPH_API_VERSION = "v20.0"


async def graph_post(
    url: str,
    *,
    json_body: dict[str, Any],
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """對 Graph API 送出 POST 並拆封回應;失敗一律轉 MetaError。

    - 網路層錯誤 → MetaError。
    - 回應非 JSON → MetaError。
    - 回應含 ``error`` 物件 → MetaError(帶 code / http_status)。
    - HTTP >= 400 但無 error 物件 → MetaError。
    """
    async with httpx.AsyncClient(transport=transport, timeout=timeout) as client:
        try:
            resp = await client.post(url, json=json_body, params=params, headers=headers)
        except httpx.HTTPError as exc:  # 網路層錯誤
            raise MetaError(f"HTTP 錯誤:{exc}") from exc

    try:
        body = resp.json()
    except ValueError as exc:
        raise MetaError(f"回應非 JSON(HTTP {resp.status_code})") from exc

    if isinstance(body, dict) and body.get("error"):
        error = body["error"] or {}
        raise MetaError(
            error.get("message", "unknown graph error"),
            code=error.get("code"),
            http_status=resp.status_code,
        )
    if resp.status_code >= 400:
        raise MetaError(f"Graph API 回傳 HTTP {resp.status_code}", http_status=resp.status_code)
    return body if isinstance(body, dict) else {"result": body}


async def graph_get(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """對 Graph API 送出 GET 並拆封回應;失敗一律轉 MetaError(語意同 graph_post)。

    入站媒體管線用它查 WhatsApp 媒體 metadata(``GET /<media_id>`` → 含 ``url`` /
    ``mime_type``),再由 media_store 依該 url 下載。
    """
    async with httpx.AsyncClient(transport=transport, timeout=timeout) as client:
        try:
            resp = await client.get(url, params=params, headers=headers)
        except httpx.HTTPError as exc:  # 網路層錯誤
            raise MetaError(f"HTTP 錯誤:{exc}") from exc

    try:
        body = resp.json()
    except ValueError as exc:
        raise MetaError(f"回應非 JSON(HTTP {resp.status_code})") from exc

    if isinstance(body, dict) and body.get("error"):
        error = body["error"] or {}
        raise MetaError(
            error.get("message", "unknown graph error"),
            code=error.get("code"),
            http_status=resp.status_code,
        )
    if resp.status_code >= 400:
        raise MetaError(f"Graph API 回傳 HTTP {resp.status_code}", http_status=resp.status_code)
    return body if isinstance(body, dict) else {"result": body}
