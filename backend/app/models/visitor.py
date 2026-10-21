"""M4 visitor: Visitor (per-channel identity) vs Contact (persistent customer)."""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin

# Contact.company_id 帶 FK → company.id,故此表必須與 company 表同在 Base.metadata,
# create_all / FK 解析才不會找不到目標表。在此顯式匯入以保證「有 Contact 就有 Company」,
# 無論匯入順序或是否經 models/__init__ 皆成立(company 模組不反向匯入本檔,無循環)。
from app.models.company import Company  # noqa: F401


class Contact(Base, TenantScopedMixin):
    """Persistent customer master record; one Contact may unify many Visitors."""

    __tablename__ = "contact"
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    attributes: Mapped[dict | None] = mapped_column(JSONB, nullable=True)  # 自訂 CRM 欄位
    note: Mapped[str | None] = mapped_column(Text, nullable=True)  # 客服備註(自由文字)
    is_blocked: Mapped[bool] = mapped_column(default=False, nullable=False)
    # 所屬公司(B2B):FK → company.id;公司刪除時置空(ON DELETE SET NULL),不連帶刪聯絡人。
    # nullable=True(未歸屬公司的個人聯絡人),建索引以支援「某公司的聯絡人」查詢。
    company_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("company.id", ondelete="SET NULL"), index=True, nullable=True
    )


class Visitor(Base, TenantScopedMixin):
    """A channel-specific identity (e.g. one Telegram user_id). Links up to a Contact."""

    __tablename__ = "visitor"
    # 同一租戶 + 渠道 + 外部 ID 唯一 → 支撐 get_or_create 去重、避免併發重複建立
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "channel_id", "external_id", name="uq_visitor_channel_external"
        ),
    )
    channel_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("channel.id", ondelete="CASCADE"), index=True, nullable=False
    )
    external_id: Mapped[str] = mapped_column(String(255), nullable=False)  # e.g. tg user id
    display_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    contact_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("contact.id", ondelete="SET NULL"), nullable=True
    )
    # 此渠道身份是否被封鎖(黑名單);跨渠道封鎖以 Contact.is_blocked 表示
    is_blocked: Mapped[bool] = mapped_column(default=False, nullable=False)
    # AI-derived profile: persona, intent history, auto tags (filled by M6)
    ai_profile: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
