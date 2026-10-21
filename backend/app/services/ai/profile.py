"""訪客 AI 畫像(ai_profile)產生器。

從一段客服會話的近期對話,呼叫 LLM 萃取結構化畫像:
  - intent    訪客意圖(想達成什麼 / 主要訴求,一句話)
  - sentiment 情緒傾向(正面 / 中性 / 負面)
  - tags      建議自動標籤(短詞清單,供坐席快速理解)
  - summary   簡短畫像(1-2 句 繁中 人物側寫)

回傳的 dict 「對齊 set_ai_profile 端點的落點結構」——鍵值扁平、可淺層合併進
Visitor.ai_profile(見 app/api/v1/visitor.py 的 set_ai_profile)。

設計原則:
  * 全程 try/except 降級:任何失敗(無訊息 / LLM 例外 / 供應商未就緒 / JSON 壞掉)
    一律回 None,**絕不拋例外**,以免拖垮入站主流程與即時回覆。
  * 節流:不在每則訊息都打 LLM。以「該會話的訪客訊息累計則數」為節流訊號
    (首則建立初始畫像;之後每 N 則更新一次),**不新增任何 migration**。
"""
from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

from sqlalchemy import func, select

from app.models.conversation import Message
from app.services.ai.agent import resolve_config
from app.services.llm.base import ChatMessage, get_provider

logger = logging.getLogger("kefu.ai.profile")

# 節流:每累計 N 則訪客訊息更新一次畫像(首則亦更新以建立初始畫像)。
_PROFILE_EVERY_N_VISITOR_MSGS = 3
# 納入畫像分析的近期訊息則數與單則截斷長度(控制 prompt 體積與成本)。
_PROFILE_MAX_MESSAGES = 30
_PROFILE_MAX_CHARS_PER_MSG = 400
# 建議標籤數量上限與情緒可用詞彙(超出則保留原值,不強制)。
_MAX_TAGS = 5
_SENTIMENTS = {"正面", "中性", "負面"}

_ROLE_LABELS = {"visitor": "訪客", "human": "客服", "ai": "AI", "system": "系統"}


async def _visitor_message_count(db, tenant_id, session_id) -> int:
    """該會話的訪客訊息累計則數(節流訊號,不需新欄位)。"""
    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(Message)
                .where(
                    Message.tenant_id == tenant_id,
                    Message.session_id == session_id,
                    Message.sender_type == "visitor",
                    Message.deleted_at.is_(None),
                )
            )
        ).scalar_one()
        or 0
    )


def should_update_profile(visitor_msg_count: int) -> bool:
    """依訪客訊息累計則數判斷是否該重算畫像。

    首則(建立初始畫像)與其後每 N 則(補充/修正)才更新,其餘則跳過以省成本。
    """
    if visitor_msg_count <= 0:
        return False
    return visitor_msg_count == 1 or visitor_msg_count % _PROFILE_EVERY_N_VISITOR_MSGS == 0


async def _load_transcript(db, tenant_id, session_id) -> str:
    """取近期對話,組成帶角色標籤的逐字稿(略過系統事件與空訊息)。"""
    rows = (
        await db.execute(
            select(Message)
            .where(
                Message.tenant_id == tenant_id,
                Message.session_id == session_id,
                Message.sender_type != "system",
                Message.deleted_at.is_(None),
            )
            .order_by(Message.created_at.asc())
        )
    ).scalars().all()

    lines: list[str] = []
    for m in rows:
        text = (m.content or "").strip()
        if not text:
            continue
        if len(text) > _PROFILE_MAX_CHARS_PER_MSG:
            text = text[:_PROFILE_MAX_CHARS_PER_MSG] + "…"
        label = _ROLE_LABELS.get(m.sender_type, m.sender_type)
        lines.append(f"{label}:{text}")
    return "\n".join(lines[-_PROFILE_MAX_MESSAGES:])


