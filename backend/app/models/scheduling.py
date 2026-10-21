"""坐席排班(W-parity 自建):對齊 LiveChat 的 Work Scheduler。

以「每週循環班表」表示坐席每天的上線時段(分鐘為單位,0=午夜)。可供顯示
「是否在班」與(可選)自動可用狀態。為新表,create_all 建立;tenant 隔離。
"""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, Integer, SmallInteger
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin


class StaffShift(Base, TenantScopedMixin):
    """單一坐席、單一星期幾的一個上線時段(分鐘表示,支援跨日以多筆表達)。"""

    __tablename__ = "staff_shift"

    staff_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("staff.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # 星期幾:0=週一 … 6=週日
    weekday: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    # 起訖(從午夜起算的分鐘;如 540=09:00、1080=18:00)
    start_minute: Mapped[int] = mapped_column(Integer, nullable=False, default=540)
    end_minute: Mapped[int] = mapped_column(Integer, nullable=False, default=1080)
    enabled: Mapped[bool] = mapped_column(default=True, nullable=False)
