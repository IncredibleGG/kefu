"""M5 channel API —— 渠道 CRUD、Telegram bot_token/webhook 設定、
Telegram / WhatsApp / Facebook webhook 回呼、Web Widget 訪客入站(REST + WS)。

掛載前綴(整合者於 main.py 註冊):`/api/v1/channel`
公開端點(無需 JWT,靠 public_key + secret / 簽章驗證):
- POST `/api/v1/channel/telegram/webhook/{channel_key}`   ← Telegram 回呼
- GET  `/api/v1/channel/whatsapp/webhook/{channel_key}`    ← WhatsApp 驗證握手(回 hub.challenge)
- POST `/api/v1/channel/whatsapp/webhook/{channel_key}`    ← WhatsApp 回呼(驗 X-Hub-Signature-256)
- GET  `/api/v1/channel/facebook/webhook/{channel_key}`    ← Messenger 驗證握手
- POST `/api/v1/channel/facebook/webhook/{channel_key}`    ← Messenger 回呼(驗 X-Hub-Signature-256)
- POST `/api/v1/channel/web/{channel_key}/session`         建立/開啟 web 會話
- POST `/api/v1/channel/web/{channel_key}/message`         web 訪客送訊
- GET  `/api/v1/channel/web/{channel_key}/sessions/{session_id}/messages`  web 訪客歷史(靠 channel-key + visitor_external_id 識別,無需登入)
- POST `/api/v1/channel/web/{channel_key}/upload`          web 訪客上傳附件(multipart)
- GET  `/api/v1/channel/files/{file_id}`                   取回上傳的附件(串流)
- WS   `/api/v1/channel/web/{channel_key}/ws`              web 訪客 WebSocket 入站

管理端點需 Bearer JWT,一律以 principal.tenant_id 過濾。
"""
from __future__ import annotations

import json
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import (
    APIRouter,
    File,
    Header,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import crypto
from app.core.db import SessionLocal
from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.models.analytics import PageView
from app.models.conversation import Channel, Message, Session
from app.models.goals import Goal, GoalConversion
from app.models.visitor import Visitor
from app.services import apple_client, channel_out, sms_client, storage
from app.services import email as email_service
from app.services.instagram_client import parse_instagram
from app.services.meta import (
    hydrate_media as hydrate_meta_media,
    parse_facebook,
    parse_whatsapp,
    verify_challenge,
    verify_signature,
)
from app.services.telegram import (
    NormalizedInbound,
    TelegramClient,
    TelegramError,
    hydrate_media as hydrate_telegram_media,
    parse_update,
    should_ignore_update,
    verify_secret,
)

router = APIRouter()
logger = logging.getLogger("kefu.channel.api")

_TG_SECRET_HEADER = "x-telegram-bot-api-secret-token"
_META_SIG_HEADER = "x-hub-signature-256"


# --------------------------------------------------------------------------- #
# Pydantic schemas
# --------------------------------------------------------------------------- #
class ChannelCreate(BaseModel):
    type: str = Field(..., description="web | telegram | email")
    name: str
    config: dict[str, Any] | None = None


class ChannelUpdate(BaseModel):
    name: str | None = None
    is_active: bool | None = None
    config: dict[str, Any] | None = None


class BotTokenIn(BaseModel):
    bot_token: str


class WebhookIn(BaseModel):
    # 對外可存取的服務根位址,例如 https://api.example.com
    base_url: str
    allow_groups: bool | None = None


class WebSessionIn(BaseModel):
    visitor_external_id: str | None = None
    display_name: str | None = None


class WebMessageIn(BaseModel):
    visitor_external_id: str
    text: str
    content_type: str = "text"
    display_name: str | None = None


class ImapConfigIn(BaseModel):
    """email 渠道 IMAP 收信設定(``pass`` 為 JSON 欄位名,對應 password)。"""

    model_config = ConfigDict(populate_by_name=True)

    host: str
    port: int = 993
    ssl: bool = True
    user: str
    # 留空(或送回遮罩值)代表沿用既有密碼,不覆寫
    password: str | None = Field(default=None, alias="pass")
    folder: str = "INBOX"


class SmtpConfigIn(BaseModel):
    """email 渠道 SMTP 發信設定。"""

    model_config = ConfigDict(populate_by_name=True)

    host: str
    port: int = 587
    tls: bool = True
    user: str
    password: str | None = Field(default=None, alias="pass")
    from_addr: str | None = Field(default=None, alias="from")


class EmailConfigIn(BaseModel):
    imap: ImapConfigIn
    smtp: SmtpConfigIn


class WhatsAppConfigIn(BaseModel):
    """WhatsApp(Meta Cloud API)渠道設定。

    敏感欄位(access_token / verify_token / app_secret)留空或送回遮罩值(含 …)
    時沿用既有值,方便前端只改非機敏欄位時不必重送機密。
    """

    phone_number_id: str
    access_token: str | None = None
    verify_token: str | None = None
    app_secret: str | None = None


class FacebookConfigIn(BaseModel):
    """Facebook Messenger 渠道設定(敏感欄位處理同 WhatsApp)。"""

    page_id: str
    page_access_token: str | None = None
    verify_token: str | None = None
    app_secret: str | None = None


class SmsConfigIn(BaseModel):
    """SMS(Twilio)渠道設定。

    account_sid / from_number 為識別碼 / 寄件號碼(不遮罩);auth_token 機敏,
    留空或送回遮罩值(含 …)時沿用既有值。webhook_url 可選,供反向代理後對齊
    Twilio 簽章所用的完整 URL(未設則以請求 URL 計算)。
    """

    account_sid: str
    auth_token: str | None = None
    from_number: str
    webhook_url: str | None = None


class InstagramConfigIn(BaseModel):
    """Instagram DM 渠道設定(複用 Meta,敏感欄位處理同 Facebook)。

    ig_account_id 為選填識別碼;page_access_token / verify_token / app_secret 機敏,
    留空或送回遮罩值時沿用既有值。
    """

    ig_account_id: str | None = None
    page_access_token: str | None = None
    verify_token: str | None = None
    app_secret: str | None = None


class AppleConfigIn(BaseModel):
    """Apple Messages for Business 渠道設定。

    msp_endpoint / business_id 為 MSP 端點與商務 ID;secret 機敏(與 MSP 約定的
    共享密鑰,兼作入站回呼授權),留空或送回遮罩值時沿用既有值。
    """

    msp_endpoint: str
    business_id: str
    secret: str | None = None


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #
def _serialize(channel: Channel) -> dict[str, Any]:
    """輸出渠道(config 內敏感欄位遮罩)。"""
    return {
        "id": str(channel.id),
        "type": channel.type,
        "name": channel.name,
        "is_active": channel.is_active,
        "config": channel_out.mask_config(channel.config),
        "created_at": channel.created_at.isoformat() if channel.created_at else None,
    }


def _new_public_key() -> str:
    return secrets.token_urlsafe(24)


def _new_secret() -> str:
    # Telegram secret_token 允許 A-Z a-z 0-9 _ - ,長度 1-256
    return secrets.token_urlsafe(32)


async def _get_owned_channel(
    db: AsyncSession, tenant_id: uuid.UUID, channel_id: uuid.UUID
) -> Channel | None:
    """取租戶自己的渠道(tenant 過濾 + 未軟刪)。"""
    return (
        await db.execute(
            select(Channel).where(
                Channel.id == channel_id,
                Channel.tenant_id == tenant_id,
                Channel.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


async def _channel_by_public_key(db: AsyncSession, key: str) -> Channel | None:
    """以 config.public_key 跨租戶定位公開渠道(webhook/widget 無 JWT 時用)。

    抽成獨立函式便於測試 monkeypatch(JSONB 查詢於 sqlite 不可用)。
    """
    return (
        await db.execute(
            select(Channel).where(
                Channel.config["public_key"].astext == key,
                Channel.deleted_at.is_(None),
                Channel.is_active.is_(True),
            )
        )
    ).scalar_one_or_none()


# --------------------------------------------------------------------------- #
# 渠道 CRUD(需 JWT)
# --------------------------------------------------------------------------- #
@router.post("")
async def create_channel(body: ChannelCreate, staff: CurrentStaff, db: DbSession):
    staff.require("channel:write")
    if body.type not in (
        channel_out.CHANNEL_WEB,
        channel_out.CHANNEL_TELEGRAM,
        channel_out.CHANNEL_EMAIL,
        channel_out.CHANNEL_WHATSAPP,
        channel_out.CHANNEL_FACEBOOK,
        channel_out.CHANNEL_SMS,
        channel_out.CHANNEL_INSTAGRAM,
        channel_out.CHANNEL_APPLE,
    ):
        return JSONResponse(status_code=400, content=err("CHANNEL_INVALID_TYPE", f"不支援的渠道型別:{body.type}"))
    config = dict(body.config or {})
    # 每個渠道都配一把公開 key,供 webhook / widget 端點定位(不含機敏)
    config.setdefault("public_key", _new_public_key())
    channel = Channel(
        tenant_id=staff.tenant_id,
        type=body.type,
        name=body.name,
        config=config,
        is_active=True,
    )
    db.add(channel)
    await db.commit()
    await db.refresh(channel)
    return ok(_serialize(channel))


@router.get("")
async def list_channels(staff: CurrentStaff, db: DbSession):
    rows = (
        await db.execute(
            select(Channel).where(
                Channel.tenant_id == staff.tenant_id, Channel.deleted_at.is_(None)
            ).order_by(Channel.created_at.desc())
        )
    ).scalars().all()
    return ok([_serialize(c) for c in rows])


@router.get("/{channel_id}")
async def get_channel(channel_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    channel = await _get_owned_channel(db, staff.tenant_id, channel_id)
    if channel is None:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "渠道不存在"))
    return ok(_serialize(channel))


@router.patch("/{channel_id}")
async def update_channel(
    channel_id: uuid.UUID, body: ChannelUpdate, staff: CurrentStaff, db: DbSession
):
    staff.require("channel:write")
    channel = await _get_owned_channel(db, staff.tenant_id, channel_id)
    if channel is None:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "渠道不存在"))
    if body.name is not None:
        channel.name = body.name
    if body.is_active is not None:
        channel.is_active = body.is_active
    if body.config is not None:
        # 合併 config,保留既有 public_key / bot_token 等(除非明確覆寫)
        merged = dict(channel.config or {})
        merged.update(body.config)
        channel.config = merged
    await db.commit()
    await db.refresh(channel)
    return ok(_serialize(channel))


@router.delete("/{channel_id}")
async def delete_channel(channel_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    staff.require("channel:write")
    channel = await _get_owned_channel(db, staff.tenant_id, channel_id)
    if channel is None:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "渠道不存在"))
    channel.deleted_at = datetime.now(timezone.utc)
    channel.is_active = False
    await db.commit()
    return ok({"id": str(channel_id), "deleted": True})


