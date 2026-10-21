"""M4 標籤:Tag + 多型關聯表 tag_relation。

一個 Tag 可套用到不同類型的目標(訪客/聯絡人/會話/工單),因此關聯採「多型」
設計:tag_relation.target_type 標明目標種類、target_id 存目標主鍵,不以外鍵綁死,
讓標籤模組不必依賴其他模組的資料表結構(乾淨的模組邊界)。
"""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin

# 允許的標籤目標類型(多型關聯的合法值)
TAG_TARGET_TYPES = ("visitor", "contact", "session", "ticket")


class Tag(Base, TenantScopedMixin):
    """租戶自訂標籤;同一租戶內標籤名唯一。"""

    __tablename__ = "tag"
    # 標籤名在同一租戶內唯一,避免重複標籤
    __table_args__ = (UniqueConstraint("tenant_id", "name", name="uq_tag_tenant_name"),)

    name: Mapped[str] = mapped_column(String(100), nullable=False)
    color: Mapped[str | None] = mapped_column(String(20), nullable=True)  # UI 顏色(hex)
    category: Mapped[str | None] = mapped_column(String(50), nullable=True)  # 選填分組


class TagRelation(Base, TenantScopedMixin):
    """標籤與目標的多型關聯。target_type ∈ visitor|contact|session|ticket。"""

    __tablename__ = "tag_relation"
    # 同一標籤對同一目標只關聯一次
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "tag_id", "target_type", "target_id", name="uq_tag_relation_unique"
        ),
    )

    tag_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tag.id", ondelete="CASCADE"), index=True, nullable=False
    )
    target_type: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    target_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
