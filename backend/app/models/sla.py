"""M(SLA)服務水準管理:SLAPolicy(時限規則)+ SLATracking(每會話追蹤)。

本模組**自成一體**:不在 conversation.py 埋 hook,而是靠 services/sla.py 定時
掃描既有 session/message 的時間來推導首回應/解決狀態,再 upsert SLATracking。

命名同 routing.py:本模型未登記進 app/models/__init__.py(不得改該檔),
但只要 sla 服務/路由被匯入,SQLAlchemy 即會註冊此 mapper 到 Base.metadata。
整合者可自行在 __init__.py 補上匯入(見完成回報)。
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin

# 追蹤狀態(單目標整體):
#   on_track 進行中且未接近時限 / at_risk 接近時限 / breached 已違約 / met 已達成(結案且未違約)
VALID_SLA_STATUSES = ("on_track", "at_risk", "breached", "met")

# 單維度(首回應 or 解決)狀態,供 evaluate 內部使用與前端顯示
#   none 未設限 / on_track / at_risk / met / breached
VALID_DIM_STATES = ("none", "on_track", "at_risk", "met", "breached")

# SLA 目標型別:政策/追蹤可套用於「會話」或「工單」。
#   session 向後相容的預設值(既有政策/追蹤皆視為會話)
#   ticket  套用於工單(app.models.ticket.Ticket)
VALID_SLA_TARGETS = ("session", "ticket")


class SLAPolicy(Base, TenantScopedMixin):
    """一條 SLA 規則:命中條件的會話套用其首回應/解決時限。

    conditions(JSONB):如 ``{"channel_type": "telegram", "tag": ["vip"]}``。
    空 dict / NULL = 套用該租戶所有會話。同一租戶可有多條,依 priority 由高到低
    取第一條命中者(見 services/sla.py 的 match_conditions / pick_policy)。
    """

    __tablename__ = "sla_policy"

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # 套用目標型別:session(預設,向後相容)| ticket。掃描/評估時,會話只套 session
    # 政策、工單只套 ticket 政策(見 services/sla.py 的 pick_policy / scan)。
    target_type: Mapped[str] = mapped_column(
        String(20), default="session", nullable=False, index=True
    )
    # 匹配條件;空/NULL 代表套用全部
    conditions: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # 首回應時限(分鐘,自目標建立起算)
    first_response_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    # 解決時限(分鐘,自目標建立起算)
    resolution_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # 匹配優先序:數字越大越先評估、越優先命中
    priority: Mapped[int] = mapped_column(Integer, default=0, nullable=False, index=True)


class SLATracking(Base, TenantScopedMixin):
    """每個 SLA 目標(會話或工單)一列的追蹤結果(掃描器 upsert)。

    **資料模型取捨(泛化目標型別)**:原設計以 ``session_id``(NOT NULL、唯一)綁定會話。
    為支援工單且保持向後相容,採「保留 session_id + 新增 ticket_id + target_type 判別」:

    - ``target_type``:``session``(預設)或 ``ticket``,標明本列追蹤何種目標。
    - 會話列:``session_id`` 有值、``ticket_id`` 為 NULL(與既有列完全相容)。
    - 工單列:``ticket_id`` 有值、``session_id`` 為 NULL。
    - ``session_id`` 由 NOT NULL 放寬為 NULL(生產需 ``ALTER COLUMN session_id DROP NOT NULL``);
      兩欄各自 ``unique``——Postgres/SQLite 皆視多個 NULL 為相異,故工單列(session_id=NULL)
      與會話列(ticket_id=NULL)不互相衝突,同一目標至多一列追蹤。

    未泛化為單一 ``target_id`` 而保留兩個具名外鍵,是為了保有各自的 ``ON DELETE CASCADE``
    參照完整性(目標被刪→追蹤連帶清除),並讓既有以 session_id 查詢的程式零改動。
    """

    __tablename__ = "sla_tracking"

    # 目標型別判別欄(session|ticket);預設 session 向後相容
    target_type: Mapped[str] = mapped_column(
        String(20), default="session", nullable=False, index=True
    )
    # 會話目標(target_type=session 時有值);放寬為 NULL 以容納工單列
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("session.id", ondelete="CASCADE"),
        nullable=True,
        unique=True,
        index=True,
    )
    # 工單目標(target_type=ticket 時有值)
    ticket_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("ticket.id", ondelete="CASCADE"),
        nullable=True,
        unique=True,
        index=True,
    )
    # 命中的規則;規則被刪不影響歷史追蹤,故 SET NULL
    policy_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sla_policy.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # 期限(= 目標 created_at 起算,經營業時間/暫停調整前的基準;實際比較時再加回暫停秒數)
    first_response_due: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolution_due: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 實際達成時間(推導自訊息/結案時間;工單另見 services/sla.py 的推導)
    first_response_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # --- SLA 暫停(等待客戶回覆時停表)---
    # paused_at 有值 = 目前暫停中(記錄本段暫停起點);None = 計時中
    paused_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 已完成暫停的累計秒數(不含目前進行中那段);due/remaining 計算時加回此值(+進行中段)
    paused_total_seconds: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # 違約旗標(供快速查詢違約清單、避免重複告警)
    breached_first: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    breached_resolution: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False, index=True
    )
    # 整體狀態(VALID_SLA_STATUSES 之一)
    status: Mapped[str] = mapped_column(String(20), default="on_track", nullable=False, index=True)