# --------------------------------------------------------------------------- #
# Telegram:設定 bot_token / webhook
# --------------------------------------------------------------------------- #
@router.put("/{channel_id}/telegram/bot-token")
async def set_bot_token(
    channel_id: uuid.UUID, body: BotTokenIn, staff: CurrentStaff, db: DbSession
):
    """設定並驗證 bot_token(呼叫 getMe);成功才存入 config。回應遮罩 token。"""
    staff.require("channel:write")
    channel = await _get_owned_channel(db, staff.tenant_id, channel_id)
    if channel is None:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "渠道不存在"))
    if channel.type != channel_out.CHANNEL_TELEGRAM:
        return JSONResponse(status_code=400, content=err("CHANNEL_WRONG_TYPE", "僅 telegram 渠道可設定 bot_token"))
    try:
        client = TelegramClient(body.bot_token)
        me = await client.get_me()
    except ValueError:
        return JSONResponse(status_code=400, content=err("CHANNEL_TG_BAD_TOKEN", "bot_token 格式錯誤"))
    except TelegramError as exc:
        return JSONResponse(status_code=400, content=err("CHANNEL_TG_TOKEN_REJECTED", f"Telegram 拒絕 token:{exc.description}"))

    config = dict(channel.config or {})
    # bot_token 靜態加密後才落 DB(先前已用明文 body.bot_token 呼叫 getMe 驗證)。
    config["bot_token"] = crypto.encrypt(body.bot_token)
    config["bot_username"] = me.get("username")
    config["bot_id"] = me.get("id")
    channel.config = config
    await db.commit()
    return ok({
        "channel_id": str(channel_id),
        "bot_username": me.get("username"),
        "bot_token": channel_out.mask_secret(body.bot_token),
    })


@router.post("/{channel_id}/telegram/webhook")
async def set_telegram_webhook(
    channel_id: uuid.UUID, body: WebhookIn, staff: CurrentStaff, db: DbSession
):
    """向 Telegram 註冊 webhook,帶 secret_token;回傳 webhook URL(secret 遮罩)。

    避免 tgo 坑:設 webhook 前生成獨立 secret,並用 public_key 作路徑;
    webhook 與 polling 不同時啟用(本 MVP 僅 webhook)。
    """
    staff.require("channel:write")
    channel = await _get_owned_channel(db, staff.tenant_id, channel_id)
    if channel is None:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "渠道不存在"))
    if channel.type != channel_out.CHANNEL_TELEGRAM:
        return JSONResponse(status_code=400, content=err("CHANNEL_WRONG_TYPE", "僅 telegram 渠道可設定 webhook"))
    config = dict(channel.config or {})
    # bot_token 於 DB 靜態加密,呼叫 Telegram setWebhook 前先解密。
    token = crypto.decrypt(config.get("bot_token"))
    if not token:
        return JSONResponse(status_code=400, content=err("CHANNEL_TG_NO_TOKEN", "請先設定 bot_token"))

    public_key = config.get("public_key") or _new_public_key()
    secret = _new_secret()
    webhook_url = f"{body.base_url.rstrip('/')}/api/v1/channel/telegram/webhook/{public_key}"
    try:
        client = TelegramClient(token)
        await client.set_webhook(
            webhook_url,
            secret_token=secret,
            allowed_updates=["message", "edited_message", "channel_post"],
            drop_pending_updates=True,
        )
    except (TelegramError, ValueError) as exc:
        return JSONResponse(status_code=502, content=err("CHANNEL_TG_WEBHOOK_FAILED", f"setWebhook 失敗:{exc}"))

    config["public_key"] = public_key
    # webhook_secret 靜態加密後才落 DB(上方 setWebhook 已用明文 secret 註冊)。
    config["webhook_secret"] = crypto.encrypt(secret)
    if body.allow_groups is not None:
        config["allow_groups"] = body.allow_groups
    channel.config = config
    await db.commit()
    return ok({
        "channel_id": str(channel_id),
        "webhook_url": webhook_url,
        "webhook_secret": channel_out.mask_secret(secret),
    })


@router.delete("/{channel_id}/telegram/webhook")
async def delete_telegram_webhook(
    channel_id: uuid.UUID, staff: CurrentStaff, db: DbSession
):
    """移除 Telegram webhook 並清掉存放的 secret。"""
    staff.require("channel:write")
    channel = await _get_owned_channel(db, staff.tenant_id, channel_id)
    if channel is None:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "渠道不存在"))
    config = dict(channel.config or {})
    # bot_token 於 DB 靜態加密,呼叫 Telegram deleteWebhook 前先解密。
    token = crypto.decrypt(config.get("bot_token"))
    if token:
        try:
            await TelegramClient(token).delete_webhook(drop_pending_updates=False)
        except (TelegramError, ValueError):
            pass  # 已無法呼叫也照樣清本地狀態
    config.pop("webhook_secret", None)
    channel.config = config
    await db.commit()
    return ok({"channel_id": str(channel_id), "webhook_deleted": True})


# --------------------------------------------------------------------------- #
# Email:IMAP 收 / SMTP 發 設定 + 連線測試(需 JWT)
# --------------------------------------------------------------------------- #
def _resolve_secret(new_val: str | None, prev_val: str | None) -> str | None:
    """合併密碼:留空或收到遮罩值(含 …)一律視為未變更,沿用既有密碼。"""
    if not new_val:
        return prev_val
    if "…" in new_val:  # 前端把 _serialize 遮罩過的值原樣送回 → 不覆寫
        return prev_val
    return new_val


