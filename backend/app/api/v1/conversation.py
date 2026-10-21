"""M3 會話 API + 即時 WebSocket。

- ``router``(REST,前綴 /api/v1/conversation):會話列表(Tabs)、單一會話+訊息歷史、
  坐席送訊、接管/轉接(handoff)、結束會話。
- ``ws_router``(WebSocket,無前綴):/ws/agent(坐席端,JWT)、/ws/widget(訪客端)。

所有查詢一律以 tenant_id 過濾;回應統一走 ok()/err() 信封。
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from sqlalchemy import String, cast, exists, func, or_, select

from app.core.db import SessionLocal
from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.core.security import decode_access_token
from app.models.conversation import Message, Session
from app.models.tag import Tag, TagRelation
from app.models.visitor import Contact, Visitor
from app.services import realtime
from app.services import channel_out
from app.services import presence
from app.services.conversation import add_message, close_session, handoff_origin

router = APIRouter()
ws_router = APIRouter()

logger = logging.getLogger("kefu.conversation.api")


# ============================ REST：資料整形 ============================

def _session_summary(
    s: Session,
    visitor: dict | None = None,
    *,
    last_message_preview: str | None = None,
    unread_count: int | None = None,
    tags: list[str] | None = None,
) -> dict:
    """會話列表用的精簡表示。

    ``visitor`` 若提供,則內嵌該會話的訪客序列化物件(含關聯 contact 的 attributes
    與 visitor 的 ai_profile),供工作台情境面板直接取用;未提供則不帶此鍵(接管 /
    轉接 / 結束 / 翻譯開關等回應維持原樣,不受影響)。

    ``last_message_preview`` / ``unread_count`` / ``tags`` 為會話列分流體驗欄位:
    僅在會話列表端點(list_sessions)以「一批會話批量載入」的方式提供(避免 N+1),
    其餘會話回應(接管 / 轉接 / 結束 / 翻譯開關等)不帶這些鍵,維持既有形狀不變。
    """
    data = {
        "id": str(s.id),
        "channel_id": str(s.channel_id),
        "visitor_id": str(s.visitor_id),
        "status": s.status,
        "handler_type": s.handler_type,
        "handler_staff_id": str(s.handler_staff_id) if s.handler_staff_id else None,
        "skill_group_id": str(s.skill_group_id) if s.skill_group_id else None,
        "last_message_at": s.last_message_at.isoformat() if s.last_message_at else None,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "closed_at": s.closed_at.isoformat() if s.closed_at else None,
        # 翻譯狀態(供前端頭部開關與呈現)
        "translate_enabled": s.translate_enabled,
        "agent_lang": s.agent_lang,
        "visitor_lang": s.visitor_lang,
        # 稍後處理(snooze):延後到期時間;None=未延後(供會話列「已延後至 X」標示與過濾)
        "snoozed_until": s.snoozed_until.isoformat() if s.snoozed_until else None,
    }
    if visitor is not None:
        data["visitor"] = visitor
    # 會話列分流欄位:僅在提供時附加(list_sessions 一律提供;其餘端點不帶,形狀不變)
    if last_message_preview is not None:
        data["last_message_preview"] = last_message_preview
    if unread_count is not None:
        data["unread_count"] = unread_count
    if tags is not None:
        data["tags"] = tags
    return data


# ============================ REST:會話訪客內嵌序列化(供工作台情境面板) ============================
# 只做序列化:把會話關聯的訪客(含關聯 contact 的 attributes 與 visitor 的 ai_profile)
# 內嵌進會話回應。全程 tenant 隔離;以「一批會話 → 三次 IN 查詢(訪客/聯絡人/標籤)」
# 批量載入,避免逐會話 N+1。不觸碰任何對話收發流程。

def _embedded_visitor_out(v: Visitor, contact: Contact | None, tag_ids: list[str]) -> dict:
    """訪客內嵌序列化:基本欄位 + ai_profile + 關聯 contact(含 attributes)+ 標籤 id。"""
    return {
        "id": str(v.id),
        "channel_id": str(v.channel_id),
        "external_id": v.external_id,
        "display_name": v.display_name,
        "avatar_url": v.avatar_url,
        "contact_id": str(v.contact_id) if v.contact_id else None,
        "is_blocked": v.is_blocked,
        # AI 畫像(意圖 / 情緒 / 標籤 / 摘要,由 M6 dispatch 淺層合併寫入)
        "ai_profile": v.ai_profile,
        "created_at": v.created_at.isoformat() if v.created_at else None,
        # 關聯 CRM 聯絡人:attributes 為情境面板「自訂屬性」的來源
        "contact": {
            "id": str(contact.id),
            "name": contact.name,
            "email": contact.email,
            "phone": contact.phone,
            "attributes": contact.attributes,
            "note": contact.note,
            "is_blocked": contact.is_blocked,
            "created_at": contact.created_at.isoformat() if contact.created_at else None,
        }
        if contact is not None
        else None,
        "tags": tag_ids,
    }


async def _visitor_tag_ids_bulk(
    db, tenant_id: uuid.UUID, visitor_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[str]]:
    """一次撈出多個訪客的標籤關聯(target_type='visitor'),回 visitor_id → tag_id 清單。"""
    if not visitor_ids:
        return {}
    rows = (
        await db.execute(
            select(TagRelation.target_id, TagRelation.tag_id).where(
                TagRelation.tenant_id == tenant_id,
                TagRelation.target_type == "visitor",
                TagRelation.target_id.in_(visitor_ids),
                TagRelation.deleted_at.is_(None),
            )
        )
    ).all()
    out: dict[uuid.UUID, list[str]] = {}
    for target_id, tag_id in rows:
        out.setdefault(target_id, []).append(str(tag_id))
    return out


async def _load_session_visitors(
    db, tenant_id: uuid.UUID, sessions: list[Session]
) -> dict[uuid.UUID, dict]:
    """批量載入一批會話的訪客內嵌序列化物件,回 visitor_id → visitor dict。

    效率:訪客、聯絡人、標籤各一次 IN 查詢(共 3 次),與會話數無關,避免 N+1。
    隔離:全部以 tenant_id 過濾。
    """
    visitor_ids = {s.visitor_id for s in sessions if s.visitor_id}
    if not visitor_ids:
        return {}
    visitors = (
        await db.execute(
            select(Visitor).where(
                Visitor.tenant_id == tenant_id,
                Visitor.id.in_(visitor_ids),
                Visitor.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    if not visitors:
        return {}

    contact_ids = {v.contact_id for v in visitors if v.contact_id}
    contacts: dict[uuid.UUID, Contact] = {}
    if contact_ids:
        crows = (
            await db.execute(
                select(Contact).where(
                    Contact.tenant_id == tenant_id,
                    Contact.id.in_(contact_ids),
                    Contact.deleted_at.is_(None),
                )
            )
        ).scalars().all()
        contacts = {c.id: c for c in crows}

    tag_map = await _visitor_tag_ids_bulk(db, tenant_id, [v.id for v in visitors])

    out: dict[uuid.UUID, dict] = {}
    for v in visitors:
        contact = contacts.get(v.contact_id) if v.contact_id else None
        out[v.id] = _embedded_visitor_out(v, contact, tag_map.get(v.id, []))
    return out


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
        # 已讀送達回執:被對向讀取的時間;None=尚未讀
        "read_at": m.read_at.isoformat() if m.read_at else None,
    }


# ============================ REST：會話層標籤 helper ============================

async def _session_tag_ids(db, tenant_id: uuid.UUID, session_id: uuid.UUID) -> list[str]:
    """回傳套用在該會話上的標籤 id 清單(target_type='session')。"""
    rows = (
        await db.execute(
            select(TagRelation.tag_id).where(
                TagRelation.tenant_id == tenant_id,
                TagRelation.target_type == "session",
                TagRelation.target_id == session_id,
                TagRelation.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    return [str(r) for r in rows]


# ============================ REST：會話列分流體驗批量載入 ============================
# 一批會話 → 各以「單次查詢」補齊「最後訊息預覽 / 未讀數 / 會話標籤」,
# 與會話數無關(不逐會話查),避免 N+1;全程 tenant 隔離。

# 會話列可見的對話訊息寄件方(排除 note 私密備註、system 系統軌跡),
# 用來取「最後一則對話訊息」作預覽,與 last_message_at 的活躍語意一致。
_CONVERSATION_SENDER_TYPES = ("visitor", "ai", "human")

# 預覽截斷長度(字元)
_PREVIEW_MAX_CHARS = 60


def _preview_text(content: str | None, content_type: str | None) -> str:
    """把一則訊息壓成單行短預覽:折疊空白 / 換行,截斷至 ~60 字。

    content 於落庫時已過信用卡號遮罩(見 services.conversation.add_message),
    故此處取用即為「遮罩後內容」,不會外洩完整卡號。非文字型別(image/file/card)
    的 content 多為可讀回退文字 / 檔名,一併壓成短預覽即可。
    """
    text = " ".join((content or "").split())
    if len(text) > _PREVIEW_MAX_CHARS:
        text = text[:_PREVIEW_MAX_CHARS] + "…"
    return text


async def _last_message_previews_bulk(
    db, tenant_id: uuid.UUID, session_ids: list[uuid.UUID]
) -> dict[uuid.UUID, str]:
    """一次取出多個會話的「最後一則對話訊息」短預覽,回 session_id → 預覽文字。

    效率:以視窗函式(row_number over partition by session_id)一次查詢取每會話最新
    一則,與會話數無關,避免逐會話 N+1。
    """
    if not session_ids:
        return {}
    rn = func.row_number().over(
        partition_by=Message.session_id,
        order_by=(Message.created_at.desc(), Message.id.desc()),
    ).label("rn")
    inner = (
        select(
            Message.session_id.label("sid"),
            Message.content.label("content"),
            Message.content_type.label("content_type"),
            rn,
        )
        .where(
            Message.tenant_id == tenant_id,
            Message.session_id.in_(session_ids),
            Message.sender_type.in_(_CONVERSATION_SENDER_TYPES),
            Message.deleted_at.is_(None),
        )
        .subquery()
    )
    rows = (
        await db.execute(
            select(inner.c.sid, inner.c.content, inner.c.content_type).where(inner.c.rn == 1)
        )
    ).all()
    return {sid: _preview_text(content, content_type) for sid, content, content_type in rows}


async def _unread_counts_bulk(
    db, tenant_id: uuid.UUID, session_ids: list[uuid.UUID]
) -> dict[uuid.UUID, int]:
    """一次取出多個會話的坐席未讀數,回 session_id → 未讀數。

    未讀定義:訪客(對向)送出、且尚未被坐席讀取(read_at IS NULL)的訊息數。
    與既有已讀機制一致(坐席 POST /read 會把訪客訊息 read_at 設為 now),因此重整後
    仍能由後端算回真實未讀數(修正「重整後歸零」)。以 GROUP BY 一次查詢,避免 N+1。
    """
    if not session_ids:
        return {}
    rows = (
        await db.execute(
            select(Message.session_id, func.count())
            .where(
                Message.tenant_id == tenant_id,
                Message.session_id.in_(session_ids),
                Message.sender_type == "visitor",
                Message.read_at.is_(None),
                Message.deleted_at.is_(None),
            )
            .group_by(Message.session_id)
        )
    ).all()
    return {sid: int(cnt) for sid, cnt in rows}


async def _session_tag_names_bulk(
    db, tenant_id: uuid.UUID, session_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[str]]:
    """一次取出多個會話的標籤名稱(target_type='session'),回 session_id → 標籤名清單。

    回「名稱」而非 id,供會話列直接顯示標籤徽章。以一次 join 查詢,避免 N+1。
    """
    if not session_ids:
        return {}
    rows = (
        await db.execute(
            select(TagRelation.target_id, Tag.name)
            .join(Tag, Tag.id == TagRelation.tag_id)
            .where(
                TagRelation.tenant_id == tenant_id,
                TagRelation.target_type == "session",
                TagRelation.target_id.in_(session_ids),
                TagRelation.deleted_at.is_(None),
                Tag.deleted_at.is_(None),
            )
        )
    ).all()
    out: dict[uuid.UUID, list[str]] = {}
    for target_id, name in rows:
        out.setdefault(target_id, []).append(name)
    return out


# ============================ REST：會話列表 ============================

@router.get("/sessions")
async def list_sessions(
    staff: CurrentStaff,
    db: DbSession,
    tab: str = Query("online", pattern="^(mine|unassigned|queue|online)$"),
    channel_id: uuid.UUID | None = None,
    status: str | None = None,
    tag_id: uuid.UUID | None = None,
    q: str | None = Query(default=None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """會話列表,支援 Tabs(我的/未分配/佇列/在線)、渠道與狀態過濾、搜尋、分頁。

    - mine(我的):指派給自己且未結束
    - unassigned(未分配):轉人工但尚無坐席認領
    - queue(佇列):技能組排隊中(status=queued)
    - online(在線):所有進行中(未結束)的會話

    ``q``:關鍵字搜尋(ILIKE),比對訪客名 / 訪客外部 id / 會話任一則訊息內容 / 會話 id;
    以子查詢(EXISTS)實作,不逐會話查,tenant 隔離。分頁走 page / page_size(可翻頁,
    移除前端「硬上限 30 不可達」),回應含 total 供前端載入更多。

    每個 session 另附「會話列分流」欄位:``last_message_preview``(最後對話訊息短預覽)、
    ``unread_count``(坐席未讀數)、``tags``(會話標籤名);皆以批量查詢補齊,避免 N+1。
    """
    conds = [Session.tenant_id == staff.tenant_id, Session.deleted_at.is_(None)]

    if tab == "mine":
        conds += [Session.handler_staff_id == staff.staff_id, Session.status != "closed"]
    elif tab == "unassigned":
        conds += [
            Session.handler_type == "human",
            Session.handler_staff_id.is_(None),
            Session.status == "open",
        ]
    elif tab == "queue":
        conds.append(Session.status == "queued")
    else:  # online
        conds.append(Session.status != "closed")

    if channel_id is not None:
        conds.append(Session.channel_id == channel_id)
    if status is not None:
        conds.append(Session.status == status)
    if tag_id is not None:
        # 依會話層標籤過濾:只取有此標籤關聯的會話
        conds.append(
            Session.id.in_(
                select(TagRelation.target_id).where(
                    TagRelation.tenant_id == staff.tenant_id,
                    TagRelation.tag_id == tag_id,
                    TagRelation.target_type == "session",
                    TagRelation.deleted_at.is_(None),
                )
            )
        )

    # 關鍵字搜尋(ILIKE):比對訪客名 / 訪客外部 id / 會話任一則訊息內容 / 會話 id。
    # 以相關子查詢(EXISTS)接到 Session,單一 SQL 完成,不逐會話查(非 N+1),並全程 tenant 隔離。
    q_norm = (q or "").strip()
    if q_norm:
        like = f"%{q_norm}%"
        visitor_match = exists(
            select(Visitor.id).where(
                Visitor.tenant_id == staff.tenant_id,
                Visitor.id == Session.visitor_id,
                Visitor.deleted_at.is_(None),
                or_(
                    Visitor.display_name.ilike(like),
                    Visitor.external_id.ilike(like),
                ),
            )
        )
        message_match = exists(
            select(Message.id).where(
                Message.tenant_id == staff.tenant_id,
                Message.session_id == Session.id,
                Message.deleted_at.is_(None),
                Message.sender_type.in_(_CONVERSATION_SENDER_TYPES),
                Message.content.ilike(like),
            )
        )
        conds.append(
            or_(
                visitor_match,
                message_match,
                cast(Session.id, String).ilike(like),
            )
        )

    total = (
        await db.execute(select(func.count()).select_from(Session).where(*conds))
    ).scalar_one()
    rows = (
        await db.execute(
            select(Session)
            .where(*conds)
            .order_by(Session.last_message_at.desc().nullslast(), Session.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).scalars().all()

    # 批量載入訪客內嵌序列化(含 contact.attributes 與 ai_profile),避免逐會話 N+1
    visitor_map = await _load_session_visitors(db, staff.tenant_id, rows)

    # 會話列分流欄位:最後訊息預覽 / 未讀數 / 標籤,各以「單次查詢」批量補齊(避免 N+1)
    session_ids = [s.id for s in rows]
    preview_map = await _last_message_previews_bulk(db, staff.tenant_id, session_ids)
    unread_map = await _unread_counts_bulk(db, staff.tenant_id, session_ids)
    tags_map = await _session_tag_names_bulk(db, staff.tenant_id, session_ids)

    return ok(
        {
            "items": [
                _session_summary(
                    s,
                    visitor_map.get(s.visitor_id),
                    last_message_preview=preview_map.get(s.id, ""),
                    unread_count=unread_map.get(s.id, 0),
                    tags=tags_map.get(s.id, []),
                )
                for s in rows
            ],
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    )


# ============================ REST：單一會話 + 訊息歷史 ============================

@router.get("/sessions/{session_id}")
async def get_session(
    session_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
    limit: int = Query(50, ge=1, le=200),
    before: uuid.UUID | None = None,
):
    """單一會話詳情 + 訊息歷史(依 created_at 倒序游標分頁,before 為某訊息 id)。"""
    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        return err("not_found", "session not found")

    msg_conds = [
        Message.tenant_id == staff.tenant_id,
        Message.session_id == session_id,
        Message.deleted_at.is_(None),
    ]
    if before is not None:
        anchor = (
            await db.execute(
                select(Message.created_at).where(
                    Message.id == before, Message.tenant_id == staff.tenant_id
                )
            )
        ).scalar_one_or_none()
        if anchor is not None:
            msg_conds.append(Message.created_at < anchor)

    msgs = (
        await db.execute(
            select(Message)
            .where(*msg_conds)
            .order_by(Message.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    # 回傳時轉為正序(由舊到新)方便前端渲染
    messages = [_message_out(m) for m in reversed(msgs)]

    # 會話層標籤(供前端頭部顯示)
    tag_ids = await _session_tag_ids(db, staff.tenant_id, session_id)

    # 內嵌訪客序列化(含 contact.attributes 與 ai_profile),供情境面板直接取用
    visitor_map = await _load_session_visitors(db, staff.tenant_id, [session])

    return ok(
        {
            "session": _session_summary(session, visitor_map.get(session.visitor_id)),
            "messages": messages,
            "tags": tag_ids,
        }
    )


# ============================ REST：坐席送出訊息 ============================

class SendMessageIn(BaseModel):
    content: str
    content_type: str = "text"
    meta: dict | None = None


async def _translate_outbound(
    db, tenant_id, session: Session, content: str, content_type: str, meta: dict
) -> tuple[str, dict]:
    """坐席出站翻譯:若會話啟用翻譯且已知訪客語言,把坐席原文翻成訪客語言。

    回傳 (要落庫的 content, 要落庫的 meta)。**content 存譯文**(訪客只看到譯文),
    meta.i18n 保留坐席原文供坐席端對照。僅翻譯文字類;失敗則降級送原文。
    """
    if not session.translate_enabled or not session.visitor_lang:
        return content, meta
    if content_type not in ("text", "markdown") or not (content or "").strip():
        return content, meta
    agent_lang = session.agent_lang or "zh-Hant"
    if session.visitor_lang == agent_lang:
        return content, meta
    try:
        from app.services import translation

        # 翻譯供應商依租戶設定(預設 google 免費端點)
        backend, backend_cfg = await translation.resolve_backend(db, tenant_id)
        result = await translation.translate(
            content,
            session.visitor_lang,
            source_lang=agent_lang,
            backend=backend,
            backend_config=backend_cfg,
        )
        translated = result.get("text") or content
        new_meta = dict(meta)
        new_meta["i18n"] = {
            "original": content,
            "translated": translated,
            "original_lang": agent_lang,
            "translated_lang": session.visitor_lang,
            "direction": "outbound",
        }
        return translated, new_meta
    except Exception:  # 降級:送原文,不阻斷送訊
        return content, meta


@router.post("/sessions/{session_id}/messages")
async def send_message(
    session_id: uuid.UUID,
    body: SendMessageIn,
    staff: CurrentStaff,
    db: DbSession,
):
    """坐席送出訊息:寫入 message(sender_type=human)並經 realtime 推送。

    附帶兩項行為:
    - 回覆即認領(auto-claim):若會話尚未指派給本坐席(或仍由 AI 接待),送訊時自動
      認領(handler_type=human、handler_staff_id=本人、status=open),並發事件更新列表。
    - 出站翻譯:若會話啟用翻譯,content 存訪客語言譯文,meta.i18n 保留坐席原文。
    """
    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        return err("not_found", "session not found")

    # --- 已結束會話守衛:不因送訊而靜默重開 ---
    # closed 會話須經明確「重新開啟」(handoff takeover)才能續談;直接送訊一律拒絕,
    # 避免坐席誤送把已結案會話悄悄復活(前端已禁用輸入,此為伺服器端防線)。
    if session.status == "closed":
        return err("session_closed", "會話已結束,請先重新開啟再回覆")

    # --- 回覆即認領 ---
    claimed = session.handler_type != "human" or session.handler_staff_id != staff.staff_id
    previous_handler = session.handler_staff_id
    if claimed:
        session.handler_type = "human"
        session.handler_staff_id = staff.staff_id
        session.status = "open"
        await db.flush()

    # --- 出站翻譯(content 存譯文) ---
    content, meta = await _translate_outbound(
        db, staff.tenant_id, session, body.content, body.content_type, dict(body.meta or {})
    )

    try:
        message = await add_message(
            db,
            staff.tenant_id,
            session_id,
            sender_type="human",
            content=content,
            sender_id=staff.staff_id,
            content_type=body.content_type,
            meta=meta or None,
        )
    except ValueError:
        return err("not_found", "session not found")

    # 送達訪客:外部渠道(telegram/whatsapp/facebook/email)必須經 send_to_visitor 真正送出;
    # web 為 no-op(靠 add_message 的 message.new 推 widget,不重送)。此前坐席人工文字回覆
    # 漏了這步,導致轉真人後外部渠道客戶收不到坐席回覆(全渠道核心承諾)。失敗只記錄不拋。
    try:
        await channel_out.send_to_visitor(
            db, staff.tenant_id, session_id, content, content_type=body.content_type
        )
    except Exception:
        logger.exception("send_message 出站送達失敗 session=%s", session_id)

    # 認領後發事件,讓其他坐席與列表即時更新(status/擁有者變動)。
    # 此為坐席專用生命週期事件(含 handler_staff_id),只發坐席頻道,不進會話頻道以免洩漏給訪客。
    if claimed:
        event = realtime.make_event(
            "handoff",
            {
                "session_id": str(session_id),
                "action": "takeover",
                "handler_type": "human",
                "handler_staff_id": str(staff.staff_id),
                "status": session.status,
                **handoff_origin(staff.staff_id, previous_handler),
            },
        )
        await realtime.publish_agents(staff.tenant_id, event)

    await db.commit()
    return ok(_message_out(message))


# ============================ REST:翻譯開關 ============================

class TranslationToggleIn(BaseModel):
    enabled: bool
    agent_lang: str | None = None
    visitor_lang: str | None = None


@router.patch("/sessions/{session_id}/translation")
async def set_translation(
    session_id: uuid.UUID,
    body: TranslationToggleIn,
    staff: CurrentStaff,
    db: DbSession,
):
    """開關本會話的雙向翻譯(需 JWT + tenant 隔離)。

    body:{enabled, agent_lang?, visitor_lang?}。回傳更新後的會話摘要。
    """
    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        return err("not_found", "session not found")

    session.translate_enabled = body.enabled
    if body.agent_lang is not None:
        session.agent_lang = body.agent_lang
    if body.visitor_lang is not None:
        session.visitor_lang = body.visitor_lang
    await db.flush()
    await db.commit()
    return ok(_session_summary(session))


# ============================ REST：接管 / 轉接(handoff)============================

class HandoffIn(BaseModel):
    action: str  # takeover | transfer
    handler_staff_id: uuid.UUID | None = None
    skill_group_id: uuid.UUID | None = None


@router.post("/sessions/{session_id}/handoff")
async def handoff(
    session_id: uuid.UUID,
    body: HandoffIn,
    staff: CurrentStaff,
    db: DbSession,
):
    """接管 / 轉接:改 handler_type / handler_staff_id / skill_group_id,發事件並留 system 訊息。

    - takeover(接管):指派給自己,handler_type=human、status=open
    - transfer(轉接):轉給指定坐席或技能組;若只轉技能組而無坐席,置為 queued 待認領
    """
    if body.action not in ("takeover", "transfer"):
        return err("bad_request", "action must be takeover or transfer")

    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        return err("not_found", "session not found")

    previous_handler = session.handler_staff_id
    if body.action == "takeover":
        session.handler_type = "human"
        session.handler_staff_id = staff.staff_id
        session.status = "open"
        note = "坐席已接管會話"
    else:  # transfer
        session.handler_type = "human"
        session.handler_staff_id = body.handler_staff_id
        if body.skill_group_id is not None:
            session.skill_group_id = body.skill_group_id
        # 轉給技能組但未指定具體坐席 → 進佇列待認領
        session.status = "queued" if body.handler_staff_id is None else "open"
        note = "會話已轉接"

    db.add(
        Message(
            tenant_id=staff.tenant_id,
            session_id=session_id,
            sender_type="system",
            sender_id=staff.staff_id,
            content_type="text",
            content=note,
            meta={
                "event": "handoff",
                "action": body.action,
                "handler_staff_id": str(session.handler_staff_id)
                if session.handler_staff_id
                else None,
                "skill_group_id": str(session.skill_group_id) if session.skill_group_id else None,
            },
        )
    )
    await db.flush()

    event = realtime.make_event(
        "handoff",
        {
            "session_id": str(session_id),
            "action": body.action,
            "handler_type": session.handler_type,
            "handler_staff_id": str(session.handler_staff_id)
            if session.handler_staff_id
            else None,
            "skill_group_id": str(session.skill_group_id) if session.skill_group_id else None,
            "status": session.status,
            **handoff_origin(staff.staff_id, previous_handler),
        },
    )
    # 坐席專用生命週期事件(handler_staff_id/skill_group_id 等內部欄位):只發坐席頻道,不進會話頻道。
    await realtime.publish_agents(staff.tenant_id, event)
    await db.commit()
    # 行動推播「轉接給我」:commit 後才排程;轉給自己 / 只轉技能組不推(未設定 FCM 時不動作)
    if body.action == "transfer" and session.handler_staff_id is not None:
        _push_transfer(staff.tenant_id, session_id, session.handler_staff_id, staff.staff_id)
    return ok(_session_summary(session))


def _push_transfer(tenant_id, session_id, target_staff_id, actor_staff_id, note=None) -> None:
    """排程「轉接給我」推播(push 內部判斷設定 / 自己 / 前景 / 合併);失敗不影響主流程。"""
    try:
        from app.services import push

        push.on_transfer(tenant_id, session_id, target_staff_id, actor_staff_id, note)
    except Exception:  # noqa: BLE001
        logger.warning("push.on_transfer 失敗(session=%s)", session_id, exc_info=True)


# ============================ REST:結束會話 ============================

@router.post("/sessions/{session_id}/close")
async def close(
    session_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
):
    """結束會話(呼叫 close_session)。"""
    try:
        session = await close_session(
            db, staff.tenant_id, session_id, closed_by=staff.staff_id
        )
    except ValueError:
        return err("not_found", "session not found")
    await db.commit()
    return ok(_session_summary(session))


# ============================ REST：坐席私密內部備註(note）============================

class NoteIn(BaseModel):
    content: str
    meta: dict | None = None


@router.post("/sessions/{session_id}/notes")
async def add_note(
    session_id: uuid.UUID,
    body: NoteIn,
    staff: CurrentStaff,
    db: DbSession,
):
    """新增一則坐席私密內部備註(僅坐席可見)。

    寫入 sender_type='note' 的 Message,meta 記錄作者(author_staff_id）。
    **絕不經 channel_out 送給訪客、不觸發翻譯**:因此不呼叫會推播到會話頻道
    (訪客 widget 訂閱端)的 add_message,而是直接落庫,並只對「租戶坐席頻道」
    發 ``note.new`` 事件,確保訪客端永遠收不到備註。
    """
    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        return err("not_found", "session not found")

    meta = dict(body.meta or {})
    meta["author_staff_id"] = str(staff.staff_id)

    note = Message(
        tenant_id=staff.tenant_id,
        session_id=session_id,
        sender_type="note",
        sender_id=staff.staff_id,
        content_type="text",
        content=body.content,
        meta=meta,
    )
    db.add(note)
    # 備註不改動會話活躍度排序(last_message_at),避免內部備註干擾列表排序
    await db.flush()

    # 只發到坐席頻道(訪客 widget 不訂閱此頻道),絕不進會話頻道
    event = realtime.make_event(
        "note.new",
        {
            "session_id": str(session_id),
            "message_id": str(note.id),
            "author_staff_id": str(staff.staff_id),
            "content": body.content,
        },
    )
    await realtime.publish_agents(staff.tenant_id, event)
    await db.commit()
    return ok(_message_out(note))


# ============================ REST：會話層標籤 ============================

class SessionTagIn(BaseModel):
    tag_id: uuid.UUID


@router.get("/sessions/{session_id}/tags")
async def list_session_tags(
    session_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
):
    """列出套用在該會話上的標籤(回傳 tag 詳情清單)。"""
    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        return err("not_found", "session not found")

    rows = (
        await db.execute(
            select(Tag)
            .join(TagRelation, TagRelation.tag_id == Tag.id)
            .where(
                TagRelation.tenant_id == staff.tenant_id,
                TagRelation.target_type == "session",
                TagRelation.target_id == session_id,
                TagRelation.deleted_at.is_(None),
                Tag.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    return ok(
        [
            {"id": str(t.id), "name": t.name, "color": t.color, "category": t.category}
            for t in rows
        ]
    )


@router.post("/sessions/{session_id}/tags")
async def apply_session_tag(
    session_id: uuid.UUID,
    body: SessionTagIn,
    staff: CurrentStaff,
    db: DbSession,
):
    """對會話套用標籤(冪等:已存在則直接回傳目前標籤清單)。"""
    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        return err("not_found", "session not found")

    tag = (
        await db.execute(
            select(Tag).where(
                Tag.id == body.tag_id,
                Tag.tenant_id == staff.tenant_id,
                Tag.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if tag is None:
        return err("not_found", "tag not found")

    existing = (
        await db.execute(
            select(TagRelation).where(
                TagRelation.tenant_id == staff.tenant_id,
                TagRelation.tag_id == body.tag_id,
                TagRelation.target_type == "session",
                TagRelation.target_id == session_id,
                TagRelation.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        db.add(
            TagRelation(
                tenant_id=staff.tenant_id,
                tag_id=body.tag_id,
                target_type="session",
                target_id=session_id,
            )
        )
        await db.commit()

    return ok({"session_id": str(session_id), "tags": await _session_tag_ids(db, staff.tenant_id, session_id)})


@router.delete("/sessions/{session_id}/tags/{tag_id}")
async def remove_session_tag(
    session_id: uuid.UUID,
    tag_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
):
    """移除會話上的標籤(軟刪關聯;冪等)。"""
    rel = (
        await db.execute(
            select(TagRelation).where(
                TagRelation.tenant_id == staff.tenant_id,
                TagRelation.tag_id == tag_id,
                TagRelation.target_type == "session",
                TagRelation.target_id == session_id,
                TagRelation.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if rel is not None:
        rel.deleted_at = datetime.now(UTC)
        await db.commit()
    return ok({"session_id": str(session_id), "tags": await _session_tag_ids(db, staff.tenant_id, session_id)})


# ============================ REST：轉接給指定對象(transfer）============================

class TransferIn(BaseModel):
    target_staff_id: uuid.UUID | None = None
    target_skill_group_id: uuid.UUID | None = None
    note: str | None = None


@router.post("/sessions/{session_id}/transfer")
async def transfer(
    session_id: uuid.UUID,
    body: TransferIn,
    staff: CurrentStaff,
    db: DbSession,
):
    """轉接會話給指定坐席 / 技能組,或轉回佇列。

    - target_staff_id:直接指派給該坐席(handler_type=human、handler_staff_id=目標、status=open)。
    - target_skill_group_id(未指定坐席):設 skill_group_id 並進佇列(status=queued,清空 handler)。
    - 兩者皆不帶:轉回佇列(清空 handler_staff_id、status=queued),供任一坐席認領。

    附一則轉接 system 訊息(note 併入 meta 與內容),並對會話頻道與坐席頻道發 handoff 事件。
    """
    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        return err("not_found", "session not found")

    # 轉接目標存在性校驗(同租戶),避免寫入不存在 FK 才炸 IntegrityError → 500 破壞信封
    from app.models.iam import SkillGroup, Staff

    if body.target_staff_id is not None:
        ok_staff = (
            await db.execute(
                select(Staff.id).where(
                    Staff.id == body.target_staff_id,
                    Staff.tenant_id == staff.tenant_id,
                    Staff.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if ok_staff is None:
            return err("target_not_found", "target staff not found")
    if body.target_skill_group_id is not None:
        ok_sg = (
            await db.execute(
                select(SkillGroup.id).where(
                    SkillGroup.id == body.target_skill_group_id,
                    SkillGroup.tenant_id == staff.tenant_id,
                    SkillGroup.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if ok_sg is None:
            return err("target_not_found", "target skill group not found")

    previous_handler = session.handler_staff_id
    if body.target_staff_id is not None:
        # 指派給指定坐席
        session.handler_type = "human"
        session.handler_staff_id = body.target_staff_id
        if body.target_skill_group_id is not None:
            session.skill_group_id = body.target_skill_group_id
        session.status = "open"
        note_text = "會話已轉接給指定坐席"
    elif body.target_skill_group_id is not None:
        # 轉給技能組 → 進佇列待認領
        session.handler_type = "human"
        session.handler_staff_id = None
        session.skill_group_id = body.target_skill_group_id
        session.status = "queued"
        note_text = "會話已轉接給技能組並進佇列"
    else:
        # 轉回佇列(清空 handler 與 skill_group,回一般池供任一坐席認領)
        session.handler_type = "human"
        session.handler_staff_id = None
        session.skill_group_id = None
        session.status = "queued"
        note_text = "會話已轉回佇列"

    if body.note:
        note_text = f"{note_text}:{body.note}"

    db.add(
        Message(
            tenant_id=staff.tenant_id,
            session_id=session_id,
            sender_type="system",
            sender_id=staff.staff_id,
            content_type="text",
            content=note_text,
            meta={
                "event": "handoff",
                "action": "transfer",
                "from_staff_id": str(staff.staff_id),
                "target_staff_id": str(body.target_staff_id) if body.target_staff_id else None,
                "target_skill_group_id": str(body.target_skill_group_id)
                if body.target_skill_group_id
                else None,
                "note": body.note,
                "handler_staff_id": str(session.handler_staff_id)
                if session.handler_staff_id
                else None,
                "skill_group_id": str(session.skill_group_id) if session.skill_group_id else None,
            },
        )
    )
    await db.flush()

    event = realtime.make_event(
        "handoff",
        {
            "session_id": str(session_id),
            "action": "transfer",
            "handler_type": session.handler_type,
            "handler_staff_id": str(session.handler_staff_id)
            if session.handler_staff_id
            else None,
            "skill_group_id": str(session.skill_group_id) if session.skill_group_id else None,
            "status": session.status,
            "target_staff_id": str(body.target_staff_id) if body.target_staff_id else None,
            "target_skill_group_id": str(body.target_skill_group_id)
            if body.target_skill_group_id
            else None,
            **handoff_origin(staff.staff_id, previous_handler, body.note),
        },
    )
    # 坐席專用生命週期事件(from/target/handler_staff_id/skill_group_id):只發坐席頻道,不進會話頻道。
    await realtime.publish_agents(staff.tenant_id, event)

    # 自動化事件:轉接完成(emit 失敗不影響轉接;併入同一交易由下方 commit 落地)
    try:
        from app.services import automation

        await automation.emit_event(
            db,
            staff.tenant_id,
            "session.transfer",
            {
                "session_id": str(session_id),
                "from_staff_id": str(staff.staff_id),
                "target_staff_id": str(body.target_staff_id) if body.target_staff_id else None,
                "target_skill_group_id": str(body.target_skill_group_id)
                if body.target_skill_group_id
                else None,
                "handler_type": session.handler_type,
                "status": session.status,
            },
        )
    except Exception:  # 自動化為加值層,失敗(含 import)不影響轉接主流程
        logger.warning("automation emit_event 失敗(event=session.transfer)", exc_info=True)

    # 對外 Webhook:會話轉接完成(派送失敗不影響轉接主流程;與 automation emit 並存)
    try:
        from app.services import webhooks

        await webhooks.deliver_event(
            db,
            staff.tenant_id,
            "conversation.transferred",
            {
                "session_id": str(session_id),
                "from_staff_id": str(staff.staff_id),
                "target_staff_id": str(body.target_staff_id) if body.target_staff_id else None,
                "target_skill_group_id": str(body.target_skill_group_id)
                if body.target_skill_group_id
                else None,
                "handler_type": session.handler_type,
                "handler_staff_id": str(session.handler_staff_id)
                if session.handler_staff_id
                else None,
                "skill_group_id": str(session.skill_group_id) if session.skill_group_id else None,
                "status": session.status,
            },
        )
    except Exception:  # webhook 為加值層,失敗(含 import)不影響轉接主流程
        logger.warning("webhook deliver_event 失敗(event=conversation.transferred)", exc_info=True)

    await db.commit()
    # 行動推播「轉接給我」:commit 後才排程;轉給自己不推(未設定 FCM 時不動作)
    if body.target_staff_id is not None:
        _push_transfer(staff.tenant_id, session_id, body.target_staff_id, staff.staff_id, body.note)
    return ok(_session_summary(session))


# ============================ REST:已讀回執 ============================
# 標記「對向」未讀訊息(read_at=now)並對會話頻道發 message.read 通知對向。
# 坐席端(JWT)呼叫時對向為訪客:標記 visitor 訊息已讀,並回傳「本側(human/ai)
# 訊息被訪客讀到的浮水印」(peer_read_until),供坐席台在自己送出的氣泡顯示已讀。

_OUTBOUND_SENDER_TYPES = ("human", "ai")


async def _mark_messages_read(
    db,
    tenant_id: uuid.UUID,
    session_id: uuid.UUID,
    *,
    target_sender_types: tuple[str, ...],
    reader_type: str,
    up_to_created_at: datetime | None = None,
) -> tuple[list[str], datetime]:
    """把指定寄件方、尚未讀的訊息 read_at 設為 now;有標記到才發 message.read。

    回傳 (被標記的 message id 清單, 標記時間)。不 commit(交由呼叫端)。
    """
    now = datetime.now(UTC)
    conds = [
        Message.tenant_id == tenant_id,
        Message.session_id == session_id,
        Message.sender_type.in_(target_sender_types),
        Message.read_at.is_(None),
        Message.deleted_at.is_(None),
    ]
    if up_to_created_at is not None:
        conds.append(Message.created_at <= up_to_created_at)
    msgs = (await db.execute(select(Message).where(*conds))).scalars().all()
    ids = [str(m.id) for m in msgs]
    for m in msgs:
        m.read_at = now
    if ids:
        await db.flush()
        event = realtime.make_event(
            "message.read",
            {
                "session_id": str(session_id),
                "reader_type": reader_type,
                "read_at": now.isoformat(),
                "message_ids": ids,
            },
        )
        await realtime.publish(tenant_id, session_id, event)
    return ids, now


class ReadReceiptIn(BaseModel):
    # 標記到某訊息(含)為止;省略則標記所有對向未讀訊息
    up_to_message_id: uuid.UUID | None = None


@router.post("/sessions/{session_id}/read")
async def mark_read(
    session_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
    body: ReadReceiptIn | None = None,
):
    """坐席標記已讀:把該會話訪客(對向)未讀訊息 read_at 設為 now,並通知對向。

    回傳 peer_read_until:本側送出訊息(human/ai)被訪客讀到的最新時間浮水印,
    供坐席台在自己氣泡上顯示「已讀 / 已送達」。
    """
    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        return err("not_found", "session not found")

    up_to: datetime | None = None
    if body is not None and body.up_to_message_id is not None:
        # anchor 必須屬於「本會話」(加 session_id 過濾),避免用他會話訊息當錨點越權
        up_to = (
            await db.execute(
                select(Message.created_at).where(
                    Message.id == body.up_to_message_id,
                    Message.tenant_id == staff.tenant_id,
                    Message.session_id == session_id,
                )
            )
        ).scalar_one_or_none()
        # 指定了錨點卻查無(不存在或不屬於本會話)→ 不可退化為「全部標記已讀」,回錯
        if up_to is None:
            return err("not_found", "anchor message not found in session")

    ids, now = await _mark_messages_read(
        db,
        staff.tenant_id,
        session_id,
        target_sender_types=("visitor",),
        reader_type="human",
        up_to_created_at=up_to,
    )

    # 本側(human/ai)訊息被訪客讀到的最新浮水印(供坐席氣泡顯示已讀)
    peer_read_until = (
        await db.execute(
            select(func.max(Message.read_at)).where(
                Message.tenant_id == staff.tenant_id,
                Message.session_id == session_id,
                Message.sender_type.in_(_OUTBOUND_SENDER_TYPES),
                Message.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()

    await db.commit()
    return ok(
        {
            "session_id": str(session_id),
            "marked": len(ids),
            "read_at": now.isoformat() if ids else None,
            "reader_type": "human",
            "message_ids": ids,
            "peer_read_until": peer_read_until.isoformat() if peer_read_until else None,
        }
    )


# ============================ REST:會話 snooze(稍後處理)============================


class SnoozeIn(BaseModel):
    # 二擇一:until(絕對時間)或 duration_minutes(相對時長)
    until: datetime | None = None
    duration_minutes: int | None = None


@router.post("/sessions/{session_id}/snooze")
async def snooze_session(
    session_id: uuid.UUID,
    body: SnoozeIn,
    staff: CurrentStaff,
    db: DbSession,
):
    """把會話延後(snooze):設 snoozed_until 與 status='snoozed',到期由 worker 喚回。"""
    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        return err("not_found", "session not found")

    now = datetime.now(UTC)
    if body.until is not None:
        until = body.until
        if until.tzinfo is None:  # 容錯:無時區資訊者當作 UTC
            until = until.replace(tzinfo=UTC)
    elif body.duration_minutes is not None and body.duration_minutes > 0:
        until = now + timedelta(minutes=body.duration_minutes)
    else:
        return err("bad_request", "until 或 duration_minutes(>0)需擇一提供")

    if until <= now:
        return err("bad_request", "snooze 時間需晚於現在")

    session.snoozed_until = until
    session.status = "snoozed"
    await db.flush()

    event = realtime.make_event(
        "session.snoozed",
        {
            "session_id": str(session_id),
            "status": "snoozed",
            "snoozed_until": until.isoformat(),
        },
    )
    # 坐席專用生命週期事件(內含 snoozed_until):只發坐席頻道,不進會話頻道以免洩漏給訪客。
    await realtime.publish_agents(staff.tenant_id, event)
    await db.commit()
    return ok(_session_summary(session))


@router.post("/sessions/{session_id}/unsnooze")
async def unsnooze_session(
    session_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
):
    """取消延後:清 snoozed_until,還原 status(有指派坐席→open,否則→queued),喚回坐席台。"""
    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        return err("not_found", "session not found")

    session.status = "open" if session.handler_staff_id else "queued"
    session.snoozed_until = None
    await db.flush()

    # 用 session.opened 喚回坐席列表(既有坐席工作台即時層已處理此事件→刷新會話列)。
    # 此為坐席專用生命週期事件:只發坐席頻道,不進會話頻道(訪客不需要、也不應收到)。
    event = realtime.make_event(
        "session.opened",
        {
            "session_id": str(session_id),
            "status": session.status,
            "reason": "unsnooze",
        },
    )
    await realtime.publish_agents(staff.tenant_id, event)
    await db.commit()
    return ok(_session_summary(session))


# ============================ WebSocket ============================

# 最後一條連線斷開後,等待多久再判定離線(秒)。前端切換會話會「斷線→重連」,
# 短暫空窗不應讓 Staff.status 在 online/offline 間閃爍。測試可調為 0。
WS_OFFLINE_GRACE_SECONDS = 3.0
# 伺服器端定期刷新連線登記的間隔(秒);須遠小於 presence.TTL_SECONDS。
WS_PRESENCE_REFRESH_SECONDS = 30.0
# 認證失敗的 close code(先 accept 再 close,客戶端才看得到原因,據此導回登入頁)
WS_CLOSE_UNAUTHORIZED = 4401


async def _pump(ws: WebSocket, channels: list[str], lock: asyncio.Lock | None = None) -> None:
    """訂閱頻道並把事件轉發到 WebSocket 連線,直到對端斷線。

    ``lock``:同一連線若另有送出端(如 pong 回覆),以同一把鎖序列化寫入。
    """
    async with realtime.subscribe(channels) as events:
        async for event in events:
            if lock is None:
                await ws.send_json(event)
            else:
                async with lock:
                    await ws.send_json(event)


async def _authenticate_agent_ws(token: str | None) -> tuple[uuid.UUID, uuid.UUID] | None:
    """驗證 /ws/agent 的 JWT 並套用即時撤銷檢查,通過回 ``(staff_id, tenant_id)``,否則 None。

    撤銷規則對齊 ``core/deps.get_current_principal``:
    - token 無效 / 過期 / 用途型權杖 / claims 不完整 → 拒絕;
    - 坐席被軟刪或停用 → 拒絕;
    - 租戶被停用 → 拒絕,平台超管除外(須 token claim 與 DB 現況**同時**為平台超管,
      被降權者不得以殘留 claim 繞過租戶停用);
    - token 的 tenant_id 與坐席實際所屬租戶不符 → 拒絕(縱深防禦)。
    DB 故障無法判定時與 REST 一致:保守放行(JWT 已驗簽);查無坐席列亦同 REST 不阻擋。
    """
    if not token:
        return None
    payload = decode_access_token(token)
    if not payload or "tenant_id" not in payload:
        return None
    try:
        staff_id = uuid.UUID(str(payload.get("sub") or payload.get("staff_id")))
        tenant_id = uuid.UUID(str(payload["tenant_id"]))
    except (KeyError, ValueError, TypeError):
        return None

    try:
        from app.models.iam import Staff
        from app.models.tenancy import Tenant

        async with SessionLocal() as db:
            row = (
                await db.execute(
                    select(
                        Staff.is_active,
                        Staff.deleted_at,
                        Staff.tenant_id,
                        Staff.is_platform_admin,
                        Tenant.is_active,
                    )
                    .outerjoin(Tenant, Tenant.id == Staff.tenant_id)
                    .where(Staff.id == staff_id)
                )
            ).first()
    except Exception:
        logger.warning("/ws/agent 撤銷檢查查詢失敗,保守放行 staff=%s", staff_id, exc_info=True)
        return staff_id, tenant_id

    if row is None:
        return staff_id, tenant_id
    staff_active, staff_deleted_at, staff_tenant_id, db_platform_admin, tenant_active = row
    if staff_deleted_at is not None or not staff_active:
        return None
    if staff_tenant_id is not None and staff_tenant_id != tenant_id:
        return None
    is_platform_admin = bool(payload.get("is_platform_admin")) and bool(db_platform_admin)
    if not is_platform_admin and tenant_active is False:
        return None
    return staff_id, tenant_id


async def _set_staff_presence(
    staff_id, tenant_id, status: str, *, only_from: str | None = None
) -> None:
    """更新坐席 last-known presence(供智慧路由挑選在線坐席)。失敗只記錄不拋。

    ``only_from``:僅在目前狀態等於此值時才改(條件式 UPDATE,原子、無讀改寫競態),
    用來保證「手動設的 busy / away 不被自動上下線覆蓋」。
    """
    if not staff_id:
        return
    try:
        sid = uuid.UUID(str(staff_id))
        tid = uuid.UUID(str(tenant_id))
    except (ValueError, TypeError):
        return
    try:
        from sqlalchemy import update

        from app.models.iam import Staff

        stmt = update(Staff).where(Staff.id == sid, Staff.tenant_id == tid)
        if only_from is not None:
            stmt = stmt.where(Staff.status == only_from)
        async with SessionLocal() as db:
            await db.execute(stmt.values(status=status))
            await db.commit()
    except Exception:
        logger.warning("更新坐席 presence 失敗 staff=%s status=%s", staff_id, status, exc_info=True)


async def _presence_keepalive(conn: presence.Connection) -> None:
    """連線存活期間定期刷新登記(不更新客戶端 seen),避免舊版不送 ping 的客戶端被當成殘留。"""
    while True:
        await asyncio.sleep(WS_PRESENCE_REFRESH_SECONDS)
        await presence.touch(conn, client_seen=False)


async def _presence_disconnected(conn: presence.Connection, tenant_id: uuid.UUID) -> None:
    """連線結束:移出登記;若已無任何連線(或 Redis 不可用)才把 online 改回 offline。"""
    remaining = await presence.unregister(conn)
    if remaining:
        return
    if remaining == 0 and WS_OFFLINE_GRACE_SECONDS > 0:
        # 寬限期:切換會話造成的「斷線→重連」空窗不判離線
        await asyncio.sleep(WS_OFFLINE_GRACE_SECONDS)
        if await presence.connection_count(conn.staff_id) > 0:
            return
    # remaining is None(Redis 不可用)→ 退回舊行為:斷線即離線(仍不覆蓋手動 busy/away)
    await _set_staff_presence(conn.staff_id, tenant_id, "offline", only_from="online")


@ws_router.websocket("/ws/agent")
async def ws_agent(
    ws: WebSocket,
    token: str | None = Query(default=None),
    session_id: uuid.UUID | None = None,
    device_id: str | None = Query(default=None),
    platform: str | None = Query(default=None),
):
    """坐席端 WebSocket:JWT 驗證,訂閱租戶坐席頻道(可選再訂閱單一會話)。

    連線以 query 參數 ``token`` 帶 JWT(瀏覽器 WS 無法自訂 header);``device_id`` /
    ``platform`` 選填,用於連線登記(presence)。推送封包 ``{type,payload,ts}``。

    認證失敗(token 無效/過期、帳號停用/刪除、租戶停用)→ 先 accept 再 ``close(4401)``。

    客戶端控制封包:
    - ``{"type":"ping"}`` → 回 ``{"type":"pong","payload":{},"ts":…}``,並刷新連線登記;
    - ``{"type":"app_state","payload":{"foreground":bool}}`` → 更新此連線前景狀態;
    - ``{"type":"typing","payload":{"session_id"}}`` → 轉發「坐席輸入中」給訪客。
    """
    auth = await _authenticate_agent_ws(token)
    if auth is None:
        await ws.accept()
        await ws.close(code=WS_CLOSE_UNAUTHORIZED)  # 未授權
        return
    staff_uuid, tenant_uuid = auth
    tenant_id = str(tenant_uuid)
    staff_id = str(staff_uuid)

    channels = [realtime.agents_channel(tenant_id)]
    if session_id is not None:
        channels.append(realtime.session_channel(tenant_id, session_id))

    await ws.accept()
    # 連線登記:第一條連線出現才把 offline 改為 online(手動 busy/away 不覆蓋);
    # Redis 不可用(None)時退回舊行為:連上即上線。
    conn = presence.Connection(
        staff_id=staff_id,
        device_id=presence.clean_device_id(device_id),
        platform=presence.clean_platform(platform),
    )
    before = await presence.register(conn)
    if not before:
        await _set_staff_presence(staff_id, tenant_id, "online", only_from="offline")

    send_lock = asyncio.Lock()
    forward = asyncio.create_task(_pump(ws, channels, send_lock))
    keepalive = asyncio.create_task(_presence_keepalive(conn))
    try:
        # 讀取對端訊息以偵測斷線(坐席送訊走 REST;此處為心跳/控制通道)
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if not isinstance(data, dict):
                continue
            mtype = data.get("type")
            # 應用層心跳:客戶端每 25 秒 ping,10 秒內沒收到 pong 即重連
            if mtype == "ping":
                await presence.touch(conn)
                async with send_lock:
                    await ws.send_json(realtime.make_event("pong"))
                continue
            # 前景/背景狀態(原生 App 切換前後景時回報;推播據此決定是否推送)
            if mtype == "app_state":
                p = data.get("payload")
                fg = p.get("foreground") if isinstance(p, dict) else None
                if isinstance(fg, bool):
                    await presence.set_foreground(conn, fg)
                continue
            # 控制通道:轉發「坐席輸入中」typing 訊號給對向(訪客);其餘訊息維持忽略。
            # payload 需帶 session_id(坐席可能同時看多個會話,無法從連線推斷)。
            if mtype == "typing":
                p = data.get("payload") or {}
                sid = p.get("session_id") if isinstance(p, dict) else None
                if sid:
                    # 校驗歸屬:sid 必須為「同租戶既有會話」才轉發,避免同租戶偽造他人會話的 typing。
                    try:
                        sid_uuid = uuid.UUID(str(sid))
                    except (ValueError, TypeError):
                        continue
                    async with SessionLocal() as db:
                        owned = (
                            await db.execute(
                                select(Session.id).where(
                                    Session.id == sid_uuid,
                                    Session.tenant_id == tenant_uuid,
                                    Session.deleted_at.is_(None),
                                )
                            )
                        ).scalar_one_or_none()
                    if owned is None:
                        continue
                    await realtime.publish(
                        tenant_id,
                        sid_uuid,
                        realtime.make_event(
                            "typing",
                            {
                                "session_id": str(sid_uuid),
                                "sender_type": "human",
                                "staff_id": staff_id,
                            },
                        ),
                    )
    except WebSocketDisconnect:
        pass
    finally:
        forward.cancel()
        keepalive.cancel()
        await _presence_disconnected(conn, tenant_uuid)


@ws_router.websocket("/ws/widget")
async def ws_widget(
    ws: WebSocket,
    tenant_id: uuid.UUID = Query(...),
    session_id: uuid.UUID = Query(...),
    visitor_external_id: str | None = Query(default=None),
):
    """訪客端 WebSocket:校驗「會話屬於該租戶」且「連線者為該會話訪客本人」後,訂閱會話頻道並可送訊。

    越權防護(對齊公開歷史端點 ``web_session_messages`` 的歸屬驗證):
    ``tenant_id`` 為公開值、``session_id`` 一旦外洩即可被竊聽/偽冒,故僅憑兩者不足以信任。
    連線必須帶 query 參數 ``visitor_external_id``,且須與該 session 所屬 visitor 的 ``external_id``
    相符,否則一律以 close code 4403 拒絕(不區分「不存在/非本人」,避免探測他人會話)。

    入向封包 ``{type:"message", payload:{content, content_type?, meta?}}`` 會以
    sender_type=visitor 寫入並推送。
    """
    external_id = (visitor_external_id or "").strip()
    if not external_id:
        await ws.close(code=4403)  # 缺少訪客身分 → 拒絕(避免僅憑 tenant/session 竊聽)
        return

    # 校驗會話存在且屬於該租戶,並確認連線者為該會話訪客本人(external_id 相符)
    async with SessionLocal() as db:
        session = (
            await db.execute(
                select(Session).where(
                    Session.id == session_id,
                    Session.tenant_id == tenant_id,
                    Session.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if session is None:
            await ws.close(code=4404)  # 會話不存在
            return
        # 以 session 所屬 visitor 的 external_id 驗證歸屬(對齊 get_or_create_visitor 的身份鍵)
        visitor = (
            await db.execute(
                select(Visitor).where(
                    Visitor.id == session.visitor_id,
                    Visitor.tenant_id == tenant_id,
                    Visitor.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if visitor is None or visitor.external_id != external_id:
            await ws.close(code=4403)  # 非本會話訪客 → 越權,拒絕連線
            return
        visitor_id = session.visitor_id

    await ws.accept()
    forward = asyncio.create_task(
        _pump(ws, [realtime.session_channel(tenant_id, session_id)])
    )
    try:
        while True:
            data = await ws.receive_json()
            if not isinstance(data, dict):
                continue
            mtype = data.get("type")
            # 新增:訪客「輸入中」→ 轉發 typing 給對向坐席(短暫、不落庫)
            if mtype == "typing":
                await realtime.publish(
                    tenant_id,
                    session_id,
                    realtime.make_event(
                        "typing",
                        {"session_id": str(session_id), "sender_type": "visitor"},
                    ),
                )
                continue
            # Message sneak-peek:訪客草稿(尚未送出的即時輸入)。只轉發到坐席頻道(publish_agents),
            # 不發到會話頻道,避免回灌訪客本人;不落庫、不進歷史。連線已於上方驗過 visitor 與 session
            # 歸屬,故直接沿用該連線的 session_id(不採信 payload 內的 session_id,防越權指向他人會話)。
            if mtype == "draft":
                p = data.get("payload") or {}
                text = p.get("text")
                if not isinstance(text, str):
                    text = ""
                text = text[:2000]  # 長度上限,防濫用
                await realtime.publish_agents(
                    tenant_id,
                    realtime.make_event(
                        "visitor_draft",
                        {"session_id": str(session_id), "text": text},
                    ),
                )
                continue
            # 新增:訪客「已讀」→ 標記坐席側(human/ai)未讀訊息 read_at,並通知對向
            if mtype == "read":
                async with SessionLocal() as db:
                    await _mark_messages_read(
                        db,
                        tenant_id,
                        session_id,
                        target_sender_types=_OUTBOUND_SENDER_TYPES,
                        reader_type="visitor",
                    )
                    await db.commit()
                continue
            if mtype != "message":
                continue
            p = data.get("payload") or {}
            content = p.get("content")
            if not content:
                continue
            async with SessionLocal() as db:
                visitor_msg = await add_message(
                    db,
                    tenant_id,
                    session_id,
                    sender_type="visitor",
                    content=content,
                    sender_id=visitor_id,
                    content_type=p.get("content_type", "text"),
                    meta=p.get("meta"),
                )
                await db.commit()
            # 行動推播「新訪客訊息」:commit 後才排程(此路徑繞過 ingest_inbound,需另掛);
            # 只推給負責的真人坐席,未設定 FCM 時不動作
            try:
                from app.services import push

                push.on_visitor_message(tenant_id, session_id, getattr(visitor_msg, "id", None))
            except Exception:  # noqa: BLE001
                logger.warning("push.on_visitor_message 失敗(session=%s)", session_id, exc_info=True)
    except WebSocketDisconnect:
        pass
    finally:
        forward.cancel()
