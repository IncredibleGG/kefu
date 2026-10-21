"""M7 knowledge: KnowledgeCollection, Document (with pgvector embedding), QAPair.

RAG retrieval is source-traceable: each Document chunk keeps its origin so AI
answers can cite sources and expose a confidence score (anti-hallucination柱).
"""
from __future__ import annotations

import uuid

from pgvector.sqlalchemy import Vector
from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.config import settings
from app.core.db import Base
from app.models.base import TenantScopedMixin

EMBED_DIM = settings.embedding_dim  # default 384 (local multilingual-e5-small)


class KnowledgeCollection(Base, TenantScopedMixin):
    __tablename__ = "knowledge_collection"
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    source_type: Mapped[str] = mapped_column(String(20), default="document", nullable=False)  # document|website|qa
    # --- 對外公開 Help Center(自助中心)發布狀態 ---
    # 集合層是公開的第一道閘:未發布的集合,其文章/QA 一律不對外可見。
    is_published: Mapped[bool] = mapped_column(default=False, nullable=False, index=True)
    # 發布時產生的公開網址片段(該分類在 Help Center 的 slug),便於前端做人類可讀 URL。
    # 未強制全域唯一;租戶內以 (tenant_id, public_slug) 定位,建立時附短碼避免碰撞。
    public_slug: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)


class Document(Base, TenantScopedMixin):
    """A retrievable chunk with its embedding and traceable origin."""

    __tablename__ = "document"
    collection_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("knowledge_collection.id", ondelete="CASCADE"), index=True, nullable=False
    )
    title: Mapped[str | None] = mapped_column(String(500), nullable=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    source_ref: Mapped[dict | None] = mapped_column(JSONB, nullable=True)  # url / file / page for citation
    # 同一來源切塊後的序號,便於回溯原文順序(M6 加)
    chunk_index: Mapped[int] = mapped_column(default=0, nullable=False)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBED_DIM), nullable=True)
    # 文章層發布開關:預設 True,發布集合後文章即隨之公開;可單獨下架某篇。
    # 公開可見性 = 所屬集合 is_published 且 本文章 is_published。
    is_published: Mapped[bool] = mapped_column(default=True, nullable=False, index=True)


class QAPair(Base, TenantScopedMixin):
    __tablename__ = "qa_pair"
    collection_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("knowledge_collection.id", ondelete="CASCADE"), index=True, nullable=False
    )
    question: Mapped[str] = mapped_column(Text, nullable=False)
    answer: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBED_DIM), nullable=True)