@router.put("/{channel_id}/email/config")
async def set_email_config(
    channel_id: uuid.UUID, body: EmailConfigIn, staff: CurrentStaff, db: DbSession
):
    """存 email 渠道的 IMAP / SMTP 設定;回應以 mask_config 遮罩密碼欄位。

    密碼欄位(imap.pass / smtp.pass)留空或送回遮罩值時沿用既有值,方便前端在
    只改非機敏欄位時不必重送密碼。SMTP from 未給則預設用 SMTP user。
    """
    staff.require("channel:write")
    channel = await _get_owned_channel(db, staff.tenant_id, channel_id)
    if channel is None:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "渠道不存在"))
    if channel.type != channel_out.CHANNEL_EMAIL:
        return JSONResponse(
            status_code=400, content=err("CHANNEL_WRONG_TYPE", "僅 email 渠道可設定 IMAP/SMTP")
        )

    config = dict(channel.config or {})
    prev_imap = config.get("imap") or {}
    prev_smtp = config.get("smtp") or {}

    # 密碼靜態加密後才落 DB。_resolve_secret 先處理「留空/遮罩沿用」(沿用既有值,
    # 該值多半已是 enc::),crypto.encrypt 對 None/已加密值皆冪等,不會二次加密或加密遮罩值。
    config["imap"] = {
        "host": body.imap.host,
        "port": body.imap.port,
        "ssl": body.imap.ssl,
        "user": body.imap.user,
        "pass": crypto.encrypt(_resolve_secret(body.imap.password, prev_imap.get("pass"))),
        "folder": body.imap.folder,
    }
    config["smtp"] = {
        "host": body.smtp.host,
        "port": body.smtp.port,
        "tls": body.smtp.tls,
        "user": body.smtp.user,
        "pass": crypto.encrypt(_resolve_secret(body.smtp.password, prev_smtp.get("pass"))),
        "from": body.smtp.from_addr or body.smtp.user,
    }
    channel.config = config
    await db.commit()
    await db.refresh(channel)
    return ok(_serialize(channel))


@router.post("/{channel_id}/email/test")
async def test_email_channel(channel_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """測試已存的 email 渠道 IMAP + SMTP 連線,回報各自 ok / error。"""
    staff.require("channel:write")
    channel = await _get_owned_channel(db, staff.tenant_id, channel_id)
    if channel is None:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "渠道不存在"))
    if channel.type != channel_out.CHANNEL_EMAIL:
        return JSONResponse(
            status_code=400, content=err("CHANNEL_WRONG_TYPE", "僅 email 渠道可測試連線")
        )

    result = await email_service.test_connection(channel.config or {})
    all_ok = bool(result.get("imap", {}).get("ok") and result.get("smtp", {}).get("ok"))
    return ok({
        "channel_id": str(channel_id),
        "ok": all_ok,
        "imap": result.get("imap"),
        "smtp": result.get("smtp"),
    })


# --------------------------------------------------------------------------- #
# WhatsApp / Facebook:Meta 渠道設定(需 JWT;存並遮罩 token/secret)
# --------------------------------------------------------------------------- #
@router.put("/{channel_id}/whatsapp/config")
async def set_whatsapp_config(
    channel_id: uuid.UUID, body: WhatsAppConfigIn, staff: CurrentStaff, db: DbSession
):
    """存 WhatsApp 渠道 config(phone_number_id / access_token / verify_token / app_secret)。

    敏感欄位留空或送回遮罩值時沿用既有值;回應以 mask_config 遮罩機密。
    """
    staff.require("channel:write")
    channel = await _get_owned_channel(db, staff.tenant_id, channel_id)
    if channel is None:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "渠道不存在"))
    if channel.type != channel_out.CHANNEL_WHATSAPP:
        return JSONResponse(
            status_code=400, content=err("CHANNEL_WRONG_TYPE", "僅 whatsapp 渠道可設定此項")
        )
    config = dict(channel.config or {})
    config["phone_number_id"] = body.phone_number_id
    # 機敏欄位:先套「留空/遮罩沿用」再靜態加密(encrypt 對 None/已加密值冪等)。
    config["access_token"] = crypto.encrypt(_resolve_secret(body.access_token, config.get("access_token")))
    config["verify_token"] = crypto.encrypt(_resolve_secret(body.verify_token, config.get("verify_token")))
    config["app_secret"] = crypto.encrypt(_resolve_secret(body.app_secret, config.get("app_secret")))
    channel.config = config
    await db.commit()
    await db.refresh(channel)
    return ok(_serialize(channel))


@router.put("/{channel_id}/facebook/config")
async def set_facebook_config(
    channel_id: uuid.UUID, body: FacebookConfigIn, staff: CurrentStaff, db: DbSession
):
    """存 Facebook Messenger 渠道 config(page_id / page_access_token / verify_token / app_secret)。

    敏感欄位留空或送回遮罩值時沿用既有值;回應以 mask_config 遮罩機密。
    """
    staff.require("channel:write")
    channel = await _get_owned_channel(db, staff.tenant_id, channel_id)
    if channel is None:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "渠道不存在"))
    if channel.type != channel_out.CHANNEL_FACEBOOK:
        return JSONResponse(
            status_code=400, content=err("CHANNEL_WRONG_TYPE", "僅 facebook 渠道可設定此項")
        )
    config = dict(channel.config or {})
    config["page_id"] = body.page_id
    # 機敏欄位:先套「留空/遮罩沿用」再靜態加密(encrypt 對 None/已加密值冪等)。
    config["page_access_token"] = crypto.encrypt(
        _resolve_secret(body.page_access_token, config.get("page_access_token"))
    )
    config["verify_token"] = crypto.encrypt(_resolve_secret(body.verify_token, config.get("verify_token")))
    config["app_secret"] = crypto.encrypt(_resolve_secret(body.app_secret, config.get("app_secret")))
    channel.config = config
    await db.commit()
    await db.refresh(channel)
    return ok(_serialize(channel))


# --------------------------------------------------------------------------- #
# SMS / Instagram / Apple:渠道設定(需 JWT;存並遮罩機密)
# --------------------------------------------------------------------------- #
@router.put("/{channel_id}/sms/config")
async def set_sms_config(
    channel_id: uuid.UUID, body: SmsConfigIn, staff: CurrentStaff, db: DbSession
):
    """存 SMS(Twilio)渠道 config(account_sid / auth_token / from_number / webhook_url)。

    auth_token 留空或送回遮罩值時沿用既有值;回應以 mask_config 遮罩機密。
    """
    staff.require("channel:write")
    channel = await _get_owned_channel(db, staff.tenant_id, channel_id)
    if channel is None:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "渠道不存在"))
    if channel.type != channel_out.CHANNEL_SMS:
        return JSONResponse(
            status_code=400, content=err("CHANNEL_WRONG_TYPE", "僅 sms 渠道可設定此項")
        )
    config = dict(channel.config or {})
    config["account_sid"] = body.account_sid
    config["from_number"] = body.from_number
    if body.webhook_url is not None:
        config["webhook_url"] = body.webhook_url
    # auth_token 機敏:先套「留空/遮罩沿用」再靜態加密(encrypt 對 None/已加密值冪等)。
    config["auth_token"] = crypto.encrypt(_resolve_secret(body.auth_token, config.get("auth_token")))
    channel.config = config
    await db.commit()
    await db.refresh(channel)
    return ok(_serialize(channel))


@router.put("/{channel_id}/instagram/config")
async def set_instagram_config(
    channel_id: uuid.UUID, body: InstagramConfigIn, staff: CurrentStaff, db: DbSession
):
    """存 Instagram DM 渠道 config(ig_account_id / page_access_token / verify_token / app_secret)。

    敏感欄位留空或送回遮罩值時沿用既有值;回應以 mask_config 遮罩機密。
    """
    staff.require("channel:write")
    channel = await _get_owned_channel(db, staff.tenant_id, channel_id)
    if channel is None:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "渠道不存在"))
    if channel.type != channel_out.CHANNEL_INSTAGRAM:
        return JSONResponse(
            status_code=400, content=err("CHANNEL_WRONG_TYPE", "僅 instagram 渠道可設定此項")
        )
    config = dict(channel.config or {})
    if body.ig_account_id is not None:
        config["ig_account_id"] = body.ig_account_id
    # 機敏欄位:先套「留空/遮罩沿用」再靜態加密(encrypt 對 None/已加密值冪等)。
    config["page_access_token"] = crypto.encrypt(
        _resolve_secret(body.page_access_token, config.get("page_access_token"))
    )
    config["verify_token"] = crypto.encrypt(_resolve_secret(body.verify_token, config.get("verify_token")))
    config["app_secret"] = crypto.encrypt(_resolve_secret(body.app_secret, config.get("app_secret")))
    channel.config = config
    await db.commit()
    await db.refresh(channel)
    return ok(_serialize(channel))


