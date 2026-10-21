"""AI 對話測試(Playground)端點:讓後台管理員直接與 AI 客服對話測試。

router 前綴由整合者掛載為 /api/v1/playground。所有查詢以 staff.tenant_id 過濾。

與真實會話的關鍵差異(乾淨室 / 沙盒):
  - **不建立任何 Session / Message**、不寫任何庫;純呼叫 agent.generate_answer
    (RAG 檢索 + LLM 生成,皆為唯讀),因此不影響線上對話與計量。
  - 以租戶目前生效的 AIAgentConfig 為基準,允許 request body 逐項覆寫測試參數
    (model / system_prompt / 知識庫 collections / 信心門檻 / temperature / top_k),
    即時觀察不同設定下的回答、信心分、引用來源與是否會觸發轉人工。

回覆一律用 app.core.response 信封。首版為逐則(非串流)。
"""
from __future__ import annotations

import dataclasses
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.core.deps import CurrentStaff, DbSession
from app.core.response import ok
from app.services.ai.agent import generate_answer, resolve_config

router = APIRouter()


# ----------------------------- schemas -----------------------------
class ChatTurn(BaseModel):
    """一則對話訊息(測試用,不落庫)。"""

    role: Literal["user", "assistant", "system"] = "user"
    content: str = ""


class PlaygroundChatIn(BaseModel):
    """對話測試請求:對話歷史 + 可選的測試參數覆寫。

    messages 為到目前為止的完整對話(含這次要送出的最新一則 user 訊息);
    後端取「最後一則有內容的 user 訊息」當本次提問,其餘較早訊息作為對話脈絡。
    覆寫欄位皆選填,未提供者沿用租戶生效設定。
    """

    messages: list[ChatTurn] = Field(min_length=1)
    # --- 可選覆寫參數(對齊 EffectiveConfig) ---
    provider: str | None = Field(default=None, max_length=50)
    model: str | None = Field(default=None, max_length=100)
    system_prompt: str | None = None
    collection_ids: list[uuid.UUID] | None = None
    confidence_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    top_k: int | None = Field(default=None, ge=1, le=50)
    handoff_enabled: bool | None = None


# ----------------------------- helpers -----------------------------
def _apply_overrides(base, body: PlaygroundChatIn):
    """把 request body 內「有提供」的覆寫欄位套到租戶生效設定上,回新的 EffectiveConfig。

    只覆寫使用者明確送出的欄位(exclude_unset);其餘沿用租戶設定,不動 api_key /
    config_id 等既有解析結果(避免測試時漏帶金鑰)。
    """
    provided = body.model_dump(exclude_unset=True)
    patch: dict = {}
    if provided.get("provider"):
        patch["provider"] = body.provider
    if provided.get("model"):
        patch["model"] = body.model
    if "system_prompt" in provided and body.system_prompt is not None:
        patch["system_prompt"] = body.system_prompt
    if "confidence_threshold" in provided and body.confidence_threshold is not None:
        patch["confidence_threshold"] = body.confidence_threshold
    if "temperature" in provided and body.temperature is not None:
        patch["temperature"] = body.temperature
    if "top_k" in provided and body.top_k is not None:
        patch["top_k"] = body.top_k
    if "handoff_enabled" in provided and body.handoff_enabled is not None:
        patch["handoff_enabled"] = body.handoff_enabled
    if "collection_ids" in provided and body.collection_ids is not None:
        # 空清單 = 檢索全租戶知識庫(對齊 resolve_config / rag.retrieve 語意)
        patch["collection_ids"] = [str(x) for x in body.collection_ids] or None
    return dataclasses.replace(base, **patch)


def _split_query(messages: list[ChatTurn]) -> tuple[str, list[dict]]:
    """從對話歷史取出本次提問與脈絡。

    - query:最後一則有內容的 user 訊息。
    - history:該則之前、且有內容的訊息([{role, content}]),供 LLM 脈絡。
    """
    last_user_idx: int | None = None
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].role == "user" and (messages[i].content or "").strip():
            last_user_idx = i
            break
    if last_user_idx is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="no user message to answer"
        )
    query = messages[last_user_idx].content.strip()
    history = [
        {"role": m.role, "content": m.content}
        for m in messages[:last_user_idx]
        if (m.content or "").strip()
    ]
    return query, history


# ----------------------------- chat -----------------------------
@router.post("/chat")
async def playground_chat(body: PlaygroundChatIn, staff: CurrentStaff, db: DbSession):
    """後台 AI 對話測試:用租戶設定(可 body 覆寫)產生一則 AI 回覆。

    回 {answer, confidence, sources, would_handoff, handoff_reason, config}。
    **不建立真實 Session / Message**、不寫庫、不計量,不影響線上會話。
    """
    query, history = _split_query(body.messages)

    base_config = await resolve_config(db, staff.tenant_id)
    config = _apply_overrides(base_config, body)

    try:
        result = await generate_answer(
            db, staff.tenant_id, query, config=config, history=history
        )
    except HTTPException:
        raise
    except Exception as exc:  # LLM / provider / 金鑰問題 → 明確回 502,不 500
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, detail=f"AI 生成失敗:{exc}"
        )

    confidence = result["confidence"]
    would_handoff = bool(
        config.handoff_enabled and confidence < config.confidence_threshold
    )

    return ok(
        {
            "query": query,
            "answer": result["answer"],
            "confidence": confidence,
            "sources": result["sources"],
            "would_handoff": would_handoff,
            "handoff_reason": "low_confidence" if would_handoff else None,
            # 回傳本次實際生效的設定,方便前端顯示「用了哪些參數」(不含 api_key)
            "config": {
                "provider": config.provider,
                "model": config.model,
                "system_prompt": config.system_prompt,
                "temperature": config.temperature,
                "top_k": config.top_k,
                "confidence_threshold": config.confidence_threshold,
                "handoff_enabled": config.handoff_enabled,
                "collection_ids": config.collection_ids,
            },
        }
    )
