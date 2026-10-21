"""樣板 worker①:SLA 逾時/接近逾時「巡檢摘要」(唯讀,不改資料)。

用途:證明背景任務機制真的能跑,且安全。每輪讀取既有 `SLATracking`
(由 `services/sla.py::scan` 維護、leader 排程已在跑),彙總目前各租戶
`at_risk` / `breached` 的會話數並寫入 log。

特性:
- 純唯讀:只 SELECT,不新增/更新任何列,無任何跨模組副作用。
- 冪等 + 空資料安全:尚無任何追蹤列時回 0、走 debug log,不報錯。

(注意:SLA 追蹤的 upsert 與新違約告警由 `services/sla.py::scan` 負責,
排程 leader 區塊已直接呼叫;本 worker 僅做「不改資料」的巡檢彙總,
兩者不重疊,可安全並存。)
"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sla import SLATracking
from app.workers.base import register_worker

logger = logging.getLogger("kefu.workers")

# 需關注的告警狀態(對齊 app.models.sla.VALID_SLA_STATUSES)
_ALERT_STATUSES = ("at_risk", "breached")


@register_worker(name="sla_digest")
async def run(db: AsyncSession) -> dict[str, Any]:
    """彙總目前 at_risk / breached 的 SLA 追蹤數(唯讀)。"""
    rows = (
        await db.execute(
            select(SLATracking.tenant_id, SLATracking.status, func.count())
            .where(
                SLATracking.status.in_(_ALERT_STATUSES),
                SLATracking.deleted_at.is_(None),
            )
            .group_by(SLATracking.tenant_id, SLATracking.status)
        )
    ).all()

    totals = {"at_risk": 0, "breached": 0}
    per_tenant: dict[str, dict[str, int]] = {}
    for tenant_id, status, count in rows:
        totals[status] = totals.get(status, 0) + int(count)
        per_tenant.setdefault(str(tenant_id), {})[status] = int(count)

    if totals["at_risk"] or totals["breached"]:
        logger.info(
            "SLA 巡檢:at_risk=%d breached=%d(涉及租戶=%d)",
            totals["at_risk"],
            totals["breached"],
            len(per_tenant),
        )
    else:
        logger.debug("SLA 巡檢:目前無 at_risk / breached 會話")

    return {"totals": totals, "tenants": len(per_tenant)}