@router.put("/{channel_id}/apple/config")
async def set_apple_config(
    channel_id: uuid.UUID, body: AppleConfigIn, staff: CurrentStaff, db: DbSession
):
    """存 Apple Messages for Business 渠道 config(msp_endpoint / business_id / secret)。

    secret 機敏(留空或送回遮罩值時沿用既有值);回應以 mask_config 遮罩機密。
    出站為 code-ready 框架:未設 msp_endpoint / business_id / secret 則不送(no-op)。
    """
    staff.require("channel:write")
    channel = await _get_owned_channel(db, staff.tenant_id, channel_id)
    if channel is None:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "渠道不存在"))
    if channel.type != channel_out.CHANNEL_APPLE:
        return JSONResponse(
            status_code=400, content=err("CHANNEL_WRONG_TYPE", "僅 apple 渠道可設定此項")
        )
    config = dict(channel.config or {})
    config["msp_endpoint"] = body.msp_endpoint
    config["business_id"] = body.business_id
    # secret 機敏:先套「留空/遮罩沿用」再靜態加密(encrypt 對 None/已加密值冪等)。
    config["secret"] = crypto.encrypt(_resolve_secret(body.secret, config.get("secret")))
    channel.config = config
    await db.commit()
    await db.refresh(channel)
    return ok(_serialize(channel))


# --------------------------------------------------------------------------- #
# Telegram webhook 回呼(公開端點,無 JWT)
# --------------------------------------------------------------------------- #
@router.post("/telegram/webhook/{channel_key}")
async def telegram_webhook(
    channel_key: str,
    update: dict[str, Any],
    db: DbSession,
    x_telegram_secret: str | None = Header(default=None, alias=_TG_SECRET_HEADER),
):
    """接收 Telegram update:驗 secret → 過濾 → 歸一化 → 標準入站流程。

    一律回 200(ok 信封)避免 Telegram 無謂重送;secret 不符則 403。
    """
    channel = await _channel_by_public_key(db, channel_key)
    if channel is None or channel.type != channel_out.CHANNEL_TELEGRAM:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "webhook 目標不存在"))

    config = channel.config or {}
    # webhook_secret 於 DB 靜態加密,驗證前解密(舊明文 decrypt 原樣回傳,相容)。
    if not verify_secret(crypto.decrypt(config.get("webhook_secret")), x_telegram_secret):
        return JSONResponse(status_code=403, content=err("CHANNEL_TG_BAD_SECRET", "secret_token 驗證失敗"))

    allow_groups = bool(config.get("allow_groups", False))
    if should_ignore_update(update, allow_groups=allow_groups):
        return ok({"ignored": True})

    inbound = parse_update(update)
    if inbound is None:
        return ok({"ignored": True})

    # 入站媒體補水:下載 Telegram 附件存進本站,失敗降級為佔位字串(不拋)。
    inbound = await hydrate_telegram_media(inbound, channel.config)
    session_id = await channel_out.ingest_inbound(db, channel.tenant_id, channel.id, inbound)
    return ok({"session_id": str(session_id) if session_id else None})


# --------------------------------------------------------------------------- #
# WhatsApp / Facebook webhook 回呼(公開端點,無 JWT)
#
# Meta 協定要點:
# - GET:訂閱驗證握手,須「原樣回傳」hub.challenge(text/plain,非信封),否則設定失敗。
# - POST:驗 X-Hub-Signature-256(以 app_secret 對「原始 bytes」做 HMAC-SHA256)。
#   一次可夾帶多筆事件,故解析回一批 inbound,逐筆走標準入站流程;一律回 200。
# --------------------------------------------------------------------------- #
async def _meta_challenge_response(
    channel_key: str, request: Request, db: AsyncSession, channel_type: str
) -> PlainTextResponse | JSONResponse:
    """Meta webhook GET 驗證共用:比對 verify_token → 原樣回 hub.challenge。"""
    channel = await _channel_by_public_key(db, channel_key)
    if channel is None or channel.type != channel_type:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "webhook 目標不存在"))
    params = request.query_params
    challenge = verify_challenge(
        mode=params.get("hub.mode"),
        token=params.get("hub.verify_token"),
        challenge=params.get("hub.challenge"),
        # verify_token 於 DB 靜態加密,比對前解密(舊明文相容)。
        expected_token=crypto.decrypt((channel.config or {}).get("verify_token")),
    )
    if challenge is None:
        return JSONResponse(status_code=403, content=err("CHANNEL_META_BAD_VERIFY", "webhook 驗證失敗"))
    # Meta 要求原樣回 challenge 字串(非 ok() 信封),否則訂閱驗證不通過。
    return PlainTextResponse(challenge)


async def _meta_ingest(
    channel_key: str,
    request: Request,
    db: AsyncSession,
    channel_type: str,
    signature: str | None,
    parse_fn,
) -> JSONResponse:
    """Meta webhook POST 共用:定位渠道 → 驗簽 → 解析 → 逐筆標準入站。一律回 200。"""
    channel = await _channel_by_public_key(db, channel_key)
    if channel is None or channel.type != channel_type:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "webhook 目標不存在"))

    raw = await request.body()
    config = channel.config or {}
    # app_secret 於 DB 靜態加密,驗簽前解密(舊明文相容)。
    if not verify_signature(crypto.decrypt(config.get("app_secret")), raw, signature):
        return JSONResponse(status_code=403, content=err("CHANNEL_META_BAD_SIGNATURE", "簽章驗證失敗"))

    try:
        payload = json.loads(raw or b"{}")
    except ValueError:
        return JSONResponse(content=ok({"ignored": True}))

    inbounds = parse_fn(payload)
    session_ids: list[str] = []
    for inbound in inbounds:
        # 入站媒體補水:下載 WhatsApp/Facebook 附件存進本站,失敗降級(不拋)。
        inbound = await hydrate_meta_media(inbound, channel.config)
        session_id = await channel_out.ingest_inbound(db, channel.tenant_id, channel.id, inbound)
        if session_id:
            session_ids.append(str(session_id))
    return JSONResponse(content=ok({"count": len(inbounds), "session_ids": session_ids}))


@router.get("/whatsapp/webhook/{channel_key}")
async def whatsapp_webhook_verify(channel_key: str, request: Request, db: DbSession):
    """WhatsApp webhook 訂閱驗證握手:回 hub.challenge。"""
    return await _meta_challenge_response(
        channel_key, request, db, channel_out.CHANNEL_WHATSAPP
    )


@router.post("/whatsapp/webhook/{channel_key}")
async def whatsapp_webhook(
    channel_key: str,
    request: Request,
    db: DbSession,
    x_hub_signature: str | None = Header(default=None, alias=_META_SIG_HEADER),
):
    """WhatsApp Cloud API 回呼:驗簽 → 解析 messages → 標準入站。"""
    return await _meta_ingest(
        channel_key,
        request,
        db,
        channel_out.CHANNEL_WHATSAPP,
        x_hub_signature,
        parse_whatsapp,
    )


@router.get("/facebook/webhook/{channel_key}")
async def facebook_webhook_verify(channel_key: str, request: Request, db: DbSession):
    """Messenger webhook 訂閱驗證握手:回 hub.challenge。"""
    return await _meta_challenge_response(
        channel_key, request, db, channel_out.CHANNEL_FACEBOOK
    )


@router.post("/facebook/webhook/{channel_key}")
async def facebook_webhook(
    channel_key: str,
    request: Request,
    db: DbSession,
    x_hub_signature: str | None = Header(default=None, alias=_META_SIG_HEADER),
):
    """Facebook Messenger 回呼:驗簽 → 解析 messaging 事件 → 標準入站。"""
    return await _meta_ingest(
        channel_key,
        request,
        db,
        channel_out.CHANNEL_FACEBOOK,
        x_hub_signature,
        parse_facebook,
    )


