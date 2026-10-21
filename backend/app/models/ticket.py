"""M9 ticket(自建):工單實體。

兩家參考產品(tgo/cskefu)皆缺工單,故本模組完整自建。工單用於把一次
會話 / 一位聯絡人衍生出的待辦事項落地追蹤:建立、指派坐席、流轉狀態、
關聯會話與聯絡人。所有查詢一律以 tenant_id 隔離(見 TenantScopedMixin)。
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin

# 工單狀態流轉:open(待處理)→ pending(處理中/等待)→ resolved(已解決)→ closed(關閉)
TICKET_STATUSES = ("open", "pending", "resolved", "closed")
# 優先級
TICKET_PRIORITIES = ("low", "normal", "high", "urgent")


class Ticket(Base, TenantScopedMixin):
    """一張工單。可獨立建立,也可由某會話一鍵衍生。"""

    __tablename__ = "ticket"

    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 狀態:open|pending|resolved|closed
    status: Mapped[str] = mapped_column(String(20), default="open", nullable=False, index=True)
    # 優先級:low|normal|high|urgent
    priority: Mapped[str] = mapped_column(String(20), default="normal", nullable=False, index=True)
    # 指派的坐席(可為 None 表示尚未指派)
    assignee_staff_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("staff.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # 關聯聯絡人(CRM 主檔)
    contact_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("contact.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # 關聯會話(選填;由會話一鍵建立時帶入)
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("session.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # 標籤:字串陣列(Tag 主檔模組尚未落地前,先以 JSONB 存輕量標籤)
    tags: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # 自訂欄位值:自由 key-value(欄位定義見 FieldDefinition;租戶可自訂工單欄位)
    attributes: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # 狀態時間戳:進入 resolved / closed 時記錄,供報表統計處理時長
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 到期日(SLA / 待辦期限):可為 None 表示無期限。已過期且未結清 = 逾期(overdue),
    # 供列表「逾期」篩選與到期掃描(見 api/v1/ticket.py scan_overdue_tickets)。
    due_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    # 延後(snooze)到某時點:在此之前不視為逾期、不進到期掃描的處理範圍。
    # None 表示未延後;snooze 過期(<= now)後工單重新回到正常逾期判定。
    snoozed_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
