"""資料匯出(CSV)API。

本模組提供把工單 / 聯絡人 / 會話 / 報表總覽 / 單一會話訊息匯出成 CSV 的端點,
供坐席與管理者下載存查、丟進 Excel 分析。整合者(main.py)請以

    from app.api.v1 import exports
    app.include_router(exports.router, prefix="/api/v1/exports", tags=["exports"])

掛載,對外路徑即為 ``/api/v1/exports/xxx.csv``。

設計要點
--------
- **租戶隔離**:所有查詢一律以 ``staff.tenant_id`` 過濾,絕不信任前端傳入的 tenant;
  join 到 Channel / Staff 亦補租戶條件,避免跨租戶關聯洩漏。
- **權限**:比照對應「讀取端點」的權限。工單 / 聯絡人 / 會話 / 訊息的既有讀取端點
  均無額外 ``require``(僅需登入 + 租戶隔離),故其匯出亦僅需 ``CurrentStaff``;
  報表總覽比照 reporting 需 ``report.view``(CSAT 欄位另受 ``quality.view`` 軟性把關,
  由被複用的 reporting.overview 自行處理)。
- **串流不爆記憶體**:以 ``fastapi.responses.StreamingResponse`` + 標準庫 ``csv`` +
  ``io.StringIO`` 逐列輸出;資料層用 SQLAlchemy 的 **伺服器端游標串流**
  (``AsyncSession.stream(...)``,asyncpg 底層以 server-side portal 分批取列),
  且 SELECT 只取需要的欄位(回傳 Row 而非 ORM 實體,不進 identity map),
  因此無論資料多寡,記憶體佔用都維持在單列 + 輸出緩衝的量級,不會一次拉爆。
- **編碼**:輸出 UTF-8 並加上 BOM(``﻿``),Excel 開啟繁中不亂碼。
- **檔名**:以 ``Content-Disposition: attachment; filename=...`` 帶出時間戳檔名。
- **串流期間的 DB 連線**:串流產生器內自行開啟 ``SessionLocal()`` 並在 ``async with``
  結束時關閉,連線生命週期完全由產生器掌控,不依賴請求級依賴的關閉時機
  (避免「回應送出前 session 已關」的版本相依問題)。權限檢查與存在性檢查則在
  回傳 StreamingResponse 之前先做,確保 403 / 404 以正常錯誤回應呈現,而非串流中途中斷。
"""
from __future__ import annotations

import csv
import io
import json
import uuid
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select

from app.core.db import SessionLocal
from app.core.deps import CurrentStaff, DbSession
from app.models.conversation import Channel, Message, Session
from app.models.iam import Staff

router = APIRouter()

# 每累積約 32KB 字元就 flush 一次輸出緩衝,平衡「產出即時性」與「yield 次數」
_FLUSH_BYTES = 32 * 1024

# 常用查詢型別別名(對齊 reporting 的時間區間語意:start 含、end 不含)
StartQ = Annotated[datetime | None, Query(description="起始時間(含);ISO 8601")]
EndQ = Annotated[datetime | None, Query(description="結束時間(不含);ISO 8601")]
LimitQ = Annotated[
    int | None,
    Query(ge=1, le=1_000_000, description="最多匯出列數上限(選填);未給則匯出全部符合條件的列"),
]


# ============================ 共用工具 ============================
# 會被試算表(Excel / Google Sheets / LibreOffice)當成公式起頭而觸發注入的危險字元。
# 儲存格若以這些字元開頭,開檔時可能被當公式執行(=cmd|... / +HYPERLINK(...) / DDE 等),
# 屬 CSV Formula Injection(CWE-1236)。工單標題、訊息內容等欄位可能來自不可信的外部
# 訪客,且匯出可被遠端觸發,故一律中和。
_CSV_INJECTION_PREFIXES = frozenset("=+-@\t\r")


def _csv_safe(value: Any) -> Any:
    """中和 CSV/試算表公式注入:字串若以危險字元開頭,前置單引號 `'` 讓其被當純文字。

    非字串(數字、None 等)原樣回傳(數字不可能被解讀為公式,且經 csv.writer 正常序列化)。
    這是標準防注入手法;單引號前綴在 Excel 中不會顯示於儲存格,只改變其被當文字而非公式。
    """
    if isinstance(value, str) and value and value[0] in _CSV_INJECTION_PREFIXES:
        return "'" + value
    return value


