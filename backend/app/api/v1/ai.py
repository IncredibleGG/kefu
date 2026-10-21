"""M6 ai API:AI Agent 設定、坐席 Copilot 回覆建議、LLM 模型探測。

router 前綴由整合者掛載為 /api/v1/ai。所有查詢以 staff.tenant_id 過濾,
回覆一律用 app.core.response 信封。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.config import settings
from app.core.deps import CurrentStaff, DbSession
from app.core.response import ok
from app.models.ai import AIAgentConfig
from app.models.conversation import Message, Session
from app.services.ai.agent import generate_answer, resolve_config
from app.services.ai.insight import analyze_session

router = APIRouter()


# ----------------------------- schemas -----------------------------
class AgentConfigIn(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    system_prompt: str | None = None
    provider: str | None = Field(default=None, max_length=50)
    model: str | None = Field(default=None, max_length=100)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    collection_ids: list[uuid.UUID] | None = None
    top_k: int | None = Field(default=None, ge=1, le=50)
    confidence_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    handoff_enabled: bool | None = None
    is_active: bool | None = None


class SuggestIn(BaseModel):
    session_id: uuid.UUID
    query: str | None = None  # 不給則取會話最新一則訪客訊息


class EnhanceIn(BaseModel):
    text: str = Field(min_length=1, max_length=8000)
    # expand|rephrase|shorten|formal|friendly|fix;未知值由服務層降級回原文,不 422。
    action: str = Field(max_length=20)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _config_dict(c: AIAgentConfig) -> dict:
    return {
        "id": str(c.id),
        "name": c.name,
        "system_prompt": c.system_prompt,
        "provider": c.provider,
        "model": c.model,
        "temperature": c.temperature,
        "collection_ids": c.collection_ids,
        "top_k": c.top_k,
        "confidence_threshold": c.confidence_threshold,
        "handoff_enabled": c.handoff_enabled,
        "is_active": c.is_active,
    }


async def _active_config(db, tenant_id) -> AIAgentConfig | None:
    return (
        await db.execute(
            select(AIAgentConfig)
            .where(
                AIAgentConfig.tenant_id == tenant_id,
                AIAgentConfig.is_active.is_(True),
                AIAgentConfig.deleted_at.is_(None),
            )
            .order_by(AIAgentConfig.updated_at.desc())
        )
    ).scalars().first()


# ----------------------------- agent config -----------------------------
@router.get("/config")
async def get_config(staff: CurrentStaff, db: DbSession):
    """取租戶目前生效的 AI Agent 設定;尚未建立則回 null。"""
    c = await _active_config(db, staff.tenant_id)
    return ok(_config_dict(c) if c else None)


@router.get("/tools")
async def list_tools(staff: CurrentStaff):
    """列出 AI 可呼叫的內建工具(唯讀)與全域啟用狀態。"""
    from app.services.ai import tools as ai_tools

    return ok({
        "tools": ai_tools.public_tool_list(),
        "feature_enabled": bool(getattr(settings, "ai_tools_enabled", False)),
    })


@router.get("/sessions/{session_id}/insight")
async def session_insight(session_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """坐席情境面板的 AI 洞察:對整段會話做 LLM 分析(意圖/情緒/摘要/建議/風險)。

    回 {intent, sentiment, summary, suggested_actions[], risk};查無會話回 null。
    LLM / provider 故障時由 analyze_session 自動降級為輕量推導(擷取式摘要 + neutral),
    端點不會因 LLM 失敗而 500。
    """
    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        return ok(None)

    return ok(await analyze_session(db, session))


@router.put("/config")
async def upsert_config(body: AgentConfigIn, staff: CurrentStaff, db: DbSession):
    """建立或更新租戶 AI Agent 設定(upsert 目前生效的一筆)。"""
    c = await _active_config(db, staff.tenant_id)
    if c is None:
        c = AIAgentConfig(tenant_id=staff.tenant_id)
        db.add(c)

    data = body.model_dump(exclude_unset=True)
    if "collection_ids" in data and data["collection_ids"] is not None:
        data["collection_ids"] = [str(x) for x in data["collection_ids"]]
    for key, value in data.items():
        setattr(c, key, value)

    await db.commit()
    await db.refresh(c)
    return ok(_config_dict(c))


# ----------------------------- copilot / suggest -----------------------------
@router.post("/suggest_reply")
async def suggest_reply(body: SuggestIn, staff: CurrentStaff, db: DbSession):
    """坐席 Copilot:對指定會話,用 RAG+LLM 產生回覆建議(不送出、不改狀態)。

    給真人坐席參考用,附來源引用與信心分數。
    """
    session = (
        await db.execute(
            select(Session).where(
                Session.id == body.session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="session not found")

    query = (body.query or "").strip()
    if not query:
        latest = (
            await db.execute(
                select(Message)
                .where(
                    Message.tenant_id == staff.tenant_id,
                    Message.session_id == body.session_id,
                    Message.sender_type == "visitor",
                    Message.deleted_at.is_(None),
                )
                .order_by(Message.created_at.desc())
            )
        ).scalars().first()
        query = (latest.content if latest else "").strip()
    if not query:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="no query and no visitor message to answer")

    result = await generate_answer(db, staff.tenant_id, query)
    return ok(
        {
            "session_id": str(body.session_id),
            "query": query,
            "suggestion": result["answer"],
            "confidence": result["confidence"],
            "sources": result["sources"],
        }
    )


# ----------------------------- 坐席草稿潤飾(AI Assist) -----------------------------
@router.post("/enhance")
async def enhance(body: EnhanceIn, staff: CurrentStaff, db: DbSession):
    """AI 潤飾草稿:對輸入文字依 action 改寫,回 {text}。

    action ∈ expand(擴寫)| rephrase(改寫)| shorten(精簡)|
    formal(正式語氣)| friendly(親切語氣)| fix(修錯字文法)。
    以該租戶有效設定(resolve_config + provider)改寫,依原文語言(預設繁中);
    LLM / provider 失敗或 action 不合法時,降級回原文,不 500。輕量、tenant 隔離。
    """
    from app.services.ai.assist import enhance_text

    text = await enhance_text(db, staff.tenant_id, body.text, body.action)
    return ok({"text": text})


# ----------------------------- 自動打標建議(Tag suggestions) -----------------------------
@router.get("/sessions/{session_id}/suggest-tags")
async def suggest_tags(session_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """自動打標建議:對該會話對話萃取 2-5 個主題標籤,與租戶既有 Tag 比對。

    回 {suggestions:[{name, tag_id|null}]}——能對上既有 tag 給 tag_id,對不上給 name 供新建。
    查無會話或 LLM 降級時回空陣列(不 500)。tenant 隔離、CurrentStaff。
    """
    from app.services.ai.assist import suggest_tags as _suggest_tags

    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        return ok({"suggestions": []})

    return ok({"suggestions": await _suggest_tags(db, session)})


# ----------------------------- model probe -----------------------------
@router.get("/models")
async def list_models(staff: CurrentStaff, db: DbSession):
    """探測 LLM endpoint 的 /models,列出可用模型。

    使用租戶有效設定解析 base_url / api_key(支援 BYO-Key)。
    """
    config = await resolve_config(db, staff.tenant_id)
    # base_url:目前 OpenAI 相容 provider 統一用 settings.openai_base_url
    base_url = settings.openai_base_url.rstrip("/")
    headers = {"Authorization": f"Bearer {config.api_key or ''}"}
    try:
        async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as client:
            resp = await client.get(f"{base_url}/models", headers=headers)
            resp.raise_for_status()
            payload = resp.json()
    except httpx.HTTPError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=f"model probe failed: {exc}")

    # OpenAI 相容格式:{"data": [{"id": ...}, ...]}
    items = payload.get("data", payload) if isinstance(payload, dict) else payload
    models = [m.get("id") for m in items if isinstance(m, dict) and m.get("id")] if isinstance(items, list) else []
    return ok({"provider": config.provider, "base_url": base_url, "models": models, "default": config.model})
