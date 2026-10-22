"""M5 channel — 渠道歸一化服務層(seam 擁有者)。

本檔提供兩個方向的核心能力:
1. 出站 seam `send_to_visitor`:dispatch/坐席台呼叫,依 session→channel.type 選 adapter
   把訊息送回訪客(web=no-op,widget 由 add_message 的 message.new 收到;telegram=Bot API sendMessage)。
2. 入站標準流程 `ingest_inbound`:webhook / widget 收到訪客訊息後的歸一化管線
   (get_or_create_visitor → get_or_open_session → add_message → dispatch.handle_inbound)。

跨模組一律走 3.5 節 seam,且以 try/except 優雅降級——他模組尚未完成時,本模組
仍能存訊息、不會整條崩潰。所有 DB 查詢一律以 tenant_id 過濾。
"""
from __future__ import annotations

import importlib
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import crypto
from app.models.conversation import Channel, Message, Session
from app.models.visitor import Visitor
from app.services.apple_client import AppleClient, AppleError
from app.services.meta import FacebookClient, MetaError, WhatsAppClient
from app.services.meta.graph import GRAPH_API_ROOT, GRAPH_API_VERSION, graph_post
from app.services.sms_client import TwilioClient, TwilioError
from app.services.telegram import NormalizedInbound, TelegramClient, TelegramError

logger = logging.getLogger("kefu.channel")

# 渠道型別常數
CHANNEL_WEB = "web"
CHANNEL_TELEGRAM = "telegram"
CHANNEL_EMAIL = "email"
CHANNEL_WHATSAPP = "whatsapp"
CHANNEL_FACEBOOK = "facebook"
# 新增渠道:SMS(Twilio)、Instagram DM、Apple Messages for Business。
CHANNEL_SMS = "sms"
CHANNEL_INSTAGRAM = "instagram"
CHANNEL_APPLE = "apple"

# 遮罩後仍可辨識的頂層敏感欄位(回傳給前端時套用)
# telegram:bot_token / webhook_secret;meta:access_token / page_access_token /
# app_secret / verify_token(phone_number_id / page_id 為識別碼,不遮罩)。
# 新增:sms(twilio)auth_token、apple(MfB)secret(account_sid / from_number /
# business_id / msp_endpoint 為識別碼 / 端點,不遮罩)。instagram 沿用 meta 的
# page_access_token / verify_token / app_secret,已含於下。
_SECRET_CONFIG_KEYS = (
    "bot_token",
    "webhook_secret",
    "access_token",
    "page_access_token",
    "app_secret",
    "verify_token",
    "auth_token",
    "secret",
)
# email 渠道的巢狀密碼欄位:config[<section>][<key>]
_EMAIL_SECRET_SECTIONS = ("imap", "smtp")
_EMAIL_SECRET_KEYS = ("pass", "password")

# email 找不到原主旨時的預設回覆主旨(亦可由 smtp config.reply_subject 覆寫)
_DEFAULT_REPLY_SUBJECT = "客服回覆"


# --------------------------------------------------------------------------- #
# seam 解析:延遲匯入他模組,未實作時回 None 讓呼叫端降級
# --------------------------------------------------------------------------- #
def _resolve_seam(module_path: str, attr: str) -> Callable[..., Any] | None:
    """延遲載入他模組 seam 函式;不存在則回 None(呼叫端須降級)。"""
    try:
        module = importlib.import_module(module_path)
    except ImportError:
        logger.warning("seam 模組尚未就緒:%s", module_path)
        return None
    fn = getattr(module, attr, None)
    if fn is None:
        logger.warning("seam 函式尚未就緒:%s.%s", module_path, attr)
    return fn


# --------------------------------------------------------------------------- #
# 安全:secret 遮罩
# --------------------------------------------------------------------------- #
def mask_secret(value: str | None) -> str | None:
    """遮罩敏感字串,只露頭尾便於辨識(bot_token 等一律經此再回傳)。"""
    if not value:
        return value
    if len(value) <= 8:
        return "****"
    return f"{value[:4]}…{value[-4:]}"


def _mask_value(raw: Any) -> Any:
    """先解密(靜態加密的 ``enc::`` 值 → 明文;舊明文原樣回傳)再遮罩尾4碼。

    確保 API 回應「既不外露密文(``enc::…``)也不外露明文」——遮罩的是解密後的
    真實密鑰尾碼,前端才能以尾4碼辨識而不觸及明文。
    """
    plain = crypto.decrypt(raw) if isinstance(raw, str) else raw
    if plain is None:
        return None
    return mask_secret(str(plain))


def mask_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """回傳遮罩過敏感欄位的 config 複本,供 API 回應使用。

    - 頂層敏感欄位(bot_token / webhook_secret / meta token 等):先解密再遮罩。
    - 巢狀 imap.pass / smtp.pass:email 用(深複製該子區,避免改到原 config)。
    - 值可能為靜態加密(``enc::``)或舊明文,一律先 decrypt 再遮罩尾4碼,
      故回應永遠不含 ``enc::`` 前綴,也不含完整明文。
    """
    if not config:
        return {}
    masked = dict(config)
    for key in _SECRET_CONFIG_KEYS:
        if key in masked:
            masked[key] = _mask_value(masked[key])
    for section in _EMAIL_SECRET_SECTIONS:
        sub = masked.get(section)
        if isinstance(sub, dict):
            sub_copy = dict(sub)
            for key in _EMAIL_SECRET_KEYS:
                if sub_copy.get(key):
                    sub_copy[key] = _mask_value(sub_copy[key])
            masked[section] = sub_copy
    return masked