def _fmt_dt(dt: datetime | None) -> str:
    """時間 → ISO 字串;None → 空字串。"""
    return dt.isoformat() if dt else ""


def _fmt_json(value: Any) -> str:
    """dict / list(JSONB)→ 緊湊 JSON 字串(保留中文);None/空 → 空字串。"""
    if not value:
        return ""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _fmt_uuid(value: uuid.UUID | None) -> str:
    return str(value) if value else ""


def _fmt_bool(value: bool | None) -> str:
    if value is None:
        return ""
    return "是" if value else "否"


def _disposition(prefix: str) -> dict[str, str]:
    """組出下載用的 Content-Disposition 標頭(帶 UTC 時間戳的 ASCII 檔名)。"""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return {"Content-Disposition": f'attachment; filename="{prefix}_{stamp}.csv"'}


async def _csv_stream(headers: list[str], rows: AsyncIterator[list[Any]]) -> AsyncIterator[str]:
    """把「表頭 + 逐列資料」串流成 CSV 文字片段(含 UTF-8 BOM)。

    ``rows`` 為非同步產生器,自行管理其 DB session 生命週期。本函式只負責把每列
    寫進 StringIO 緩衝、累積到門檻或結束時吐出,確保記憶體佔用恆定。

    **公式注入防護集中於此**:每一格(含表頭)輸出前一律過 ``_csv_safe``,因此無論
    哪個端點、哪個欄位(工單標題/描述、聯絡人姓名/備註/公司、訊息內容、tags/attributes
    JSON、渠道名稱…)都受同一道防線保護,新增端點也自動涵蓋。
    """
    buf = io.StringIO()
    writer = csv.writer(buf)

    def take() -> str:
        chunk = buf.getvalue()
        buf.seek(0)
        buf.truncate(0)
        return chunk

    # BOM 讓 Excel 正確辨識 UTF-8;隨後寫入繁中表頭
    buf.write("﻿")
    writer.writerow([_csv_safe(h) for h in headers])
    yield take()

    async for row in rows:
        writer.writerow([_csv_safe(cell) for cell in row])
        if buf.tell() >= _FLUSH_BYTES:
            yield take()

    tail = take()
    if tail:
        yield tail


def _csv_response(prefix: str, headers: list[str], rows: AsyncIterator[list[Any]]) -> StreamingResponse:
    return StreamingResponse(
        _csv_stream(headers, rows),
        media_type="text/csv; charset=utf-8",
        headers=_disposition(prefix),
    )


# ============================ 工單匯出 ============================
_TICKET_HEADERS = [
    "工單ID", "標題", "描述", "狀態", "優先級",
    "指派坐席ID", "指派坐席", "關聯聯絡人ID", "關聯會話ID",
    "標籤", "已解決時間", "關閉時間", "建立時間", "更新時間",
]


