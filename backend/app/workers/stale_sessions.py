"""樣板 worker②:久未活動(idle)會話巡檢(唯讀,不改資料)。

用途:掃描未結案(open/queued)且「最後活動時間」早於門檻的會話,
彙總各租戶數量並寫 log。最後活動 = COALESCE(last_message_at, created_at)。
只用既有 `Session` 欄位,無需新 migration/欄位。

特性:
- 純唯讀:只 SELECT + COUNT,不改任何資料。
- 冪等 + 空資料安全:無久未活動會話時回 0、走 debug log。

後續可掛在此邏輯上的真動作(需要各自的新欄位/服務,先不做):
- 自動提醒/升級久候會話 → 可送 realtime 通知或觸發 automation 事件。
- 自動關閉超久無回應會話 → 需產品規則確認。
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Session
from app.workers.base import register_worker

logger = logging.getLogger("kefu.workers")

# 未結案狀態(對齊 conversation/sla 語意)
_OPEN_STATUSES = ("open", "queued")
# 視為「久未活動」的門檻(分鐘)。日後可改由 TenantSettings 驅動。
IDLE_THRESHOLD_MINUTES = 30


@register_worker(name="stale_sessions")
async def run(db: AsyncSession) -> dict[str, Any]:
    """彙總逾門檻未活動的未結案會話數(唯讀)。"""
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=IDLE_THRESHOLD_MINUTES)
    # 最後活動:優先 last_message_at,無則退回 created_at
    last_activity = func.coalesce(Session.last_message_at, Session.created_at)

    rows = (
        await db.execute(
            select(Session.tenant_id, func.count())
            .where(
                Session.status.in_(_OPEN_STATUSES),
                Session.deleted_at.is_(None),
                last_activity < cutoff,
            )
            .group_by(Session.tenant_id)
        )
    ).all()

    per_tenant = {str(tenant_id): int(count) for tenant_id, count in rows}
    total = sum(per_tenant.values())

    if total:
        logger.info(
            "idle 會話巡檢:逾 %d 分未活動之未結案會話=%d(涉及租戶=%d)",
            IDLE_THRESHOLD_MINUTES,
            total,
            len(per_tenant),
        )
    else:
        logger.debug("idle 會話巡檢:目前無久未活動之未結案會話")

    return {
        "idle_total": total,
        "tenants": len(per_tenant),
        "threshold_minutes": IDLE_THRESHOLD_MINUTES,
    }
