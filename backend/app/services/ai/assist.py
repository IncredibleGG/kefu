"""坐席輔助:AI 潤飾草稿 + 自動打標建議。

對齊 LiveChat 的 AI Assist(潤飾草稿)與 Tag suggestions(自動打標)。
兩者皆:
- 以 tenant_id 過濾查詢,共用 agent.resolve_config + LLM provider(依原文語言,預設繁中);
- 全程 try/except 降級——潤飾失敗回原文、打標失敗回空清單,確保端點不因 LLM 故障而 500。

被 app.api.v1.ai 的 enhance / suggest-tags 端點呼叫;不觸碰 dispatch,僅讀 agent.resolve_config。
"""
from __future__ import annotations

import json

from sqlalchemy import select

from app.models.conversation import Message
from app.models.tag import Tag
from app.services.ai.agent import resolve_config
from app.services.llm.base import ChatMessage, get_provider

# --------------------------- 潤飾草稿(AI Assist) --------------------------- #

# 潤飾動作 → 繁中指示。未知 action 由 enhance_text 視為無指示 → 回原文降級。
_ENHANCE_ACTIONS: dict[str, str] = {
    "expand": "在保留原意與事實的前提下,適度擴寫這段客服回覆,補充必要的細節與禮貌用語,使其更完整。",
    "rephrase": "換一種說法改寫這段客服回覆,保留原本的意思與資訊,但用不同的措辭與句式。",
    "shorten": "精簡這段客服回覆,刪去冗詞贅語,保留關鍵資訊與基本禮貌,使其更簡潔。",
    "formal": "把這段客服回覆改寫為正式、專業、有禮的語氣,保留原意與資訊。",
    "friendly": "把這段客服回覆改寫為親切、溫暖、易讀的語氣,保留原意與資訊。",
    "fix": "修正這段客服回覆的錯字、標點與文法錯誤,不改變它的語氣、意思與資訊。",
}

# 供端點驗證用的合法 action 集合。
ENHANCE_ACTIONS: tuple[str, ...] = tuple(_ENHANCE_ACTIONS.keys())

_ENHANCE_SYSTEM = (
    "你是專業的客服文字潤飾助手。你會依使用者的指示改寫一段客服草稿。"
    "務必使用與原文相同的語言輸出(原文為中文時輸出繁體中文),"
    "只輸出改寫後的文字本身,不要加入任何說明、前言、結語、引號或 Markdown 標記。"
)

_MAX_TEXT_CHARS = 4000  # 潤飾輸入上限,控制 prompt 體積


def _strip_wrapping_quotes(text: str) -> str:
    """去除模型偶爾自加、包住整段輸出的成對引號(不動內文中的引號)。"""
    pairs = (('"', '"'), ("'", "'"), ("「", "」"), ("『", "』"), ("“", "”"))
    for left, right in pairs:
        if len(text) >= 2 and text.startswith(left) and text.endswith(right):
            inner = text[1:-1].strip()
            # 內文若還有同款引號則不動,避免誤刪合法引號
            if left not in inner and right not in inner:
                return inner
    return text


async def enhance_text(db, tenant_id, text: str, action: str) -> str:
    """對草稿做 LLM 潤飾;回改寫後文字。

    任一步(未知 action / resolve_config / provider / LLM)失敗即回原文,
    呼叫端據此保證不 500。
    """
    original = (text or "").strip()
    instruction = _ENHANCE_ACTIONS.get(action)
    if not original or instruction is None:
        return original

    clipped = original[:_MAX_TEXT_CHARS]
    try:
        config = await resolve_config(db, tenant_id)
        provider = get_provider(config.provider, config.api_key)
        messages = [
            ChatMessage(role="system", content=_ENHANCE_SYSTEM),
            ChatMessage(role="user", content=f"{instruction}\n\n草稿內容:\n{clipped}"),
        ]
        # 潤飾求穩定用低溫度;不依賴 provider 特有參數。
        answer = await provider.chat(messages, model=config.model, temperature=0.3)
    except Exception:
        return original

    result = _strip_wrapping_quotes((answer or "").strip())
    return result or original


# --------------------------- 自動打標(Tag suggestions) --------------------------- #

