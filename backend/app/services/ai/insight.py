"""情境面板 AI 洞察:用 LLM 對整段會話做意圖/情緒/摘要/建議/風險分析。

乾淨室升級:取代原本「intent 恆 None、sentiment 恆 neutral、summary 只擷取最後一則
訪客訊息前 200 字、suggested_actions/risk 依 handoff 布林給固定字串」的輕量推導。

全程 try/except 降級——只要 resolve_config / provider / LLM 呼叫 / JSON 解析任一步
失敗,即回退到與原本一致的輕量版(擷取式 summary + neutral),確保 insight 端點不會
因 LLM 故障而 500。

被 app.api.v1.ai 的 insight 端點呼叫。不觸碰 dispatch、agent(僅讀 agent.resolve_config)。
"""
from __future__ import annotations

import json
import time

from sqlalchemy import select

from app.models.conversation import Message
from app.services.ai.agent import resolve_config
from app.services.llm.base import ChatMessage, get_provider

# 允許的情緒值(需與前端 AiInsight.sentiment 列舉一致)
_SENTIMENTS = {"positive", "neutral", "negative"}

# 進程內輕量快取:key = "<session_id>:<訊息數>"。以訊息數當版本——有新訊息即失效重算,
# 避免坐席短時間反覆開面板重複打 LLM。純記憶體、不落 DB、不需 migration。
_CACHE: dict[str, tuple[float, dict]] = {}
_CACHE_TTL_SECONDS = 300.0
_CACHE_MAX = 512

_MAX_MESSAGES = 20          # 帶入 LLM 的近期訊息數上限
_MAX_CONTENT_CHARS = 500    # 每則訊息截斷長度,控制 prompt 體積

_ROLE_LABELS = {
    "visitor": "訪客",
    "ai": "AI 客服",
    "human": "真人客服",
}

# risk 欄位常見的「無風險」表述,統一收斂為 None,讓前端不顯示警示條。
_RISK_EMPTY = {
    "",
    "無",
    "none",
    "n/a",
    "na",
    "無風險",
    "無明顯風險",
    "沒有",
    "無明顯",
}

_SYSTEM_PROMPT = (
    "你是資深客服品質分析師。閱讀訪客與客服的對話後,只用繁體中文輸出一個 JSON 物件,"
    "不要輸出 JSON 以外的任何文字,也不要用 Markdown 圍欄。JSON 需包含以下欄位:\n"
    '- "intent":訪客的主要意圖,20 字內短語(例:退款查詢、催促出貨)。\n'
    '- "sentiment":只能是 "positive"、"neutral"、"negative" 三者之一,依對話語氣判定。\n'
    '- "summary":2-3 句話的對話摘要,聚焦訪客訴求與目前進展。\n'
    '- "suggested_actions":給接手坐席的 1-3 條具體行動建議,元素為字串的陣列。\n'
    '- "risk":風險或需注意處(如客訴升級、情緒激動、承諾未兌現);若無明顯風險用空字串。'
)


# ----------------------------- helpers -----------------------------
def _clean_str(value, *, limit: int) -> str | None:
    """轉字串、去空白;空值回 None;過長截斷並補省略號。"""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    if len(s) > limit:
        s = s[:limit].rstrip() + "…"
    return s


def _build_transcript(msgs) -> str:
    """把時間正序的訊息拼成可讀對話文本(略過 system 訊息與空訊息)。"""
    lines: list[str] = []
    for m in msgs:
        if m.sender_type == "system":
            continue
        content = (m.content or "").strip()
        if not content:
            continue
        if len(content) > _MAX_CONTENT_CHARS:
            content = content[:_MAX_CONTENT_CHARS] + "…"
        label = _ROLE_LABELS.get(m.sender_type, m.sender_type)
        lines.append(f"{label}:{content}")
    return "\n".join(lines) if lines else "(無對話內容)"


