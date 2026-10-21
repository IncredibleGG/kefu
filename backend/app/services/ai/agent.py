"""AI 回覆生成核心:解析設定 → RAG 檢索 → LLM 生成 → 附來源與信心分數。

被 dispatch(自動回覆)與 ai.suggest_reply(坐席 Copilot)共用。
所有查詢都以 tenant_id 過濾;LLM 供應商/金鑰支援租戶 BYO-Key 覆寫。
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field

import httpx
from sqlalchemy import select

from app.core import crypto
from app.core.config import settings
from app.services import rag
from app.services.ai import tools as ai_tools
from app.services.ai.prompt import build_messages
from app.services.llm.base import ChatMessage, get_provider

# tool_call 迴圈上限:每輪允許模型呼叫工具並回灌一次;超過則強制無工具收尾,
# 避免模型反覆要求工具而無限迴圈。
MAX_TOOL_ROUNDS = 3


@dataclass
class EffectiveConfig:
    """合併 AIAgentConfig + 租戶 llm_config + 全域 settings 後的有效設定。"""

    provider: str
    model: str
    api_key: str | None
    system_prompt: str | None
    temperature: float = 0.3
    top_k: int = 5
    confidence_threshold: float = 0.55
    handoff_enabled: bool = True
    collection_ids: list[str] | None = None
    config_id: uuid.UUID | None = None
    _extra: dict = field(default_factory=dict)


async def resolve_config(db, tenant_id) -> EffectiveConfig:
    """取租戶的 AI 設定;缺項用租戶 llm_config,再退回全域 settings 預設。"""
    from app.models.ai import AIAgentConfig

    row = (
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

    # 租戶 BYO-Key(讀 Tenant.llm_config,不修改 tenancy 模組)
    tenant_llm: dict = {}
    try:
        from app.models.tenancy import Tenant

        tenant = (
            await db.execute(select(Tenant).where(Tenant.id == tenant_id))
        ).scalar_one_or_none()
        if tenant and tenant.llm_config:
            tenant_llm = dict(tenant.llm_config)
    except Exception:
        tenant_llm = {}

    provider = (row.provider if row else None) or tenant_llm.get("provider") or settings.default_llm_provider
    model = (row.model if row else None) or tenant_llm.get("model") or settings.default_llm_model
    # 租戶 BYO api_key 於 DB 靜態加密,取用前解密(舊明文相容);缺則退回全域設定。
    api_key = crypto.decrypt(tenant_llm.get("api_key")) or settings.openai_api_key

    return EffectiveConfig(
        provider=provider,
        model=model,
        api_key=api_key,
        system_prompt=row.system_prompt if row else None,
        temperature=row.temperature if row else 0.3,
        top_k=row.top_k if row else 5,
        confidence_threshold=row.confidence_threshold if row else 0.55,
        handoff_enabled=row.handoff_enabled if row else True,
        collection_ids=list(row.collection_ids) if (row and row.collection_ids) else None,
        config_id=row.id if row else None,
    )


def compute_confidence(knowledge: list[dict]) -> float:
    """由 RAG 檢索分數推導回覆信心。

    以最高相似度為主訊號(cosine 相似度,約 0~1);無知識則 0。
    這是可信 AI 的核心閘門:低分代表知識庫沒把握,應轉人而非硬答。
    """
    if not knowledge:
        return 0.0
    top = max((float(k.get("score") or 0.0) for k in knowledge), default=0.0)
    return round(max(0.0, min(1.0, top)), 4)


async def generate_answer(
    db,
    tenant_id,
    query: str,
    *,
    config: EffectiveConfig | None = None,
    history: list[dict] | None = None,
    enable_tools: bool | None = None,
) -> dict:
    """RAG + LLM 生成回覆,回 {answer, confidence, sources, config}。

    sources 為引用清單(content/source_ref/score),供 UI 展示與稽核。

    ``enable_tools`` 開啟後,會把內建唯讀工具(見 services/ai/tools.py)提供給 LLM;
    模型如要求呼叫工具,則執行工具、把結果回灌再問一次(迴圈上限 MAX_TOOL_ROUNDS),
    最後回自然語言答案,並在結果附上 ``tool_calls`` 稽核軌跡。
    - None(預設):依 config 或全域旗標決定,實際預設為關閉。
    - True / False:明確覆寫。
    未啟用時完全走原路徑(provider.chat),行為與回傳形狀不變(向後相容)。
    """
    if config is None:
        config = await resolve_config(db, tenant_id)

    knowledge = await rag.retrieve(
        db, tenant_id, query, top_k=config.top_k, collection_ids=config.collection_ids
    )
    confidence = compute_confidence(knowledge)

    messages = build_messages(query, knowledge, system_prompt=config.system_prompt, history=history)

    tools_on = _resolve_tools_enabled(config, enable_tools)
    tool_trace: list[dict] = []
    if tools_on and _provider_supports_tools(config):
        # 工具路徑失敗時優雅降級為一般回覆,避免因工具問題導致整體 500。
        try:
            answer, tool_trace = await _run_tool_loop(db, tenant_id, config, messages)
        except Exception:  # noqa: BLE001
            provider = get_provider(config.provider, config.api_key)
            answer = await provider.chat(
                messages, model=config.model, temperature=config.temperature
            )
    else:
        provider = get_provider(config.provider, config.api_key)
        answer = await provider.chat(messages, model=config.model, temperature=config.temperature)

    # sources 帶編號,對應提示詞內的 [1][2]...
    sources = [
        {
            "index": i + 1,
            "content": k.get("content"),
            "source_ref": k.get("source_ref"),
            "score": k.get("score"),
        }
        for i, k in enumerate(knowledge)
    ]
    result = {"answer": answer, "confidence": confidence, "sources": sources, "config": config}
    # 僅在啟用工具時附加軌跡,維持未啟用時的回傳形狀不變(向後相容)。
    if tools_on:
        result["tool_calls"] = tool_trace
    return result


# --------------------------- tool calling(function calling)--------------------------- #
def _resolve_tools_enabled(config: EffectiveConfig, override: bool | None) -> bool:
    """決定本次是否啟用工具:明確覆寫 > config._extra 旗標 > 全域 settings 旗標 > 關閉。"""
    if override is not None:
        return bool(override)
    extra = getattr(config, "_extra", None) or {}
    if "enable_tools" in extra:
        return bool(extra.get("enable_tools"))
    return bool(getattr(settings, "ai_tools_enabled", False))


def _provider_supports_tools(config: EffectiveConfig) -> bool:
    """目前僅 OpenAI 相容 provider 走 tool_calls(共用 settings.openai_base_url)。

    其他 provider 暫不支援工具迴圈,會自動退回一般 RAG 回覆(不報錯)。
    """
    return (config.provider or "").lower() == "openai"


async def _run_tool_loop(
    db, tenant_id, config: EffectiveConfig, messages: list[ChatMessage]
) -> tuple[str, list[dict]]:
    """OpenAI 相容 tool_call 迴圈:提供工具 → 執行 → 回灌 → 續問,直到得到文字答案。

    provider.chat 只回文字(拿不到 tool_calls),故此處直接以 OpenAI 相容 HTTP
    呼叫(沿用 ai.py /models 探測同一組 base_url / api_key / httpx 慣例),
    才能讀到回應中的 tool_calls 並多輪對話。
    """
    ctx = ai_tools.ToolContext(db=db, tenant_id=tenant_id, config=config)
    # ChatMessage → dict;之後附加的 assistant(含 tool_calls)/ tool 訊息皆為原始 dict。
    convo: list[dict] = [dict(role=m.role, content=m.content) for m in messages]
    trace: list[dict] = []

    for _ in range(MAX_TOOL_ROUNDS):
        msg = await _openai_chat_completion(config, convo, tools=ai_tools.TOOL_SPECS)
        tool_calls = msg.get("tool_calls") or []
        if not tool_calls:
            return (msg.get("content") or ""), trace

        # 把模型的 assistant 回合(含 tool_calls)原樣加入對話,tool 結果需對應其 id。
        convo.append(_assistant_toolcall_msg(msg, tool_calls))
        for call in tool_calls:
            fn = (call.get("function") or {})
            name = fn.get("name") or ""
            args = _safe_json_args(fn.get("arguments"))
            output = await ai_tools.execute_tool(name, args, ctx)
            trace.append({"id": call.get("id"), "name": name, "args": args, "result": output})
            convo.append(
                {
                    "role": "tool",
                    "tool_call_id": call.get("id"),
                    "name": name,
                    "content": json.dumps(output, ensure_ascii=False),
                }
            )

    # 迴圈用盡仍在要求工具 → 強制一次「無工具」收尾,保證回出自然語言答案。
    final = await _openai_chat_completion(config, convo, tools=None)
    return (final.get("content") or ""), trace


async def _openai_chat_completion(
    config: EffectiveConfig, convo: list[dict], *, tools: list[dict] | None
) -> dict:
    """對 OpenAI 相容端點發一次 chat/completions,回 choices[0].message(原始 dict)。"""
    base_url = settings.openai_base_url.rstrip("/")
    payload: dict = {
        "model": config.model,
        "messages": convo,
        "temperature": config.temperature,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    headers = {
        "Authorization": f"Bearer {config.api_key or ''}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as client:
        resp = await client.post(
            f"{base_url}/chat/completions", json=payload, headers=headers
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]


def _assistant_toolcall_msg(msg: dict, tool_calls: list[dict]) -> dict:
    """重建要回灌的 assistant 訊息:保留 content 與 tool_calls(只取必要欄位)。"""
    return {
        "role": "assistant",
        "content": msg.get("content") or "",
        "tool_calls": [
            {
                "id": c.get("id"),
                "type": c.get("type", "function"),
                "function": {
                    "name": (c.get("function") or {}).get("name"),
                    "arguments": (c.get("function") or {}).get("arguments") or "{}",
                },
            }
            for c in tool_calls
        ],
    }


def _safe_json_args(raw) -> dict:
    """把工具呼叫的 arguments(JSON 字串)安全解析成 dict;失敗回空 dict。"""
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}
