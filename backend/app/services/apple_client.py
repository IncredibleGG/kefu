"""M5 channel — Apple Messages for Business 子套件(乾淨室框架)。

Apple Messages for Business(下稱 MfB)的訊息不直接點對點傳輸:企業須先於
**Apple Business Register** 註冊,並透過 **Messaging Service Provider(MSP)** 中繼
(Apple 伺服器 ↔ MSP ↔ 本服務)。因此本子套件為 **code-ready 框架**:

- 入站(``parse_apple``):把 MSP 回呼的訊息物件(單筆或 ``messages`` 批次)歸一化成
  渠道無關的 NormalizedInbound(external_id = 顧客不透明 ``sourceId``)。可直接使用。
- 入站授權(``verify_apple_secret``):以渠道設定的共享 secret 對回呼做恆定時間比較
  (未設 secret → 拒絕,安全預設,對齊其他渠道)。實際 MSP 的驗證機制依供應商而異,
  此為框架式共享密鑰閘門。
- 出站(``build_text_payload`` / ``AppleClient``):組出 MfB 文字訊息 payload 並(若已
  設定 MSP 端點與憑證)POST 給 MSP;**未設定則由 channel_out._send_apple 直接 no-op**。
  真正送達需 Apple 商務註冊 + MSP 端點 + 憑證,故出站標明為 code-ready 框架。

歸一化沿用 telegram 子套件定義的渠道無關 NormalizedInbound。可注入 httpx transport
以利測試(不需真的連任何 MSP)。
"""
from __future__ import annotations

import hmac
import uuid
from typing import Any

import httpx

from app.services.telegram import NormalizedInbound

# MfB 訊息 schema 版本(payload 的 ``v`` 欄位)。
APPLE_MESSAGE_VERSION = 1

# 無說明文字 / 非純文字型訊息所用佔位字串,與其他子套件一致。
_MEDIA_PLACEHOLDER = "[媒體]"


class AppleError(RuntimeError):
    """MSP / HTTP / 解析層錯誤時拋出。

    出站 adapter 會捕捉此例外並降級(只 log 不向上拋),避免拖垮 dispatch。
    """

    def __init__(
        self, message: str, *, code: int | None = None, http_status: int | None = None
    ) -> None:
        super().__init__(message)
        self.description = message
        self.code = code
        self.http_status = http_status


# --------------------------------------------------------------------------- #
# 安全:入站共享密鑰驗證(框架式閘門)
# --------------------------------------------------------------------------- #
def verify_apple_secret(expected: str | None, provided: str | None) -> bool:
    """驗證 MSP 回呼所帶的共享 secret。

    - 渠道未設 secret(expected 為空)→ 拒絕(安全預設,對齊 telegram/meta)。
    - 缺 provided → 拒絕。
    - 恆定時間比較(避免時序側信道)。

    實務上不同 MSP 的回呼驗證機制不一(bearer token / 簽章…),此處採「共享密鑰」
    框架:channel API 由 ``Authorization: Bearer <secret>`` 或 ``X-Apple-Signature``
    取出 provided 後交此比對。
    """
    if not expected:
        return False
    if not provided:
        return False
    # 一律先 encode 成 bytes:compare_digest 對「非 ASCII str」會拋 TypeError,
    # 而 provided 來自攻擊者可控的請求標頭,直接比 str 會被構造輸入打成 500。
    return hmac.compare_digest(str(expected).encode("utf-8"), str(provided).encode("utf-8"))


# --------------------------------------------------------------------------- #
# 入站解析
# --------------------------------------------------------------------------- #
def _parse_apple_message(msg: dict[str, Any]) -> NormalizedInbound | None:
    """把單筆 MfB 訊息物件轉為 NormalizedInbound;無 sourceId 回 None。"""
    if not isinstance(msg, dict):
        return None
    source_id = msg.get("sourceId") or msg.get("source_id")
    if not source_id:
        return None
    mtype = msg.get("type") or "text"
    meta: dict[str, Any] = {
        "provider": "apple",
        "message_id": msg.get("id"),
        "source_id": source_id,
        "destination_id": msg.get("destinationId") or msg.get("destination_id"),
        "type": mtype,
        "group": msg.get("group"),
        "locale": msg.get("locale"),
    }

    content_type = "text"
    if mtype == "text":
        text = msg.get("body") or ""
    else:
        # interactive / attachment / richLink 等富訊息:需 MSP 端解密/換取,本框架以佔位表示。
        text = _MEDIA_PLACEHOLDER
        if mtype == "attachment" or msg.get("attachments"):
            content_type = "file"
    if not text:
        text = _MEDIA_PLACEHOLDER

    return NormalizedInbound(
        external_id=str(source_id),
        text=text,
        content_type=content_type,
        display_name=None,
        meta={k: v for k, v in meta.items() if v is not None},
    )