# --------------------------------------------------------------------------- #
# 富訊息卡片(card):跨渠道原生渲染共用工具
#
# 卡片契約(既有):meta.card = {
#     title?, text?, image_url?,
#     buttons: [ {label, url? | reply?} ]   # url=外連;reply=快捷回覆文字
# }
# 目標:讓 telegram/whatsapp/facebook 以各自「原生互動元件」呈現卡片與按鈕,
# 對齊 web widget;任一渠道遇 meta 缺 card / 無合法按鈕 / 送出失敗,一律降級為
# 純文字(與現況一致,零回歸)。所有連結一律 http(s) 白名單。
# --------------------------------------------------------------------------- #
def _card_from_meta(meta: dict[str, Any] | None) -> dict[str, Any] | None:
    """從 message.meta 取出 card 物件;結構不符則回 None(呼叫端降級純文字)。"""
    if not isinstance(meta, dict):
        return None
    card = meta.get("card")
    return card if isinstance(card, dict) else None


def _safe_url(url: Any) -> str | None:
    """URL http(s) 白名單:僅放行 http/https,其餘(javascript:/tel:/空值…)回 None。"""
    if not isinstance(url, str) or not url.strip():
        return None
    candidate = url.strip()
    try:
        scheme = urlsplit(candidate).scheme.lower()
    except ValueError:
        return None
    return candidate if scheme in ("http", "https") else None


def _card_buttons(card: dict[str, Any]) -> list[dict[str, Any]]:
    """回傳 card.buttons 中的合法 dict 元素(非 list / 非 dict 元素一律略過)。"""
    buttons = card.get("buttons")
    if not isinstance(buttons, list):
        return []
    return [b for b in buttons if isinstance(b, dict)]


def _classify_buttons(
    card: dict[str, Any],
) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """把卡片按鈕分成 (url 鈕, reply 鈕),各為 (label, value) 串列。

    - 有合法 http(s) url → url 鈕(url 優先於 reply)。
    - 否則有非空 reply 字串 → reply 鈕(快捷回覆)。
    - 無 label、或 url 非法且無 reply → 略過(不渲染該鈕)。
    """
    url_btns: list[tuple[str, str]] = []
    reply_btns: list[tuple[str, str]] = []
    for b in _card_buttons(card):
        label = str(b.get("label") or "").strip()
        if not label:
            continue
        url = _safe_url(b.get("url"))
        if url:
            url_btns.append((label, url))
            continue
        reply = b.get("reply")
        if isinstance(reply, str) and reply.strip():
            reply_btns.append((label, reply.strip()))
    return url_btns, reply_btns


def _truncate(value: Any, limit: int) -> str:
    """字元數截斷(超長補「…」);用於各渠道 title/label/body 的長度上限。"""
    text = str(value)
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"


def _card_body_text(card: dict[str, Any], default_text: str = "") -> str:
    """卡片主體純文字(title + text);供「按鈕原生呈現」的渠道當訊息本文。

    不含按鈕(按鈕由原生元件呈現);皆空時退回 default_text。
    """
    parts = [
        str(card.get("title") or "").strip(),
        str(card.get("text") or "").strip(),
    ]
    body = "\n".join(p for p in parts if p).strip()
    return body or (default_text or "")


def _card_fallback_text(card: dict[str, Any], default_text: str = "") -> str:
    """卡片完全降級為純文字時的內容:title + text + 連結 + 可回覆選項。

    用於「無法原生呈現按鈕」或「原生送出失敗」的保底,盡量不遺失資訊:
    - url 鈕 → 「label:url」;reply 鈕 → 「• label」(純文字渠道下 label 即回覆提示)。
    """
    url_btns, reply_btns = _classify_buttons(card)
    lines = [
        str(card.get("title") or "").strip(),
        str(card.get("text") or "").strip(),
    ]
    lines = [ln for ln in lines if ln]
    tail = [f"{lbl}:{url}" if lbl else url for lbl, url in url_btns]
    tail += [f"• {lbl}" for lbl, _ in reply_btns]
    if tail:
        if lines:
            lines.append("")
        lines.extend(tail)
    return "\n".join(lines).strip() or (default_text or "")


# --- Telegram inline keyboard ------------------------------------------------ #
_TELEGRAM_CALLBACK_MAX = 64  # callback_data 上限(bytes);超過則不放進鍵盤


def _build_telegram_keyboard(
    card: dict[str, Any],
) -> tuple[list[list[dict[str, Any]]] | None, list[tuple[str, str]]]:
    """由 card.buttons 建 Telegram inline_keyboard(每鈕自成一列)。

    回傳 (inline_keyboard 或 None, overflow):
    - url 鈕 → {"text": label, "url": url}(url 已過 http(s) 白名單)。
    - reply 鈕 → {"text": label, "callback_data": reply};callback_data 有 64 byte
      限制,超長者不放進鍵盤,改列入 overflow 由呼叫端在文字中以編號呈現。
    - 無合法按鈕 → (None, overflow)。
    """
    url_btns, reply_btns = _classify_buttons(card)
    rows: list[list[dict[str, Any]]] = []
    overflow: list[tuple[str, str]] = []
    for label, url in url_btns:
        rows.append([{"text": label, "url": url}])
    for label, reply in reply_btns:
        if len(reply.encode("utf-8")) <= _TELEGRAM_CALLBACK_MAX:
            rows.append([{"text": label, "callback_data": reply}])
        else:
            overflow.append((label, reply))
    return (rows or None), overflow


# --- WhatsApp Cloud API interactive ------------------------------------------ #
# Cloud API 互動訊息限制(官方公告值):
#   - body 文字 <= 1024;header text <= 60。
#   - reply button:最多 3 顆,title <= 20、id <= 256。
#   - list:單訊息最多 10 列(此處放單一 section),row title <= 24、id <= 200。
#   - interactive button 型「不支援 url 鈕」;url 只能用 cta_url(單一)或放進 body 文字。
_WA_BODY_MAX = 1024
_WA_HEADER_TEXT_MAX = 60
_WA_BTN_TITLE_MAX = 20
_WA_BTN_ID_MAX = 256
_WA_LIST_ROW_TITLE_MAX = 24
_WA_LIST_ROW_ID_MAX = 200
_WA_REPLY_BTN_MAX = 3
_WA_LIST_ROW_MAX = 10


