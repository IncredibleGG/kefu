"""AI 工作流(W6 自建):可視化流程編排定義。

以 JSONB 存節點/連線定義(definition),由工作流引擎解讀執行。屬「可用首版」:
節點型別涵蓋常見客服自動化(訊息、條件、AI 回答、轉人工、標籤等)。
查詢一律 tenant_id 隔離(TenantScopedMixin);為新表,create_all 於啟動時建立。
"""
from __future__ import annotations

from sqlalchemy import String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin


class AIWorkflow(Base, TenantScopedMixin):
    __tablename__ = "ai_workflow"

    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # 觸發時機:session_start | keyword | manual | ...(由引擎解讀)
    trigger: Mapped[str] = mapped_column(String(40), default="manual", nullable=False)
    # 流程定義:{nodes: [{id,type,config,next}], edges: [...], start: nodeId}
    definition: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    is_active: Mapped[bool] = mapped_column(default=False, nullable=False)
