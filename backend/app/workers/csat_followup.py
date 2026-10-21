"""CSAT 自動後續 worker:結案自動邀評 + 低分自動開跟進工單(首版)。

每輪(排程器 ``run_due_jobs``)做兩件互相獨立的事,各自 try/except 降級、批量節流:

1) **自動邀評(invite)**:撿「已結案(``status='closed'``)、尚未邀評
   (``csat_invited_at IS NULL``)、確有訪客訊息、且尚無任何 CSAT 評分」的會話,
   透過既有 ``conversation.add_message`` 發一則帶 ``meta.csat_invite`` 旗標的
   **system** 訊息(內容為繁中評分提示;訪客端 widget 可據該旗標呈現評分卡,
   提交仍走既有公開端點 ``POST /api/v1/quality/csat``——即與現有 CSAT 提交機制對齊),
   並把 ``Session.csat_invited_at`` 設為 now 作去重旗標。

2) **低分開單(ticket)**:撿「``rating <= LOW_RATING_THRESHOLD`` 且尚未為其所屬會話
   建過『csat 跟進』工單」的 CSAT,依既有工單資料模型直接建立一張 ``priority=high``
   的跟進工單(標題「低分回訪:會話 xxxxxxxx」,關聯該會話與其聯絡人,盡量指派給
   原處理坐席),以 ``Ticket.tags`` 含 ``FOLLOWUP_TAG`` 作為去重標記(不新增 migration)。

設計對齊既有 worker 慣例:
- **不 commit**:交易邊界一律交給 ``run_due_jobs`` / 排程器。
- 每一筆各自包一個 **SAVEPOINT(``begin_nested``)+ try/except**:單筆失敗
  (含 realtime 推送失敗、DB 錯誤)只回滾這一筆,不影響同批其他筆,也不影響另一階段;
  整個 worker 亦不向外拋——確保已成功的寫入得以保留,交給呼叫端 commit。
- 冪等 + 空資料安全:無待處理資料時回 0、走 debug log。
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Message, Session
from app.models.quality import CSAT
from app.models.ticket import Ticket
from app.models.visitor import Visitor
from app.services import conversation as conversation_svc
from app.workers.base import register_worker

logger = logging.getLogger("kefu.workers")

# 低分門檻:rating <= 此值 → 自動開跟進工單(星等 1–5,故 2 以下含 2)
LOW_RATING_THRESHOLD = 2
# 節流:每輪邀評 / 開單上限,避免單輪爆量(可日後改由 TenantSettings 驅動)
INVITE_BATCH_LIMIT = 50
TICKET_BATCH_LIMIT = 50
# 跟進工單去重標記:寫在 Ticket.tags(JSONB 陣列),以 @> 判存在(不新增欄位/表)
FOLLOWUP_TAG = "csat-followup"
# 邀評訊息內容(繁中);不理解 meta.csat_invite 的客戶端仍會把它當一般訊息顯示(優雅降級)
_INVITE_TEXT = "感謝您的來訊!為持續改善服務品質,誠摯邀請您為本次服務評分。"


@register_worker(name="csat_followup")
async def run(db: AsyncSession) -> dict[str, Any]:
    """一輪:先做自動邀評、再做低分開單;兩階段互相獨立降級。回傳本輪摘要。

    兩階段各自 try/except:任一階段的頂層查詢失敗都不影響另一階段;
    單筆處理另有各自的 SAVEPOINT(見 helper)。本函式不 commit、不向外拋。
    """
    invited = 0
    tickets = 0
    try:
        invited = await _invite_closed_sessions(db)
    except Exception:  # noqa: BLE001 - 邀評階段失敗不影響開單階段與其他 worker
        logger.exception("csat_followup:邀評階段失敗")
    try:
        tickets = await _open_low_score_tickets(db)
    except Exception:  # noqa: BLE001 - 開單階段失敗不影響邀評階段與其他 worker
        logger.exception("csat_followup:低分開單階段失敗")
    return {"invited": invited, "tickets_created": tickets}


async def _invite_closed_sessions(db: AsyncSession) -> int:
    """對符合條件的結案會話發出邀評並設去重旗標;回傳本輪成功邀評數。"""
    now = datetime.now(timezone.utc)

    # 相關子查詢:該會話是否「有訪客訊息」/「已有任何 CSAT」(交由 SQLAlchemy 自動相關)
    has_visitor_msg = (
        select(Message.id)
        .where(Message.session_id == Session.id, Message.sender_type == "visitor")
        .exists()
    )
    has_csat = select(CSAT.id).where(CSAT.session_id == Session.id).exists()

    sessions = (
        (
            await db.execute(
                select(Session)
                .where(
                    Session.status == "closed",
                    Session.csat_invited_at.is_(None),
                    Session.deleted_at.is_(None),
                    has_visitor_msg,
                    ~has_csat,
                )
                # 先處理較早結案者;PostgreSQL ASC 預設把 NULL 排最後
                .order_by(Session.closed_at.asc())
                .limit(INVITE_BATCH_LIMIT)
            )
        )
        .scalars()
        .all()
    )

    invited = 0
    for s in sessions:
        try:
            # 單筆 SAVEPOINT:add_message 的訊息寫入與 csat_invited_at 一起原子落地;
            # 若 realtime 推送等失敗,連同旗標一併回滾 → 旗標維持 NULL,下輪自然重試。
            async with db.begin_nested():
                await conversation_svc.add_message(
                    db,
                    s.tenant_id,
                    s.id,
                    "system",
                    _INVITE_TEXT,
                    meta={
                        "csat_invite": {
                            "rating_scale": 5,
                            "reason": "session_closed",
                            # widget 提交評分的既有公開端點(與現有 CSAT 機制對齊)
                            "submit_endpoint": "/api/v1/quality/csat",
                        }
                    },
                )
                s.csat_invited_at = now  # 去重旗標
                await db.flush()
            invited += 1
        except Exception:  # noqa: BLE001 - 單筆邀評失敗不拖垮其餘;不設旗標→下輪重試
            logger.warning("csat_followup:會話 %s 邀評失敗", s.id, exc_info=True)

    if invited:
        logger.info("csat_followup:本輪邀評 %d 個結案會話", invited)
    else:
        logger.debug("csat_followup:本輪無待邀評會話")
    return invited


async def _open_low_score_tickets(db: AsyncSession) -> int:
    """對尚未建過跟進工單的低分 CSAT 各建一張跟進工單;回傳本輪成功開單數。"""
    # 相關子查詢:該會話是否已有「csat 跟進」工單(tags 含 FOLLOWUP_TAG)。
    # 刻意不濾 deleted_at:即便被軟刪也視為「已建過」,避免刪除後每輪重建 → 去重穩定。
    followup_exists = (
        select(Ticket.id)
        .where(
            Ticket.tenant_id == CSAT.tenant_id,
            Ticket.session_id == CSAT.session_id,
            Ticket.tags.contains([FOLLOWUP_TAG]),
        )
        .exists()
    )

    low_csats = (
        (
            await db.execute(
                select(CSAT)
                .where(
                    CSAT.rating <= LOW_RATING_THRESHOLD,
                    CSAT.deleted_at.is_(None),
                    ~followup_exists,
                )
                .order_by(CSAT.created_at.asc())
                .limit(TICKET_BATCH_LIMIT)
            )
        )
        .scalars()
        .all()
    )

    created = 0
    handled_sessions: set[uuid.UUID] = set()  # 同批同一會話多筆低分 → 只開一張
    for c in low_csats:
        if c.session_id in handled_sessions:
            continue
        try:
            async with db.begin_nested():  # 單筆 SAVEPOINT:失敗只回滾這一張工單
                await _create_followup_ticket(db, c)
            handled_sessions.add(c.session_id)
            created += 1
        except Exception:  # noqa: BLE001 - 單筆開單失敗不拖垮其餘
            logger.warning("csat_followup:CSAT %s 低分開單失敗", c.id, exc_info=True)

    if created:
        logger.info("csat_followup:本輪低分開單 %d 張", created)
    else:
        logger.debug("csat_followup:本輪無待開單之低分 CSAT")
    return created


async def _create_followup_ticket(db: AsyncSession, csat: CSAT) -> Ticket:
    """依既有 Ticket 資料模型建立一張低分跟進工單(不 commit;由呼叫端 flush 保護)。

    仿 ticket API ``create_from_session`` 的關聯策略:由會話反查訪客→聯絡人並帶入,
    盡量指派給原處理坐席。會話若已不可用(軟刪等)則以最小資訊建單。
    """
    sess = (
        await db.execute(
            select(Session).where(
                Session.id == csat.session_id,
                Session.tenant_id == csat.tenant_id,
            )
        )
    ).scalar_one_or_none()

    contact_id: uuid.UUID | None = None
    assignee_staff_id: uuid.UUID | None = None
    if sess is not None:
        assignee_staff_id = sess.handler_staff_id
        # 由會話的訪客反查其聯絡人(CRM 主檔),自動關聯到工單
        contact_id = (
            await db.execute(
                select(Visitor.contact_id).where(Visitor.id == sess.visitor_id)
            )
        ).scalar_one_or_none()

    short = str(csat.session_id)[:8]
    desc_lines = [
        f"訪客於本次會話給出低分評價(rating={csat.rating}/5,level={csat.level or '-'})。",
        "系統自動建立此跟進工單,請主動回訪了解不滿原因並補救。",
    ]
    if csat.comment:
        desc_lines.append(f"訪客留言:{csat.comment}")

    ticket = Ticket(
        tenant_id=csat.tenant_id,
        title=f"低分回訪:會話 {short}",
        description="\n".join(desc_lines),
        status="open",
        priority="high",
        assignee_staff_id=assignee_staff_id,
        contact_id=contact_id,
        session_id=csat.session_id,
        tags=[FOLLOWUP_TAG],  # 去重標記(供 followup_exists 以 @> 判定)
        attributes={
            "csat_followup": True,
            "csat_id": str(csat.id),
            "rating": csat.rating,
        },
    )
    db.add(ticket)
    await db.flush()
    return ticket