# --------------------------------------------------------------------------- #
# Instagram DM webhook 回呼(公開端點,無 JWT)
#
# 複用 Meta 基礎設施:與 Facebook 同一組 GET hub.challenge 驗證握手與
# POST X-Hub-Signature-256 驗簽,只是解析用 parse_instagram(external_id=IGSID)。
# --------------------------------------------------------------------------- #
@router.get("/instagram/webhook/{channel_key}")
async def instagram_webhook_verify(channel_key: str, request: Request, db: DbSession):
    """Instagram webhook 訂閱驗證握手:回 hub.challenge。"""
    return await _meta_challenge_response(
        channel_key, request, db, channel_out.CHANNEL_INSTAGRAM
    )


@router.post("/instagram/webhook/{channel_key}")
async def instagram_webhook(
    channel_key: str,
    request: Request,
    db: DbSession,
    x_hub_signature: str | None = Header(default=None, alias=_META_SIG_HEADER),
):
    """Instagram Messaging 回呼:驗簽 → 解析 messaging 事件 → 標準入站。"""
    return await _meta_ingest(
        channel_key,
        request,
        db,
        channel_out.CHANNEL_INSTAGRAM,
        x_hub_signature,
        parse_instagram,
    )


# --------------------------------------------------------------------------- #
# SMS(Twilio)webhook 回呼(公開端點,無 JWT)
#
# Twilio 以 application/x-www-form-urlencoded POST(From / Body / MediaUrlN…),
# 並在 X-Twilio-Signature 帶簽章(HMAC-SHA1 → base64,對「完整 URL + 排序後表單」)。
# 安全預設:渠道未設 auth_token 即拒(對齊 meta/telegram)。回空 TwiML 避免 Twilio 自動回覆。
# --------------------------------------------------------------------------- #
_TWILIO_SIG_HEADER = "x-twilio-signature"
_EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'


@router.post("/sms/webhook/{channel_key}")
async def sms_webhook(
    channel_key: str,
    request: Request,
    db: DbSession,
    x_twilio_signature: str | None = Header(default=None, alias=_TWILIO_SIG_HEADER),
):
    """Twilio 回呼:驗簽(X-Twilio-Signature)→ 解析 From/Body → 標準入站。

    成功回空 TwiML(text/xml);簽章不符或未設 auth_token 回 403;渠道不存在回 404。
    """
    channel = await _channel_by_public_key(db, channel_key)
    if channel is None or channel.type != channel_out.CHANNEL_SMS:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "webhook 目標不存在"))

    config = channel.config or {}
    # 表單參數(Twilio 為 urlencoded);簽章需對「完整 URL + 排序後表單」計算。
    form = await request.form()
    params = {k: str(v) for k, v in form.items()}
    # 反向代理後可由 config.webhook_url 指定 Twilio 實際回呼的完整 URL,否則以請求 URL 計算。
    url = config.get("webhook_url") or str(request.url)
    # auth_token 於 DB 靜態加密,驗簽前解密;未設 auth_token → verify 回 False(安全預設拒)。
    if not sms_client.verify_twilio_signature(
        crypto.decrypt(config.get("auth_token")), url, params, x_twilio_signature
    ):
        return JSONResponse(status_code=403, content=err("CHANNEL_SMS_BAD_SIGNATURE", "簽章驗證失敗"))

    inbound = sms_client.parse_inbound(params)
    if inbound is None:
        return Response(content=_EMPTY_TWIML, media_type="application/xml")
    await channel_out.ingest_inbound(db, channel.tenant_id, channel.id, inbound)
    # Twilio 期望 TwiML;回空 <Response/> 表示不自動回覆(出站由 send_to_visitor 主動送)。
    return Response(content=_EMPTY_TWIML, media_type="application/xml")


# --------------------------------------------------------------------------- #
# Apple Messages for Business webhook 回呼(MSP 回呼,公開端點,無 JWT)
#
# code-ready 框架:以渠道共享 secret 作入站授權閘門(Authorization: Bearer <secret>
# 或 X-Apple-Signature);未設 secret 即拒(安全預設)。解析 MSP 訊息 → 標準入站。
# 實際 MSP 的驗證機制依供應商而異,此為框架式共享密鑰閘門。
# --------------------------------------------------------------------------- #
@router.post("/apple/webhook/{channel_key}")
async def apple_webhook(
    channel_key: str,
    request: Request,
    db: DbSession,
    authorization: str | None = Header(default=None),
    x_apple_signature: str | None = Header(default=None, alias="x-apple-signature"),
):
    """Apple MfB MSP 回呼:驗共享 secret → 解析訊息 → 標準入站。一律回 200(ok 信封)。"""
    channel = await _channel_by_public_key(db, channel_key)
    if channel is None or channel.type != channel_out.CHANNEL_APPLE:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "webhook 目標不存在"))

    config = channel.config or {}
    # 取出 provided:優先 X-Apple-Signature,否則 Authorization(去除 Bearer 前綴)。
    provided = x_apple_signature
    if not provided and authorization:
        provided = authorization[7:] if authorization.lower().startswith("bearer ") else authorization
    # secret 於 DB 靜態加密,驗證前解密;未設 secret → verify 回 False(安全預設拒)。
    if not apple_client.verify_apple_secret(crypto.decrypt(config.get("secret")), provided):
        return JSONResponse(status_code=403, content=err("CHANNEL_APPLE_BAD_SECRET", "授權驗證失敗"))

    raw = await request.body()
    try:
        payload = json.loads(raw or b"{}")
    except ValueError:
        return JSONResponse(content=ok({"ignored": True}))

    inbounds = apple_client.parse_apple(payload)
    session_ids: list[str] = []
    for inbound in inbounds:
        session_id = await channel_out.ingest_inbound(db, channel.tenant_id, channel.id, inbound)
        if session_id:
            session_ids.append(str(session_id))
    return JSONResponse(content=ok({"count": len(inbounds), "session_ids": session_ids}))


# --------------------------------------------------------------------------- #
# Web Widget 入站(公開端點)
# --------------------------------------------------------------------------- #
@router.post("/web/{channel_key}/session")
async def web_open_session(channel_key: str, body: WebSessionIn, db: DbSession):
    """建立/開啟一個 web widget 會話,回傳 visitor_external_id 供後續送訊。"""
    channel = await _channel_by_public_key(db, channel_key)
    if channel is None or channel.type != channel_out.CHANNEL_WEB:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "widget 渠道不存在"))

    external_id = body.visitor_external_id or f"web-{uuid.uuid4().hex}"
    inbound = NormalizedInbound(
        external_id=external_id,
        text="",
        display_name=body.display_name,
        meta={"provider": "web", "event": "session_open"},
    )
    # 僅建立 visitor/session,不送空訊息:呼叫核心 seam 但略過空 add_message。
    session_id = await _web_open_only(db, channel, inbound)
    return ok({
        "channel_id": str(channel.id),
        "tenant_id": str(channel.tenant_id),  # widget needs it to subscribe /ws/widget
        "visitor_external_id": external_id,
        "session_id": str(session_id) if session_id else None,
    })


async def _web_open_only(db: AsyncSession, channel: Channel, inbound: NormalizedInbound):
    """只建立 visitor + session(不落訊息、不派發),供 widget 初始化。"""
    get_or_create_visitor = channel_out._resolve_seam("app.services.visitor", "get_or_create_visitor")
    get_or_open_session = channel_out._resolve_seam("app.services.conversation", "get_or_open_session")
    if get_or_create_visitor is None or get_or_open_session is None:
        return None
    try:
        visitor = await get_or_create_visitor(
            db, channel.tenant_id, channel.id, inbound.external_id,
            display_name=inbound.display_name,
        )
        session = await get_or_open_session(db, channel.tenant_id, channel.id, visitor.id)
        await db.commit()
        return session.id
    except Exception:  # seam 執行失敗則優雅降級(不阻擋 widget 初始化)
        logger.exception("web widget 開啟會話失敗(channel=%s)", channel.id)
        return None


