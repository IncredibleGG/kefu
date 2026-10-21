"""Telegram webhook update 歸一化與安全驗證。

職責:
- verify_secret:比對 `X-Telegram-Bot-Api-Secret-Token` 標頭與存放的 secret(恆定時間比較)。
- parse_update:把 Telegram update dict 轉成渠道無關的 NormalizedInbound。
- should_ignore_update:依渠道設定過濾群組/頻道訊息、機器人自身訊息等。

只處理 message / edited_message / channel_post;其餘 update 型別(callback_query…)
於本 MVP 略過。
"""
from __future__ import annotations

import hmac
from dataclasses import dataclass, field
from typing import Any


@dataclass
class NormalizedInbound:
    """渠道歸一化後的入站訊息(web / telegram / email 共用同一形狀)。"""

    external_id: str  # 訪客在該渠道的識別;telegram=chat_id(回覆時當 chat_id 用)
    text: str
    content_type: str = "text"  # text | image | file ...
    display_name: str | None = None
    avatar_url: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


def verify_secret(expected: str | None, received: str | None) -> bool:
    """驗證 webhook secret_token。

    - 若渠道未設定 secret(expected 為空),為安全預設**拒絕**(必須設 secret)。
    - 使用 hmac.compare_digest 做恆定時間比較,避免時序側信道。
    """
    if not expected:
        return False
    if not received:
        return False
    # encode 成 bytes:received 來自公開端點的 X-Telegram-Bot-Api-Secret-Token 標頭
    # (攻擊者可控),非 ASCII 值直接比 str 會拋 TypeError → 未認證端點 500。
    return hmac.compare_digest(str(expected).encode("utf-8"), str(received).encode("utf-8"))


def _display_name(from_user: dict[str, Any]) -> str | None:
    parts = [from_user.get("first_name"), from_user.get("last_name")]
    name = " ".join(p for p in parts if p).strip()
    if name:
        return name
    return from_user.get("username")


def _extract_message(update: dict[str, Any]) -> dict[str, Any] | None:
    """取出承載訊息的節點;支援一般訊息、編輯訊息、頻道貼文。"""
    for key in ("message", "edited_message", "channel_post", "edited_channel_post"):
        node = update.get(key)
        if node:
            return node
    return None


def should_ignore_update(update: dict[str, Any], *, allow_groups: bool = False) -> bool:
    """是否應忽略此 update。

    忽略條件:
    - 沒有可解析的訊息節點(例如 callback_query)。
    - 機器人自身送出的訊息(from.is_bot=True)。
    - 群組/超級群組/頻道訊息,且渠道未開啟 allow_groups。
    """
    message = _extract_message(update)
    if not message:
        return True
    from_user = message.get("from") or {}
    if from_user.get("is_bot"):
        return True
    chat_type = (message.get("chat") or {}).get("type", "private")
    return chat_type in ("group", "supergroup", "channel") and not allow_groups


def parse_update(update: dict[str, Any]) -> NormalizedInbound | None:
    """把 Telegram update 轉為 NormalizedInbound;無法解析則回 None。"""
    message = _extract_message(update)
    if not message:
        return None

    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    if chat_id is None:
        return None
    from_user = message.get("from") or {}

    text = message.get("text") or message.get("caption") or ""
    content_type = "text"

    meta: dict[str, Any] = {
        "provider": "telegram",
        "update_id": update.get("update_id"),
        "message_id": message.get("message_id"),
        "chat_id": chat_id,
        "chat_type": chat.get("type"),
        "from_user_id": from_user.get("id"),
        "username": from_user.get("username"),
    }

    # 圖片:取最大尺寸的 file_id
    photos = message.get("photo")
    if photos:
        largest = max(photos, key=lambda p: p.get("file_size", 0) or 0)
        content_type = "image"
        meta["file_id"] = largest.get("file_id")
        if not text:
            text = "[image]"

    # 文件 / 其他附件僅記錄 file_id,內容以佔位字串表示
    document = message.get("document")
    if document:
        content_type = "file"
        meta["file_id"] = document.get("file_id")
        meta["file_name"] = document.get("file_name")
        if not text:
            text = document.get("file_name") or "[file]"

    return NormalizedInbound(
        external_id=str(chat_id),
        text=text,
        content_type=content_type,
        display_name=_display_name(from_user),
        meta=meta,
    )