_TAG_SYSTEM = (
    "你是客服對話標籤分析助手。閱讀訪客與客服的對話後,萃取 2 到 5 個最能代表此對話主題的"
    "標籤。每個標籤為 2 到 6 字的繁體中文名詞短語(例:退款、物流查詢、帳號問題、投訴)。"
    "只輸出一個 JSON 字串陣列,例如 [\"退款\", \"物流查詢\"];"
    "不要輸出陣列以外的任何文字,也不要用 Markdown 圍欄。"
)

_MAX_MESSAGES = 20
_MAX_CONTENT_CHARS = 500
_MAX_TAG_NAME_CHARS = 20
_MAX_SUGGESTIONS = 5

_ROLE_LABELS = {
    "visitor": "訪客",
    "ai": "AI 客服",
    "human": "真人客服",
}


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


def _clean_tag_name(value) -> str | None:
    """把單一候選標籤收斂為乾淨短語:去空白、去外圍引號/項目符號,過長截斷。"""
    if value is None:
        return None
    s = str(value).strip().strip("-•*·。.、,, \t")
    s = _strip_wrapping_quotes(s).strip()
    if not s:
        return None
    if len(s) > _MAX_TAG_NAME_CHARS:
        s = s[:_MAX_TAG_NAME_CHARS].rstrip()
    return s or None


def _extract_tag_names(text: str) -> list[str]:
    """從 LLM 回應中擷取標籤名清單(優先解析 JSON 陣列,退回逗號/換行切分)。"""
    if not text:
        return []
    s = text.strip()
    names: list[str] = []

    start = s.find("[")
    end = s.rfind("]")
    if start != -1 and end != -1 and end > start:
        try:
            arr = json.loads(s[start : end + 1])
        except (TypeError, ValueError):
            arr = None
        if isinstance(arr, list):
            for item in arr:
                name = _clean_tag_name(item)
                if name:
                    names.append(name)

    # 後備:非 JSON 時按常見分隔符切
    if not names:
        for chunk in s.replace("\n", ",").replace("、", ",").split(","):
            name = _clean_tag_name(chunk)
            if name:
                names.append(name)

    return names


async def suggest_tags(db, session) -> list[dict]:
    """對會話萃取 2-5 個主題標籤,並與該租戶既有 Tag 比對。

    回 ``[{"name": str, "tag_id": str | None}]``:
    - 能對上既有 tag(名稱不分大小寫)→ 帶該 tag 的 id 與正式名稱;
    - 對不上 → tag_id 為 None,name 供前端新建。

    任一步失敗(無訊息 / LLM / 解析)即回空清單,呼叫端據此不 500。
    呼叫端需先自行做租戶隔離並確認 session 存在;本函式以 session.tenant_id 過濾查詢。
    """
    try:
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
        msgs = list(reversed(msgs))  # 轉時間正序

        # 無訪客訊息時萃取不出主題,直接回空(待有內容再建議)。
        if not any(m.sender_type == "visitor" for m in msgs):
            return []

        config = await resolve_config(db, session.tenant_id)
        provider = get_provider(config.provider, config.api_key)
        transcript = _build_transcript(msgs)
        messages = [
            ChatMessage(role="system", content=_TAG_SYSTEM),
            ChatMessage(
                role="user",
                content="以下是完整對話,請依系統指示萃取主題標籤:\n\n" + transcript,
            ),
        ]
        answer = await provider.chat(messages, model=config.model, temperature=0.2)
        names = _extract_tag_names(answer)
    except Exception:
        return []

    if not names:
        return []

    # 與既有 tag 比對(名稱不分大小寫)
    existing = (
        await db.execute(
            select(Tag).where(
                Tag.tenant_id == session.tenant_id,
                Tag.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    by_lower: dict[str, Tag] = {}
    for tag in existing:
        key = (tag.name or "").strip().lower()
        if key and key not in by_lower:
            by_lower[key] = tag

    out: list[dict] = []
    seen: set[str] = set()
    for name in names:
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        match = by_lower.get(key)
        out.append(
            {
                "name": match.name if match else name,
                "tag_id": str(match.id) if match else None,
            }
        )
        if len(out) >= _MAX_SUGGESTIONS:
            break

    return out
