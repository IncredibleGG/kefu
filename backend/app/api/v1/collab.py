"""W6 團隊協作 API:旁支會話(side conversation)、旁支訊息、協作者/關注者、@提及。

掛載前綴由 main.py 指定為 ``/api/v1/collab``。所有查詢一律以 ``tenant_id`` 隔離,
身分取自 JWT(``CurrentStaff``);回應統一走 ok()/err() 信封,與既有模組一致。

概念:
- SideConversation:在主會話「旁邊」另開對內(團隊)或對第三方(kind=external)的討論串,
  不干擾與訪客的主對話(主對話走 conversation.py,本模組完全不碰)。
- SideMessage:旁支討論串內的逐則訊息(sender_staff_id = 發話坐席)。
- SessionParticipant:主會話的協作者(collaborator,可回覆)/ 關注者(watcher,只收通知)。
- @提及:``GET /collab/staff/mentionable`` 提供可提及坐席清單;旁支發訊 / 私密備註送出時,
  前端把 ``@名字`` 併入文字內容(首版純文字),並可帶 ``mentions``(staff_id 陣列)供解析與
  未來通知。SideMessage 無 meta 欄位,故其 @提及僅存於內容文字;私密備註走既有 notes 端點,
  可把 mentions 記入 meta(見前端 collab.ts 的 addNoteWithMentions)。
"""
from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import or_, select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.models.collab import SessionParticipant, SideConversation, SideMessage
from app.models.conversation import Session
from app.models.iam import Staff
from app.services import realtime

router = APIRouter()

logger = logging.getLogger("kefu.collab.api")

# 旁支會話類型 / 協作者角色的合法值(與 models/collab.py 的預設一致)
VALID_KINDS = ("internal", "external")
VALID_ROLES = ("collaborator", "watcher")


# ============================ 序列化 ============================

def _side_out(sc: SideConversation) -> dict:
    return {
        "id": str(sc.id),
        "session_id": str(sc.session_id),
        "topic": sc.topic,
        "kind": sc.kind,
        "status": sc.status,
        "created_by": str(sc.created_by) if sc.created_by else None,
        "created_at": sc.created_at.isoformat() if sc.created_at else None,
    }


def _side_msg_out(m: SideMessage, mentions: list[dict] | None = None) -> dict:
    return {
        "id": str(m.id),
        "side_conversation_id": str(m.side_conversation_id),
        "sender_staff_id": str(m.sender_staff_id) if m.sender_staff_id else None,
        "content": m.content,
        "created_at": m.created_at.isoformat() if m.created_at else None,
        # 本則訊息解析出的 @提及坐席(id + 名字);SideMessage 無 meta 欄,故不落庫,僅回傳供前端呈現
        "mentions": mentions or [],
    }


def _participant_out(p: SessionParticipant, staff: Staff | None = None) -> dict:
    return {
        "id": str(p.id),
        "session_id": str(p.session_id),
        "staff_id": str(p.staff_id),
        "role": p.role,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        # 內嵌坐席顯示名/信箱(若可解析),省去前端再查
        "display_name": staff.display_name if staff else None,
        "email": staff.email if staff else None,
    }


def _mentionable_out(s: Staff) -> dict:
    return {
        "id": str(s.id),
        "display_name": s.display_name,
        "email": s.email,
        "status": s.status,
    }


# ============================ 共用載入 / 校驗 ============================