def parse_apple(payload: Any) -> list[NormalizedInbound]:
    """把 MSP 回呼 payload 轉為一批 NormalizedInbound。

    相容三種形狀:單筆訊息 dict、``{"messages": [...]}`` 批次、或直接是訊息 list。
    非可解析內容回空 list。
    """
    if isinstance(payload, dict):
        if isinstance(payload.get("messages"), list):
            messages = payload["messages"]
        else:
            messages = [payload]
    elif isinstance(payload, list):
        messages = payload
    else:
        return []

    results: list[NormalizedInbound] = []
    for msg in messages:
        inbound = _parse_apple_message(msg)
        if inbound is not None:
            results.append(inbound)
    return results


# --------------------------------------------------------------------------- #
# 出站(code-ready 框架)
# --------------------------------------------------------------------------- #
def build_text_payload(business_id: str, destination_id: str, text: str) -> dict[str, Any]:
    """組出 MfB 出站文字訊息 payload。

    出站方向:sourceId = 企業(business_id)、destinationId = 顧客不透明 id
    (即入站的 sourceId)。``id`` 為本次訊息的 UUID、``v`` 為 schema 版本。
    """
    return {
        "type": "text",
        "id": str(uuid.uuid4()),
        "sourceId": str(business_id),
        "destinationId": str(destination_id),
        "body": text,
        "v": APPLE_MESSAGE_VERSION,
    }


class AppleClient:
    """MfB 出站用戶端(code-ready 框架)。

    把 ``build_text_payload`` 組出的訊息 POST 給 MSP 端點,並以 secret 作 bearer 認證。
    真正送達仍需 Apple 商務註冊 + 對應 MSP 的實際端點契約 / 憑證,故此為框架式實作;
    channel_out._send_apple 在缺少 msp_endpoint / business_id / secret 時直接 no-op,
    不會建構本 client。

    參數:
        msp_endpoint:MSP 收訊端點 URL。
        business_id:Apple 商務 ID(出站 sourceId)。
        secret:與 MSP 約定的共享密鑰(bearer;機敏)。
        transport:可選,測試時注入 httpx.MockTransport。
        timeout:單次請求逾時秒數。
    """

    def __init__(
        self,
        msp_endpoint: str,
        business_id: str,
        secret: str | None = None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 30.0,
    ) -> None:
        if not msp_endpoint:
            raise ValueError("缺少 msp_endpoint")
        if not business_id:
            raise ValueError("缺少 business_id")
        self._endpoint = msp_endpoint
        self._business_id = business_id
        self._secret = secret
        self._transport = transport
        self._timeout = timeout

    async def send_text(self, destination_id: str, text: str) -> dict[str, Any]:
        """組 payload 並 POST 給 MSP 端點;失敗一律轉 AppleError。"""
        payload = build_text_payload(self._business_id, destination_id, text)
        headers = {"Content-Type": "application/json"}
        if self._secret:
            headers["Authorization"] = f"Bearer {self._secret}"
        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
            try:
                resp = await client.post(self._endpoint, json=payload, headers=headers)
            except httpx.HTTPError as exc:  # 網路層錯誤
                raise AppleError(f"HTTP 錯誤:{exc}") from exc
        if resp.status_code >= 400:
            raise AppleError(
                f"MSP 回傳 HTTP {resp.status_code}", http_status=resp.status_code
            )
        try:
            data = resp.json()
        except ValueError:
            return {"status": resp.status_code}
        return data if isinstance(data, dict) else {"result": data}