@router.post("/web/{channel_key}/message")
async def web_send_message(channel_key: str, body: WebMessageIn, db: DbSession):
    """web 訪客送訊 → 標準入站流程。"""
    channel = await _channel_by_public_key(db, channel_key)
    if channel is None or channel.type != channel_out.CHANNEL_WEB:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "widget 渠道不存在"))
    if not body.text.strip():
        return JSONResponse(status_code=400, content=err("CHANNEL_EMPTY_MESSAGE", "訊息不可為空"))

    inbound = NormalizedInbound(
        external_id=body.visitor_external_id,
        text=body.text,
        content_type=body.content_type,
        display_name=body.display_name,
        meta={"provider": "web"},
    )
    session_id = await channel_out.ingest_inbound(db, channel.tenant_id, channel.id, inbound)
    return ok({"session_id": str(session_id) if session_id else None})


# 訪客可見的 sender_type 白名單:內部備註(note)等一律排除,避免公開歷史越權外洩。
_VISITOR_VISIBLE_SENDERS = ("visitor", "ai", "human", "system")

# 公開訪客歷史可回傳的 meta 白名單:僅訪客端「渲染所需」的展示欄位。
# meta 可能夾帶敏感內部鍵——例如 system 訊息(在上面白名單內、會回給訪客)的 handoff
# 坐席 UUID(handler_staff_id / from_staff_id / target_staff_id)與內部轉接 note、
# session.closed 的 closed_by、坐席譯文 i18n、質檢 qc/quality 分數等——故一律白名單過濾,
# **不整包回**,避免坐席資訊 / 內部備註隨公開歷史外洩。
# - card:富卡片內容(title/text/image_url/buttons),widget 用以在重整/重開後還原卡片。
# - csat_invite:結案邀評旗標(rating_scale/reason/submit_endpoint),widget 既有展示欄位;
#   submit_endpoint 由 widget 端再驗為同源相對路徑,內無坐席 / 內部資訊。
_VISITOR_VISIBLE_META_KEYS = ("card", "cards", "csat_invite")


def _public_meta(meta: Any) -> dict[str, Any] | None:
    """從 message.meta 濾出訪客端可見的展示白名單子集;非 dict 或無可見鍵回 None。"""
    if not isinstance(meta, dict):
        return None
    out = {k: meta[k] for k in _VISITOR_VISIBLE_META_KEYS if k in meta}
    return out or None


