"""M8 routing:會話分配規則存儲。

RoutingPolicy 記錄「每技能組」的分配策略與坐席接待上限:
- skill_group_id 為 NULL → 該租戶的預設策略(找不到技能組專屬策略時回退用)。
- strategy:least_load(最少負載)| round_robin(輪詢)| llm(智能分配,預設仍回退規則式)。
- max_load:單一坐席可同時接待的會話上限。
- rr_cursor:round_robin 策略的游標,記錄上次指派到的坐席,下次挑其後一位。

注意:本模型未登記進 app/models/__init__.py(不得改該檔),
但只要 routing 服務/路由被匯入,SQLAlchemy 即會註冊此 mapper 到 Base.metadata。
"""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin

# 內建預設(找不到任何 RoutingPolicy 時使用)
DEFAULT_STRATEGY = "least_load"
DEFAULT_MAX_LOAD = 5
VALID_STRATEGIES = ("least_load", "round_robin", "llm")


class RoutingPolicy(Base, TenantScopedMixin):
    """一條分配規則:綁定某技能組(或租戶預設),決定策略與接待上限。"""

    __tablename__ = "routing_policy"
    # 同一租戶下,每個技能組(含 NULL 預設)只有一條策略
    __table_args__ = (
        UniqueConstraint("tenant_id", "skill_group_id", name="uq_routing_policy_tenant_group"),
    )

    # NULL = 該租戶的預設策略
    skill_group_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("skill_group.id", ondelete="CASCADE"), nullable=True, index=True
    )
    strategy: Mapped[str] = mapped_column(String(20), default=DEFAULT_STRATEGY, nullable=False)
    max_load: Mapped[int] = mapped_column(Integer, default=DEFAULT_MAX_LOAD, nullable=False)
    # round_robin 游標:上次指派到的坐席 id(下次挑其後一位)
    rr_cursor: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)
