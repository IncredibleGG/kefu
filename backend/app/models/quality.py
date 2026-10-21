"""M10 quality:質檢 / 滿意度 / 服務小結。

三張表各司其職:
- ServiceSummary:坐席結束會話時填的「服務小結」(分類 + 備註,關聯會話)。
- CSAT:訪客提交的滿意度評分/等級(關聯會話)。
- QualityRecord:質檢紀錄——針對某則 message 或整段 session 的標註/評分/抽檢。

全部 tenant 隔離。CSAT 由訪客提交,故其 tenant_id 由所屬 session 推導,
而非信任外部輸入(見 app/services/quality.py)。
"""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin

# 質檢對象型別
QUALITY_TARGETS = ("message", "session")


class ServiceSummary(Base, TenantScopedMixin):
    """服務小結:一段會話結束時的分類與備註,便於後續統計與品質回顧。"""

    __tablename__ = "service_summary"

    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("session.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # 填寫小結的坐席(通常為當前處理者)
    staff_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("staff.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # 業務分類(如:諮詢/投訴/售後/退款…);由租戶自訂字典,這裡只存字串
    category: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class CSAT(Base, TenantScopedMixin):
    """訪客滿意度評分。一段會話可有多筆(例:多輪詢問),查詢時取最新即可。"""

    __tablename__ = "csat"

    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("session.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # 提交評分的訪客(選填;可由 session 推導)
    visitor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("visitor.id", ondelete="SET NULL"), nullable=True
    )
    # 分數:1–5(星等);等級 level 為可讀標籤(如 bad/neutral/good),由前端或服務層映射
    rating: Mapped[int] = mapped_column(Integer, nullable=False)
    level: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)


class QualityRecord(Base, TenantScopedMixin):
    """質檢紀錄:針對 message 或 session 的標註 / 評分 / 抽檢。

    target_type 決定 message_id / session_id 哪一個有值。is_sampled 標記此筆
    是否為抽檢樣本(供「抽檢列表」過濾)。
    """

    __tablename__ = "quality_record"

    # 對象型別:message | session
    target_type: Mapped[str] = mapped_column(String(10), nullable=False, index=True)
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("session.id", ondelete="SET NULL"), nullable=True, index=True
    )
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("message.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # 執行質檢的坐席/質檢員
    reviewer_staff_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("staff.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # 質檢評分(選填,如 0–100 或 1–5,由租戶質檢表定義)
    score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 標註/旗標類型(如:違規用語、未遵循話術、優秀案例…)
    label: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 是否抽檢樣本
    is_sampled: Mapped[bool] = mapped_column(default=False, nullable=False, index=True)
