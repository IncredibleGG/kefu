"""M1 tenancy: Tenant, Organization, Department. White-label settings live here."""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin, TimestampMixin, UUIDMixin


class TenantDomain(Base, TenantScopedMixin):
    """白牌自訂網域:一個租戶可綁多個網域(如 support.clientA.com),
    前端依當前 host 解析出該租戶的品牌(logo/色/名)。

    - domain 全域唯一(跨租戶不可重複)、建索引、寫入前一律正規化為小寫。
    - verify_token 於綁定時產生,供 DNS TXT(_kefu-verify.<domain>)驗證。
    """

    __tablename__ = "tenant_domain"

    # 完整網域名 DNS 上限 253 字元;全域唯一 + index(unique 已隱含索引,仍顯式標註)
    domain: Mapped[str] = mapped_column(
        String(253), unique=True, index=True, nullable=False
    )
    is_primary: Mapped[bool] = mapped_column(default=False, nullable=False)
    verified: Mapped[bool] = mapped_column(default=False, nullable=False)
    verify_token: Mapped[str | None] = mapped_column(String(64), nullable=True)


class Tenant(Base, UUIDMixin, TimestampMixin):
    """Top-level isolation boundary. A reseller creates one tenant per end-customer."""

    __tablename__ = "tenant"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    slug: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    # White-label: subdomain, custom domain, brand name, theme tokens, logo url
    branding: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # Per-tenant BYO LLM key + provider config (encrypted at rest — see M12/security)
    llm_config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)


class Organization(Base, TenantScopedMixin):
    """Org tree node (department). parent_id null == root."""

    __tablename__ = "organization"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organization.id", ondelete="SET NULL"), nullable=True
    )
