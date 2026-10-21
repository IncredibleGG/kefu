"""稽核日誌(W7 自建):記錄管理/敏感操作,供合規追溯。

每筆記錄「誰(actor)在何時對什麼(target)做了什麼(action)」。為新表,
create_all 於啟動時建立;查詢一律 tenant_id 隔離(TenantScopedMixin)。
"""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin


class AuditLog(Base, TenantScopedMixin):
    __tablename__ = "audit_log"

    # 操作者坐席(系統/自動操作可為 None)
    actor_staff_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("staff.id", ondelete="SET NULL"), nullable=True, index=True
    )
    actor_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # 動作:如 staff.create / role.update / channel.delete / login / password.change ...
    action: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    # 目標型別與 id(如 staff / role / channel / ticket ...)
    target_type: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    target_id: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # 來源 IP(盡力而為)與細節
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    meta: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
