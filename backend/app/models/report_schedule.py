"""排程 / 訂閱式報表(對齊 LiveChat 的 Scheduled reports):定期把報表寄到信箱。

一列 ``ReportSchedule`` = 一份「訂閱」:指定報表類型、頻率、收件人與輸出格式;
到期時由背景排程器(見 ``reporting.run_due_report_schedules``)產出報表內容並寄出,
再把 ``last_run_at`` / ``next_run_at`` 前推到下一輪。為新表,create_all 建立;tenant 隔離。

設計要點:
- **不新增 presence / 快照表**:報表內容一律於執行當下複用既有 reporting 聚合即時產出,
  本表只承載「訂閱設定 + 排程游標(last/next_run)」,不落地報表資料本身。
- **收件人**:以 JSONB 陣列存 email 字串清單(可多人);執行時逐一寄送。
- **格式**:``summary``(純文字摘要,信件內文可讀)| ``csv``(CSV 全文放入信件內文,
  便於落地 Excel;現行 SMTP 發信為純文字內文、無附件,故 CSV 以內文承載)。
- **排程游標**:``next_run_at`` 建索引,排程器以 ``next_run_at <= now`` 撿出到期者;
  單次執行後依 ``frequency`` 前推 ``next_run_at``,``last_run_at`` 記錄本次執行時刻。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin

# 支援的報表類型(對應 reporting 既有聚合 + 本次新增的坐席活動)
REPORT_TYPES = ("overview", "agents", "sales", "satisfaction", "activity")
# 支援的頻率
FREQUENCIES = ("daily", "weekly", "monthly")
# 輸出格式
REPORT_FORMATS = ("summary", "csv")


class ReportSchedule(Base, TenantScopedMixin):
    """一份排程/訂閱式報表設定(tenant 隔離,create_all 建表)。"""

    __tablename__ = "report_schedule"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # 報表類型:overview | agents | sales | satisfaction | activity
    report_type: Mapped[str] = mapped_column(String(30), nullable=False)
    # 頻率:daily | weekly | monthly
    frequency: Mapped[str] = mapped_column(String(20), nullable=False)
    # 收件人 email 清單(JSONB 陣列;可多人)
    recipients: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # 輸出格式:summary(純文字摘要)| csv(CSV 全文放入信件內文)
    format: Mapped[str] = mapped_column(String(20), default="summary", nullable=False)
    # 排程游標:上次執行時刻 / 下次應執行時刻(next_run_at 建索引供到期撿選)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    next_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