@router.get("/tickets.csv")
async def export_tickets(
    staff: CurrentStaff,
    status_: Annotated[str | None, Query(alias="status", description="工單狀態過濾")] = None,
    priority: str | None = None,
    assignee_staff_id: uuid.UUID | None = None,
    contact_id: uuid.UUID | None = None,
    session_id: uuid.UUID | None = None,
    start: StartQ = None,
    end: EndQ = None,
    limit: LimitQ = None,
):
    """匯出工單清單(比照 GET /api/v1/ticket 讀取端點:僅需登入 + 租戶隔離)。"""
    from app.models.ticket import Ticket  # 局部匯入,避免模組載入順序耦合

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
    if start is not None:
        conds.append(Ticket.created_at >= start)
    if end is not None:
        conds.append(Ticket.created_at < end)

    stmt = (
        select(
            Ticket.id.label("id"),
            Ticket.title.label("title"),
            Ticket.description.label("description"),
            Ticket.status.label("status"),
            Ticket.priority.label("priority"),
            Ticket.assignee_staff_id.label("assignee_id"),
            Staff.display_name.label("assignee_name"),
            Ticket.contact_id.label("contact_id"),
            Ticket.session_id.label("session_id"),
            Ticket.tags.label("tags"),
            Ticket.resolved_at.label("resolved_at"),
            Ticket.closed_at.label("closed_at"),
            Ticket.created_at.label("created_at"),
            Ticket.updated_at.label("updated_at"),
        )
        .select_from(Ticket)
        # 指派坐席顯示名:outerjoin 且限同租戶,未指派時為 NULL
        .outerjoin(Staff, (Staff.id == Ticket.assignee_staff_id) & (Staff.tenant_id == staff.tenant_id))
        .where(*conds)
        .order_by(Ticket.created_at.desc())
    )
    if limit is not None:
        stmt = stmt.limit(limit)

    async def _rows() -> AsyncIterator[list[Any]]:
        async with SessionLocal() as session:
            result = await session.stream(stmt)
            async for r in result:
                yield [
                    _fmt_uuid(r.id),
                    r.title,
                    r.description or "",
                    r.status,
                    r.priority,
                    _fmt_uuid(r.assignee_id),
                    r.assignee_name or "",
                    _fmt_uuid(r.contact_id),
                    _fmt_uuid(r.session_id),
                    _fmt_json(r.tags),
                    _fmt_dt(r.resolved_at),
                    _fmt_dt(r.closed_at),
                    _fmt_dt(r.created_at),
                    _fmt_dt(r.updated_at),
                ]

    return _csv_response("tickets", _TICKET_HEADERS, _rows())


# ============================ 聯絡人匯出 ============================
_CONTACT_HEADERS = [
    "聯絡人ID", "姓名", "Email", "電話", "公司",
    "是否封鎖", "備註", "自訂屬性(JSON)", "建立時間",
]


@router.get("/contacts.csv")
async def export_contacts(
    staff: CurrentStaff,
    is_blocked: bool | None = None,
    q: Annotated[str | None, Query(description="模糊搜尋:姓名/Email/電話")] = None,
    start: StartQ = None,
    end: EndQ = None,
    limit: LimitQ = None,
):
    """匯出聯絡人(CRM)清單(比照 GET /api/v1/visitor/contacts:僅需登入 + 租戶隔離)。

    ``company`` 欄位:資料模型未獨立設欄,由 ``attributes.company`` 攤平帶出;
    另附完整 ``attributes`` 的 JSON 字串,避免自訂欄位資訊遺失。
    """
    from app.models.visitor import Contact as ContactModel

    conds = [ContactModel.tenant_id == staff.tenant_id, ContactModel.deleted_at.is_(None)]
    if is_blocked is not None:
        conds.append(ContactModel.is_blocked.is_(is_blocked))
    if q:
        like = f"%{q}%"
        conds.append(
            ContactModel.name.ilike(like)
            | ContactModel.email.ilike(like)
            | ContactModel.phone.ilike(like)
        )
    if start is not None:
        conds.append(ContactModel.created_at >= start)
    if end is not None:
        conds.append(ContactModel.created_at < end)

    stmt = (
        select(
            ContactModel.id.label("id"),
            ContactModel.name.label("name"),
            ContactModel.email.label("email"),
            ContactModel.phone.label("phone"),
            ContactModel.attributes.label("attributes"),
            ContactModel.is_blocked.label("is_blocked"),
            ContactModel.note.label("note"),
            ContactModel.created_at.label("created_at"),
        )
        .where(*conds)
        .order_by(ContactModel.created_at.desc())
    )
    if limit is not None:
        stmt = stmt.limit(limit)

    async def _rows() -> AsyncIterator[list[Any]]:
        async with SessionLocal() as session:
            result = await session.stream(stmt)
            async for r in result:
                attrs = r.attributes or {}
                company = attrs.get("company", "") if isinstance(attrs, dict) else ""
                yield [
                    _fmt_uuid(r.id),
                    r.name or "",
                    r.email or "",
                    r.phone or "",
                    company or "",
                    _fmt_bool(r.is_blocked),
                    r.note or "",
                    _fmt_json(r.attributes),
                    _fmt_dt(r.created_at),
                ]

    return _csv_response("contacts", _CONTACT_HEADERS, _rows())


