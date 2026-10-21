"""Meta webhook 安全驗證與入站歸一化(WhatsApp / Facebook 共用一組工具)。

職責:
- verify_challenge:GET 驗證握手,比對 ``hub.verify_token`` → 回 ``hub.challenge``。
- verify_signature:POST 回呼,驗 ``X-Hub-Signature-256``(HMAC-SHA256,恆定時間比較)。
- parse_whatsapp:WhatsApp Cloud API webhook → 一批 NormalizedInbound(external_id=wa_id)。
- parse_facebook:Messenger webhook → 一批 NormalizedInbound(external_id=sender.id)。

歸一化沿用 telegram 子套件定義的渠道無關 NormalizedInbound,直接餵入
channel_out.ingest_inbound。Meta 一次 POST 可夾帶多筆事件,故解析回傳 list。
"""
from __future__ import annotations

import hashlib
import hmac
from typing import Any

from app.services.telegram import NormalizedInbound

_SIG_PREFIX = "sha256="
_MEDIA_PLACEHOLDER = "[媒體]"


# --------------------------------------------------------------------------- #
# 安全:GET 驗證握手 / POST 簽章
# --------------------------------------------------------------------------- #
def verify_challenge(
    *, mode: str | None, token: str | None, challenge: str | None, expected_token: str | None
) -> str | None:
    """Meta webhook GET 驗證:條件全符則回傳 challenge,否則回 None(呼叫端回 403)。

    - 渠道未設 verify_token(expected 為空)→ 拒絕(必須先設定)。
    - mode 必須為 ``subscribe``;token 需與 expected 相符(恆定時間比較)。
    """
    if not expected_token:
        return None
    if mode != "subscribe":
        return None
    if not token or challenge is None:
        return None
    # encode 成 bytes:token 來自查詢參數(攻擊者可控),非 ASCII 直接比會 TypeError → 500。
    if not hmac.compare_digest(str(token).encode("utf-8"), str(expected_token).encode("utf-8")):
        return None
    return challenge


def verify_signature(
    app_secret: str | None, raw_body: bytes, header_value: str | None
) -> bool:
    """驗證 ``X-Hub-Signature-256``(格式 ``sha256=<hex>``)。

    - 渠道未設 app_secret → 拒絕(安全預設,必須先設定)。
    - header 缺失或格式不符 → 拒絕。
    - 以 app_secret 對「原始請求 bytes」做 HMAC-SHA256,恆定時間比較 hexdigest。
    """
    if not app_secret:
        return False
    if not header_value or not header_value.startswith(_SIG_PREFIX):
        return False
    received = header_value[len(_SIG_PREFIX) :]
    expected = hmac.new(
        app_secret.encode("utf-8"), raw_body or b"", hashlib.sha256
    ).hexdigest()
    # encode 成 bytes:received 來自標頭(攻擊者可控),非 ASCII 直接比會 TypeError → 500。
    return hmac.compare_digest(expected.encode("utf-8"), str(received).encode("utf-8"))


# --------------------------------------------------------------------------- #
# WhatsApp Cloud API 入站解析
# --------------------------------------------------------------------------- #
def _parse_wa_message(
    msg: dict[str, Any], names: dict[str, str | None], phone_number_id: str | None
) -> NormalizedInbound | None:
    wa_id = msg.get("from")
    if not wa_id:
        return None
    msg_type = msg.get("type", "text")
    content_type = "text"
    text = ""
    meta: dict[str, Any] = {
        "provider": "whatsapp",
        "message_id": msg.get("id"),
        "wa_id": wa_id,
        "phone_number_id": phone_number_id,
        "timestamp": msg.get("timestamp"),
        "type": msg_type,
    }

    if msg_type == "text":
        text = (msg.get("text") or {}).get("body") or ""
    elif msg_type == "image":
        content_type = "image"
        media = msg.get("image") or {}
        meta["media_id"] = media.get("id")
        text = media.get("caption") or _MEDIA_PLACEHOLDER
    elif msg_type in ("video", "audio", "voice", "document", "sticker"):
        content_type = "file"
        media = msg.get(msg_type) or {}
        meta["media_id"] = media.get("id")
        if media.get("filename"):
            meta["file_name"] = media.get("filename")
        text = media.get("caption") or media.get("filename") or _MEDIA_PLACEHOLDER
    else:
        # location / contacts / interactive / button / reaction … 一律以佔位字串表示
        text = _MEDIA_PLACEHOLDER

    return NormalizedInbound(
        external_id=str(wa_id),
        text=text,
        content_type=content_type,
        display_name=names.get(wa_id),
        meta=meta,
    )


def parse_whatsapp(payload: dict[str, Any]) -> list[NormalizedInbound]:
    """把 WhatsApp Cloud API webhook payload 轉為一批 NormalizedInbound。

    僅取 ``entry[].changes[].value.messages[]``;狀態回報(statuses)略過。
    display_name 取自同層 ``contacts[].profile.name``(依 wa_id 對應)。
    """
    results: list[NormalizedInbound] = []
    if not isinstance(payload, dict):
        return results
    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            value = change.get("value") or {}
            metadata = value.get("metadata") or {}
            phone_number_id = metadata.get("phone_number_id")
            names: dict[str, str | None] = {}
            for contact in value.get("contacts") or []:
                wa_id = contact.get("wa_id")
                if wa_id:
                    names[wa_id] = (contact.get("profile") or {}).get("name")
            for msg in value.get("messages") or []:
                inbound = _parse_wa_message(msg, names, phone_number_id)
                if inbound is not None:
                    results.append(inbound)
    return results


# --------------------------------------------------------------------------- #
# Facebook Messenger 入站解析
# --------------------------------------------------------------------------- #
def _parse_fb_event(event: dict[str, Any], page_id: str | None) -> NormalizedInbound | None:
    message = event.get("message")
    if not message:
        return None  # delivery / read / postback 等非訊息事件:本 MVP 略過
    if message.get("is_echo"):
        return None  # 粉專自身送出的訊息回聲,略過
    sender_id = (event.get("sender") or {}).get("id")
    if not sender_id:
        return None

    content_type = "text"
    text = message.get("text") or ""
    meta: dict[str, Any] = {
        "provider": "facebook",
        "mid": message.get("mid"),
        "sender_id": sender_id,
        "recipient_id": (event.get("recipient") or {}).get("id") or page_id,
        "page_id": page_id,
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
        display_name=None,  # Messenger webhook 不含姓名;需另呼叫 Graph 取得,本 MVP 不取
        meta=meta,
    )


def parse_facebook(payload: dict[str, Any]) -> list[NormalizedInbound]:
    """把 Messenger webhook payload 轉為一批 NormalizedInbound(external_id=sender.id)。

    僅取 ``entry[].messaging[]`` 內的 ``message`` 事件;echo / 遞送回報略過。
    """
    results: list[NormalizedInbound] = []
    if not isinstance(payload, dict):
        return results
    for entry in payload.get("entry") or []:
        page_id = entry.get("id")
        for event in entry.get("messaging") or []:
            inbound = _parse_fb_event(event, page_id)
            if inbound is not None:
                results.append(inbound)
    return results
