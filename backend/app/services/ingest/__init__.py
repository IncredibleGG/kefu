"""知識庫匯入(ingest)子系統:文檔解析 + 網站爬取。

- ``parsers``:PDF / DOCX / 純文字 → 純文字(接回既有切塊→嵌入→入庫管線)。
- ``crawler``:抓取網站(遵守 robots、限頁數/深度)、抽正文。

網站爬取採「**無 migration**」佇列:把爬取任務直接記在一列 ``Document`` 的
``source_ref``(JSONB)裡當任務標記(``kind=crawl_task``),狀態
``pending → running → done | failed``;背景 worker(``app.workers.crawl``)
每輪撿 pending 任務處理。此模組提供該標記的建立/辨識 helper,供 knowledge API
與 worker 共用,避免魔術字串散落各處。

(選用 ``Document`` 而非 ``KnowledgeCollection`` 承載任務狀態,是因為只有 Document
既有 JSONB 欄位(``source_ref``)可用,且不需新增資料表/欄位;任務標記列的
``embedding`` 恆為 None,故不會被 RAG 檢索命中,也在 documents 列表中被過濾掉。)
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from app.services.ingest.parsers import (
    SUPPORTED_DOC_EXTENSIONS,
    DocumentParseError,
    parse_document,
)

# Document.source_ref 中,標示「這列是網站爬取任務(而非可檢索內容)」的 kind 值。
CRAWL_TASK_KIND = "crawl_task"

# 安全上限:單一任務最多實際抓取的頁數 / BFS 深度(端點傳入值會被夾到此上限內)。
CRAWL_MAX_PAGES_CAP = 50
CRAWL_MAX_DEPTH_CAP = 3
CRAWL_DEFAULT_DEPTH = 2


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def build_crawl_task_ref(
    url: str, max_pages: int, max_depth: int = CRAWL_DEFAULT_DEPTH
) -> dict[str, Any]:
    """建立一筆爬取任務標記(存於 ``Document.source_ref``)。狀態初始為 ``pending``。"""
    pages = max(1, min(int(max_pages), CRAWL_MAX_PAGES_CAP))
    depth = max(0, min(int(max_depth), CRAWL_MAX_DEPTH_CAP))
    return {
        "kind": CRAWL_TASK_KIND,
        "url": url,
        "status": "pending",  # pending → running → done | failed
        "max_pages": pages,
        "max_depth": depth,
        "pages_ingested": 0,
        "chunks": 0,
        "error": None,
        "created_at": _now_iso(),
        "started_at": None,
        "finished_at": None,
    }


def is_crawl_task_ref(source_ref: Any) -> bool:
    """判斷某 Document.source_ref 是否為爬取任務標記(而非一般可檢索內容)。"""
    return isinstance(source_ref, dict) and source_ref.get("kind") == CRAWL_TASK_KIND


__all__ = [
    "CRAWL_DEFAULT_DEPTH",
    "CRAWL_MAX_DEPTH_CAP",
    "CRAWL_MAX_PAGES_CAP",
    "CRAWL_TASK_KIND",
    "SUPPORTED_DOC_EXTENSIONS",
    "DocumentParseError",
    "build_crawl_task_ref",
    "is_crawl_task_ref",
    "parse_document",
]
