"""主動式訊息規則(proactive message rule)。

租戶可設定「在什麼情境下,主動對訪客拋出一則客服訊息」的規則。實際觸發判定
發生在**瀏覽器端**(widget):後端只負責存規則、以公開端點把該渠道的 is_active
規則吐給 widget,由 widget 依 trigger 在前端評估、命中後依 mode 呈現。

一租戶可有多條規則;`channel_id` 可選:
  - 指定某渠道 → 只有該渠道的 widget 會拿到並評估。
  - 留空(NULL)→ 視為該租戶「全渠道通用」,任一渠道皆會拿到。
公開端點 `/proactive/public/{channel_key}` 以 public_key 定位渠道後,回傳
「channel_id 為該渠道 或 為 NULL」且 is_active 的規則(不含機敏欄位)。

trigger(JSONB)形狀:``{"type": <觸發型別>, "params": {...}}``
  - ``url_match``     params: {"pattern": "/pricing", "match": "contains|prefix|exact|regex"}
                       (pattern 含 ``*`` 時走萬用字元;match 省略時預設 contains)
  - ``time_on_page``  params: {"seconds": 20}          停留達 N 秒
  - ``scroll_depth``  params: {"percent": 50}          捲動達頁面 N%
  - ``visit_count``   params: {"count": 2, "op": "gte|eq|lte"}  造訪次數(widget 用 localStorage 記)
  - ``exit_intent``   params: {}                        游標往上離開視窗(關頁意圖)

mode:``show_bubble``(氣泡提示,點擊才開聊天)| ``auto_open``(自動打開聊天窗)。
frequency:``once_per_session`` | ``once_per_visitor`` | ``always``(由 widget 以 web
storage 記錄已觸發,避免洗版)。priority 數字越大越優先(widget 端多規則命中時取高者)。

整合者注意:本模組**不**修改 main.py / models/__init__.py / core。請於
``app/models/__init__.py`` 補一行讓 Alembic autogenerate 與 mapper 看見此表:
    from app.models.proactive import ProactiveRule  # noqa: F401
"""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin

# --- 允許值(供 API 層驗證與 widget 契約對齊) ---
TRIGGER_TYPES = ("url_match", "time_on_page", "scroll_depth", "visit_count", "exit_intent")
MODES = ("show_bubble", "auto_open")
FREQUENCIES = ("once_per_session", "once_per_visitor", "always")


class ProactiveRule(Base, TenantScopedMixin):
    """一條主動式訊息規則(tenant 隔離;可選綁定單一渠道)。"""

    __tablename__ = "proactive_rule"

    # 管理端顯示用名稱(不外洩給 widget)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # 選填:綁定的渠道;NULL = 該租戶全渠道通用
    channel_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("channel.id", ondelete="CASCADE"), nullable=True, index=True
    )
    # 觸發條件 {"type": ..., "params": {...}}
    trigger: Mapped[dict] = mapped_column(JSONB, nullable=False)
    # 命中後要呈現的主動訊息(當作客服開場)
    message: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # 呈現方式:show_bubble | auto_open
    mode: Mapped[str] = mapped_column(String(20), default="show_bubble", nullable=False)
    # 是否啟用(公開端點只吐 is_active 者)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)
    # 優先度:數字越大越優先(widget 端多規則命中時取高者)
    priority: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # 觸發頻率:once_per_session | once_per_visitor | always
    frequency: Mapped[str] = mapped_column(String(20), default="once_per_session", nullable=False)
