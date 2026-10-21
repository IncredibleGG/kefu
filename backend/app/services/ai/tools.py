"""AI 工具呼叫(function calling)內建工具註冊表 + 執行器(首版)。

護城河柱二(反幻覺可信 AI)延伸:讓 LLM 除了 RAG 之外,還能主動「查」租戶
自己的資料(知識庫 / 工單 / 會話 / 營業時間)再作答。**所有內建工具一律唯讀、
一律以 tenant_id 隔離**,不做任何寫入 / 刪除 / 危險操作,確保安全。

對外契約(給 agent.py 用):
    TOOL_SPECS                 # list[dict] — OpenAI function-calling 格式的工具定義
    async execute_tool(name, args, ctx) -> dict   # 依名稱執行,回可 JSON 序列化結果
    public_tool_list()         # list[dict] — 給前端/端點展示的 UI 友善中繼資料
    ToolContext                # 執行上下文(db / tenant_id / config)

新增工具的唯一真實來源是 `_REGISTRY`:在其中登記 spec + 執行函式 + 分類,
TOOL_SPECS / public_tool_list / execute_tool 皆由它衍生,避免多處不同步。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo

import uuid as _uuid

from sqlalchemy import select

from app.services import rag


@dataclass
class ToolContext:
    """工具執行上下文。tenant_id 為租戶隔離的唯一依據,所有查詢都必須帶上。"""

    db: Any
    tenant_id: Any
    config: Any = None  # EffectiveConfig(選填;工具可讀 top_k 等偏好)


# ------------------------------------------------------------------------- #
# 內建工具實作(全部唯讀、全部 tenant 隔離)
# ------------------------------------------------------------------------- #
async def _search_knowledge(args: dict, ctx: ToolContext) -> dict:
    """語意檢索租戶知識庫,回相關片段(含來源與相似度分數)。"""
    query = str(args.get("query") or "").strip()
    if not query:
        return {"error": "query 為必填", "results": []}
    top_k = _clamp_int(args.get("top_k"), default=5, lo=1, hi=20)
    hits = await rag.retrieve(ctx.db, ctx.tenant_id, query, top_k=top_k)
    return {
        "query": query,
        "count": len(hits),
        "results": [
            {
                "content": h.get("content"),
                "source_ref": h.get("source_ref"),
                "score": h.get("score"),
            }
            for h in hits
        ],
    }


async def _get_ticket_status(args: dict, ctx: ToolContext) -> dict:
    """依工單 ID 查工單狀態(唯讀)。示範查「訂單/工單」類實體的狀態。"""
    from app.models.ticket import Ticket

    tid = _parse_uuid(args.get("ticket_id"))
    if tid is None:
        return {"error": "ticket_id 需為有效的 UUID"}
    row = (
        await ctx.db.execute(
            select(Ticket).where(
                Ticket.id == tid,
                Ticket.tenant_id == ctx.tenant_id,  # 租戶隔離
                Ticket.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if row is None:
        return {"found": False, "ticket_id": str(tid)}
    return {
        "found": True,
        "ticket_id": str(row.id),
        "title": row.title,
        "status": row.status,
        "priority": row.priority,
        "assigned": row.assignee_staff_id is not None,
        "tags": row.tags or [],
        "created_at": _iso(row.created_at),
        "resolved_at": _iso(row.resolved_at),
        "closed_at": _iso(row.closed_at),
    }


async def _get_session_status(args: dict, ctx: ToolContext) -> dict:
    """依會話 ID 查會話狀態與目前處理者(AI/真人)(唯讀)。"""
    from app.models.conversation import Session

    sid = _parse_uuid(args.get("session_id"))
    if sid is None:
        return {"error": "session_id 需為有效的 UUID"}
    row = (
        await ctx.db.execute(
            select(Session).where(
                Session.id == sid,
                Session.tenant_id == ctx.tenant_id,  # 租戶隔離
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if row is None:
        return {"found": False, "session_id": str(sid)}
    return {
        "found": True,
        "session_id": str(row.id),
        "status": row.status,
        "handler_type": row.handler_type,  # ai | human
        "handled_by_human": row.handler_type == "human",
        "last_message_at": _iso(row.last_message_at),
        "closed_at": _iso(row.closed_at),
    }


async def _get_business_hours(args: dict, ctx: ToolContext) -> dict:
    """查租戶營業時間 / 離線留言,並盡力推算「當下是否營業」(唯讀)。"""
    from app.models.settings import TenantSettings

    row = (
        await ctx.db.execute(
            select(TenantSettings).where(
                TenantSettings.tenant_id == ctx.tenant_id,  # 租戶隔離
                TenantSettings.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if row is None:
        # 未設定 → 視為全天營業(與 settings 模型 docstring 一致)
        return {"configured": False, "is_open_now": True, "business_hours": None}

    bh = row.business_hours or None
    tz = (bh or {}).get("timezone") if isinstance(bh, dict) else None
    tz = tz or row.timezone
    return {
        "configured": True,
        "timezone": tz,
        "business_hours": bh,
        "offline_message": row.offline_message,
        "is_open_now": _compute_is_open(bh, tz),
    }


# ------------------------------------------------------------------------- #
# 工具註冊表(唯一真實來源):spec(給 LLM)+ 執行函式 + UI 中繼資料
# ------------------------------------------------------------------------- #
@dataclass
class _Tool:
    name: str
    description: str
    parameters: dict  # JSON Schema(OpenAI function parameters)
    handler: Callable[[dict, ToolContext], Awaitable[dict]]
    category: str = "general"
    readonly: bool = True


_REGISTRY: dict[str, _Tool] = {
    t.name: t
    for t in [
        _Tool(
            name="search_knowledge",
            description=(
                "在租戶知識庫中做語意檢索,取回與問題最相關的片段(含來源與相似度)。"
                "回答事實性 / 產品 / 政策問題前應先呼叫此工具取得依據。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "要檢索的問題或關鍵字"},
                    "top_k": {
                        "type": "integer",
                        "description": "取回筆數(1-20,預設 5)",
                        "minimum": 1,
                        "maximum": 20,
                    },
                },
                "required": ["query"],
            },
            handler=_search_knowledge,
            category="knowledge",
        ),
        _Tool(
            name="get_ticket_status",
            description="依工單 ID 查詢該工單的目前狀態、優先級與時間戳(唯讀)。",
            parameters={
                "type": "object",
                "properties": {
                    "ticket_id": {"type": "string", "description": "工單 UUID"},
                },
                "required": ["ticket_id"],
            },
            handler=_get_ticket_status,
            category="ticket",
        ),
        _Tool(
            name="get_session_status",
            description="依會話 ID 查詢該會話的狀態與目前處理者(AI 或真人)(唯讀)。",
            parameters={
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "會話 UUID"},
                },
                "required": ["session_id"],
            },
            handler=_get_session_status,
            category="conversation",
        ),
        _Tool(
            name="get_business_hours",
            description="查詢本客服的營業時間、離線留言,以及當下是否在營業時間內(唯讀)。",
            parameters={"type": "object", "properties": {}},
            handler=_get_business_hours,
            category="settings",
        ),
    ]
}


# 給 LLM 的 function 定義(OpenAI function-calling 格式)
TOOL_SPECS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": t.name,
            "description": t.description,
            "parameters": t.parameters,
        },
    }
    for t in _REGISTRY.values()
]


async def execute_tool(name: str, args: dict | None, ctx: ToolContext) -> dict:
    """依名稱執行工具,回可 JSON 序列化的 dict。

    設計為「永不拋例外」:未知工具或執行錯誤都以 {"error": ...} 回傳,讓
    agent tool_call 迴圈能把錯誤回灌給 LLM 續答,而不是讓整個回覆流程 500。
    """
    tool = _REGISTRY.get(name)
    if tool is None:
        return {"error": f"unknown tool: {name}"}
    try:
        return await tool.handler(args or {}, ctx)
    except Exception as exc:  # noqa: BLE001 — 工具錯誤需回灌給模型,不可外拋
        return {"error": f"{type(exc).__name__}: {exc}"}


def public_tool_list() -> list[dict]:
    """給前端 / 端點展示用的工具中繼資料(name / 說明 / 參數 / 分類 / 唯讀)。

    參數攤平成 UI 友善的清單,前端不必自行解析 JSON Schema。
    """
    out: list[dict] = []
    for t in _REGISTRY.values():
        props: dict = (t.parameters or {}).get("properties", {}) or {}
        required = set((t.parameters or {}).get("required", []) or [])
        out.append(
            {
                "name": t.name,
                "description": t.description,
                "category": t.category,
                "readonly": t.readonly,
                "parameters": [
                    {
                        "name": pname,
                        "type": pdef.get("type", "string"),
                        "description": pdef.get("description"),
                        "required": pname in required,
                    }
                    for pname, pdef in props.items()
                ],
            }
        )
    return out


# ------------------------------------------------------------------------- #
# 小工具
# ------------------------------------------------------------------------- #
def _clamp_int(value: Any, *, default: int, lo: int, hi: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _parse_uuid(value: Any) -> _uuid.UUID | None:
    if isinstance(value, _uuid.UUID):
        return value
    try:
        return _uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if isinstance(dt, datetime) else None


_WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _compute_is_open(business_hours: dict | None, tz: str | None) -> bool | None:
    """由 business_hours 結構盡力推算當下是否營業;資料不足 / 出錯回 None。

    - business_hours 為 None → 視為全天營業(True)。
    - days[weekday] 為多段 [["09:00","18:00"], ...];空陣列 = 當天休息。
    - 跨午夜段(end <= start,如 ["22:00","02:00"])亦支援(近似:同日該段也涵蓋凌晨)。
    """
    if business_hours is None:
        return True
    if not isinstance(business_hours, dict):
        return None
    days = business_hours.get("days")
    if not isinstance(days, dict):
        return None
    try:
        zone = ZoneInfo(tz) if tz else ZoneInfo("UTC")
        now = datetime.now(zone)
        segments = days.get(_WEEKDAYS[now.weekday()]) or []
        cur = now.time()
        for seg in segments:
            if not (isinstance(seg, (list, tuple)) and len(seg) == 2):
                continue
            start = _parse_hhmm(seg[0])
            end = _parse_hhmm(seg[1])
            if start is None or end is None:
                continue
            if end <= start:  # 跨午夜
                if cur >= start or cur < end:
                    return True
            elif start <= cur < end:
                return True
        return False
    except Exception:  # noqa: BLE001 — 時區/格式問題不應讓工具失敗
        return None


def _parse_hhmm(value: Any) -> time | None:
    try:
        hh, mm = str(value).split(":")
        return time(hour=int(hh), minute=int(mm))
    except (TypeError, ValueError):
        return None