# ============================ 會話匯出 ============================
_SESSION_HEADERS = [
    "會話ID", "渠道類型", "渠道名稱", "狀態", "處理者類型",
    "處理坐席ID", "處理坐席", "訪客ID", "技能組ID",
    "開始時間", "最後訊息時間", "結束時間", "訊息數",
]


@router.get("/sessions.csv")
async def export_sessions(
    staff: CurrentStaff,
    status_: Annotated[str | None, Query(alias="status", description="會話狀態過濾")] = None,
    channel_id: uuid.UUID | None = None,
    handler_staff_id: uuid.UUID | None = None,
    start: StartQ = None,
    end: EndQ = None,
    limit: LimitQ = None,
):
    """匯出會話清單(比照 GET /api/v1/conversation/sessions:僅需登入 + 租戶隔離)。

    訊息數以「依 session_id 分組計數」的子查詢 outerjoin 帶出(單一聚合,無 N+1)。
    """
    conds = [Session.tenant_id == staff.tenant_id, Session.deleted_at.is_(None)]
    if status_ is not None:
        conds.append(Session.status == status_)
    if channel_id is not None:
        conds.append(Session.channel_id == channel_id)
    if handler_staff_id is not None:
        conds.append(Session.handler_staff_id == handler_staff_id)
    if start is not None:
        conds.append(Session.created_at >= start)
    if end is not None:
        conds.append(Session.created_at < end)

    # 每會話訊息數(限同租戶、未軟刪)
    msg_count = (
        select(
            Message.session_id.label("sid"),
            func.count().label("cnt"),
        )
        .where(Message.tenant_id == staff.tenant_id, Message.deleted_at.is_(None))
        .group_by(Message.session_id)
        .subquery()
    )

    stmt = (
        select(
            Session.id.label("id"),
            Channel.type.label("channel_type"),
            Channel.name.label("channel_name"),
            Session.status.label("status"),
            Session.handler_type.label("handler_type"),
            Session.handler_staff_id.label("handler_id"),
            Staff.display_name.label("handler_name"),
            Session.visitor_id.label("visitor_id"),
            Session.skill_group_id.label("skill_group_id"),
            Session.created_at.label("created_at"),
            Session.last_message_at.label("last_message_at"),
            Session.closed_at.label("closed_at"),
            func.coalesce(msg_count.c.cnt, 0).label("message_count"),
        )
        .select_from(Session)
        .join(Channel, (Channel.id == Session.channel_id) & (Channel.tenant_id == staff.tenant_id))
        .outerjoin(Staff, (Staff.id == Session.handler_staff_id) & (Staff.tenant_id == staff.tenant_id))
        .outerjoin(msg_count, msg_count.c.sid == Session.id)
        .where(*conds)
        .order_by(Session.created_at.desc())
    )
    if limit is not None:
        stmt = stmt.limit(limit)

    async def _rows() -> AsyncIterator[list[Any]]:
        async with SessionLocal() as session:
            result = await session.stream(stmt)
            async for r in result:
                yield [
                    _fmt_uuid(r.id),
                    r.channel_type,
                    r.channel_name,
                    r.status,
                    r.handler_type,
                    _fmt_uuid(r.handler_id),
                    r.handler_name or "",
                    _fmt_uuid(r.visitor_id),
                    _fmt_uuid(r.skill_group_id),
                    _fmt_dt(r.created_at),
                    _fmt_dt(r.last_message_at),
                    _fmt_dt(r.closed_at),
                    int(r.message_count),
                ]

    return _csv_response("sessions", _SESSION_HEADERS, _rows())


# ============================ 單一會話訊息匯出 ============================
_MESSAGE_HEADERS = [
    "訊息ID", "會話ID", "發送者類型", "發送者ID",
    "內容類型", "內容", "附加資料(JSON)", "建立時間", "已讀時間",
]