def _build_whatsapp_interactive(card: dict[str, Any]) -> dict[str, Any] | None:
    """由 card 建 WhatsApp interactive 物件;無法原生呈現則回 None(呼叫端純文字保底)。

    取捨(受 Cloud API 限制):
    - 有 reply 鈕:<=3 用 `button`、>3 用 `list`;url 鈕無法與 reply 併存於同一互動,
      故一律附進 body 文字。
    - 純 url 鈕:恰 1 顆用 `cta_url`;多顆無法一次帶多個 url 鈕 → 回 None,改純文字
      (連結已由 _card_fallback_text 併入)。
    - 有圖:放 header image;否則 title 放 header text。
    """
    url_btns, reply_btns = _classify_buttons(card)
    title = str(card.get("title") or "").strip()
    body_core = str(card.get("text") or "").strip()
    image_url = _safe_url(card.get("image_url"))

    header: dict[str, Any] | None = None
    if image_url:
        header = {"type": "image", "image": {"link": image_url}}
    elif title:
        header = {"type": "text", "text": _truncate(title, _WA_HEADER_TEXT_MAX)}

    body_lines: list[str] = []
    if image_url and title:  # 有圖時 title 進不了 text header,改併入 body
        body_lines.append(title)
    if body_core:
        body_lines.append(body_core)

    def _finish(
        itype: str, action: dict[str, Any], extra_lines: list[str] | None = None
    ) -> dict[str, Any]:
        lines = [ln for ln in body_lines + (extra_lines or []) if ln]
        body_text = _truncate("\n".join(lines).strip() or title or "詳情", _WA_BODY_MAX)
        interactive: dict[str, Any] = {"type": itype, "body": {"text": body_text}, "action": action}
        if header is not None:
            interactive["header"] = header
        return interactive

    if reply_btns:
        url_lines = [f"{lbl}:{url}" for lbl, url in url_btns]
        if len(reply_btns) <= _WA_REPLY_BTN_MAX:
            buttons = [
                {
                    "type": "reply",
                    "reply": {
                        "id": _truncate(reply, _WA_BTN_ID_MAX),
                        "title": _truncate(label, _WA_BTN_TITLE_MAX),
                    },
                }
                for label, reply in reply_btns[:_WA_REPLY_BTN_MAX]
            ]
            return _finish("button", {"buttons": buttons}, url_lines)
        rows = [
            {
                "id": _truncate(reply, _WA_LIST_ROW_ID_MAX),
                "title": _truncate(label, _WA_LIST_ROW_TITLE_MAX),
            }
            for label, reply in reply_btns[:_WA_LIST_ROW_MAX]
        ]
        action = {
            "button": _truncate(title or "選項", _WA_BTN_TITLE_MAX),
            "sections": [{"title": _truncate(title or "請選擇", _WA_LIST_ROW_TITLE_MAX), "rows": rows}],
        }
        return _finish("list", action, url_lines)

    if len(url_btns) == 1:
        label, url = url_btns[0]
        action = {
            "name": "cta_url",
            "parameters": {"display_text": _truncate(label or "開啟", _WA_BTN_TITLE_MAX), "url": url},
        }
        return _finish("cta_url", action)

    # 無 reply 鈕、且 url 鈕 0 或 >1:無法原生互動,交由純文字保底。
    return None


# --- Facebook Messenger 模板 -------------------------------------------------- #
# button template:text <= 640、最多 3 顆按鈕(web_url / postback)。
# generic template:含圖片;element title <= 80、subtitle <= 80、最多 3 顆按鈕。
_FB_BTN_TITLE_MAX = 20
_FB_BTN_PAYLOAD_MAX = 1000
_FB_BTN_MAX = 3
_FB_TEXT_MAX = 640
_FB_TITLE_MAX = 80
_FB_SUBTITLE_MAX = 80


def _build_facebook_buttons(card: dict[str, Any]) -> list[dict[str, Any]]:
    """卡片按鈕 → Messenger 按鈕(url→web_url、reply→postback),最多 3 顆。"""
    url_btns, reply_btns = _classify_buttons(card)
    buttons: list[dict[str, Any]] = [
        {"type": "web_url", "title": _truncate(label, _FB_BTN_TITLE_MAX), "url": url}
        for label, url in url_btns
    ]
    buttons += [
        {"type": "postback", "title": _truncate(label, _FB_BTN_TITLE_MAX),
         "payload": _truncate(reply, _FB_BTN_PAYLOAD_MAX)}
        for label, reply in reply_btns
    ]
    return buttons[:_FB_BTN_MAX]


def _build_facebook_message(card: dict[str, Any]) -> dict[str, Any] | None:
    """由 card 建 Messenger message 物件(button / generic 模板);無合法按鈕則回 None。"""
    buttons = _build_facebook_buttons(card)
    if not buttons:
        return None
    title = str(card.get("title") or "").strip()
    body_core = str(card.get("text") or "").strip()
    image_url = _safe_url(card.get("image_url"))
    if image_url:
        # 有圖 → generic template(button template 不支援圖片)。
        element: dict[str, Any] = {
            "title": _truncate(title or body_core or "詳情", _FB_TITLE_MAX),
            "image_url": image_url,
            "buttons": buttons,
        }
        if title and body_core:
            element["subtitle"] = _truncate(body_core, _FB_SUBTITLE_MAX)
        return {
            "attachment": {
                "type": "template",
                "payload": {"template_type": "generic", "elements": [element]},
            }
        }
    text = "\n".join(p for p in (title, body_core) if p).strip() or "請選擇"
    return {
        "attachment": {
            "type": "template",
            "payload": {
                "template_type": "button",
                "text": _truncate(text, _FB_TEXT_MAX),
                "buttons": buttons,
            },
        }
    }


# --------------------------------------------------------------------------- #
# 出站:send_to_visitor
# --------------------------------------------------------------------------- #
@dataclass
class _DeliveryContext:
    channel_type: str
    channel_config: dict[str, Any]
    external_id: str | None


