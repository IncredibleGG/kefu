"""到期任務執行器:排程器每輪呼叫 `run_due_jobs(db)` 一次。

設計要點(對齊需求):
- 依序跑所有已註冊 worker;每個 worker 各自 try/except 降級,
  並以 SAVEPOINT(巢狀交易)隔離——單一 worker 失敗(含 DB 錯誤)
  只回滾它自己那段,不會拖垮其他 worker,也不污染外層交易。
- 冪等、可安全被每 60 秒呼叫一次;不假設一定有資料(worker 內部自理空集合)。
- 本函式**不 commit**:交易邊界由呼叫端(排程器)決定,慣例同 `sla_service.scan`。
  → 呼叫端請在 `run_due_jobs` 後自行 `await db.commit()`(見完成回報的接線片段)。

新增 worker 的方式:寫好 worker 檔並 `@register_worker(...)` 後,
只要在下方 append 一行 import(讓該模組被載入 → 觸發自我註冊)即可。
"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.workers.base import WORKERS, worker_name

# --- 載入各 worker 模組以觸發自我註冊(新增 worker 時在此加一行) ---
from app.workers import crawl as _crawl  # noqa: F401,E402
from app.workers import csat_followup as _csat_followup  # noqa: F401,E402
from app.workers import sla_digest as _sla_digest  # noqa: F401,E402
from app.workers import snooze as _snooze  # noqa: F401,E402
from app.workers import stale_sessions as _stale_sessions  # noqa: F401,E402

# 網站爬取非同步入庫(crawl)已上線:無需新表/欄位,任務佇列以一列 Document 的
# source_ref(JSONB,kind=crawl_task)承載狀態(pending→running→done/failed),
# 由 app.services.ingest 與 app.api.v1.knowledge 的 crawl 端點協作。
#
# snooze 到期喚醒(snooze_wake)已上線:見 app.workers.snooze,撿選 status='snoozed' 且
# snoozed_until 到期的會話,還原 status(open/queued)、清 snoozed_until 並發 session.opened
# 喚回坐席台。無需新表(Session.snoozed_until 欄位已具備)。
#
# CSAT 自動後續(csat_followup)已上線:見 app.workers.csat_followup。兩件事——
#   ① 結案自動邀評:撿已結案且未邀評、有訪客訊息、尚無 CSAT 的會話,經既有
#      conversation.add_message 發帶 csat_invite 旗標的 system 訊息(提交走既有
#      /api/v1/quality/csat),並以 Session.csat_invited_at 去重;
#   ② 低分自動開單:撿 rating<=2 且尚未建過跟進工單的 CSAT,依既有 Ticket 模型
#      建 priority=high 跟進工單,以 Ticket.tags 含 "csat-followup" 去重。
#   皆無需新表/欄位(Session.csat_invited_at 已具備;去重靠既有 Ticket.tags)。

logger = logging.getLogger("kefu.workers")


async def run_due_jobs(db: AsyncSession) -> dict[str, Any]:
    """依序執行所有已註冊 worker,回傳本輪摘要。

    每個 worker 包在獨立 SAVEPOINT 中:成功則釋放(其寫入併入外層交易,
    待呼叫端 commit),失敗則只回滾該 SAVEPOINT 並記錄,不影響其餘 worker。
    """
    summary: dict[str, Any] = {"ran": 0, "ok": 0, "failed": 0, "workers": {}}

    for fn in list(WORKERS):  # 複本迭代:避免 worker 執行中意外改動清單
        name = worker_name(fn)
        summary["ran"] += 1
        try:
            # SAVEPOINT:隔離單一 worker 的寫入與錯誤(DB 錯誤亦不會污染外層交易)。
            # 注意:worker 內部**不應**自行 commit,交易邊界一律交給呼叫端。
            async with db.begin_nested():
                result = await fn(db)
            summary["ok"] += 1
            summary["workers"][name] = {"ok": True, "result": result}
        except Exception:  # noqa: BLE001 - 單一 worker 失敗不得拖垮其他
            summary["failed"] += 1
            summary["workers"][name] = {"ok": False}
            logger.exception("背景 worker 執行失敗:%s", name)

    return summary
