"""M5 channel — SMS(Twilio)子套件(乾淨室自寫,依 Twilio 官方公開協定)。

只實作 M5 所需:
- TwilioClient:出站傳送簡訊(Messages API,basic auth = account_sid:auth_token)。
- TwilioError:Twilio API / HTTP / 解析失敗時拋出(對齊 meta 的 MetaError 語意)。
- verify_twilio_signature:入站 webhook 的 ``X-Twilio-Signature`` 驗證(HMAC-SHA1 → base64)。
- parse_inbound:Twilio inbound webhook 表單欄位(From / Body / MediaUrlN…)→ NormalizedInbound。

出站端點:``POST https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json``,
以 HTTP Basic Auth(account_sid:auth_token)認證,body 為 ``application/x-www-form-urlencoded``
(``From`` / ``To`` / ``Body``)。SMS 無富訊息,card 由 channel_out 一律降級純文字。

歸一化沿用 telegram 子套件定義的渠道無關 NormalizedInbound,直接餵入
channel_out.ingest_inbound。可注入 httpx transport 以利測試(不需真的連 api.twilio.com)。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
from typing import Any

import httpx

from app.services.telegram import NormalizedInbound

# Twilio REST API 根位址與版本;client 可於建構時覆寫(利於測試)。
TWILIO_API_ROOT = "https://api.twilio.com"
TWILIO_API_VERSION = "2010-04-01"

# 無說明文字的媒體(MMS)所用佔位字串,與 meta 子套件一致。
_MEDIA_PLACEHOLDER = "[媒體]"


class TwilioError(RuntimeError):
    """Twilio API 回傳 error,或 HTTP / 解析層錯誤時拋出。

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
# 安全:X-Twilio-Signature 驗證
# --------------------------------------------------------------------------- #
def compute_twilio_signature(auth_token: str, url: str, params: dict[str, Any]) -> str:
    """依 Twilio 官方演算法算出預期簽章(HMAC-SHA1 → base64)。

    演算法:取「完整 webhook URL」為起點,對 POST 表單參數依「鍵」字典序排序,
    逐一把 key 與 value 直接串接於 URL 後方,再以 auth_token 為金鑰做 HMAC-SHA1,
    最後 base64 編碼。
    """
    data = url
    for key in sorted(params.keys()):
        data += key + str(params[key])
    digest = hmac.new(auth_token.encode("utf-8"), data.encode("utf-8"), hashlib.sha1).digest()
    return base64.b64encode(digest).decode("ascii")


def verify_twilio_signature(
    auth_token: str | None, url: str, params: dict[str, Any], header_value: str | None
) -> bool:
    """驗證 ``X-Twilio-Signature``。

    - 渠道未設 auth_token → 拒絕(安全預設,對齊 meta/telegram 的「未設簽章即拒」)。
    - header 缺失 → 拒絕。
    - 以恆定時間比較算出的簽章與 header(避免時序側信道)。

    注意:``url`` 必須是 Twilio 實際回呼的完整 URL(含 scheme/host/path/query);
    若服務位於反向代理後,可由渠道 config.webhook_url 覆寫以對齊(見 channel API)。
    """
    if not auth_token:
        return False
    if not header_value:
        return False
    expected = compute_twilio_signature(auth_token, url, params)
    # encode 成 bytes:非 ASCII 標頭值直接比 str 會拋 TypeError → 500。
    return hmac.compare_digest(str(expected).encode("utf-8"), str(header_value).encode("utf-8"))


# --------------------------------------------------------------------------- #
# 入站解析
# --------------------------------------------------------------------------- #
def parse_inbound(form: dict[str, Any]) -> NormalizedInbound | None:
    """把 Twilio inbound webhook 表單欄位轉為 NormalizedInbound。

    ``From`` 為訪客手機號(當 external_id/回覆對象);``Body`` 為文字。
    MMS(``NumMedia`` > 0):以佔位字串表示,媒體 URL 記進 meta(本 MVP 不下載回站)。
    無 ``From`` 則回 None(呼叫端略過)。
    """
    from_number = form.get("From") or form.get("from")
    if not from_number:
        return None
    body = form.get("Body") or ""
    meta: dict[str, Any] = {
        "provider": "sms",
        "message_sid": form.get("MessageSid") or form.get("SmsSid"),
        "from": from_number,
        "to": form.get("To"),
        "account_sid": form.get("AccountSid"),
    }

    content_type = "text"
    try:
        num_media = int(form.get("NumMedia") or 0)
    except (TypeError, ValueError):
        num_media = 0
    if num_media > 0:
        media_url = form.get("MediaUrl0")
        media_ct = form.get("MediaContentType0") or ""
        content_type = "image" if str(media_ct).startswith("image/") else "file"
        meta["num_media"] = num_media
        if media_url:
            meta["media_url"] = media_url
        if media_ct:
            meta["media_content_type"] = media_ct
        if not body:
            body = media_url or _MEDIA_PLACEHOLDER

    return NormalizedInbound(
        external_id=str(from_number),
        text=body,
        content_type=content_type,
        display_name=form.get("ProfileName") or None,
        meta={k: v for k, v in meta.items() if v is not None},
    )


# --------------------------------------------------------------------------- #
# 出站 client
# --------------------------------------------------------------------------- #
class TwilioClient:
    """輕量 Twilio Messages API 用戶端。

    參數:
        account_sid:Twilio 帳號 SID(``AC...``,basic auth 使用者名)。
        auth_token:Twilio auth token(basic auth 密碼;機敏)。
        transport:可選,測試時注入 httpx.MockTransport。
        timeout:單次請求逾時秒數。
    """

    def __init__(
        self,
        account_sid: str,
        auth_token: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 30.0,
        api_root: str = TWILIO_API_ROOT,
        api_version: str = TWILIO_API_VERSION,
    ) -> None:
        if not account_sid:
            raise ValueError("缺少 account_sid")
        if not auth_token:
            raise ValueError("缺少 auth_token")
        self._account_sid = account_sid
        self._auth_token = auth_token
        self._transport = transport
        self._timeout = timeout
        self._base = f"{api_root.rstrip('/')}/{api_version}"

    async def send_message(self, from_number: str, to: str, body: str) -> dict[str, Any]:
        """傳送簡訊給 ``to``,寄件者為渠道設定號碼 ``from_number``。

        以 basic auth(account_sid:auth_token)認證,body 為表單(非 JSON)。
        Twilio 成功回 2xx 並帶 ``sid`` / ``status``;失敗回 4xx 並帶 ``code`` / ``message``。
        """
        url = f"{self._base}/Accounts/{self._account_sid}/Messages.json"
        payload = {"From": str(from_number), "To": str(to), "Body": body}
        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
            try:
                resp = await client.post(
                    url, data=payload, auth=(self._account_sid, self._auth_token)
                )
            except httpx.HTTPError as exc:  # 網路層錯誤
                raise TwilioError(f"HTTP 錯誤:{exc}") from exc

        try:
            data = resp.json()
        except ValueError as exc:
            raise TwilioError(f"回應非 JSON(HTTP {resp.status_code})") from exc

        if resp.status_code >= 400:
            err = data if isinstance(data, dict) else {}
            raise TwilioError(
                err.get("message", "unknown twilio error"),
                code=err.get("code"),
                http_status=resp.status_code,
            )
        return data if isinstance(data, dict) else {"result": data}
