"""知識庫使用分析:命中追蹤(KB usage analytics)。

對標 LiveChat KnowledgeBase「使用分析」:每次 RAG 檢索(``rag.retrieve``)在
成功回結果後,把命中的 top 片段各記一列 ``KBHit``;零命中的查詢也記一列
(FK 皆 null、score null)作為「未命中」事件標記,供命中率的分母。

命中率定義(定義清楚,見 knowledge.py analytics 端點):
- 一次 ``retrieve`` 呼叫 = 一次「檢索事件」;同批寫入的列共用同一 ``occurred_at``,
  故「檢索事件數」以 ``COUNT(DISTINCT occurred_at)`` 計(單次呼叫算一次)。
- 命中率 = 有命中的檢索事件數 / 總檢索事件數。
- 「最常命中文件 / 集合」「熱門搜尋詞」等以列(片段)為單位聚合。

寫入走「獨立 session + try/except」旁路(見 ``rag._record_hits``):任何失敗
(表未建、DB 故障、型別問題)都完全吞掉,絕不影響檢索主流程(零回歸)。

註:本表需由主 session 於 ``app/models/__init__.py`` 匯入(供 Alembic autogenerate
與 mapper 註冊);惟 ``knowledge.py`` / ``rag.py`` 已就地匯入 ``KBHit``,故 metadata
仍能在 app 啟動時被 ``create_all`` 建出 ``kb_hit`` 表。
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, Float, ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin


def _utcnow() -> datetime:
    return datetime.now(UTC)


class KBHit(Base, TenantScopedMixin):
    """一次 RAG 檢索命中的一個片段(或零命中事件的標記列)。

    - ``collection_id`` / ``document_id`` / ``qa_id``:命中片段的來源(依片段型別
      擇一填 document 或 qa;集合一併記錄以利集合層聚合)。零命中列三者皆 null。
    - ``query``:觸發本次檢索的查詢字串(已截斷,見 rag._HIT_QUERY_MAX)。
    - ``score``:相似度分數(0~1);零命中列為 null。
    - ``session_id``:選填的會話關聯(目前檢索呼叫多不帶,故常為 null)。
    - ``occurred_at``:檢索發生時間;同一次檢索的多列共用同一值,作為事件分組鍵。

    FK 皆 ``ON DELETE SET NULL``:即使來源被硬刪,歷史命中統計仍保留(只失去指向)。
    """

    __tablename__ = "kb_hit"

    collection_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("knowledge_collection.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("document.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    qa_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("qa_pair.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    query: Mapped[str] = mapped_column(Text, nullable=False)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    # 會話關聯:不設 FK(檢索可能來自無 session 的情境,如檢索測試端點/工具呼叫),
    # 避免無效 session_id 造成插入失敗;僅作為維度欄位,故 nullable 且不強制外鍵。
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True, default=_utcnow
    )
