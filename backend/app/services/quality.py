"""M10 quality 服務層 seam。

集中質檢/滿意度/服務小結的寫入邏輯,供 app/api/v1/quality.py 呼叫,
也讓其他模組(如 M3 close_session 時想順手落一筆服務小結、或渠道端收到
訪客評分)能以穩定的函式簽名跨模組呼叫,而不必碰本模組檔案。

所有函式都要求傳入 tenant_id 並據以隔離;需由 session 推導 tenant 的
情境(如訪客提交 CSAT)提供 resolve_tenant_from_session()。
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Message, Session
from app.models.quality import CSAT, QualityRecord, ServiceSummary


async def resolve_tenant_from_session(
    db: AsyncSession, session_id: uuid.UUID
) -> uuid.UUID | None:
    """由 session 反查其 tenant_id;供無 JWT 的訪客提交情境安全取得租戶。

    回 None 表示查無此會話(呼叫端應回 404,而非信任外部傳入的 tenant_id)。
    """
    return (
        await db.execute(select(Session.tenant_id).where(Session.id == session_id))
    ).scalar_one_or_none()


async def get_session_for_csat(
    db: AsyncSession, session_id: uuid.UUID
) -> Session | None:
    """取回會話供 CSAT 提交把關(存在性 + 狀態 + 租戶 + 歸屬)。

    公開 CSAT 端點無 JWT,呼叫端據此判斷:查無(含已軟刪)→ 404;會話未結束
    (status != closed)→ 409;並以 ``session.tenant_id`` / ``session.visitor_id``
    作為權威的租戶與歸屬來源(絕不信任外部傳入)。
    """
    return (
        await db.execute(
            select(Session).where(
                Session.id == session_id, Session.deleted_at.is_(None)
            )
        )
    ).scalar_one_or_none()


async def create_service_summary(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    session_id: uuid.UUID,
    category: str | None = None,
    note: str | None = None,
    staff_id: uuid.UUID | None = None,
) -> ServiceSummary:
    """建立服務小結(結束會話時的分類 + 備註)。"""
    summary = ServiceSummary(
        tenant_id=tenant_id,
        session_id=session_id,
        category=category,
        note=note,
        staff_id=staff_id,
    )
    db.add(summary)
    await db.flush()
    return summary


async def submit_csat(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    session_id: uuid.UUID,
    rating: int,
    level: str | None = None,
    comment: str | None = None,
    visitor_id: uuid.UUID | None = None,
) -> CSAT:
    """提交滿意度評分。rating 未帶 level 時,依 1–5 自動映射一個等級。

    **每會話限一次評分(防灌票)**:若該會話已有 CSAT(取最新一筆),則就地更新其
    分數/等級/評語/歸屬,而非新增第二筆——避免公開端點被重複灌票堆出無限列。
    首次提交才新增。無論新增或更新,回傳該筆 CSAT 供呼叫端 commit/refresh。
    (以「取最新一筆更新」而非唯一鍵,亦能相容修法前既存的多筆歷史資料。)
    """
    if level is None:
        level = _rating_to_level(rating)

    existing = (
        await db.execute(
            select(CSAT)
            .where(
                CSAT.tenant_id == tenant_id,
                CSAT.session_id == session_id,
                CSAT.deleted_at.is_(None),
            )
            .order_by(CSAT.created_at.desc())
            .limit(1)
        )
    ).scalars().first()
    if existing is not None:
        existing.rating = rating
        existing.level = level
        existing.comment = comment
        if visitor_id is not None:
            existing.visitor_id = visitor_id
        await db.flush()
        return existing

    csat = CSAT(
        tenant_id=tenant_id,
        session_id=session_id,
        rating=rating,
        level=level,
        comment=comment,
        visitor_id=visitor_id,
    )
    db.add(csat)
    await db.flush()
    return csat


async def create_quality_record(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    target_type: str,
    *,
    session_id: uuid.UUID | None = None,
    message_id: uuid.UUID | None = None,
    reviewer_staff_id: uuid.UUID | None = None,
    score: int | None = None,
    label: str | None = None,
    note: str | None = None,
    is_sampled: bool = False,
) -> QualityRecord:
    """建立一筆質檢紀錄(標註 / 評分 / 抽檢)。"""
    record = QualityRecord(
        tenant_id=tenant_id,
        target_type=target_type,
        session_id=session_id,
        message_id=message_id,
        reviewer_staff_id=reviewer_staff_id,
        score=score,
        label=label,
        note=note,
        is_sampled=is_sampled,
    )
    db.add(record)
    await db.flush()
    return record


async def flag_message(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    message_id: uuid.UUID,
    *,
    label: str | None = None,
    note: str | None = None,
    score: int | None = None,
    reviewer_staff_id: uuid.UUID | None = None,
) -> QualityRecord | None:
    """對某 message 加質檢旗/備註。

    雙寫策略:①建立 QualityRecord(可追溯、可列表)②在 Message.meta 蓋一個
    輕量 quality 標記,方便坐席台在訊息流上直接顯示旗標,免得再連表。
    回 None 表示訊息不存在或不屬於本租戶(呼叫端回 404)。
    """
    msg = (
        await db.execute(
            select(Message).where(Message.id == message_id, Message.tenant_id == tenant_id)
        )
    ).scalar_one_or_none()
    if msg is None:
        return None

    record = await create_quality_record(
        db,
        tenant_id,
        "message",
        session_id=msg.session_id,
        message_id=message_id,
        reviewer_staff_id=reviewer_staff_id,
        score=score,
        label=label,
        note=note,
    )

    # 以「重新賦值整個 dict」的方式變更 JSONB,確保 SQLAlchemy 偵測到髒值並更新。
    flag: dict[str, Any] = {"flagged": True, "record_id": str(record.id)}
    if label is not None:
        flag["label"] = label
    if note is not None:
        flag["note"] = note
    if score is not None:
        flag["score"] = score
    msg.meta = {**(msg.meta or {}), "quality": flag}

    await db.flush()
    return record


async def agent_active_sessions(
    db: AsyncSession, tenant_id: uuid.UUID, staff_id: uuid.UUID
) -> list[dict[str, Any]]:
    """坐席監控:查某坐席目前進行中的會話摘要(status in open/queued)。"""
    rows = (
        await db.execute(
            select(Session)
            .where(
                Session.tenant_id == tenant_id,
                Session.handler_staff_id == staff_id,
                Session.status.in_(("open", "queued")),
                Session.deleted_at.is_(None),
            )
            .order_by(Session.updated_at.desc())
        )
    ).scalars().all()

    summaries: list[dict[str, Any]] = []
    for s in rows:
        # 取該會話最近一則訊息,做為監控卡片的預覽
        last = (
            await db.execute(
                select(Message)
                .where(Message.session_id == s.id, Message.tenant_id == tenant_id)
                .order_by(Message.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        summaries.append(
            {
                "session_id": str(s.id),
                "status": s.status,
                "handler_type": s.handler_type,
                "visitor_id": str(s.visitor_id),
                "channel_id": str(s.channel_id),
                "updated_at": s.updated_at.isoformat() if s.updated_at else None,
                "last_message": None
                if last is None
                else {
                    "sender_type": last.sender_type,
                    "content": last.content,
                    "created_at": last.created_at.isoformat() if last.created_at else None,
                },
            }
        )
    return summaries


def _rating_to_level(rating: int) -> str:
    """1–5 星映射為可讀等級。"""
    if rating <= 2:
        return "bad"
    if rating == 3:
        return "neutral"
    return "good"