@router.get("/messages.csv")
async def export_messages(
    staff: CurrentStaff,
    db: DbSession,
    session_id: Annotated[uuid.UUID, Query(description="要匯出的會話 ID")],
    start: StartQ = None,
    end: EndQ = None,
    limit: LimitQ = None,
):
    """匯出單一會話的逐則訊息(比照 GET /api/v1/conversation/sessions/{id})。

    先確認該會話屬本租戶且存在(否則 404),再依時間升冪串流其訊息。
    """
    # 存在性 + 租戶歸屬前置檢查(用請求級 session;在回傳串流前完成,404 以正常錯誤回應)
    owned = (
        await db.execute(
            select(Session.id).where(
                Session.id == session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if owned is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="EXPORT_SESSION_NOT_FOUND")

    conds = [
        Message.tenant_id == staff.tenant_id,
        Message.session_id == session_id,
        Message.deleted_at.is_(None),
    ]
    if start is not None:
        conds.append(Message.created_at >= start)
    if end is not None:
        conds.append(Message.created_at < end)

    stmt = (
        select(
            Message.id.label("id"),
            Message.session_id.label("session_id"),
            Message.sender_type.label("sender_type"),
            Message.sender_id.label("sender_id"),
            Message.content_type.label("content_type"),
            Message.content.label("content"),
            Message.meta.label("meta"),
            Message.created_at.label("created_at"),
            Message.read_at.label("read_at"),
        )
        .where(*conds)
        .order_by(Message.created_at.asc())
    )
    if limit is not None:
        stmt = stmt.limit(limit)

    async def _rows() -> AsyncIterator[list[Any]]:
        async with SessionLocal() as session:
            result = await session.stream(stmt)
            async for r in result:
                yield [
                    _fmt_uuid(r.id),
                    _fmt_uuid(r.session_id),
                    r.sender_type,
                    _fmt_uuid(r.sender_id),
                    r.content_type,
                    r.content or "",
                    _fmt_json(r.meta),
                    _fmt_dt(r.created_at),
                    _fmt_dt(r.read_at),
                ]

    return _csv_response(f"messages_{str(session_id)[:8]}", _MESSAGE_HEADERS, _rows())


# ============================ 報表總覽匯出 ============================
_OVERVIEW_HEADERS = ["指標", "本期值", "前期值", "環比百分比"]


@router.get("/reports/overview.csv")
async def export_overview(
    staff: CurrentStaff,
    db: DbSession,
    start: StartQ = None,
    end: EndQ = None,
    skill_group_id: Annotated[uuid.UUID | None, Query(description="技能組維度過濾")] = None,
):
    """匯出報表總覽關鍵指標。

    直接複用 reporting.overview 的計算(clean-room:只讀取/呼叫,不改動其檔),
    確保欄位與口徑與線上報表完全一致;權限亦沿用其內部的 ``report.view``
    (CSAT 相關欄位受 ``quality.view`` 軟性把關,無權限時回空/None)。
    """
    from app.api.v1.reporting import overview as reporting_overview

    # 於回傳串流前先算好(權限不足會在此拋 403);結果為有界的小量聚合,可安全放記憶體
    envelope = await reporting_overview(staff, db, start, end, skill_group_id)
    data = envelope.get("data", {}) if isinstance(envelope, dict) else {}
    kpi = data.get("kpi", {})
    period = data.get("period", {})

    def _n(v: Any) -> Any:
        return "" if v is None else v

    conv = kpi.get("conversations", {})
    ai = kpi.get("ai_resolution_rate", {})
    wait = kpi.get("avg_wait_seconds", {})
    csat = kpi.get("csat", {})

    table: list[list[Any]] = [
        ["統計期間(起)", _n(period.get("start")), "", ""],
        ["統計期間(迄)", _n(period.get("end")), "", ""],
        ["會話總數", _n(conv.get("value")), _n(conv.get("prev")), _n(conv.get("delta_pct"))],
        ["AI 解決率(%)", _n(ai.get("value")), _n(ai.get("prev")), _n(ai.get("delta_pct"))],
        ["平均等待秒數", _n(wait.get("value")), _n(wait.get("prev")), _n(wait.get("delta_pct"))],
        ["滿意度 CSAT(%)", _n(csat.get("value")), _n(csat.get("prev")), _n(csat.get("delta_pct"))],
        ["CSAT 回應數", _n(csat.get("responses")), "", ""],
    ]

    async def _rows() -> AsyncIterator[list[Any]]:
        for row in table:
            yield row

    return _csv_response("report_overview", _OVERVIEW_HEADERS, _rows())
