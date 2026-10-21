"""M9 ticket API:工單 CRUD、指派、改狀態、依會話一鍵建立、列表過濾。

路由前綴由整合者掛在 /api/v1/ticket。所有查詢一律以 principal.tenant_id
隔離;成功回應統一走 response.ok 信封,錯誤沿用專案慣例以 HTTPException
拋出(detail 帶模組前綴錯誤碼)。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import ok
from app.models.iam import Staff
from app.models.productivity import FieldDefinition
from app.models.ticket import TICKET_PRIORITIES, TICKET_STATUSES, Ticket
from app.models.ticket_note import TicketNote
from app.models.visitor import Contact, Visitor

router = APIRouter()

# 工單狀態機:定義合法的狀態流轉(避免任意互跳)。
# 正向路徑 open → pending → resolved → closed;另允許回退(reopen):
# pending/resolved 可退回較前狀態,closed 只能重開回 open(需重新分流)。
# 同狀態(冪等重設)一律放行。非法跳轉回 TICKET_INVALID_TRANSITION(422)。
_TICKET_TRANSITIONS: dict[str, set[str]] = {
    "open": {"pending", "resolved", "closed"},
    "pending": {"open", "resolved", "closed"},
    "resolved": {"open", "pending", "closed"},
    "closed": {"open"},
}

# 「未結清」狀態:仍需處理、可能逾期的狀態(resolved/closed 視為已結清,不算逾期)。
_OPEN_STATUSES = ("open", "pending")

# 到期自動化打的標籤(逾期自動加、結清後自動移除)。輕量自動化見 _apply_ticket_automation。
_OVERDUE_TAG = "overdue"

# 合併標記:寫入來源工單 attributes 的保留鍵(記錄併入的目標工單 id)。
# 以 "_" 前綴避免與租戶自訂欄位(FieldDefinition.key)相撞;前端自訂欄位僅依
# FieldDefinition 逐鍵渲染,不會顯示此保留鍵(見 TicketsPage CustomFieldInputs)。
_MERGED_INTO_KEY = "_merged_into_ticket_id"


# ---------- Pydantic 輸入/輸出 ----------
class TicketCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    description: str | None = None
    priority: str = "normal"
    assignee_staff_id: uuid.UUID | None = None
    contact_id: uuid.UUID | None = None
    session_id: uuid.UUID | None = None
    tags: list[str] | None = None
    # 自訂欄位值(key → 值);key 須為已定義的工單欄位(見 FieldDefinition),
    # 未定義的 key 一律略過(寬鬆過濾,見 _filter_attributes)
    attributes: dict | None = None
    # 到期日(選填);建立即帶入,供逾期判定與到期掃描
    due_at: datetime | None = None


class TicketUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = None
    priority: str | None = None
    tags: list[str] | None = None
    # 傳入即整段覆寫自訂欄位值(僅保留已定義 key);不傳(None)則不動
    attributes: dict | None = None
    # 到期日:以 model_fields_set 判斷「有無傳入」——
    #   未傳 → 不動;傳 null → 清除到期日;傳時間 → 設定到期日。
    due_at: datetime | None = None


class AssignIn(BaseModel):
    # None 表示取消指派
    assignee_staff_id: uuid.UUID | None = None


class StatusIn(BaseModel):
    status: str


class NoteCreate(BaseModel):
    # 內部備註正文(非空)
    body: str = Field(min_length=1)


class SnoozeIn(BaseModel):
    # 延後到某時點;None 表示取消延後(立即恢復逾期判定)
    until: datetime | None = None


class MergeIn(BaseModel):
    # 目標工單 id:把「當前(來源)工單」併入此目標
    into_ticket_id: uuid.UUID


class FromSessionIn(BaseModel):
    title: str | None = Field(default=None, max_length=300)
    description: str | None = None
    priority: str = "normal"
    assignee_staff_id: uuid.UUID | None = None
    tags: list[str] | None = None


def _is_overdue(t: Ticket, now: datetime | None = None) -> bool:
    """工單是否逾期:有到期日且已過期、狀態未結清、且未處於有效 snooze 期內。"""
    if t.due_at is None or t.status not in _OPEN_STATUSES:
        return False
    now = now or datetime.now(timezone.utc)
    if t.snoozed_until is not None and t.snoozed_until > now:
        return False
    return t.due_at <= now


def _serialize(t: Ticket) -> dict:
    attrs = t.attributes or {}
    merged_into = attrs.get(_MERGED_INTO_KEY)
    return {
        "id": str(t.id),
        "tenant_id": str(t.tenant_id),
        "title": t.title,
        "description": t.description,
        "status": t.status,
        "priority": t.priority,
        "assignee_staff_id": str(t.assignee_staff_id) if t.assignee_staff_id else None,
        "contact_id": str(t.contact_id) if t.contact_id else None,
        "session_id": str(t.session_id) if t.session_id else None,
        "tags": t.tags or [],
        # 對外隱藏合併等保留鍵(以 "_" 前綴),只回租戶自訂欄位值
        "attributes": {k: v for k, v in attrs.items() if not str(k).startswith("_")},
        "resolved_at": t.resolved_at.isoformat() if t.resolved_at else None,
        "closed_at": t.closed_at.isoformat() if t.closed_at else None,
        "due_at": t.due_at.isoformat() if t.due_at else None,
        "snoozed_until": t.snoozed_until.isoformat() if t.snoozed_until else None,
        # 衍生旗標:是否逾期 / 是否為合併來源(併入的目標工單 id)
        "overdue": _is_overdue(t),
        "merged_into_ticket_id": str(merged_into) if merged_into else None,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


def _serialize_note(n: TicketNote) -> dict:
    return {
        "id": str(n.id),
        "ticket_id": str(n.ticket_id),
        "staff_id": str(n.staff_id) if n.staff_id else None,
        "body": n.body,
        "created_at": n.created_at.isoformat() if n.created_at else None,
    }


async def _filter_attributes(db, tenant_id: uuid.UUID, attributes: dict | None) -> dict:
    """依 FieldDefinition 過濾自訂欄位:僅保留本租戶已定義的工單欄位 key。

    寬鬆策略:未定義的 key 一律「略過」(不寫入、不報錯),避免任意鍵污染
    attributes;回傳只含已定義 key 的 dict(可能為空)。
    """
    if not attributes:
        return {}
    rows = (
        await db.execute(
            select(FieldDefinition.key).where(
                FieldDefinition.tenant_id == tenant_id,
                FieldDefinition.entity == "ticket",
                FieldDefinition.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    known = set(rows)
    return {k: v for k, v in attributes.items() if k in known}


async def _get_owned(db, tenant_id: uuid.UUID, ticket_id: uuid.UUID) -> Ticket:
    """取得本租戶未軟刪的工單,否則 404。"""
    t = (
        await db.execute(
            select(Ticket).where(
                Ticket.id == ticket_id,
                Ticket.tenant_id == tenant_id,
                Ticket.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if t is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="TICKET_NOT_FOUND")
    return t


def _apply_status_timestamps(t: Ticket, new_status: str) -> None:
    """依狀態流轉補時間戳(進入 resolved/closed 記錄,回到未結清則清空)。

    resolved_at 記錄「首次解決時間」:resolved→closed 不覆寫(否則會把原解決時間
    改成關閉時間,污染 MTTR / 解決時長統計);僅在尚未有值時補記。回到未結清狀態
    (open/pending 等)才清空,讓下次解決重新計時。
    """
    now = datetime.now(timezone.utc)
    if new_status in ("resolved", "closed"):
        if t.resolved_at is None:
            t.resolved_at = now
    else:
        t.resolved_at = None
    t.closed_at = now if new_status == "closed" else None


# ---------- 輕量工單自動化(建立 / 狀態變更 / 到期掃描時觸發)----------
#
# 設計取捨:既有 automation 引擎(services/automation.py)綁定「會話」生命週期事件
# (message.visitor / session.created ...),動作也全針對 Session 物件,無工單事件掛鉤;
# 複用需改 services/automation.py(本任務不可改該檔)。故此處在工單模組內自建一組
# 「純資料面、可被排程呼叫」的輕量規則,與會話自動化解耦。目前內建規則:
#   1) 逾期自動打標:未結清且逾期 → 併入 _OVERDUE_TAG;
#   2) 結清自動清標:resolved/closed → 移除 _OVERDUE_TAG。
# 皆為冪等、就地修改 ticket(不自行 commit,併入呼叫端交易),失敗降級不拋。


def _set_tag(t: Ticket, tag: str, present: bool) -> bool:
    """確保 tag 在 / 不在 t.tags(冪等)。有變更回 True。"""
    tags = list(t.tags or [])
    has = tag in tags
    if present and not has:
        tags.append(tag)
    elif not present and has:
        tags = [x for x in tags if x != tag]
    else:
        return False
    t.tags = tags
    return True


def _apply_ticket_automation(t: Ticket, event: str, now: datetime | None = None) -> bool:
    """對單張工單套用內建自動化規則(就地修改,不 commit)。回傳是否有變更。

    event:"created" | "status_changed" | "due_scan" | "updated"。全程 try/except
    降級不拋——自動化失敗絕不拖垮建立 / 改狀態等主流程。
    """
    try:
        now = now or datetime.now(timezone.utc)
        changed = False
        if t.status in _OPEN_STATUSES:
            # 未結清:逾期則打標(否則確保不帶殘留的逾期標)
            changed |= _set_tag(t, _OVERDUE_TAG, _is_overdue(t, now))
        else:
            # 已結清:清除逾期標
            changed |= _set_tag(t, _OVERDUE_TAG, False)
        return changed
    except Exception:  # noqa: BLE001 — 自動化為盡力而為,任何異常都不得影響主流程
        return False


async def scan_overdue_tickets(
    db, tenant_id: uuid.UUID | None = None, *, commit: bool = True
) -> dict:
    """到期掃描:掃出逾期未結清工單並套用自動化(打逾期標),供排程 / cron 呼叫。

    這是「到期掃描背景邏輯的資料面」——目前專案無排程器基建(見交付報告),故提供
    此可被任意排程器 / 管理命令 / 背景任務直接 await 的 helper。

    參數:
    - tenant_id:限定單一租戶;None 表示全租戶掃描(排程場景)。
    - commit:True 時自行提交(獨立背景執行);False 時併入呼叫端交易。

    回傳:{"scanned": 掃描筆數, "updated": 有變更筆數}。查詢一律帶 deleted_at IS NULL,
    不掃已軟刪 / 已合併來源工單。
    """
    now = datetime.now(timezone.utc)
    conds = [
        Ticket.deleted_at.is_(None),
        Ticket.status.in_(_OPEN_STATUSES),
        Ticket.due_at.is_not(None),
        Ticket.due_at <= now,
        or_(Ticket.snoozed_until.is_(None), Ticket.snoozed_until <= now),
    ]
    if tenant_id is not None:
        conds.append(Ticket.tenant_id == tenant_id)
    rows = (await db.execute(select(Ticket).where(*conds))).scalars().all()
    updated = 0
    for t in rows:
        if _apply_ticket_automation(t, "due_scan", now):
            updated += 1
    if commit and updated:
        await db.commit()
    return {"scanned": len(rows), "updated": updated}


# ---------- 租戶歸屬校驗(寫入前先行,把懸空外鍵轉成 404 而非 500)----------
async def _assert_staff_in_tenant(db, tenant_id: uuid.UUID, staff_id: uuid.UUID | None) -> None:
    """驗指派坐席屬本租戶且未軟刪;None 表示不指派,直接放行。否則 404 STAFF_NOT_FOUND。"""
    if staff_id is None:
        return
    found = (
        await db.execute(
            select(Staff.id).where(
                Staff.id == staff_id,
                Staff.tenant_id == tenant_id,
                Staff.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="STAFF_NOT_FOUND")


async def _assert_contact_in_tenant(db, tenant_id: uuid.UUID, contact_id: uuid.UUID | None) -> None:
    """驗關聯聯絡人屬本租戶且未軟刪;None 直接放行。否則 404 TICKET_CONTACT_NOT_FOUND。"""
    if contact_id is None:
        return
    found = (
        await db.execute(
            select(Contact.id).where(
                Contact.id == contact_id,
                Contact.tenant_id == tenant_id,
                Contact.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="TICKET_CONTACT_NOT_FOUND")


async def _assert_session_in_tenant(db, tenant_id: uuid.UUID, session_id: uuid.UUID | None) -> None:
    """驗關聯會話屬本租戶且未軟刪;None 直接放行。否則 404 TICKET_SESSION_NOT_FOUND。"""
    if session_id is None:
        return
    from app.models.conversation import Session  # 局部匯入,避免模組載入順序耦合

    found = (
        await db.execute(
            select(Session.id).where(
                Session.id == session_id,
                Session.tenant_id == tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="TICKET_SESSION_NOT_FOUND")


# ---------- 建立 ----------
@router.post("")
async def create_ticket(body: TicketCreate, staff: CurrentStaff, db: DbSession):
    staff.require("ticket.manage")
    if body.priority not in TICKET_PRIORITIES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="TICKET_INVALID_PRIORITY")
    # 租戶歸屬校驗:指派坐席 / 關聯聯絡人 / 關聯會話須屬本租戶(寫入前檢查,避免懸空外鍵)
    await _assert_staff_in_tenant(db, staff.tenant_id, body.assignee_staff_id)
    await _assert_contact_in_tenant(db, staff.tenant_id, body.contact_id)
    await _assert_session_in_tenant(db, staff.tenant_id, body.session_id)
    t = Ticket(
        tenant_id=staff.tenant_id,
        title=body.title,
        description=body.description,
        priority=body.priority,
        assignee_staff_id=body.assignee_staff_id,
        contact_id=body.contact_id,
        session_id=body.session_id,
        tags=body.tags,
        attributes=await _filter_attributes(db, staff.tenant_id, body.attributes),
        due_at=body.due_at,
    )
    db.add(t)
    # 先 flush 讓 status 等 Python 端預設值(default="open")落定,自動化才讀得到正確狀態
    await db.flush()
    _apply_ticket_automation(t, "created")
    await db.commit()
    await db.refresh(t)
    return ok(_serialize(t))


# ---------- 依會話一鍵建立 ----------
@router.post("/from-session/{session_id}")
async def create_from_session(
    session_id: uuid.UUID, body: FromSessionIn, staff: CurrentStaff, db: DbSession
):
    staff.require("ticket.manage")
    from app.models.conversation import Session  # 局部匯入,避免模組載入順序耦合

    sess = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if sess is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="TICKET_SESSION_NOT_FOUND")
    if body.priority not in TICKET_PRIORITIES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="TICKET_INVALID_PRIORITY")
    # 呼叫端指定的指派坐席須屬本租戶(未指定則沿用會話處理者,後者本即同租戶)
    await _assert_staff_in_tenant(db, staff.tenant_id, body.assignee_staff_id)

    # 從會話的訪客反查其聯絡人,自動關聯到工單
    contact_id = (
        await db.execute(select(Visitor.contact_id).where(Visitor.id == sess.visitor_id))
    ).scalar_one_or_none()

    t = Ticket(
        tenant_id=staff.tenant_id,
        title=body.title or f"會話工單 {str(session_id)[:8]}",
        description=body.description,
        priority=body.priority,
        assignee_staff_id=body.assignee_staff_id or sess.handler_staff_id,
        contact_id=contact_id,
        session_id=session_id,
        tags=body.tags,
    )
    db.add(t)
    await db.commit()
    await db.refresh(t)
    return ok(_serialize(t))


# ---------- 列表(過濾 + 分頁)----------
@router.get("")
async def list_tickets(
    staff: CurrentStaff,
    db: DbSession,
    status_: str | None = Query(default=None, alias="status"),
    priority: str | None = None,
    assignee_staff_id: uuid.UUID | None = None,
    contact_id: uuid.UUID | None = None,
    session_id: uuid.UUID | None = None,
    overdue: bool = Query(default=False),
    order_by: str = Query(default="created", pattern="^(created|due)$"),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
):
    staff.require("ticket.view")
    conds = [Ticket.tenant_id == staff.tenant_id, Ticket.deleted_at.is_(None)]
    if status_ is not None:
        conds.append(Ticket.status == status_)
    if priority is not None:
        conds.append(Ticket.priority == priority)
    if assignee_staff_id is not None:
        conds.append(Ticket.assignee_staff_id == assignee_staff_id)
    if contact_id is not None:
        conds.append(Ticket.contact_id == contact_id)
    if session_id is not None:
        conds.append(Ticket.session_id == session_id)
    # 「逾期」篩選:有到期日且已過期、狀態未結清、且未處於有效 snooze 期內
    if overdue:
        now = datetime.now(timezone.utc)
        conds.extend(
            [
                Ticket.due_at.is_not(None),
                Ticket.due_at <= now,
                Ticket.status.in_(_OPEN_STATUSES),
                or_(Ticket.snoozed_until.is_(None), Ticket.snoozed_until <= now),
            ]
        )

    # 排序:預設建立時間新→舊;order_by=due 依到期日近→遠(無到期日者排最後)
    if order_by == "due":
        order_clause = (Ticket.due_at.asc().nulls_last(), Ticket.created_at.desc())
    else:
        order_clause = (Ticket.created_at.desc(),)

    total = (
        await db.execute(select(func.count()).select_from(Ticket).where(*conds))
    ).scalar_one()
    rows = (
        await db.execute(
            select(Ticket)
            .where(*conds)
            .order_by(*order_clause)
            .offset((page - 1) * size)
            .limit(size)
        )
    ).scalars().all()
    return ok({"items": [_serialize(t) for t in rows], "total": total, "page": page, "size": size})


# ---------- 單筆讀取 ----------
@router.get("/{ticket_id}")
async def get_ticket(ticket_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    staff.require("ticket.view")
    t = await _get_owned(db, staff.tenant_id, ticket_id)
    return ok(_serialize(t))


# ---------- 更新一般欄位 ----------
@router.patch("/{ticket_id}")
async def update_ticket(
    ticket_id: uuid.UUID, body: TicketUpdate, staff: CurrentStaff, db: DbSession
):
    staff.require("ticket.manage")
    t = await _get_owned(db, staff.tenant_id, ticket_id)
    if body.priority is not None:
        if body.priority not in TICKET_PRIORITIES:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, detail="TICKET_INVALID_PRIORITY"
            )
        t.priority = body.priority
    if body.title is not None:
        t.title = body.title
    if body.description is not None:
        t.description = body.description
    if body.tags is not None:
        t.tags = body.tags
    if body.attributes is not None:
        # 保留既有合併等保留鍵(以 "_" 前綴),只覆寫租戶自訂欄位值,避免整段覆寫抹掉 merge 標記
        filtered = await _filter_attributes(db, staff.tenant_id, body.attributes)
        preserved = {k: v for k, v in (t.attributes or {}).items() if str(k).startswith("_")}
        t.attributes = {**preserved, **filtered}
    # due_at:以 model_fields_set 判斷是否傳入(可傳 null 清除)
    if "due_at" in body.model_fields_set:
        t.due_at = body.due_at
    # 到期日 / 標籤異動後重判逾期自動化
    _apply_ticket_automation(t, "updated")
    await db.commit()
    await db.refresh(t)
    return ok(_serialize(t))


# ---------- 指派 ----------
@router.post("/{ticket_id}/assign")
async def assign_ticket(
    ticket_id: uuid.UUID, body: AssignIn, staff: CurrentStaff, db: DbSession
):
    staff.require("ticket.manage")
    t = await _get_owned(db, staff.tenant_id, ticket_id)
    # 指派前驗坐席屬本租戶(None 為取消指派,放行),避免跨租戶指派 / 懸空外鍵
    await _assert_staff_in_tenant(db, staff.tenant_id, body.assignee_staff_id)
    t.assignee_staff_id = body.assignee_staff_id
    await db.commit()
    await db.refresh(t)
    return ok(_serialize(t))


# ---------- 改狀態 ----------
@router.post("/{ticket_id}/status")
async def change_status(
    ticket_id: uuid.UUID, body: StatusIn, staff: CurrentStaff, db: DbSession
):
    staff.require("ticket.manage")
    if body.status not in TICKET_STATUSES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="TICKET_INVALID_STATUS")
    t = await _get_owned(db, staff.tenant_id, ticket_id)
    # 狀態機守衛:同狀態(冪等)放行,否則須為當前狀態的合法後繼,阻擋非法跳轉
    if body.status != t.status and body.status not in _TICKET_TRANSITIONS.get(t.status, set()):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="TICKET_INVALID_TRANSITION"
        )
    t.status = body.status
    _apply_status_timestamps(t, body.status)
    # 狀態變更觸發輕量自動化(如結清清除逾期標、或退回未結清重判逾期)
    _apply_ticket_automation(t, "status_changed")
    await db.commit()
    await db.refresh(t)
    return ok(_serialize(t))


# ---------- 到期日:延後(snooze)----------
@router.post("/{ticket_id}/snooze")
async def snooze_ticket(
    ticket_id: uuid.UUID, body: SnoozeIn, staff: CurrentStaff, db: DbSession
):
    """把工單延後到某時點(在此之前不視為逾期);until=null 取消延後。"""
    staff.require("ticket.manage")
    t = await _get_owned(db, staff.tenant_id, ticket_id)
    if body.until is not None:
        now = datetime.now(timezone.utc)
        until = body.until
        # 天真 datetime 補上 UTC 時區,避免與 aware now 比較報錯
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
        if until <= now:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"code": "TICKET_INVALID_SNOOZE", "message": "snooze 時點須為未來時間"},
            )
        t.snoozed_until = until
    else:
        t.snoozed_until = None
    # snooze 生效 / 解除後重判逾期(snooze 中的工單不應保留逾期標)
    _apply_ticket_automation(t, "updated")
    await db.commit()
    await db.refresh(t)
    return ok(_serialize(t))


# ---------- 內部備註:新增 / 列表 ----------
@router.post("/{ticket_id}/notes")
async def create_note(
    ticket_id: uuid.UUID, body: NoteCreate, staff: CurrentStaff, db: DbSession
):
    """在工單上新增一則內部備註(團隊可見,訪客不可見)。"""
    staff.require("ticket.manage")
    # 先確認工單屬本租戶且未軟刪(否則 404),避免對不存在 / 跨租戶工單留言
    await _get_owned(db, staff.tenant_id, ticket_id)
    note = TicketNote(
        tenant_id=staff.tenant_id,
        ticket_id=ticket_id,
        staff_id=staff.staff_id,
        body=body.body,
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)
    return ok(_serialize_note(note))


@router.get("/{ticket_id}/notes")
async def list_notes(ticket_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """列出工單的內部備註串(依 created_at 升冪,呈現為時間線)。"""
    staff.require("ticket.view")
    await _get_owned(db, staff.tenant_id, ticket_id)
    rows = (
        await db.execute(
            select(TicketNote)
            .where(
                TicketNote.tenant_id == staff.tenant_id,
                TicketNote.ticket_id == ticket_id,
                TicketNote.deleted_at.is_(None),
            )
            .order_by(TicketNote.created_at.asc())
        )
    ).scalars().all()
    return ok({"items": [_serialize_note(n) for n in rows], "total": len(rows)})


# ---------- 工單合併 ----------
@router.post("/{ticket_id}/merge")
async def merge_ticket(
    ticket_id: uuid.UUID, body: MergeIn, staff: CurrentStaff, db: DbSession
):
    """把來源工單(ticket_id)併入目標工單(into_ticket_id)。

    效果:來源的內部備註全數轉移到目標;目標若缺聯絡人 / 會話關聯則自來源補上;
    標籤取聯集;來源標記 merged(attributes 保留鍵)並軟刪。兩單須同租戶且未軟刪。
    """
    staff.require("ticket.manage")
    if body.into_ticket_id == ticket_id:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "TICKET_MERGE_SELF", "message": "來源與目標不可為同一工單"},
        )
    # 兩單皆須屬本租戶且未軟刪(_get_owned 內含租戶隔離),否則 404
    src = await _get_owned(db, staff.tenant_id, ticket_id)
    dst = await _get_owned(db, staff.tenant_id, body.into_ticket_id)

    # 1) 轉移內部備註:來源全部備註改掛到目標工單
    src_notes = (
        await db.execute(
            select(TicketNote).where(
                TicketNote.tenant_id == staff.tenant_id,
                TicketNote.ticket_id == src.id,
                TicketNote.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    for n in src_notes:
        n.ticket_id = dst.id

    # 2) 關聯轉移:目標缺聯絡人 / 會話時,自來源補上(不覆蓋目標既有關聯)
    if dst.contact_id is None and src.contact_id is not None:
        dst.contact_id = src.contact_id
    if dst.session_id is None and src.session_id is not None:
        dst.session_id = src.session_id

    # 3) 標籤取聯集(維持順序、去重)
    merged_tags = list(dst.tags or [])
    for tag in src.tags or []:
        if tag not in merged_tags:
            merged_tags.append(tag)
    dst.tags = merged_tags

    # 4) 目標留一則系統備註,記錄本次合併(可追溯)
    db.add(
        TicketNote(
            tenant_id=staff.tenant_id,
            ticket_id=dst.id,
            staff_id=staff.staff_id,
            body=f"[merge] 已併入來源工單 {src.id}(標題:{src.title})",
        )
    )

    # 5) 來源標記 merged(attributes 保留鍵)並軟刪
    src.attributes = {**(src.attributes or {}), _MERGED_INTO_KEY: str(dst.id)}
    src.deleted_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(dst)
    return ok(
        {
            "merged_from": str(src.id),
            "into_ticket_id": str(dst.id),
            "moved_notes": len(src_notes),
            "ticket": _serialize(dst),
        }
    )


# ---------- 軟刪 ----------
@router.delete("/{ticket_id}")
async def delete_ticket(ticket_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    staff.require("ticket.manage")
    t = await _get_owned(db, staff.tenant_id, ticket_id)
    t.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    return ok({"id": str(ticket_id), "deleted": True})
