"""snooze 到期喚醒 worker:撿出到期的延後會話,還原狀態並喚回坐席台。

每輪(排程器 run_due_jobs)撿選 ``status='snoozed' AND snoozed_until <= now`` 的會話,
- 還原 status:有指派坐席(handler_staff_id)→ ``open``,否則 → ``queued``;
- 清空 snoozed_until;
- 發 realtime ``session.opened`` 事件(既有前端即時層已處理此事件→刷新會話列),喚回坐席台。

特性:
- 冪等 + 空資料安全:無到期會話時回 0、走 debug log。
- 本 worker **不 commit**:交易邊界由呼叫端(run_due_jobs / 排程器)決定;
  每輪包在 SAVEPOINT 中,單一失敗只回滾自己。
- 發事件失敗(如 Redis 不可用)逐會話降級,不影響狀態還原與其他 worker。
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Session
from app.services import realtime
from app.workers.base import register_worker

logger = logging.getLogger("kefu.workers")


@register_worker(name="snooze_wake")
async def run(db: AsyncSession) -> dict[str, Any]:
    """還原所有到期的 snoozed 會話並喚回坐席台(不 commit)。"""
    now = datetime.now(timezone.utc)
    # 注意:snoozed_until <= now 已隱含非 NULL(NULL 比較為 false),無需另加 is_not。
    rows = (
        await db.execute(
            select(Session).where(
                Session.status == "snoozed",
                Session.snoozed_until <= now,
                Session.deleted_at.is_(None),
            )
        )
    ).scalars().all()

    woken = 0
    for s in rows:
        s.status = "open" if s.handler_staff_id else "queued"
        s.snoozed_until = None
        woken += 1
        # 喚回坐席台:發到租戶坐席頻道與該會話頻道;發事件失敗不影響狀態還原
        try:
            event = realtime.make_event(
                "session.opened",
                {
                    "session_id": str(s.id),
                    "status": s.status,
                    "reason": "snooze_wake",
                },
            )
            await realtime.publish_agents(s.tenant_id, event)
            await realtime.publish(s.tenant_id, s.id, event)
        except Exception:  # noqa: BLE001 - 即時推送為加值,失敗不阻斷還原
            logger.warning("snooze 喚醒發事件失敗:session=%s", s.id, exc_info=True)

    # 併入外層交易,待呼叫端 commit(對齊 jobs.run_due_jobs 慣例:worker 不自行 commit)
    await db.flush()

    if woken:
        logger.info("snooze 喚醒:還原 %d 個到期會話", woken)
    else:
        logger.debug("snooze 喚醒:目前無到期會話")

    return {"woken": woken}
