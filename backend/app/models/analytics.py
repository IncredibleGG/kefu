"""訪客行為分析(W6 自建):即時瀏覽頁面軌跡。

widget 於訪客瀏覽頁面時上報 URL/標題/referrer,存為 PageView,供坐席在情境面板
看到訪客「看了哪些頁」。為新表,create_all 建立;查詢 tenant_id 隔離。
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin


class PageView(Base, TenantScopedMixin):
    __tablename__ = "page_view"

    visitor_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("visitor.id", ondelete="CASCADE"), index=True, nullable=False
    )
    url: Mapped[str] = mapped_column(String(2000), nullable=False)
    title: Mapped[str | None] = mapped_column(String(500), nullable=True)
    referrer: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
