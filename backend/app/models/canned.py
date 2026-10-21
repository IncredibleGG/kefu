"""罐頭訊息 / 快捷回覆(canned response）。

坐席常用的預存回覆,前端以 ``/`` 觸發並依短碼(shortcut）快速插入。內容支援
變數佔位(如 ``{{visitor_name}}``），**後端只原樣存取**,實際替換由前端完成。

共享 / 個人區分:``owner_staff_id`` 為空 → 全租戶共享;有值 → 該坐席私人。
可選 ``skill_group_id`` 讓罐頭按技能組歸類。所有查詢一律以 tenant_id 隔離。
"""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin


class CannedResponse(Base, TenantScopedMixin):
    """一則罐頭訊息 / 快捷回覆。"""

    __tablename__ = "canned_response"
    # 同一租戶內,同一擁有者(共享或個人）的短碼唯一,避免 `/` 觸發歧義。
    # owner_staff_id 為 NULL(共享）時,NULL 在唯一鍵中不互相衝突為預期行為:
    # 個人短碼與共享短碼可同名,查詢時個人優先由 API 層處理。
    __table_args__ = (
        UniqueConstraint(
            "tenant_id", "owner_staff_id", "shortcut", name="uq_canned_tenant_owner_shortcut"
        ),
    )

    # 顯示標題(供列表挑選）
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    # 短碼:前端輸入 `/<shortcut>` 觸發插入(不含斜線)
    shortcut: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    # 回覆內容,原樣保存(含 {{變數}} 佔位,前端替換)
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # 選填:歸屬技能組
    skill_group_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("skill_group.id", ondelete="SET NULL"), nullable=True
    )
    # 擁有者坐席;NULL 表示全租戶共享,有值表示該坐席私人
    owner_staff_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("staff.id", ondelete="CASCADE"), nullable=True, index=True
    )
