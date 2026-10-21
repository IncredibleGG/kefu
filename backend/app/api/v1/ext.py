"""開放 REST API(/api/ext/v1):供租戶的外部系統以 API key 整合。

掛載前綴(整合方於 main.py 註冊):/api/ext/v1
認證:API key(非 JWT),見 core/apikey_auth.get_api_key_context;注入的
CurrentApiKey.tenant_id 是唯一租戶來源,所有查詢一律以它隔離。

端點:
- POST /sessions        建立 / 取得會話(需 channel_id + visitor_external_id)
- POST /messages        送訊:帶 session_id 直接建訊;或帶 channel + visitor 走入站管線
- GET  /contacts        列出聯絡人(客戶主檔)
- GET  /conversations   列出會話

成功走 response.ok 信封;錯誤一律 raise HTTPException(正確狀態碼, detail={code,message}),
由全域處理器包成統一信封並保留狀態碼(查無 → 404 not_found,輸入不合法 →
400 bad_request)。跨模組核心行為重用既有 seam(conversation / visitor /
channel_out),不重複實作。
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.apikey_auth import CurrentApiKey
from app.core.deps import DbSession
from app.core.response import ok
from app.models.conversation import Channel, Message, Session
from app.models.visitor import Contact
from app.services import channel_out
from app.services.conversation import add_message, get_or_open_session
from app.services.telegram import NormalizedInbound
from app.services.visitor import get_or_create_visitor

router = APIRouter()


# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #
class ExtSessionIn(BaseModel):
    channel_id: uuid.UUID
    visitor_external_id: str = Field(min_length=1, max_length=255)
    display_name: str | None = None


class ExtMessageIn(BaseModel):
    content: str = Field(min_length=1)
    content_type: str = "text"
    # 路徑一:對既有會話直接建訊
    session_id: uuid.UUID | None = None
    # 路徑二:走入站管線(自動建/取 visitor + session,並觸發 AI 派發)
    channel_id: uuid.UUID | None = None
    visitor_external_id: str | None = None
    display_name: str | None = None


# --------------------------------------------------------------------------- #
# 整形
# --------------------------------------------------------------------------- #
def _session_out(s: Session) -> dict:
    return {
        "id": str(s.id),
        "channel_id": str(s.channel_id),
        "visitor_id": str(s.visitor_id),
        "status": s.status,
        "handler_type": s.handler_type,
        "handler_staff_id": str(s.handler_staff_id) if s.handler_staff_id else None,
        "last_message_at": s.last_message_at.isoformat() if s.last_message_at else None,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "closed_at": s.closed_at.isoformat() if s.closed_at else None,
    }


def _message_out(m: Message) -> dict:
    return {
        "id": str(m.id),
        "session_id": str(m.session_id),
        "sender_type": m.sender_type,
        "sender_id": str(m.sender_id) if m.sender_id else None,
        "content_type": m.content_type,
        "content": m.content,
        "meta": m.meta,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


def _contact_out(c: Contact) -> dict:
    return {
        "id": str(c.id),
        "name": c.name,
        "email": c.email,
        "phone": c.phone,
        "attributes": c.attributes,
        "is_blocked": c.is_blocked,
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }


async def _get_owned_channel(db, tenant_id: uuid.UUID, channel_id: uuid.UUID) -> Channel | None:
    return (
        await db.execute(
            select(Channel).where(
                Channel.id == channel_id,
                Channel.tenant_id == tenant_id,
                Channel.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


# --------------------------------------------------------------------------- #
# POST /sessions
# --------------------------------------------------------------------------- #
@router.post("/sessions")
async def create_session(body: ExtSessionIn, ctx: CurrentApiKey, db: DbSession):
    """建立 / 取得該訪客在該渠道的會話(以 API key 的租戶隔離)。"""
    channel = await _get_owned_channel(db, ctx.tenant_id, body.channel_id)
    if channel is None:
        raise HTTPException(
            status_code=404, detail={"code": "not_found", "message": "channel not found"}
        )

    visitor = await get_or_create_visitor(
        db,
        ctx.tenant_id,
        body.channel_id,
        body.visitor_external_id,
        display_name=body.display_name,
    )
    session = await get_or_open_session(db, ctx.tenant_id, body.channel_id, visitor.id)
    await db.commit()
    return ok(_session_out(session))


# --------------------------------------------------------------------------- #
# POST /messages
# --------------------------------------------------------------------------- #
@router.post("/messages")
async def create_message(body: ExtMessageIn, ctx: CurrentApiKey, db: DbSession):
    """送訊。兩種模式擇一:

    - 帶 ``session_id``:對既有會話直接寫入一則訪客訊息(sender_type=visitor)。
    - 帶 ``channel_id`` + ``visitor_external_id``:走標準入站管線(建/取 visitor +
      session、落訊、觸發 AI 派發),回傳 session_id。
    """
    if body.session_id is not None:
        session = (
            await db.execute(
                select(Session).where(
                    Session.id == body.session_id,
                    Session.tenant_id == ctx.tenant_id,
                    Session.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if session is None:
            raise HTTPException(
                status_code=404,
                detail={"code": "not_found", "message": "session not found"},
            )
        try:
            message = await add_message(
                db,
                ctx.tenant_id,
                body.session_id,
                sender_type="visitor",
                content=body.content,
                sender_id=session.visitor_id,
                content_type=body.content_type,
            )
        except ValueError:
            raise HTTPException(
                status_code=404,
                detail={"code": "not_found", "message": "session not found"},
            ) from None
        await db.commit()
        return ok(_message_out(message))

    if body.channel_id is not None and body.visitor_external_id:
        channel = await _get_owned_channel(db, ctx.tenant_id, body.channel_id)
        if channel is None:
            raise HTTPException(
                status_code=404,
                detail={"code": "not_found", "message": "channel not found"},
            )
        inbound = NormalizedInbound(
            external_id=body.visitor_external_id,
            text=body.content,
            content_type=body.content_type,
            display_name=body.display_name,
            meta={"provider": "ext_api"},
        )
        session_id = await channel_out.ingest_inbound(
            db, ctx.tenant_id, body.channel_id, inbound
        )
        return ok({"session_id": str(session_id) if session_id else None})

    raise HTTPException(
        status_code=400,
        detail={
            "code": "bad_request",
            "message": "provide session_id, or channel_id + visitor_external_id",
        },
    )


# --------------------------------------------------------------------------- #
# GET /contacts
# --------------------------------------------------------------------------- #
@router.get("/contacts")
async def list_contacts(
    ctx: CurrentApiKey,
    db: DbSession,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """列出本租戶的聯絡人(客戶主檔),分頁。"""
    conds = [Contact.tenant_id == ctx.tenant_id, Contact.deleted_at.is_(None)]
    total = (
        await db.execute(select(func.count()).select_from(Contact).where(*conds))
    ).scalar_one()
    rows = (
        await db.execute(
            select(Contact)
            .where(*conds)
            .order_by(Contact.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
    ).scalars().all()
    return ok(
        {
            "items": [_contact_out(c) for c in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    )


# --------------------------------------------------------------------------- #
# GET /conversations
# --------------------------------------------------------------------------- #
@router.get("/conversations")
async def list_conversations(
    ctx: CurrentApiKey,
    db: DbSession,
    status: str | None = None,
    channel_id: uuid.UUID | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """列出本租戶的會話,分頁;可選 status / channel_id 過濾。"""
    conds = [Session.tenant_id == ctx.tenant_id, Session.deleted_at.is_(None)]
    if status is not None:
        conds.append(Session.status == status)
    if channel_id is not None:
        conds.append(Session.channel_id == channel_id)
    total = (
        await db.execute(select(func.count()).select_from(Session).where(*conds))
    ).scalar_one()
    rows = (
        await db.execute(
            select(Session)
            .where(*conds)
            .order_by(Session.last_message_at.desc().nullslast(), Session.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
    ).scalars().all()
    return ok(
        {
            "items": [_session_out(s) for s in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    )
