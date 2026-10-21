"""M6 ai: AIAgentConfig — 每租戶的 AI 客服代理設定。

護城河柱二(反幻覺可信 AI):設定裡帶「掛哪些知識庫、信心門檻、轉人規則」,
dispatch 依此決定是否自動回覆或轉真人。Provider/model 可被租戶 BYO-Key 覆寫
(見 Tenant.llm_config),此表提供租戶層預設。
"""
from __future__ import annotations

from sqlalchemy import Boolean, Float, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin


class AIAgentConfig(Base, TenantScopedMixin):
    """租戶的 AI Agent 設定(可有多筆,dispatch 取 is_active 最新一筆)。"""

    __tablename__ = "ai_agent_config"

    name: Mapped[str] = mapped_column(String(200), default="Default Agent", nullable=False)
    # 系統提示詞(人格 / 規則 / 語氣)
    system_prompt: Mapped[str] = mapped_column(
        Text,
        default=(
            "你是專業、友善的客服助理。只依據提供的知識庫內容回答;"
            "若知識庫沒有足夠資訊,請誠實說明並建議轉接真人客服,切勿編造。"
        ),
        nullable=False,
    )
    # LLM 供應商 / 模型;null 代表沿用 settings 或租戶 llm_config 預設
    provider: Mapped[str | None] = mapped_column(String(50), nullable=True)
    model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    temperature: Mapped[float] = mapped_column(Float, default=0.3, nullable=False)
    # 掛載的知識庫 collection id 清單(字串陣列);null / 空 = 全租戶知識庫
    collection_ids: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # RAG 檢索取回筆數
    top_k: Mapped[int] = mapped_column(Integer, default=5, nullable=False)
    # 信心門檻:AI 回覆信心低於此值 → 觸發轉人
    confidence_threshold: Mapped[float] = mapped_column(Float, default=0.55, nullable=False)
    # 是否允許自動轉人
    handoff_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
