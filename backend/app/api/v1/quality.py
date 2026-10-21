"""M10 quality API:服務小結、CSAT、質檢標註/抽檢列表、訊息級質檢標旗、坐席監控。

路由前綴由整合者掛在 /api/v1/quality。

授權說明:多數端點為坐席操作,需 Bearer JWT(CurrentStaff),並以其
tenant_id 隔離。唯 CSAT「提交」由**訪客**發起、無 JWT,故該端點不要求
CurrentStaff——其 tenant_id 一律由所屬 session 反查(絕不信任外部傳入),
查無會話即 404。
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import ok
from app.models.quality import QUALITY_TARGETS, CSAT, QualityRecord, ServiceSummary
from app.services import quality as quality_svc

router = APIRouter()


# ---------- 服務小結 ----------
class ServiceSummaryIn(BaseModel):
    session_id: uuid.UUID
    category: str | None = Field(default=None, max_length=100)
    note: str | None = None


@router.post("/service-summary")
async def create_service_summary(body: ServiceSummaryIn, staff: CurrentStaff, db: DbSession):
    # 確認會話屬於本租戶,避免跨租戶掛小結
    tenant_id = await quality_svc.resolve_tenant_from_session(db, body.session_id)
    if tenant_id is None or tenant_id != staff.tenant_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="QUALITY_SESSION_NOT_FOUND")
    summary = await quality_svc.create_service_summary(
        db,
        staff.tenant_id,
        body.session_id,
        category=body.category,
        note=body.note,
        staff_id=staff.staff_id,
    )
    await db.commit()
    await db.refresh(summary)
    return ok(
        {
            "id": str(summary.id),
            "session_id": str(summary.session_id),
            "category": summary.category,
            "note": summary.note,
            "staff_id": str(summary.staff_id) if summary.staff_id else None,
            "created_at": summary.created_at.isoformat() if summary.created_at else None,
        }
    )


@router.get("/service-summary")
async def list_service_summaries(
    staff: CurrentStaff,
    db: DbSession,
    session_id: uuid.UUID | None = None,
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
):
    # 質檢資料把關:對齊 reporting,避免一般坐席讀取整租戶服務小結
    staff.require("quality.view")
    conds = [ServiceSummary.tenant_id == staff.tenant_id, ServiceSummary.deleted_at.is_(None)]
    if session_id is not None:
        conds.append(ServiceSummary.session_id == session_id)
    total = (
        await db.execute(select(func.count()).select_from(ServiceSummary).where(*conds))
    ).scalar_one()
    rows = (
        await db.execute(
            select(ServiceSummary)
            .where(*conds)
            .order_by(ServiceSummary.created_at.desc())
            .offset((page - 1) * size)
            .limit(size)
        )
    ).scalars().all()
    items = [
        {
            "id": str(r.id),
            "session_id": str(r.session_id),
            "category": r.category,
            "note": r.note,
            "staff_id": str(r.staff_id) if r.staff_id else None,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]
    return ok({"items": items, "total": total, "page": page, "size": size})


# ---------- CSAT ----------
class CSATIn(BaseModel):
    session_id: uuid.UUID
    rating: int = Field(ge=1, le=5)
    level: str | None = None
    comment: str | None = None
    visitor_id: uuid.UUID | None = None


@router.post("/csat")
async def submit_csat(body: CSATIn, db: DbSession):
    """訪客提交滿意度(公開端點,無 JWT)。

    防灌票 / 防無歸屬(公開端點的把關):
    - **存在性**:會話須存在且未軟刪,否則 404。tenant_id 由 session 反查(不信任外部)。
    - **狀態**:僅允許對「已結束(closed)」會話評分,否則 409;對進行中會話提前/重複
      評分不予受理,對齊結案後才邀評的流程。
    - **歸屬**:visitor_id 一律取自會話本身(session.visitor_id),不信任外部傳入,
      確保每筆評分都掛在該會話真正的訪客上。
    - **去重**:每會話限一次評分,已存在則由服務層更新而非新增(見 submit_csat)。
    """
    session = await quality_svc.get_session_for_csat(db, body.session_id)
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="QUALITY_SESSION_NOT_FOUND")
    if session.status != "closed":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="QUALITY_SESSION_NOT_CLOSED")
    csat = await quality_svc.submit_csat(
        db,
        session.tenant_id,
        body.session_id,
        rating=body.rating,
        level=body.level,
        comment=body.comment,
        # 歸屬以會話本身的訪客為準,忽略外部可偽造的 body.visitor_id
        visitor_id=session.visitor_id,
    )
    await db.commit()
    await db.refresh(csat)
    return ok(
        {
            "id": str(csat.id),
            "session_id": str(csat.session_id),
            "rating": csat.rating,
            "level": csat.level,
            "comment": csat.comment,
        }
    )


@router.get("/csat")
async def list_csat(
    staff: CurrentStaff,
    db: DbSession,
    session_id: uuid.UUID | None = None,
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
):
    # 質檢資料把關:對齊 reporting,避免一般坐席讀取整租戶 CSAT 評分與評語
    staff.require("quality.view")
    conds = [CSAT.tenant_id == staff.tenant_id, CSAT.deleted_at.is_(None)]
    if session_id is not None:
        conds.append(CSAT.session_id == session_id)
    total = (await db.execute(select(func.count()).select_from(CSAT).where(*conds))).scalar_one()
    rows = (
        await db.execute(
            select(CSAT)
            .where(*conds)
            .order_by(CSAT.created_at.desc())
            .offset((page - 1) * size)
            .limit(size)
        )
    ).scalars().all()
    items = [
        {
            "id": str(r.id),
            "session_id": str(r.session_id),
            "rating": r.rating,
            "level": r.level,
            "comment": r.comment,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]
    return ok({"items": items, "total": total, "page": page, "size": size})


# ---------- 質檢紀錄(標註 / 抽檢) ----------
class QualityRecordIn(BaseModel):
    target_type: str  # message | session
    session_id: uuid.UUID | None = None
    message_id: uuid.UUID | None = None
    score: int | None = None
    label: str | None = Field(default=None, max_length=100)
    note: str | None = None
    is_sampled: bool = False


def _serialize_record(r: QualityRecord) -> dict:
    return {
        "id": str(r.id),
        "target_type": r.target_type,
        "session_id": str(r.session_id) if r.session_id else None,
        "message_id": str(r.message_id) if r.message_id else None,
        "reviewer_staff_id": str(r.reviewer_staff_id) if r.reviewer_staff_id else None,
        "score": r.score,
        "label": r.label,
        "note": r.note,
        "is_sampled": r.is_sampled,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


@router.post("/quality-record")
async def create_quality_record(body: QualityRecordIn, staff: CurrentStaff, db: DbSession):
    if body.target_type not in QUALITY_TARGETS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="QUALITY_INVALID_TARGET")
    if body.target_type == "message" and body.message_id is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="QUALITY_MESSAGE_ID_REQUIRED")
    if body.target_type == "session" and body.session_id is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="QUALITY_SESSION_ID_REQUIRED")
    record = await quality_svc.create_quality_record(
        db,
        staff.tenant_id,
        body.target_type,
        session_id=body.session_id,
        message_id=body.message_id,
        reviewer_staff_id=staff.staff_id,
        score=body.score,
        label=body.label,
        note=body.note,
        is_sampled=body.is_sampled,
    )
    await db.commit()
    await db.refresh(record)
    return ok(_serialize_record(record))


@router.get("/quality-record")
async def list_quality_records(
    staff: CurrentStaff,
    db: DbSession,
    target_type: str | None = None,
    session_id: uuid.UUID | None = None,
    message_id: uuid.UUID | None = None,
    reviewer_staff_id: uuid.UUID | None = None,
    is_sampled: bool | None = None,
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
):
    """質檢紀錄列表;is_sampled=true 即為「抽檢列表」。"""
    # 質檢資料把關:對齊 reporting,避免一般坐席讀取整租戶質檢紀錄
    staff.require("quality.view")
    conds = [QualityRecord.tenant_id == staff.tenant_id, QualityRecord.deleted_at.is_(None)]
    if target_type is not None:
        conds.append(QualityRecord.target_type == target_type)
    if session_id is not None:
        conds.append(QualityRecord.session_id == session_id)
    if message_id is not None:
        conds.append(QualityRecord.message_id == message_id)
    if reviewer_staff_id is not None:
        conds.append(QualityRecord.reviewer_staff_id == reviewer_staff_id)
    if is_sampled is not None:
        conds.append(QualityRecord.is_sampled.is_(is_sampled))
    total = (
        await db.execute(select(func.count()).select_from(QualityRecord).where(*conds))
    ).scalar_one()
    rows = (
        await db.execute(
            select(QualityRecord)
            .where(*conds)
            .order_by(QualityRecord.created_at.desc())
            .offset((page - 1) * size)
            .limit(size)
        )
    ).scalars().all()
    return ok(
        {"items": [_serialize_record(r) for r in rows], "total": total, "page": page, "size": size}
    )


# ---------- 訊息級質檢標旗 ----------
class MessageFlagIn(BaseModel):
    label: str | None = Field(default=None, max_length=100)
    note: str | None = None
    score: int | None = None


@router.post("/message/{message_id}/flag")
async def flag_message(
    message_id: uuid.UUID, body: MessageFlagIn, staff: CurrentStaff, db: DbSession
):
    """對某 message 加質檢旗/備註:寫入 QualityRecord + 蓋 Message.meta.quality。"""
    record = await quality_svc.flag_message(
        db,
        staff.tenant_id,
        message_id,
        label=body.label,
        note=body.note,
        score=body.score,
        reviewer_staff_id=staff.staff_id,
    )
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="QUALITY_MESSAGE_NOT_FOUND")
    await db.commit()
    await db.refresh(record)
    return ok(_serialize_record(record))


# ---------- 坐席監控 ----------
@router.get("/agent-monitor/{staff_id}")
async def agent_monitor(staff_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """查某坐席目前進行中的會話摘要(同租戶)。"""
    # 質檢資料把關:對齊 reporting,避免一般坐席窺看他人會話的最後訊息內容
    staff.require("quality.view")
    summaries = await quality_svc.agent_active_sessions(db, staff.tenant_id, staff_id)
    return ok({"staff_id": str(staff_id), "active_sessions": summaries, "count": len(summaries)})
