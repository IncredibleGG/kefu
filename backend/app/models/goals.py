"""目標 / 銷售追蹤(W-parity 自建):對齊 LiveChat 的 Goals & Sales tracker。

Goal 定義要衡量的轉換事件(到達某頁、完成訂單、自訂事件),GoalConversion 記錄
每次達成並歸因到當時的會話/訪客,供電商/成效報表。為新表,create_all 建立;tenant 隔離。
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin

# 目標型別:url(到達指定網址)| event(自訂事件名)| manual(坐席手動標記達成)
GOAL_KINDS = ("url", "event", "manual")


class Goal(Base, TenantScopedMixin):
    __tablename__ = "goal"

    name: Mapped[str] = mapped_column(String(160), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), default="url", nullable=False)
    # 比對條件:url 型放 {url_contains}; event 型放 {event_name};manual 無
    config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # 每次達成的價值(分為單位;用於銷售額估算),幣別
    value_cents: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    currency: Mapped[str] = mapped_column(String(10), default="USD", nullable=False)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)


class GoalConversion(Base, TenantScopedMixin):
    __tablename__ = "goal_conversion"

    goal_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("goal.id", ondelete="CASCADE"), index=True, nullable=False
    )
    visitor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("visitor.id", ondelete="SET NULL"), nullable=True, index=True
    )
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("session.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # 成交歸因的坐席(manual 型=標記當下的坐席;url/event 型=命中會話的指派坐席)。
    # 坐席被刪時保留成交歷史但清歸因(SET NULL);index 供逐坐席 sales 排行聚合。
    staff_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("staff.id", ondelete="SET NULL"), nullable=True, index=True
    )
    value_cents: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