def _extract_json(text: str) -> dict:
    """從 LLM 回應中擷取第一個 JSON 物件(容忍前後雜訊與程式碼圍欄)。"""
    if not text:
        raise ValueError("empty LLM response")
    s = text.strip()
    start = s.find("{")
    end = s.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("no JSON object in LLM response")
    data = json.loads(s[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("LLM response is not a JSON object")
    return data


def _coerce_result(raw: dict) -> dict:
    """把 LLM 產出的 dict 收斂成前端相容、型別安全的洞察結構。"""
    intent = _clean_str(raw.get("intent"), limit=60)

    sentiment = raw.get("sentiment")
    if isinstance(sentiment, str) and sentiment.strip().lower() in _SENTIMENTS:
        sentiment = sentiment.strip().lower()
    else:
        sentiment = "neutral"

    summary = _clean_str(raw.get("summary"), limit=600)

    actions_raw = raw.get("suggested_actions")
    actions: list[str] = []
    if isinstance(actions_raw, list):
        for item in actions_raw:
            s = _clean_str(item, limit=200)
            if s:
                actions.append(s)
    elif isinstance(actions_raw, str):
        s = _clean_str(actions_raw, limit=200)
        if s:
            actions.append(s)
    actions = actions[:3]

    risk = _clean_str(raw.get("risk"), limit=300)
    if risk is not None and risk.strip().lower() in _RISK_EMPTY:
        risk = None

    return {
        "intent": intent,
        "sentiment": sentiment,
        "summary": summary,
        "suggested_actions": actions,
        "risk": risk,
    }


def _fallback(session, msgs) -> dict:
    """輕量降級版:與升級前的行為一致,零外部呼叫,確保端點可用。

    msgs 為時間正序;取最後一則訪客訊息前 200 字作摘要,風險僅看是否已轉真人。
    """
    last_visitor = next(
        (m.content for m in reversed(msgs) if m.sender_type == "visitor"), None
    )
    handed_off = getattr(session, "handler_type", None) == "human"
    return {
        "intent": None,
        "sentiment": "neutral",
        "summary": (last_visitor or "").strip()[:200] or None,
        "suggested_actions": (["盡快回覆訪客,AI 已轉真人"] if handed_off else []),
        "risk": ("已轉真人" if handed_off else None),
    }


def _cache_get(key: str) -> dict | None:
    entry = _CACHE.get(key)
    if entry is None:
        return None
    ts, value = entry
    if time.monotonic() - ts > _CACHE_TTL_SECONDS:
        _CACHE.pop(key, None)
        return None
    return value


def _cache_put(key: str, value: dict) -> None:
    # 粗略防漲:超過上限直接清空(洞察為衍生資料,重算成本可接受)。
    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.clear()
    _CACHE[key] = (time.monotonic(), value)


# ----------------------------- public API -----------------------------
async def analyze_session(db, session, *, use_cache: bool = True) -> dict:
    """對單一會話做 LLM 洞察,回傳與前端 AiInsight 相容的結構化 dict。

    回傳欄位:
    - intent:訪客意圖短語(str | None)
    - sentiment:positive | neutral | negative(恆為三者之一,非寫死)
    - summary:2-3 句真摘要(str | None)
    - suggested_actions:1-3 條具體建議(list[str],恆為陣列)
    - risk:風險提示(str | None)

    LLM 任一步失敗即回退 _fallback(擷取式 summary + neutral)。呼叫端仍需自行做
    租戶隔離查詢並確認 session 存在;本函式以 session.tenant_id 過濾訊息查詢。
    """
    msgs = (
        await db.execute(
            select(Message)
            .where(
                Message.session_id == session.id,
                Message.tenant_id == session.tenant_id,
                Message.deleted_at.is_(None),
            )
            .order_by(Message.created_at.desc())
            .limit(_MAX_MESSAGES)
        )
    ).scalars().all()
    msgs = list(reversed(msgs))  # 轉為時間正序,供閱讀與摘要

    cache_key = f"{session.id}:{len(msgs)}"
    if use_cache:
        hit = _cache_get(cache_key)
        if hit is not None:
            return hit

    fallback = _fallback(session, msgs)

    # 無訪客訊息時 LLM 也分析不出東西,直接用輕量版(且不快取,待有內容再分析)。
    if not any(m.sender_type == "visitor" for m in msgs):
        return fallback

    try:
        config = await resolve_config(db, session.tenant_id)
        provider = get_provider(config.provider, config.api_key)
        transcript = _build_transcript(msgs)
        messages = [
            ChatMessage(role="system", content=_SYSTEM_PROMPT),
            ChatMessage(
                role="user",
                content="以下是完整對話,請依系統指示輸出 JSON 分析:\n\n" + transcript,
            ),
        ]
        # 分析類任務用低溫度求穩定;不依賴 provider 特有的 response_format,靠 _extract_json 容錯。
        answer = await provider.chat(messages, model=config.model, temperature=0.2)
        result = _coerce_result(_extract_json(answer))
    except Exception:
        # LLM / provider / 解析任一失敗 → 降級,端點不 500。
        return fallback

    if use_cache:
        _cache_put(cache_key, result)
    return result
