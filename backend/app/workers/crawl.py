"""背景 worker:網站爬取非同步入庫。

以一列 ``Document`` 的 ``source_ref[kind=crawl_task]`` 為佇列(**無新 migration**),
每輪撿出 pending 任務,逐一:
1) 標記 running,
2) 抓取(遵守 robots、限頁數/深度)、以 BeautifulSoup 抽正文,
3) 切塊 → 嵌入 → 入庫(和 .txt/.pdf/.docx 同一條管線:chunk_text + embed_texts),
4) 更新任務狀態 done / failed(頁數、切塊數、錯誤訊息一併記回 source_ref)。

降級策略:單一任務失敗只把該任務標記 failed;單頁入庫失敗只跳過該頁;
皆不拋出、不拖垮其他任務或其他 worker。

交易邊界:同其他 worker,本函式**不 commit**(由排程器在 run_due_jobs 後 commit);
DB 寫入(新 Document、任務狀態更新)併入外層交易。JSONB 狀態更新一律「重建整個
dict 再賦值」,以確保 SQLAlchemy 偵測到變更(避免 in-place mutate 不被追蹤)。
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.knowledge import Document
from app.services.ai.chunking import chunk_text
from app.services.embedding import embed_texts
from app.services.ingest import CRAWL_TASK_KIND
from app.services.ingest.crawler import crawl_site
from app.workers.base import register_worker

logger = logging.getLogger("kefu.workers")

# 每輪最多處理的任務數(避免單輪耗時過長、阻塞其他 worker)。
_MAX_TASKS_PER_CYCLE = 2


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def _pending_tasks(db: AsyncSession, limit: int) -> list[Document]:
    """撈 pending 的爬取任務標記列(依建立時間先進先出)。"""
    stmt = (
        select(Document)
        .where(
            Document.deleted_at.is_(None),
            Document.source_ref["kind"].astext == CRAWL_TASK_KIND,
            Document.source_ref["status"].astext == "pending",
        )
        .order_by(Document.created_at.asc())
        .limit(limit)
    )
    return list((await db.execute(stmt)).scalars().all())


async def _ingest_pages(db: AsyncSession, task: Document, pages) -> int:
    """把抓到的頁面切塊 + 嵌入 + 入庫,回總切塊數。單頁失敗只跳過。"""
    total_chunks = 0
    for page in pages:
        try:
            chunks = chunk_text(page.text)
            if not chunks:
                continue
            vectors = await embed_texts(chunks)
            for i, (chunk, vec) in enumerate(zip(chunks, vectors)):
                db.add(
                    Document(
                        tenant_id=task.tenant_id,
                        collection_id=task.collection_id,
                        title=page.title or page.url,
                        content=chunk,
                        source_ref={
                            "url": page.url,
                            "title": page.title,
                            "crawl_task_id": str(task.id),
                        },
                        chunk_index=i,
                        embedding=vec,
                    )
                )
                total_chunks += 1
        except Exception:  # noqa: BLE001 - 單頁失敗不拖垮整體
            logger.exception("爬取入庫單頁失敗:%s", getattr(page, "url", "?"))
            continue
    await db.flush()
    return total_chunks


@register_worker(name="crawl")
async def run(db: AsyncSession) -> dict[str, Any]:
    """撿 pending 爬取任務並處理(抓取→抽正文→切塊嵌入入庫→更新狀態)。"""
    tasks = await _pending_tasks(db, _MAX_TASKS_PER_CYCLE)
    if not tasks:
        return {"picked": 0}

    done = failed = 0
    for task in tasks:
        ref = dict(task.source_ref or {})
        url = ref.get("url") or ""
        max_pages = int(ref.get("max_pages", 20))
        max_depth = int(ref.get("max_depth", 2))

        # 標記 running(重建整個 dict 以觸發變更追蹤)
        ref.update({"status": "running", "started_at": _now_iso(), "error": None})
        task.source_ref = ref
        await db.flush()

        try:
            result = await crawl_site(url, max_pages=max_pages, max_depth=max_depth)
            chunks = await _ingest_pages(db, task, result.pages)
            ref = dict(task.source_ref or {})
            ref.update(
                {
                    "status": "done",
                    "pages_ingested": len(result.pages),
                    "chunks": chunks,
                    "fetched": result.fetched,
                    "skipped_robots": result.skipped_robots,
                    "errors": result.errors,
                    "finished_at": _now_iso(),
                }
            )
            task.source_ref = ref
            done += 1
            logger.info(
                "網站爬取完成:%s 入庫頁=%d 切塊=%d(抓取=%d robots略過=%d 失敗=%d)",
                url,
                len(result.pages),
                chunks,
                result.fetched,
                result.skipped_robots,
                result.errors,
            )
        except Exception as e:  # noqa: BLE001 - 單一任務失敗不拖垮其餘
            ref = dict(task.source_ref or {})
            ref.update({"status": "failed", "error": str(e)[:500], "finished_at": _now_iso()})
            task.source_ref = ref
            failed += 1
            logger.exception("網站爬取任務失敗:%s", url)

    await db.flush()
    return {"picked": len(tasks), "done": done, "failed": failed}