async def _load_delivery_context(
    db: AsyncSession, tenant_id: uuid.UUID, session_id: uuid.UUID
) -> _DeliveryContext | None:
    """載入送出訊息所需的 session→channel→visitor 脈絡(tenant 過濾)。

    抽成獨立函式,便於測試以 monkeypatch 取代 DB。
    """
    session = (
        await db.execute(
            select(Session).where(Session.id == session_id, Session.tenant_id == tenant_id)
        )
    ).scalar_one_or_none()
    if session is None:
        return None

    channel = (
        await db.execute(
            select(Channel).where(
                Channel.id == session.channel_id, Channel.tenant_id == tenant_id
            )
        )
    ).scalar_one_or_none()
    if channel is None:
        return None

    visitor = (
        await db.execute(
            select(Visitor).where(
                Visitor.id == session.visitor_id, Visitor.tenant_id == tenant_id
            )
        )
    ).scalar_one_or_none()

    return _DeliveryContext(
        channel_type=channel.type,
        channel_config=channel.config or {},
        external_id=visitor.external_id if visitor else None,
    )


async def _resolve_outbound_card(
    db: AsyncSession | None,
    tenant_id: uuid.UUID,
    session_id: uuid.UUID,
    content_type: str,
    meta: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """解析要原生渲染的卡片:content_type=="card" 才處理,否則一律回 None。

    優先用呼叫端傳入的 meta.card;若未傳(現行 dispatch/坐席台/自動化的送訊路徑
    皆在本檔不可改的模組中,尚未把 meta 帶進來),退而從 DB 取本會話最近一則 card
    訊息的 meta 補上。任何查詢失敗都降級回 None(→ 純文字保底)。
    """
    if content_type != "card":
        return None
    card = _card_from_meta(meta)
    if card is not None or db is None:
        return card
    try:
        row = (
            await db.execute(
                select(Message)
                .where(
                    Message.session_id == session_id,
                    Message.tenant_id == tenant_id,
                    Message.content_type == "card",
                )
                .order_by(Message.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
    except Exception:  # 卡片補水是加值,查詢失敗一律降級純文字
        logger.warning("載入出站卡片 meta 失敗,降級純文字(session=%s)", session_id, exc_info=True)
        return None
    if row is not None and isinstance(row.meta, dict):
        return _card_from_meta(row.meta)
    return None


async def send_to_visitor(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    session_id: uuid.UUID,
    text: str,
    content_type: str = "text",
    meta: dict[str, Any] | None = None,
) -> None:
    """把訊息送回訪客(3.5 出站 seam)。

    依 session→channel.type 選 adapter:
    - web:no-op(add_message 的 message.new 已推 widget;此處不重發)。
    - telegram:Bot API sendMessage/sendPhoto;card 時帶 inline_keyboard 原生互動。
    - whatsapp:Cloud API;card 時用 interactive(button/list/cta_url)。
    - facebook:Messenger Send API;card 時用 button/generic 模板。
    - instagram:Graph me/messages(複用 Meta 基礎設施);card 時用 button/generic 模板。
    - sms:Twilio Messages API 純文字;card 一律降級純文字(SMS 無富訊息)。
    - apple:MfB(需 MSP)出站框架;未設 MSP 端點 / 憑證則 no-op(僅 log)。
    - email:SMTP 純文字。
    card 契約見本檔「富訊息卡片」段;meta 未帶時由 _resolve_outbound_card 從 DB 補。
    任一 adapter 失敗只記錄,不向上拋(避免拖垮 dispatch);card 送出失敗降級純文字。
    """
    ctx = await _load_delivery_context(db, tenant_id, session_id)
    if ctx is None:
        logger.warning("send_to_visitor:找不到 session=%s(tenant=%s)", session_id, tenant_id)
        return

    card = await _resolve_outbound_card(db, tenant_id, session_id, content_type, meta)

    if ctx.channel_type == CHANNEL_WEB:
        await _send_web(tenant_id, session_id, text, content_type)
    elif ctx.channel_type == CHANNEL_TELEGRAM:
        await _send_telegram(ctx, text, content_type, card=card)
    elif ctx.channel_type == CHANNEL_WHATSAPP:
        await _send_whatsapp(ctx, text, content_type, card=card)
    elif ctx.channel_type == CHANNEL_FACEBOOK:
        await _send_facebook(ctx, text, content_type, card=card)
    elif ctx.channel_type == CHANNEL_INSTAGRAM:
        await _send_instagram(ctx, text, content_type, card=card)
    elif ctx.channel_type == CHANNEL_SMS:
        await _send_sms(ctx, text, content_type, card=card)
    elif ctx.channel_type == CHANNEL_APPLE:
        await _send_apple(ctx, text, content_type, card=card)
    elif ctx.channel_type == CHANNEL_EMAIL:
        await _send_email(db, tenant_id, session_id, ctx, text)
    else:
        logger.warning("send_to_visitor:未知渠道型別 %s", ctx.channel_type)


async def _send_web(
    tenant_id: uuid.UUID, session_id: uuid.UUID, text: str, content_type: str
) -> None:
    """web widget 出站:no-op。

    web 訊息實際透過 M3 add_message 於落庫時發佈的 ``message.new`` 事件送達
    /ws/widget(同一會話頻道)。此處若再自行 publish 會造成 widget 收到重複訊息,
    故不重發。telegram/email 等「外部傳輸」才需要在 send_to_visitor 真正送出。
    """
    return


async def _send_telegram_card(
    client: TelegramClient, chat_id: str, text: str, card: dict[str, Any]
) -> None:
    """telegram card:sendMessage/sendPhoto 帶 reply_markup.inline_keyboard。

    - url 鈕 → {text,url};reply 鈕 → {text,callback_data}(64 byte 內)。
    - callback_data 超長的 reply 鈕改在文字內以編號列出(Telegram 限制)。
    - 有圖:sendPhoto 帶 caption+鍵盤(caption<=1024);caption 過長則圖片不帶說明、
      另發一則帶本文的訊息。無合法按鈕時 keyboard=None,退化為純文字/圖片。
    直接用 TelegramClient._call 送出(公開 send_message/send_photo 未開放 reply_markup;
    本檔不可改 client)。_call 會濾除 None 欄位、拆封信封並在 ok=false 時拋 TelegramError。
    """
    keyboard, overflow = _build_telegram_keyboard(card)
    body = _card_body_text(card, text)
    if overflow:
        extra = "\n".join(
            f"{i}. {lbl}:{_truncate(reply, 120)}" for i, (lbl, reply) in enumerate(overflow, 1)
        )
        body = f"{body}\n\n{extra}".strip() if body else extra
    reply_markup = {"inline_keyboard": keyboard} if keyboard else None
    image_url = _safe_url(card.get("image_url"))
    if image_url:
        caption = body if body and len(body) <= 1024 else None
        await client._call(
            "sendPhoto",
            chat_id=chat_id,
            photo=image_url,
            caption=caption,
            reply_markup=reply_markup,
        )
        if caption is None and body:  # caption 過長:鍵盤已附在圖片上,本文另發一則
            await client._call("sendMessage", chat_id=chat_id, text=_truncate(body, 4096))
        return
    await client._call(
        "sendMessage",
        chat_id=chat_id,
        text=_truncate(body or text or " ", 4096),
        reply_markup=reply_markup,
    )


async def _send_telegram(
    ctx: _DeliveryContext, text: str, content_type: str, card: dict[str, Any] | None = None
) -> None:
    """telegram:呼叫 Bot API sendMessage/sendPhoto;card 時帶 inline_keyboard。"""
    # bot_token 於 DB 靜態加密(enc::),送出前解密;舊明文 decrypt 原樣回傳。
    token = crypto.decrypt(ctx.channel_config.get("bot_token"))
    if not token or not ctx.external_id:
        logger.warning("telegram 送出缺少 bot_token 或 chat_id,略過")
        return
    try:
        client = TelegramClient(token)
        if content_type == "card" and card is not None:
            await _send_telegram_card(client, ctx.external_id, text, card)
        elif content_type == "image":
            await client.send_photo(ctx.external_id, text)
        else:
            await client.send_message(ctx.external_id, text)
    except (TelegramError, ValueError):
        logger.exception("telegram 送出失敗(chat_id=%s)", ctx.external_id)


async def _send_whatsapp(
    ctx: _DeliveryContext, text: str, content_type: str, card: dict[str, Any] | None = None
) -> None:
    """whatsapp:呼叫 WhatsApp Cloud API messages 端點。

    - 非 card / 無 card:傳純文字(維持原行為)。
    - card:用 interactive(button/list/cta_url,見 _build_whatsapp_interactive);
      無法原生呈現或送出失敗一律降級純文字保底。
    缺 phone_number_id / access_token / 收件 wa_id 一律略過;任何失敗只 log 不拋。
    """
    cfg = ctx.channel_config or {}
    phone_number_id = cfg.get("phone_number_id")
    # access_token 於 DB 靜態加密,送出前解密後才交給外部 client。
    access_token = crypto.decrypt(cfg.get("access_token"))
    if not phone_number_id or not access_token or not ctx.external_id:
        logger.warning("whatsapp 送出缺少 phone_number_id / access_token / wa_id,略過")
        return
    try:
        client = WhatsAppClient(phone_number_id, access_token)
    except ValueError:
        logger.exception("whatsapp client 建立失敗(wa_id=%s)", ctx.external_id)
        return

    async def _send_plain(body: str) -> None:
        try:
            await client.send_text(ctx.external_id, body)
        except (MetaError, ValueError):
            logger.exception("whatsapp 送出失敗(wa_id=%s)", ctx.external_id)

    if content_type != "card" or card is None:
        await _send_plain(text)
        return

    interactive = _build_whatsapp_interactive(card)
    if interactive is None:  # 無法原生互動 → 純文字保底(連結已併入)
        await _send_plain(_card_fallback_text(card, text))
        return
    url = f"{GRAPH_API_ROOT}/{GRAPH_API_VERSION}/{phone_number_id}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": str(ctx.external_id),
        "type": "interactive",
        "interactive": interactive,
    }
    try:
        await graph_post(
            url,
            json_body=payload,
            headers={"Authorization": f"Bearer {access_token}"},
        )
    except (MetaError, ValueError):
        logger.exception("whatsapp 互動訊息送出失敗,降級純文字(wa_id=%s)", ctx.external_id)
        await _send_plain(_card_fallback_text(card, text))


async def _send_facebook(
    ctx: _DeliveryContext, text: str, content_type: str, card: dict[str, Any] | None = None
) -> None:
    """facebook:呼叫 Messenger Send API me/messages 送給 sender PSID。

    - 非 card / 無 card:傳純文字(維持原行為)。
    - card:用 button/generic 模板(web_url/postback,見 _build_facebook_message);
      無合法按鈕或送出失敗一律降級純文字保底。
    缺 page_access_token / 收件 PSID 一律略過;任何失敗只 log 不拋。
    """
    cfg = ctx.channel_config or {}
    # page_access_token 於 DB 靜態加密,送出前解密後才交給外部 client。
    page_access_token = crypto.decrypt(cfg.get("page_access_token"))
    if not page_access_token or not ctx.external_id:
        logger.warning("facebook 送出缺少 page_access_token / PSID,略過")
        return
    try:
        client = FacebookClient(page_access_token)
    except ValueError:
        logger.exception("facebook client 建立失敗(PSID=%s)", ctx.external_id)
        return

    async def _send_plain(body: str) -> None:
        try:
            await client.send_text(ctx.external_id, body)
        except (MetaError, ValueError):
            logger.exception("facebook 送出失敗(PSID=%s)", ctx.external_id)

    if content_type != "card" or card is None:
        await _send_plain(text)
        return

    message = _build_facebook_message(card)
    if message is None:  # 無合法按鈕 → 純文字保底
        await _send_plain(_card_fallback_text(card, text))
        return
    url = f"{GRAPH_API_ROOT}/{GRAPH_API_VERSION}/me/messages"
    payload = {
        "recipient": {"id": str(ctx.external_id)},
        "messaging_type": "RESPONSE",
        "message": message,
    }
    try:
        await graph_post(
            url,
            json_body=payload,
            headers={"Authorization": f"Bearer {page_access_token}"},
        )
    except (MetaError, ValueError):
        logger.exception("facebook 卡片送出失敗,降級純文字(PSID=%s)", ctx.external_id)
        await _send_plain(_card_fallback_text(card, text))


async def _send_instagram(
    ctx: _DeliveryContext, text: str, content_type: str, card: dict[str, Any] | None = None
) -> None:
    """instagram:複用 Meta 基礎設施,呼叫 Graph ``me/messages`` 送給 IGSID。

    Instagram Messaging 與 Messenger 同走 Graph Send API(``POST /me/messages``,以
    page_access_token 認證,recipient.id = IGSID),故沿用 FacebookClient 與
    _build_facebook_message:
    - 非 card / 無 card:傳純文字(維持與 facebook 一致的行為)。
    - card:用 button/generic 模板;無合法按鈕或送出失敗一律降級純文字保底
      (IG 對模板支援較嚴,故任何 Graph 錯誤都會安全降級)。
    缺 page_access_token / 收件 IGSID 一律略過;任何失敗只 log 不拋。
    """
    cfg = ctx.channel_config or {}
    # page_access_token 於 DB 靜態加密,送出前解密後才交給外部 client。
    page_access_token = crypto.decrypt(cfg.get("page_access_token"))
    if not page_access_token or not ctx.external_id:
        logger.warning("instagram 送出缺少 page_access_token / IGSID,略過")
        return
    try:
        client = FacebookClient(page_access_token)
    except ValueError:
        logger.exception("instagram client 建立失敗(IGSID=%s)", ctx.external_id)
        return

    async def _send_plain(body: str) -> None:
        try:
            await client.send_text(ctx.external_id, body)
        except (MetaError, ValueError):
            logger.exception("instagram 送出失敗(IGSID=%s)", ctx.external_id)

    if content_type != "card" or card is None:
        await _send_plain(text)
        return

    message = _build_facebook_message(card)
    if message is None:  # 無合法按鈕 → 純文字保底
        await _send_plain(_card_fallback_text(card, text))
        return
    url = f"{GRAPH_API_ROOT}/{GRAPH_API_VERSION}/me/messages"
    payload = {
        "recipient": {"id": str(ctx.external_id)},
        "messaging_type": "RESPONSE",
        "message": message,
    }
    try:
        await graph_post(
            url,
            json_body=payload,
            headers={"Authorization": f"Bearer {page_access_token}"},
        )
    except (MetaError, ValueError):
        logger.exception("instagram 卡片送出失敗,降級純文字(IGSID=%s)", ctx.external_id)
        await _send_plain(_card_fallback_text(card, text))


async def _send_sms(
    ctx: _DeliveryContext, text: str, content_type: str, card: dict[str, Any] | None = None
) -> None:
    """sms:呼叫 Twilio Messages API 送純文字給收件手機號。

    SMS 無富訊息:card 一律降級為純文字(_card_fallback_text,盡量保留連結 / 選項)。
    缺 account_sid / auth_token / from_number / 收件號碼一律略過(降級);任何失敗只 log 不拋。
    """
    cfg = ctx.channel_config or {}
    account_sid = cfg.get("account_sid")
    # auth_token 於 DB 靜態加密,送出前解密後才交給外部 client。
    auth_token = crypto.decrypt(cfg.get("auth_token"))
    from_number = cfg.get("from_number")
    if not account_sid or not auth_token or not from_number or not ctx.external_id:
        logger.warning("sms 送出缺少 account_sid / auth_token / from_number / 收件號碼,略過")
        return
    # card → 純文字降級(SMS 無按鈕 / 圖片 / 模板)
    body = (
        _card_fallback_text(card, text)
        if (content_type == "card" and card is not None)
        else text
    )
    try:
        client = TwilioClient(account_sid, auth_token)
    except ValueError:
        logger.exception("twilio client 建立失敗(to=%s)", ctx.external_id)
        return
    try:
        await client.send_message(from_number, ctx.external_id, body)
    except (TwilioError, ValueError):
        logger.exception("sms 送出失敗(to=%s)", ctx.external_id)


async def _send_apple(
    ctx: _DeliveryContext, text: str, content_type: str, card: dict[str, Any] | None = None
) -> None:
    """apple:Apple Messages for Business 出站(code-ready 框架)。

    真正送達需 Apple 商務註冊 + MSP 端點 + 憑證。未設 msp_endpoint / business_id /
    secret 時直接 no-op(僅記 log),不建構 client、不拋。已設定則組 MfB 文字 payload
    POST 給 MSP。card 一律降級純文字(富訊息需 MSP 端支援,本框架不組)。
    任何失敗只 log 不拋。
    """
    cfg = ctx.channel_config or {}
    msp_endpoint = cfg.get("msp_endpoint")
    business_id = cfg.get("business_id")
    # secret 於 DB 靜態加密,取用前解密。
    secret = crypto.decrypt(cfg.get("secret"))
    if not ctx.external_id:
        logger.warning("apple 送出缺少收件 source_id,略過")
        return
    body = (
        _card_fallback_text(card, text)
        if (content_type == "card" and card is not None)
        else text
    )
    # code-ready:未設 MSP 端點 / 商務ID / secret → no-op(僅 log),不拋、零回歸。
    if not msp_endpoint or not business_id or not secret:
        logger.info(
            "apple 出站為 code-ready 框架:未設定 msp_endpoint / business_id / secret,"
            "no-op(to=%s)",
            ctx.external_id,
        )
        return
    try:
        client = AppleClient(msp_endpoint, business_id, secret)
        await client.send_text(ctx.external_id, body)
    except (AppleError, ValueError):
        logger.exception("apple 送出失敗(to=%s)", ctx.external_id)


async def _resolve_reply_subject(
    db: AsyncSession, tenant_id: uuid.UUID, session_id: uuid.UUID, smtp_cfg: dict[str, Any]
) -> str:
    """決定回覆主旨:取本會話最近一則訪客訊息 meta.subject → 「Re: 原主旨」。

    取不到(非 email 進站、無 subject、查詢失敗)則用 smtp config.reply_subject
    或模組預設。已是 Re: 開頭則不重複加前綴。
    """
    default = smtp_cfg.get("reply_subject") or _DEFAULT_REPLY_SUBJECT
    subject: str | None = None
    try:
        row = (
            await db.execute(
                select(Message)
                .where(
                    Message.session_id == session_id,
                    Message.tenant_id == tenant_id,
                    Message.sender_type == "visitor",
                )
                .order_by(Message.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if row is not None and isinstance(row.meta, dict):
            subject = row.meta.get("subject")
    except Exception:  # 主旨僅為加值,查詢失敗就用預設
        logger.warning("取回原主旨失敗,改用預設主旨(session=%s)", session_id, exc_info=True)
        return default

    if not subject or not str(subject).strip():
        return default
    subject = str(subject).strip()
    if subject.lower().startswith("re:"):
        return subject
    return f"Re: {subject}"


async def _send_email(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    session_id: uuid.UUID,
    ctx: _DeliveryContext,
    text: str,
) -> None:
    """email 出站:用渠道 SMTP 設定把 text 寄給 visitor.external_id(收件信箱)。

    主旨用「Re: 原主旨」(取自最近訪客訊息 meta),沒有就用預設。
    任何失敗(缺設定、連線、寄送)只記 log,不向上拋(避免拖垮 dispatch)。
    """
    smtp_cfg = (ctx.channel_config or {}).get("smtp") or {}
    to_addr = ctx.external_id
    if not smtp_cfg.get("host") or not to_addr:
        logger.warning("email 送出缺少 SMTP host 或收件者,略過(to=%s)", to_addr)
        return
    subject = await _resolve_reply_subject(db, tenant_id, session_id, smtp_cfg)
    try:
        # 延遲匯入:email 為可選子系統,避免與本模組於載入期互相牽連
        from app.services import email as email_service

        await email_service.send_email(smtp_cfg, to_addr, subject, text)
    except Exception:  # EmailError 及底層例外一律降級
        logger.exception("SMTP 寄送失敗(to=%s)", to_addr)


# --------------------------------------------------------------------------- #
# 入站翻譯:訪客原文 → 坐席語言(寫進 message.meta.i18n,content 保留原文)
# --------------------------------------------------------------------------- #
async def _translate_inbound(db: AsyncSession, session, message) -> None:
    """若會話啟用翻譯,將訪客訊息翻成坐席語言,結果寫入 ``message.meta.i18n``。

    - ``content`` 保持訪客原文(訪客端看自己原文);坐席端靠 meta.i18n 顯示譯文。
    - ``session.visitor_lang`` 未知時先偵測並寫回 session(首次訪客訊息)。
    - 僅翻譯文字類訊息;任何失敗都靜默降級,不影響訊息已落地。
    """
    try:
        if not getattr(session, "translate_enabled", False):
            return
        text = (getattr(message, "content", "") or "").strip()
        if not text or getattr(message, "content_type", "text") not in ("text", "markdown"):
            return

        from app.services import translation

        # 翻譯供應商依租戶設定(預設 google 免費端點)
        backend, backend_cfg = await translation.resolve_backend(db, session.tenant_id)

        target = getattr(session, "agent_lang", None) or "zh-Hant"
        source_lang = getattr(session, "visitor_lang", None)
        # 訪客語言未知 → 先偵測並寫回 session
        if not source_lang:
            detected = await translation.detect_lang(
                text, backend=backend, backend_config=backend_cfg
            )
            if detected and detected != "unknown":
                source_lang = detected
                session.visitor_lang = detected

        # 已與坐席語言相同則不需翻譯
        if source_lang and source_lang == target:
            return

        result = await translation.translate(
            text,
            target,
            source_lang=source_lang or None,
            backend=backend,
            backend_config=backend_cfg,
        )
        translated = result.get("text") or text
        original_lang = source_lang or result.get("source_lang") or "unknown"

        new_meta = dict(getattr(message, "meta", None) or {})
        new_meta["i18n"] = {
            "original": text,
            "translated": translated,
            "original_lang": original_lang,
            "translated_lang": target,
            "direction": "inbound",
        }
        message.meta = new_meta
        await db.flush()
    except Exception:  # 翻譯是加值層,任何失敗都降級略過
        logger.warning(
            "入站翻譯失敗,降級略過(session=%s)", getattr(session, "id", None), exc_info=True
        )


# --------------------------------------------------------------------------- #
# 入站:標準歸一化流程
# --------------------------------------------------------------------------- #
async def ingest_inbound(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    channel_id: uuid.UUID,
    inbound: NormalizedInbound,
) -> uuid.UUID | None:
    """渠道入站標準流程(3.5):web / telegram / email 共用。

    get_or_create_visitor → get_or_open_session → add_message(visitor)
    → dispatch.handle_inbound。每個跨模組 seam 皆 try/except 降級;
    dispatch 失敗不影響訊息已落地。回傳 session_id(降級時可能為 None)。
    """
    get_or_create_visitor = _resolve_seam("app.services.visitor", "get_or_create_visitor")
    get_or_open_session = _resolve_seam("app.services.conversation", "get_or_open_session")
    add_message = _resolve_seam("app.services.conversation", "add_message")
    handle_inbound = _resolve_seam("app.services.dispatch", "handle_inbound")

    if get_or_create_visitor is None or get_or_open_session is None or add_message is None:
        # 會話/訪客核心 seam 未就緒:無法落地,只記錄後降級。
        logger.warning("入站核心 seam 未就緒,暫存不可用(channel=%s)", channel_id)
        return None

    try:
        visitor = await get_or_create_visitor(
            db,
            tenant_id,
            channel_id,
            inbound.external_id,
            display_name=inbound.display_name,
            avatar_url=inbound.avatar_url,
        )
        session = await get_or_open_session(db, tenant_id, channel_id, visitor.id)
        message = await add_message(
            db,
            tenant_id,
            session.id,
            "visitor",
            inbound.text,
            content_type=inbound.content_type,
            meta=inbound.meta or None,
        )
        # 入站翻譯(若會話啟用):訪客原文→坐席語言,寫進 message.meta.i18n(content 保留原文)。
        await _translate_inbound(db, session, message)
        # 落地訊息(webhook 無其他交易邊界);seam 若已 commit,此處為 no-op。
        await db.commit()
    except Exception:  # 核心 seam 執行失敗則降級
        logger.exception("入站落地失敗(channel=%s)", channel_id)
        return None

    # 交給 AI 派發(M6);未就緒或失敗都不影響訊息已存。
    if handle_inbound is not None:
        try:
            await handle_inbound(db, tenant_id, session.id, message.id)
            # dispatch 內以 add_message/flush 寫入 AI 回覆或 handoff,需在此提交交易,
            # 否則請求結束時整段回滾(AI 回覆會遺失)。
            await db.commit()
        except Exception:
            logger.exception("dispatch.handle_inbound 失敗(session=%s)", session.id)
            await db.rollback()

    # 行動推播「新訪客訊息」:兩段 commit 都完成後才排程(訪客訊息已落地);任務內重讀會話,
    # 只推給負責的真人坐席(AI 接待中不推)。未設定 FCM 時完全不動作,失敗不影響入站。
    _notify_push_visitor_message(tenant_id, session.id, getattr(message, "id", None))
    return session.id


def _notify_push_visitor_message(tenant_id, session_id, message_id) -> None:
    try:
        from app.services import push

        push.on_visitor_message(tenant_id, session_id, message_id)
    except Exception:  # noqa: BLE001
        logger.warning("push.on_visitor_message 失敗(session=%s)", session_id, exc_info=True)


# --------------------------------------------------------------------------- #
# 一次性遷移:把 DB 內既有明文機敏欄位就地靜態加密(冪等)
# --------------------------------------------------------------------------- #
def _encrypt_channel_config(config: dict[str, Any] | None) -> tuple[dict[str, Any], bool]:
    """回傳 (加密後的新 config 複本, 是否有變更);已加密(enc::)欄位略過。

    加密頂層機敏(bot_token / webhook_secret / access_token / page_access_token /
    app_secret / verify_token)與巢狀 imap/smtp 的 pass/password。
    """
    changed = False
    new_cfg = dict(config or {})
    for key in _SECRET_CONFIG_KEYS:
        val = new_cfg.get(key)
        if isinstance(val, str) and val and not crypto.is_encrypted(val):
            new_cfg[key] = crypto.encrypt(val)
            changed = True
    for section in _EMAIL_SECRET_SECTIONS:
        sub = new_cfg.get(section)
        if isinstance(sub, dict):
            sub_copy = dict(sub)
            sub_changed = False
            for key in _EMAIL_SECRET_KEYS:
                val = sub_copy.get(key)
                if isinstance(val, str) and val and not crypto.is_encrypted(val):
                    sub_copy[key] = crypto.encrypt(val)
                    sub_changed = True
            if sub_changed:
                new_cfg[section] = sub_copy
                changed = True
    return new_cfg, changed


def _encrypt_llm_config(config: dict[str, Any] | None) -> tuple[dict[str, Any], bool]:
    """回傳 (加密後的 llm_config 複本, 是否有變更);加密 api_key 與 translation.api_key。"""
    changed = False
    new_cfg = dict(config or {})
    val = new_cfg.get("api_key")
    if isinstance(val, str) and val and not crypto.is_encrypted(val):
        new_cfg["api_key"] = crypto.encrypt(val)
        changed = True
    trans = new_cfg.get("translation")
    if isinstance(trans, dict):
        t_copy = dict(trans)
        tval = t_copy.get("api_key")
        if isinstance(tval, str) and tval and not crypto.is_encrypted(tval):
            t_copy["api_key"] = crypto.encrypt(tval)
            new_cfg["translation"] = t_copy
            changed = True
    return new_cfg, changed


async def encrypt_existing_secrets(db: AsyncSession) -> dict[str, int]:
    """一次性遷移:掃全部 Channel.config / Tenant.llm_config,把尚未加密的機敏欄位就地加密。

    - **冪等**:已是 ``enc::`` 的值一律略過;可安全重複執行。
    - 僅在該筆確有變更時才重指派欄位(JSONB 需重指派新 dict 才會被標記為 dirty)。
    - 不改動遮罩/非機敏欄位;無機敏值的渠道/租戶不計入。

    回傳 ``{"channels": n, "tenants": m}``,n/m 為實際被更新(有加密到欄位)的筆數。

    遠端執行範例(一次即可)::

        from app.core.db import SessionLocal
        from app.services.channel_out import encrypt_existing_secrets

        async with SessionLocal() as db:
            print(await encrypt_existing_secrets(db))
    """
    # 租戶模型延遲匯入,避免服務層於載入期與 tenancy 模組相互牽連。
    from app.models.tenancy import Tenant

    stats = {"channels": 0, "tenants": 0}

    channels = (await db.execute(select(Channel))).scalars().all()
    for ch in channels:
        new_cfg, changed = _encrypt_channel_config(ch.config)
        if changed:
            ch.config = new_cfg
            stats["channels"] += 1

    tenants = (await db.execute(select(Tenant))).scalars().all()
    for tenant in tenants:
        new_cfg, changed = _encrypt_llm_config(tenant.llm_config)
        if changed:
            tenant.llm_config = new_cfg
            stats["tenants"] += 1

    await db.commit()
    return stats