async def _get_session(db, tenant_id: uuid.UUID, session_id: uuid.UUID) -> Session | None:
    """載入屬於該租戶且未刪除的主會話;查無回 None。"""
    return (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


async def _get_side(db, tenant_id: uuid.UUID, side_id: uuid.UUID) -> SideConversation | None:
    """載入屬於該租戶且未刪除的旁支會話;查無回 None。"""
    return (
        await db.execute(
            select(SideConversation).where(
                SideConversation.id == side_id,
                SideConversation.tenant_id == tenant_id,
                SideConversation.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


async def _resolve_mentions(
    db, tenant_id: uuid.UUID, ids: list[uuid.UUID] | None
) -> list[dict]:
    """把 @提及的 staff_id 陣列解析為 [{staff_id, display_name}],並過濾掉不屬於本租戶者。

    tenant 隔離:只認同租戶、未停權(未軟刪)的坐席,避免跨租戶洩漏或提及不存在對象。
    """
    if not ids:
        return []
    # 去重、保序
    uniq: list[uuid.UUID] = list(dict.fromkeys(ids))
    rows = (
        await db.execute(
            select(Staff.id, Staff.display_name).where(
                Staff.tenant_id == tenant_id,
                Staff.id.in_(uniq),
                Staff.deleted_at.is_(None),
            )
        )
    ).all()
    name_by_id = {sid: name for sid, name in rows}
    return [
        {"staff_id": str(sid), "display_name": name_by_id[sid]}
        for sid in uniq
        if sid in name_by_id
    ]


# ============================ 旁支會話(SideConversation)============================

class SideCreateIn(BaseModel):
    topic: str | None = None
    kind: str = "internal"  # internal(對內團隊)| external(對第三方)


@router.post("/sessions/{session_id}/side")
async def create_side(
    session_id: uuid.UUID,
    body: SideCreateIn,
    staff: CurrentStaff,
    db: DbSession,
):
    """在主會話旁建立一條旁支討論串(對內或對第三方)。"""
    kind = (body.kind or "internal").strip()
    if kind not in VALID_KINDS:
        return err("bad_request", "kind 需為 internal 或 external")

    session = await _get_session(db, staff.tenant_id, session_id)
    if session is None:
        return err("not_found", "session not found")

    sc = SideConversation(
        tenant_id=staff.tenant_id,
        session_id=session_id,
        topic=(body.topic or None),
        kind=kind,
        status="open",
        created_by=staff.staff_id,
    )
    db.add(sc)
    await db.flush()
    await db.commit()
    return ok(_side_out(sc))


@router.get("/sessions/{session_id}/side")
async def list_side(
    session_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
    status: str | None = Query(None, pattern="^(open|closed)$"),
):
    """列出某主會話下的所有旁支討論串(可依 status 過濾),依建立時間新→舊。"""
    session = await _get_session(db, staff.tenant_id, session_id)
    if session is None:
        return err("not_found", "session not found")

    conds = [
        SideConversation.tenant_id == staff.tenant_id,
        SideConversation.session_id == session_id,
        SideConversation.deleted_at.is_(None),
    ]
    if status is not None:
        conds.append(SideConversation.status == status)

    rows = (
        await db.execute(
            select(SideConversation)
            .where(*conds)
            .order_by(SideConversation.created_at.desc())
        )
    ).scalars().all()
    return ok({"items": [_side_out(sc) for sc in rows]})


@router.post("/side/{side_id}/close")
async def close_side(
    side_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
):
    """關閉一條旁支討論串(status=closed);冪等。"""
    sc = await _get_side(db, staff.tenant_id, side_id)
    if sc is None:
        return err("not_found", "side conversation not found")

    sc.status = "closed"
    await db.flush()
    await db.commit()
    return ok(_side_out(sc))


# ============================ 旁支訊息(SideMessage)============================

class SideMessageIn(BaseModel):
    content: str
    # @提及的坐席 id 陣列(選填);內容文字內的 @名字 由前端組裝,此處僅解析/驗證 id
    mentions: list[uuid.UUID] | None = None


@router.post("/side/{side_id}/messages")
async def send_side_message(
    side_id: uuid.UUID,
    body: SideMessageIn,
    staff: CurrentStaff,
    db: DbSession,
):
    """在旁支討論串發一則訊息(sender_staff_id = 目前坐席)。

    - 旁支已關閉(closed)則拒收,避免往已結束的討論串補話。
    - mentions:驗證屬於本租戶後回傳解析結果(供前端呈現與未來通知);SideMessage 無 meta 欄,
      故不另落庫,@提及以文字形式存於 content。
    """
    sc = await _get_side(db, staff.tenant_id, side_id)
    if sc is None:
        return err("not_found", "side conversation not found")
    if sc.status == "closed":
        return err("closed", "side conversation already closed")

    content = (body.content or "").strip()
    if not content:
        return err("bad_request", "content 不可為空")

    mentions = await _resolve_mentions(db, staff.tenant_id, body.mentions)

    msg = SideMessage(
        tenant_id=staff.tenant_id,
        side_conversation_id=side_id,
        sender_staff_id=staff.staff_id,
        content=content,
    )
    db.add(msg)
    await db.flush()
    await db.commit()

    # 盡力而為的即時推送:對坐席頻道發 side.message,讓協作者端可即時感知(失敗不影響落庫)
    try:
        await realtime.publish_agents(
            staff.tenant_id,
            realtime.make_event(
                "side.message",
                {
                    "session_id": str(sc.session_id),
                    "side_conversation_id": str(side_id),
                    "message_id": str(msg.id),
                    "sender_staff_id": str(staff.staff_id),
                    "mentions": [m["staff_id"] for m in mentions],
                },
            ),
        )
    except Exception:  # 即時層為加值,任何失敗都不影響旁支發訊
        logger.warning("collab side.message 即時推送失敗", exc_info=True)

    return ok(_side_msg_out(msg, mentions))


@router.get("/side/{side_id}/messages")
async def list_side_messages(
    side_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
    limit: int = Query(100, ge=1, le=500),
):
    """列出某旁支討論串的訊息(依建立時間正序,由舊到新)。"""
    sc = await _get_side(db, staff.tenant_id, side_id)
    if sc is None:
        return err("not_found", "side conversation not found")

    rows = (
        await db.execute(
            select(SideMessage)
            .where(
                SideMessage.tenant_id == staff.tenant_id,
                SideMessage.side_conversation_id == side_id,
                SideMessage.deleted_at.is_(None),
            )
            .order_by(SideMessage.created_at.asc())
            .limit(limit)
        )
    ).scalars().all()
    return ok({"items": [_side_msg_out(m) for m in rows]})


# ============================ 協作者 / 關注者(SessionParticipant)============================

class ParticipantIn(BaseModel):
    staff_id: uuid.UUID
    role: str = "collaborator"  # collaborator(可回覆)| watcher(只收通知)


@router.get("/sessions/{session_id}/participants")
async def list_participants(
    session_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
):
    """列出某主會話的協作者 / 關注者(內嵌坐席顯示名與信箱)。"""
    session = await _get_session(db, staff.tenant_id, session_id)
    if session is None:
        return err("not_found", "session not found")

    parts = (
        await db.execute(
            select(SessionParticipant)
            .where(
                SessionParticipant.tenant_id == staff.tenant_id,
                SessionParticipant.session_id == session_id,
                SessionParticipant.deleted_at.is_(None),
            )
            .order_by(SessionParticipant.created_at.asc())
        )
    ).scalars().all()

    # 一次撈出坐席顯示名(避免逐筆 N+1)
    staff_ids = [p.staff_id for p in parts]
    staff_map: dict[uuid.UUID, Staff] = {}
    if staff_ids:
        srows = (
            await db.execute(
                select(Staff).where(
                    Staff.tenant_id == staff.tenant_id,
                    Staff.id.in_(staff_ids),
                )
            )
        ).scalars().all()
        staff_map = {s.id: s for s in srows}

    return ok({"items": [_participant_out(p, staff_map.get(p.staff_id)) for p in parts]})


@router.post("/sessions/{session_id}/participants")
async def add_participant(
    session_id: uuid.UUID,
    body: ParticipantIn,
    staff: CurrentStaff,
    db: DbSession,
):
    """加入(或更新角色)一位協作者 / 關注者。冪等:同會話同坐席已存在則更新其 role。"""
    role = (body.role or "collaborator").strip()
    if role not in VALID_ROLES:
        return err("bad_request", "role 需為 collaborator 或 watcher")

    session = await _get_session(db, staff.tenant_id, session_id)
    if session is None:
        return err("not_found", "session not found")

    # 目標坐席須為同租戶存在坐席
    target = (
        await db.execute(
            select(Staff).where(
                Staff.id == body.staff_id,
                Staff.tenant_id == staff.tenant_id,
                Staff.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if target is None:
        return err("not_found", "staff not found")

    existing = (
        await db.execute(
            select(SessionParticipant).where(
                SessionParticipant.tenant_id == staff.tenant_id,
                SessionParticipant.session_id == session_id,
                SessionParticipant.staff_id == body.staff_id,
                SessionParticipant.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()

    if existing is not None:
        existing.role = role
        part = existing
    else:
        part = SessionParticipant(
            tenant_id=staff.tenant_id,
            session_id=session_id,
            staff_id=body.staff_id,
            role=role,
        )
        db.add(part)
    await db.flush()
    await db.commit()
    return ok(_participant_out(part, target))


@router.delete("/sessions/{session_id}/participants/{staff_id}")
async def remove_participant(
    session_id: uuid.UUID,
    staff_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
):
    """移除一位協作者 / 關注者(硬刪成員關聯;冪等,查無亦回成功)。"""
    session = await _get_session(db, staff.tenant_id, session_id)
    if session is None:
        return err("not_found", "session not found")

    part = (
        await db.execute(
            select(SessionParticipant).where(
                SessionParticipant.tenant_id == staff.tenant_id,
                SessionParticipant.session_id == session_id,
                SessionParticipant.staff_id == staff_id,
                SessionParticipant.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if part is not None:
        await db.delete(part)
        await db.commit()
    return ok({"session_id": str(session_id), "staff_id": str(staff_id), "removed": True})


# ============================ @提及:可提及坐席清單 ============================

@router.get("/staff/mentionable")
async def mentionable_staff(
    staff: CurrentStaff,
    db: DbSession,
    q: str | None = None,
    limit: int = Query(20, ge=1, le=50),
):
    """列出可被 @提及 的坐席(本租戶、啟用中);q 就地模糊比對顯示名 / 信箱。"""
    conds = [
        Staff.tenant_id == staff.tenant_id,
        Staff.deleted_at.is_(None),
        Staff.is_active.is_(True),
    ]
    if q:
        like = f"%{q.strip()}%"
        conds.append(or_(Staff.display_name.ilike(like), Staff.email.ilike(like)))

    rows = (
        await db.execute(
            select(Staff).where(*conds).order_by(Staff.display_name.asc()).limit(limit)
        )
    ).scalars().all()
    return ok({"items": [_mentionable_out(s) for s in rows]})
