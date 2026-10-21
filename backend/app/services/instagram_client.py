"""M5 channel — Instagram DM 子套件(乾淨室自寫,依 Meta 官方公開協定)。

Instagram Messaging 複用 Meta 基礎設施(與 Facebook Messenger 同一組 Graph API 與
webhook 簽章 ``X-Hub-Signature-256`` / GET ``hub.challenge`` 驗證握手),故:

- 安全驗證(verify_signature / verify_challenge)直接沿用 ``app.services.meta``,
  不重複實作(見 channel API 的 instagram webhook 端點)。
- 出站(送出文字 / 卡片模板)沿用 Graph ``POST /me/messages`` 與既有
  ``FacebookClient`` / ``_build_facebook_message``(見 channel_out._send_instagram)。
- 入站解析在此以獨立 ``parse_instagram`` 提供:結構同 Messenger 的
  ``entry[].messaging[]``,但 provider 標記為 ``instagram``、external_id 為 IGSID
  (Instagram-scoped user id,即 ``sender.id``)。

之所以另寫 parse_instagram(而非改 meta 子套件):meta.webhook 的 parse_facebook
會把 provider 固定標為 ``facebook``,且本次不可改既有檔;獨立解析可正確標記渠道別,
供後續統計 / 媒體補水分派使用。
"""
from __future__ import annotations

from typing import Any

from app.services.telegram import NormalizedInbound

# 無說明文字的媒體所用佔位字串,與 meta 子套件一致。
_MEDIA_PLACEHOLDER = "[媒體]"


def _parse_ig_event(
    event: dict[str, Any], ig_account_id: str | None
) -> NormalizedInbound | None:
    """把單一 messaging 事件轉為 NormalizedInbound;非訊息 / echo / 空事件回 None。"""
    message = event.get("message")
    if not message:
        return None  # delivery / read / reaction 等非訊息事件:本 MVP 略過
    if message.get("is_echo"):
        return None  # IG 帳號自身送出的訊息回聲,略過
    sender_id = (event.get("sender") or {}).get("id")
    if not sender_id:
        return None

    content_type = "text"
    text = message.get("text") or ""
    meta: dict[str, Any] = {
        "provider": "instagram",
        "mid": message.get("mid"),
        "sender_id": sender_id,
        "recipient_id": (event.get("recipient") or {}).get("id") or ig_account_id,
        "ig_account_id": ig_account_id,
        "timestamp": event.get("timestamp"),
    }

    attachments = message.get("attachments") or []
    if not text and attachments:
        first = attachments[0] or {}
        atype = first.get("type")
        content_type = "image" if atype == "image" else "file"
        meta["attachment_type"] = atype
        url = (first.get("payload") or {}).get("url")
        if url:
            meta["attachment_url"] = url
        text = _MEDIA_PLACEHOLDER

    if not text:
        return None  # 無文字也無附件的空事件:略過

    return NormalizedInbound(
        external_id=str(sender_id),
        text=text,
        content_type=content_type,
        display_name=None,  # IG webhook 不含姓名;需另呼叫 Graph 取得,本 MVP 不取
        meta={k: v for k, v in meta.items() if v is not None},
    )


def parse_instagram(payload: dict[str, Any]) -> list[NormalizedInbound]:
    """把 Instagram Messaging webhook payload 轉為一批 NormalizedInbound。

    僅取 ``entry[].messaging[]`` 內的 ``message`` 事件(結構同 Messenger);
    echo / 遞送回報 / 空事件略過。external_id 為 IGSID(``sender.id``)。
    Meta 一次 POST 可夾帶多筆事件,故回傳 list。
    """
    results: list[NormalizedInbound] = []
    if not isinstance(payload, dict):
        return results
    for entry in payload.get("entry") or []:
        ig_account_id = entry.get("id")
        for event in entry.get("messaging") or []:
            inbound = _parse_ig_event(event, ig_account_id)
            if inbound is not None:
                results.append(inbound)
    return results