@router.get("/web/{channel_key}/sessions/{session_id}/messages")
async def web_session_messages(
    channel_key: str,
    session_id: uuid.UUID,
    db: DbSession,
    visitor_external_id: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=200),
):
    """公開訪客歷史:回某 web 會話的訊息清單,供 widget 重開/重整後還原對話。

    無登入守衛,比照既有公開 web 端點,以 channel ``public_key`` 定位租戶。越權防護:
    - channel 必須存在且為 web 型;
    - ``visitor_external_id`` 必填,且該 visitor 必須屬於此 channel(以 tenant+channel+external_id
      定位,對齊 ``get_or_create_visitor`` 的身份鍵);
    - session 必須「同時」屬於此 channel 與此 visitor,否則一律回 404(不洩漏他人對話是否存在)。
    僅回訪客可見的 sender_type(排除內部備註等),content 直接對齊出/入站語意
    (訪客訊息為原文、出站回覆為送給訪客的內容),欄位對齊 widget 的 HistoryMessage。
    """
    channel = await _channel_by_public_key(db, channel_key)
    if channel is None or channel.type != channel_out.CHANNEL_WEB:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "widget 渠道不存在"))

    external_id = (visitor_external_id or "").strip()
    if not external_id:
        return JSONResponse(
            status_code=400, content=err("CHANNEL_VISITOR_REQUIRED", "缺少 visitor_external_id")
        )

    # 以 tenant+channel+external_id 定位訪客(找不到即視為無此會話,不區分「不存在/非本人」)
    visitor = (
        await db.execute(
            select(Visitor).where(
                Visitor.tenant_id == channel.tenant_id,
                Visitor.channel_id == channel.id,
                Visitor.external_id == external_id,
                Visitor.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if visitor is None:
        return JSONResponse(status_code=404, content=err("CHANNEL_SESSION_NOT_FOUND", "會話不存在"))

    # session 必須同時屬於此 channel 與此 visitor,才算本訪客可讀(核心越權防護)
    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == channel.tenant_id,
                Session.channel_id == channel.id,
                Session.visitor_id == visitor.id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        return JSONResponse(status_code=404, content=err("CHANNEL_SESSION_NOT_FOUND", "會話不存在"))

    # 取最近 limit 則(倒序取後反轉成由舊到新),排除內部 sender_type
    msgs = (
        await db.execute(
            select(Message)
            .where(
                Message.tenant_id == channel.tenant_id,
                Message.session_id == session.id,
                Message.sender_type.in_(_VISITOR_VISIBLE_SENDERS),
                Message.deleted_at.is_(None),
            )
            .order_by(Message.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()

    messages = [
        {
            "id": str(m.id),
            "session_id": str(m.session_id),
            "sender_type": m.sender_type,
            "content_type": m.content_type,
            "content": m.content,
            # 白名單過濾後的展示用 meta(讓 widget 重整/重開後能還原富卡片與邀評,
            # 不外洩坐席 / 內部備註等敏感 meta);無可見鍵時為 None。
            "meta": _public_meta(m.meta),
            "created_at": m.created_at.isoformat() if m.created_at else None,
        }
        for m in reversed(msgs)
    ]
    return ok({"messages": messages})


# --------------------------------------------------------------------------- #
# Web Widget 附件上傳 / 取檔(公開端點,無 JWT,靠 channelKey 定位租戶)
# --------------------------------------------------------------------------- #
@router.post("/web/{channel_key}/upload")
async def web_upload_file(
    channel_key: str, db: DbSession, file: UploadFile = File(...)
):
    """訪客上傳附件(multipart)→ 存檔 → 回 `{url, id, filename, content_type, size}`。

    url 形如 `/api/v1/channel/files/{id}`,前端拿去以 message 端點送出。
    channelKey 無效回 404;型別/大小不符回 storage 定義的錯誤碼。
    """
    channel = await _channel_by_public_key(db, channel_key)
    if channel is None or channel.type != channel_out.CHANNEL_WEB:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "widget 渠道不存在"))
    try:
        saved = await storage.save_upload(file)
    except storage.StorageError as exc:
        return JSONResponse(status_code=exc.status, content=err(exc.code, exc.message))
    return ok({
        "url": f"/api/v1/channel/files/{saved.id}",
        "id": saved.id,
        "filename": saved.filename,
        "content_type": saved.media_type,
        "size": saved.size,
    })


@router.get("/files/{file_id}")
async def web_get_file(file_id: str):
    """串流回傳先前上傳的檔案;設對應 content-type,圖片 inline、其餘附件下載。

    以內容定址的不可枚舉 id 取檔;id 格式非法或檔案不存在皆回 404。
    """
    resolved = storage.resolve_file(file_id)
    if resolved is None:
        return JSONResponse(status_code=404, content=err("FILE_NOT_FOUND", "檔案不存在"))
    # 圖片 inline 顯示;一般檔以原始檔名下載。
    disposition = "inline" if resolved.is_image else "attachment"
    return FileResponse(
        path=resolved.path,
        media_type=resolved.media_type,
        filename=resolved.filename,
        content_disposition_type=disposition,
    )


@router.websocket("/web/{channel_key}/ws")
async def web_widget_ws(websocket: WebSocket, channel_key: str):
    """web 訪客 WebSocket 入站入口。

    協定:連線後每個 frame `{ "type": "message", "text": "...",
    "visitor_external_id": "...", "content_type": "text" }` 觸發標準入站流程,
    回 `{ "type": "ack", ... }`。出站(AI/坐席回覆)由 M3 realtime /ws/widget 負責。
    """
    await websocket.accept()
    # WebSocket 生命週期自管一個 DB session
    async with SessionLocal() as db:
        channel = await _channel_by_public_key(db, channel_key)
        if channel is None or channel.type != channel_out.CHANNEL_WEB:
            await websocket.send_json(err("CHANNEL_NOT_FOUND", "widget 渠道不存在"))
            await websocket.close()
            return
        try:
            while True:
                frame = await websocket.receive_json()
                if frame.get("type") != "message":
                    continue
                text = (frame.get("text") or "").strip()
                external_id = frame.get("visitor_external_id") or f"web-{uuid.uuid4().hex}"
                if not text:
                    await websocket.send_json(err("CHANNEL_EMPTY_MESSAGE", "訊息不可為空"))
                    continue
                inbound = NormalizedInbound(
                    external_id=external_id,
                    text=text,
                    content_type=frame.get("content_type", "text"),
                    display_name=frame.get("display_name"),
                    meta={"provider": "web", "transport": "ws"},
                )
                session_id = await channel_out.ingest_inbound(
                    db, channel.tenant_id, channel.id, inbound
                )
                await websocket.send_json(
                    ok({"session_id": str(session_id) if session_id else None})
                )
        except WebSocketDisconnect:
            return


# --------------------------------------------------------------------------- #
# W6 頁面軌跡(page trail):公開上報 + 坐席讀取
#
# 純新增,不動既有端點。
# - 公開上報:widget 於訪客瀏覽頁面時呼叫,無 JWT,靠 channel public_key 定位租戶/渠道,
#   對齊 get_or_create_visitor 身份鍵(tenant+channel+external_id)定位/建立訪客後寫一筆
#   PageView。防濫用:url 必填且長度上限、title/referrer 截斷、每訪客僅保留最近 N 筆
#   (插入後裁剪較舊者)。任何失敗一律優雅降級(回 recorded:false),不影響訪客瀏覽/聊天。
# - 坐席讀取:CurrentStaff,tenant 隔離,回某訪客最近 N 筆(倒序,最新在前)。
# --------------------------------------------------------------------------- #
class WebPageViewIn(BaseModel):
    visitor_external_id: str
    url: str
    title: str | None = None
    referrer: str | None = None


class WebEventIn(BaseModel):
    """訪客端自訂事件上報(對應 event 型目標)。

    ``value_cents`` 為可選的本次成交價值覆寫(如購物車金額);負值視為未提供,
    沿用目標本身的 value_cents(公開端點不 400,優雅降級)。
    """

    visitor_external_id: str
    event_name: str
    value_cents: int | None = None


# 每訪客保留的頁面軌跡上限(插入後裁剪舊筆,防單一訪客灌爆)
_PAGEVIEW_KEEP_PER_VISITOR = 50
# url / referrer 長度上限(對齊 PageView.url 欄位 String(2000)),超長截斷
_PAGEVIEW_URL_MAX = 2000
# title 長度上限(對齊 PageView.title 欄位 String(500)),超長截斷
_PAGEVIEW_TITLE_MAX = 500


async def _trim_pageviews(
    db: AsyncSession, tenant_id: uuid.UUID, visitor_id: uuid.UUID
) -> None:
    """僅保留該訪客最近 ``_PAGEVIEW_KEEP_PER_VISITOR`` 筆頁面軌跡,較舊者硬刪。

    軌跡為輔助資料、量大且可再生,無需軟刪。以 (tenant, visitor) 過濾確保租戶隔離。
    """
    ids = (
        await db.execute(
            select(PageView.id)
            .where(
                PageView.tenant_id == tenant_id,
                PageView.visitor_id == visitor_id,
            )
            .order_by(PageView.occurred_at.desc())
        )
    ).scalars().all()
    stale = ids[_PAGEVIEW_KEEP_PER_VISITOR:]
    if stale:
        await db.execute(delete(PageView).where(PageView.id.in_(stale)))


# --------------------------------------------------------------------------- #
# 目標追蹤(url 型):pageview 命中啟用中的 url 目標 → 記一筆 GoalConversion
#
# 純加值:於既有 pageview 上報端點內、pageview 成功落地「之後」比對,獨立 try/except
# 與獨立 commit,任何失敗都不影響已提交的 pageview。去重用既有欄位判斷(不新增 migration):
# 同一 visitor+goal 於 _GOAL_DEDUP_WINDOW 內、或同一會話(session)僅記一次。
# --------------------------------------------------------------------------- #
# 同一訪客同一目標的去重時間窗(避免重整/多次瀏覽同頁灌爆達成)
_GOAL_DEDUP_WINDOW = timedelta(hours=6)


async def _goal_recently_converted(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    goal_id: uuid.UUID,
    visitor_id: uuid.UUID,
    session_id: uuid.UUID | None,
) -> bool:
    """該 visitor+goal 是否已在去重窗內、或於同一會話記過達成(去重判斷)。"""
    since = datetime.now(timezone.utc) - _GOAL_DEDUP_WINDOW
    # 時間窗命中即去重;若本次能歸因到會話,另把「同會話已達成」也視為重複
    dedup = GoalConversion.occurred_at >= since
    if session_id is not None:
        dedup = or_(dedup, GoalConversion.session_id == session_id)
    existing = (
        await db.execute(
            select(GoalConversion.id)
            .where(
                and_(
                    GoalConversion.tenant_id == tenant_id,
                    GoalConversion.goal_id == goal_id,
                    GoalConversion.visitor_id == visitor_id,
                    GoalConversion.deleted_at.is_(None),
                    dedup,
                )
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    return existing is not None


async def _match_url_goals(
    db: AsyncSession, tenant_id: uuid.UUID, visitor_id: uuid.UUID, url: str
) -> None:
    """比對本租戶啟用中的 url 型目標;config.url_contains 命中本次 url 且未去重則記達成。

    歸因會話取該訪客「最近一個未結束(非 closed)會話」(以最後訊息/建立時間排序),
    可為 None;成交坐席歸因該會話的指派坐席(``Session.handler_staff_id``,無則 NULL),
    供逐坐席 sales 排行。命中多個目標時各記一筆;有寫入才 commit。
    """
    goals = (
        await db.execute(
            select(Goal).where(
                Goal.tenant_id == tenant_id,
                Goal.kind == "url",
                Goal.is_active.is_(True),
                Goal.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    if not goals:
        return

    # 先算出可命中的目標(config.url_contains 為非空字串且為本次 url 子字串)
    hits = [
        g
        for g in goals
        if isinstance((g.config or {}).get("url_contains"), str)
        and (g.config or {}).get("url_contains")
        and (g.config or {}).get("url_contains") in url
    ]
    if not hits:
        return

    # 該訪客最近一個未結束會話(供歸因);coalesce 避免 last_message_at 為 NULL 時排序不定。
    # 一併取該會話的指派坐席(handler_staff_id)做成交坐席歸因,無會話/未指派則皆為 None。
    session_row = (
        await db.execute(
            select(Session.id, Session.handler_staff_id)
            .where(
                Session.tenant_id == tenant_id,
                Session.visitor_id == visitor_id,
                Session.status != "closed",
                Session.deleted_at.is_(None),
            )
            .order_by(func.coalesce(Session.last_message_at, Session.created_at).desc())
            .limit(1)
        )
    ).first()
    session_id = session_row[0] if session_row else None
    staff_id = session_row[1] if session_row else None

    wrote = False
    for goal in hits:
        if await _goal_recently_converted(db, tenant_id, goal.id, visitor_id, session_id):
            continue
        db.add(
            GoalConversion(
                tenant_id=tenant_id,
                goal_id=goal.id,
                visitor_id=visitor_id,
                session_id=session_id,
                staff_id=staff_id,
                value_cents=goal.value_cents,
            )
        )
        wrote = True
    if wrote:
        await db.commit()


@router.post("/web/{channel_key}/pageview")
async def web_report_pageview(channel_key: str, body: WebPageViewIn, db: DbSession):
    """公開頁面瀏覽上報(無 JWT)。

    以 channel ``public_key`` 定位 web 渠道 → 對齊 ``get_or_create_visitor`` 身份鍵
    (tenant+channel+external_id)定位/建立訪客 → 寫一筆 PageView 並裁剪舊筆。
    channelKey 無效或非 web 型回 404;缺 visitor_external_id / url 回 400;
    其餘任何執行失敗優雅降級(回 recorded:false,HTTP 200),不阻擋訪客端。
    """
    channel = await _channel_by_public_key(db, channel_key)
    if channel is None or channel.type != channel_out.CHANNEL_WEB:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "widget 渠道不存在"))

    external_id = (body.visitor_external_id or "").strip()
    if not external_id:
        return JSONResponse(
            status_code=400, content=err("CHANNEL_VISITOR_REQUIRED", "缺少 visitor_external_id")
        )

    url = (body.url or "").strip()
    if not url:
        return JSONResponse(
            status_code=400, content=err("CHANNEL_PAGEVIEW_EMPTY_URL", "url 不可為空")
        )
    # 防濫用:長度截斷(對齊欄位上限,避免超長字串寫入失敗)
    url = url[:_PAGEVIEW_URL_MAX]
    title = body.title[:_PAGEVIEW_TITLE_MAX] if body.title else None
    referrer = body.referrer[:_PAGEVIEW_URL_MAX] if body.referrer else None

    # 對齊既有 web 端點:以 seam 取 get_or_create_visitor(便於測試 monkeypatch),
    # 未就緒或執行失敗則優雅降級,不阻擋訪客瀏覽。
    get_or_create_visitor = channel_out._resolve_seam(
        "app.services.visitor", "get_or_create_visitor"
    )
    if get_or_create_visitor is None:
        return ok({"recorded": False})
    try:
        visitor = await get_or_create_visitor(
            db, channel.tenant_id, channel.id, external_id
        )
        db.add(
            PageView(
                tenant_id=channel.tenant_id,
                visitor_id=visitor.id,
                url=url,
                title=title,
                referrer=referrer,
            )
        )
        await db.flush()
        await _trim_pageviews(db, channel.tenant_id, visitor.id)
        await db.commit()
    except Exception:  # 軌跡為加值資料,任何失敗都不影響訪客端
        logger.exception("web pageview 上報失敗(channel=%s)", channel.id)
        return ok({"recorded": False})

    # pageview 已落地:比對 url 型目標並記達成(獨立 try/except + 獨立 commit,
    # 任何失敗都不回滾/不影響已提交的 pageview 與訪客端回應)。
    try:
        await _match_url_goals(db, channel.tenant_id, visitor.id, url)
    except Exception:
        logger.exception("url 目標比對失敗(channel=%s)", channel.id)
    return ok({"recorded": True})


# --------------------------------------------------------------------------- #
# 目標追蹤(event 型):訪客端自訂事件上報 → 命中啟用中的 event 目標 → 記 GoalConversion
#
# 讓 event 型目標可用(先前無上報端點=死型別)。與 pageview 同層的公開 web 端點,
# 沿用同一 visitor 定位(get_or_create_visitor 身份鍵)、去重(_goal_recently_converted)
# 與坐席歸因(最近未結束會話的指派坐席)。任何失敗優雅降級,不阻擋訪客端。
# --------------------------------------------------------------------------- #
async def _match_event_goals(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    visitor_id: uuid.UUID,
    event_name: str,
    value_override: int | None,
) -> int:
    """比對本租戶啟用中的 event 型目標;config.event_name == event_name 命中且未去重則記達成。

    坐席歸因同 url 型:取該訪客最近未結束會話的指派坐席(handler_staff_id),無則 NULL。
    value_override(>=0)覆寫本次成交價值,未給則沿用 goal.value_cents。回記錄筆數。
    """
    goals = (
        await db.execute(
            select(Goal).where(
                Goal.tenant_id == tenant_id,
                Goal.kind == "event",
                Goal.is_active.is_(True),
                Goal.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    # 精確比對事件名(url 型用子字串,event 型用等值,語意更明確)
    hits = [g for g in goals if (g.config or {}).get("event_name") == event_name]
    if not hits:
        return 0

    # 最近未結束會話 + 其指派坐席(供歸因),無會話/未指派則皆 None
    session_row = (
        await db.execute(
            select(Session.id, Session.handler_staff_id)
            .where(
                Session.tenant_id == tenant_id,
                Session.visitor_id == visitor_id,
                Session.status != "closed",
                Session.deleted_at.is_(None),
            )
            .order_by(func.coalesce(Session.last_message_at, Session.created_at).desc())
            .limit(1)
        )
    ).first()
    session_id = session_row[0] if session_row else None
    staff_id = session_row[1] if session_row else None

    wrote = 0
    for goal in hits:
        if await _goal_recently_converted(db, tenant_id, goal.id, visitor_id, session_id):
            continue
        value_cents = value_override if value_override is not None else goal.value_cents
        db.add(
            GoalConversion(
                tenant_id=tenant_id,
                goal_id=goal.id,
                visitor_id=visitor_id,
                session_id=session_id,
                staff_id=staff_id,
                value_cents=value_cents,
            )
        )
        wrote += 1
    if wrote:
        await db.commit()
    return wrote


@router.post("/web/{channel_key}/event")
async def web_report_event(channel_key: str, body: WebEventIn, db: DbSession):
    """公開自訂事件上報(無 JWT),讓 event 型目標可用。

    以 channel ``public_key`` 定位 web 渠道 → 對齊 ``get_or_create_visitor`` 身份鍵
    (tenant+channel+external_id)定位/建立訪客 → 比對本租戶啟用中的 event 目標
    (config.event_name 命中)並記 GoalConversion(去重同 pageview)。
    channelKey 無效或非 web 型回 404;缺 visitor_external_id / event_name 回 400;
    其餘任何執行失敗優雅降級(回 recorded:false,HTTP 200),不阻擋訪客端。
    """
    channel = await _channel_by_public_key(db, channel_key)
    if channel is None or channel.type != channel_out.CHANNEL_WEB:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "widget 渠道不存在"))

    external_id = (body.visitor_external_id or "").strip()
    if not external_id:
        return JSONResponse(
            status_code=400, content=err("CHANNEL_VISITOR_REQUIRED", "缺少 visitor_external_id")
        )

    event_name = (body.event_name or "").strip()
    if not event_name:
        return JSONResponse(
            status_code=400, content=err("CHANNEL_EVENT_EMPTY_NAME", "event_name 不可為空")
        )
    # 負值視為未提供(公開端點不 400,避免污染 sales 聚合;沿用目標本身價值)
    value_override = body.value_cents if (body.value_cents is not None and body.value_cents >= 0) else None

    get_or_create_visitor = channel_out._resolve_seam(
        "app.services.visitor", "get_or_create_visitor"
    )
    if get_or_create_visitor is None:
        return ok({"recorded": False})
    try:
        visitor = await get_or_create_visitor(
            db, channel.tenant_id, channel.id, external_id
        )
        recorded = await _match_event_goals(
            db, channel.tenant_id, visitor.id, event_name, value_override
        )
    except Exception:  # 目標追蹤為加值資料,任何失敗都不影響訪客端
        logger.exception("event 目標上報失敗(channel=%s)", channel.id)
        return ok({"recorded": False})

    return ok({"recorded": recorded > 0, "conversions": recorded})


@router.get("/visitors/{visitor_id}/pageviews")
async def visitor_pageviews(
    visitor_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
    limit: int = Query(default=50, ge=1, le=200),
):
    """坐席讀取某訪客最近的頁面瀏覽軌跡(倒序,最新在前)。

    tenant 隔離:先確認 visitor 屬於 ``staff.tenant_id``(不存在/跨租戶一律 404,
    不洩漏他租戶訪客是否存在);pageview 查詢亦以 tenant + visitor 過濾。
    """
    visitor = (
        await db.execute(
            select(Visitor).where(
                Visitor.id == visitor_id,
                Visitor.tenant_id == staff.tenant_id,
                Visitor.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if visitor is None:
        return JSONResponse(status_code=404, content=err("VISITOR_NOT_FOUND", "訪客不存在"))

    rows = (
        await db.execute(
            select(PageView)
            .where(
                PageView.tenant_id == staff.tenant_id,
                PageView.visitor_id == visitor_id,
                PageView.deleted_at.is_(None),
            )
            .order_by(PageView.occurred_at.desc())
            .limit(limit)
        )
    ).scalars().all()

    return ok({
        "pageviews": [
            {
                "id": str(r.id),
                "url": r.url,
                "title": r.title,
                "referrer": r.referrer,
                "occurred_at": r.occurred_at.isoformat() if r.occurred_at else None,
            }
            for r in rows
        ]
    })
