"""背景任務(worker)基礎設施。

作為後續 snooze 喚醒、CSAT 自動邀評、SLA 升級、網站爬取非同步入庫等
週期性/到期工作的共同執行載體。核心觀念:

- `base.py`:worker 介面(協定)+ 全域註冊表 `WORKERS` + `register_worker` helper。
  各 worker 檔 import 後以 `@register_worker(...)` 自我登記。
- `jobs.py`:`run_due_jobs(db)`——由外部排程器(main.py 的 `_scheduler_loop`
  leader 區塊)每輪呼叫一次;依序、各自 try/except + SAVEPOINT 隔離降級地跑
  所有已註冊 worker,單一失敗不拖垮其他。
- 具體 worker 檔(如 `sla_digest.py`、`stale_sessions.py`):每個檔一個關注點。

本套件刻意不在此 `__init__` eager-import 子模組,避免影響既有匯入順序;
worker 的註冊由 `jobs.py` 匯入各 worker 模組時觸發(見 jobs.py 頂部)。
"""
