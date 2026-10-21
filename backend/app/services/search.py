"""P0 全域搜尋服務:以 SQL ILIKE 跨 訊息 / 會話 / 聯絡人 檢索。

抽成服務層便於單元測試(API 只做參數解析 + 信封包裝)。所有查詢一律以
tenant_id 過濾(租戶隔離)、排除軟刪、分頁。

- messages:對 Message.content 做 ILIKE,回傳含高亮 snippet 與 session_id。
- sessions:對關聯 Visitor 的 display_name / external_id 做 ILIKE(join Visitor)。
- contacts:對 Contact 的 name / email / phone / note 做 ILIKE。

ILIKE 在 Postgres 原生大小寫不敏感;SQLAlchemy 對其他後端(如測試用 sqlite)
會編譯為 lower(x) LIKE lower(y),語意一致,故服務可在 sqlite 上直接受測。
"""
from __future__ import annotations

import uuid

from sqlalchemy import or_, select

from app.models.conversation import Message, Session
from app.models.visitor import Contact, Visitor

# 可搜尋的型別
SEARCH_TYPES = ("all", "sessions", "messages", "contacts")

_MAX_SIZE = 50
_SNIPPET_RADIUS = 40  # 命中詞前後各取的字元數


def normalize_pagination(page: int | None, size: int | None) -> tuple[int, int, int]:
    """回 (page, size, offset)。page 從 1 起;size 夾在 1.._MAX_SIZE。"""
    p = page if (page and page > 0) else 1
    s = size if (size and size > 0) else 20
    s = min(s, _MAX_SIZE)
    return p, s, (p - 1) * s


def _like_term(q: str) -> str:
    """把使用者輸入包成 ILIKE 樣式,並轉義 LIKE 萬用字元,避免注入 % / _。"""
    esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{esc}%"


def make_snippet(content: str | None, q: str, *, radius: int = _SNIPPET_RADIUS) -> str:
    """擷取命中詞附近的片段;命中處以 [[ ]] 標記,兩端超出則補省略號。

    純函式,無 DB 依賴,便於單元測試。找不到命中詞時退回開頭片段。
    """
    text = (content or "").replace("\n", " ").strip()
    if not text:
        return ""
    if not q:
        return text[: radius * 2] + ("…" if len(text) > radius * 2 else "")
    idx = text.lower().find(q.lower())
    if idx < 0:
        head = text[: radius * 2]
        return head + ("…" if len(text) > radius * 2 else "")
    start = max(0, idx - radius)
    end = min(len(text), idx + len(q) + radius)
    core = text[start:idx] + "[[" + text[idx : idx + len(q)] + "]]" + text[idx + len(q) : end]
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text) else ""
    return prefix + core + suffix


def _session_dict(session: Session, visitor: Visitor | None) -> dict:
    return {
        "id": str(session.id),
        "status": session.status,
        "handler_type": session.handler_type,
        "channel_id": str(session.channel_id),
        "visitor_id": str(session.visitor_id),
        "visitor_name": visitor.display_name if visitor else None,
        "visitor_external_id": visitor.external_id if visitor else None,
        "last_message_at": session.last_message_at.isoformat() if session.last_message_at else None,
        "created_at": session.created_at.isoformat() if session.created_at else None,
    }


def _message_dict(msg: Message, q: str) -> dict:
    return {
        "id": str(msg.id),
        "session_id": str(msg.session_id),
        "sender_type": msg.sender_type,
        "content_type": msg.content_type,
        "snippet": make_snippet(msg.content, q),
        "created_at": msg.created_at.isoformat() if msg.created_at else None,
    }


def _contact_dict(c: Contact) -> dict:
    return {
        "id": str(c.id),
        "name": c.name,
        "email": c.email,
        "phone": c.phone,
        "note": c.note,
    }


async def _search_messages(db, tenant_id, term: str, size: int, offset: int, q: str) -> list[dict]:
    stmt = (
        select(Message)
        .where(
            Message.tenant_id == tenant_id,
            Message.deleted_at.is_(None),
            Message.content.ilike(term, escape="\\"),
        )
        .order_by(Message.created_at.desc())
        .limit(size)
        .offset(offset)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [_message_dict(m, q) for m in rows]


async def _search_sessions(db, tenant_id, term: str, size: int, offset: int) -> list[dict]:
    stmt = (
        select(Session, Visitor)
        .join(Visitor, Visitor.id == Session.visitor_id)
        .where(
            Session.tenant_id == tenant_id,
            Session.deleted_at.is_(None),
            or_(
                Visitor.display_name.ilike(term, escape="\\"),
                Visitor.external_id.ilike(term, escape="\\"),
            ),
        )
        .order_by(Session.last_message_at.desc().nullslast(), Session.created_at.desc())
        .limit(size)
        .offset(offset)
    )
    rows = (await db.execute(stmt)).all()
    return [_session_dict(s, v) for (s, v) in rows]


async def _search_contacts(db, tenant_id, term: str, size: int, offset: int) -> list[dict]:
    stmt = (
        select(Contact)
        .where(
            Contact.tenant_id == tenant_id,
            Contact.deleted_at.is_(None),
            or_(
                Contact.name.ilike(term, escape="\\"),
                Contact.email.ilike(term, escape="\\"),
                Contact.phone.ilike(term, escape="\\"),
                Contact.note.ilike(term, escape="\\"),
            ),
        )
        .order_by(Contact.created_at.desc())
        .limit(size)
        .offset(offset)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [_contact_dict(c) for c in rows]


async def global_search(
    db,
    tenant_id: uuid.UUID,
    q: str,
    *,
    type: str = "all",
    page: int | None = 1,
    size: int | None = 20,
) -> dict:
    """全域搜尋。回統一形狀:

        {"sessions": [...], "messages": [...], "contacts": [...],
         "query": q, "type": type, "page": p, "size": s}

    q 為空白時回空結果(不掃全表)。type 不在白名單時視為 "all"。
    """
    q = (q or "").strip()
    kind = type if type in SEARCH_TYPES else "all"
    p, s, offset = normalize_pagination(page, size)
    empty = {"sessions": [], "messages": [], "contacts": [], "query": q, "type": kind, "page": p, "size": s}
    if not q:
        return empty

    term = _like_term(q)
    result = {"sessions": [], "messages": [], "contacts": [], "query": q, "type": kind, "page": p, "size": s}
    if kind in ("all", "messages"):
        result["messages"] = await _search_messages(db, tenant_id, term, s, offset, q)
    if kind in ("all", "sessions"):
        result["sessions"] = await _search_sessions(db, tenant_id, term, s, offset)
    if kind in ("all", "contacts"):
        result["contacts"] = await _search_contacts(db, tenant_id, term, s, offset)
    return result