def _parse_profile(raw: str) -> dict:
    """把 LLM 輸出解析成畫像 dict;容忍 ```json 圍欄與前後雜訊。

    只回傳有內容的鍵,避免用空值覆蓋既有畫像。解析失敗回空 dict。
    """
    if not raw:
        return {}
    text = raw.strip()
    # 去除 markdown 圍欄
    if text.startswith("```"):
        text = text.split("```", 2)[1] if text.count("```") >= 2 else text.strip("`")
        if text.lstrip().lower().startswith("json"):
            text = text.lstrip()[4:]
    # 擷取第一個 { 到最後一個 } 之間的 JSON 主體
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return {}
    try:
        data = json.loads(text[start : end + 1])
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}

    out: dict = {}
    intent = data.get("intent")
    if isinstance(intent, str) and intent.strip():
        out["intent"] = intent.strip()[:200]

    sentiment = data.get("sentiment")
    if isinstance(sentiment, str) and sentiment.strip():
        out["sentiment"] = sentiment.strip()[:20]

    summary = data.get("summary")
    if isinstance(summary, str) and summary.strip():
        out["summary"] = summary.strip()[:500]

    tags = data.get("tags")
    if isinstance(tags, list):
        clean = []
        for t in tags:
            if isinstance(t, str) and t.strip():
                clean.append(t.strip()[:30])
            if len(clean) >= _MAX_TAGS:
                break
        if clean:
            out["tags"] = clean
    return out


_SYSTEM_PROMPT = (
    "你是客服對話分析助手。請閱讀以下客服對話,萃取訪客畫像,並**只輸出一個 JSON 物件**"
    "(不要任何前後說明、不要 markdown 圍欄),格式為:\n"
    '{"intent": "訪客的主要意圖或訴求,一句話", '
    '"sentiment": "正面 或 中性 或 負面(擇一)", '
    '"tags": ["1~5 個精簡的中文標籤,概括訪客類型/需求/狀態"], '
    '"summary": "1-2 句繁體中文的訪客側寫"}\n'
    "全部內容用繁體中文。資訊不足的欄位可留空字串或空陣列,但仍需輸出合法 JSON。"
)


async def build_visitor_profile(db, session, *, config=None, force=False) -> dict | None:
    """由會話近期對話產生訪客 AI 畫像 dict(供淺層合併進 Visitor.ai_profile)。

    參數:
      db      : AsyncSession(沿用呼叫端交易,不自行 commit)。
      session : conversation.Session ORM 物件(取 tenant_id / id)。
      config  : 可選的 EffectiveConfig;省略則自行 resolve_config。
      force   : True 時略過節流強制重算(供結案等關鍵節點呼叫)。

    回傳萃取到的畫像 dict(至少含 generated_at / source);節流未達、無對話、
    或任何失敗一律回 None。**不拋例外。**
    """
    try:
        tenant_id = session.tenant_id
        session_id = session.id

        visitor_count = await _visitor_message_count(db, tenant_id, session_id)
        if not force and not should_update_profile(visitor_count):
            return None

        transcript = await _load_transcript(db, tenant_id, session_id)
        if not transcript:
            return None

        if config is None:
            config = await resolve_config(db, tenant_id)
        provider = get_provider(config.provider, config.api_key)

        messages = [
            ChatMessage(role="system", content=_SYSTEM_PROMPT),
            ChatMessage(role="user", content=transcript),
        ]
        raw = await provider.chat(messages, model=config.model, temperature=0.2)

        profile = _parse_profile(raw or "")
        if not profile:
            return None

        # 元資料:標記來源與產生時間,便於面板/稽核區分「AI 自動」與「人工寫入」。
        profile["source"] = "ai_auto"
        profile["generated_at"] = datetime.now(UTC).isoformat()
        profile["message_count"] = visitor_count
        return profile
    except Exception:
        logger.warning(
            "build_visitor_profile 失敗,降級回 None(session=%s)",
            getattr(session, "id", None),
            exc_info=True,
        )
        return None
