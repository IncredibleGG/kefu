"""AI 工作流引擎(W6 自建首版):解讀 AIWorkflow.definition 並逐節點執行。

definition 結構(對齊 models/ai_workflow.py 建議):

    {
      "start": "n1",                 # 起始節點 id(可省略,預設取 nodes[0])
      "nodes": [
        {"id": "n1", "type": "message",   "config": {"text": "您好 {name}"}, "next": "n2"},
        {"id": "n2", "type": "condition", "config": {"field": "vip", "op": "eq", "value": true},
                                          "next": {"true": "n3", "false": "n4"}},
        {"id": "n3", "type": "ai_answer", "config": {"query": "{content}"}, "next": "end"},
        {"id": "n4", "type": "handoff",   "config": {}, "next": "end"},
        {"id": "end","type": "end"}
      ]
    }

節點型別(首版):
- ``message``    對訪客發訊息(config.text,支援 {var} 以 ctx 內插)。
- ``condition``  依 ctx 欄位比對(config.field/op/value)分流到 next.true / next.false。
- ``ai_answer``  呼叫 AI 生成回覆(services.ai.agent.generate_answer);LLM 故障自動降級。
- ``handoff``    轉真人(session.handler_type=human、status=open,可帶 skill_group_id)。
- ``add_tag``    對會話加標籤(config.tag_id 或 config.name,不存在則建立)。
- ``end``        結束流程。
- 其他/未知型別:安全略過並沿 next 前進(不拋)。

設計要點(對齊 services/automation.py 的降級哲學):
- **全程 try/except 降級不拋**:run_workflow 絕不向呼叫端拋例外;單節點失敗只記軌跡、
  安全停止,不影響呼叫端交易。
- **步數 / 重入上限**:MAX_STEPS 總步數上限、MAX_VISITS 單節點重入上限,雙保險防無限迴圈。
- **乾跑(dry_run)**:測試觸發時不做任何副作用(不發訊息、不改會話、不寫標籤),
  只記錄「將會執行什麼」。無有效 session 時自動退化為乾跑。
- **副作用不自行 commit**:改動併入呼叫端交易,由 API 層決定 commit / rollback。
- **跨模組延遲 import**:conversation / tag 等在節點內才 import,缺席時該節點降級略過。

所有 DB 查詢一律以 workflow.tenant_id 過濾(租戶隔離)。
"""
from __future__ import annotations

import logging
import re
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("kefu.workflow")

# 引擎可辨識的節點型別(未列出者於執行時安全略過)
NODE_TYPES: tuple[str, ...] = (
    "message",
    "condition",
    "ai_answer",
    "handoff",
    "add_tag",
    "end",
)

# 觸發時機(供前端下拉;實際事件接線由主 session 負責,引擎本身不綁事件)
TRIGGER_TYPES: tuple[str, ...] = ("manual", "session_start", "keyword", "message")

# 條件運算子(與 automation 語義一致)
CONDITION_OPS: tuple[str, ...] = ("eq", "ne", "contains", "gt", "lt", "in")

# 迴圈防護
MAX_STEPS = 50  # 單次執行總步數上限
MAX_VISITS = 10  # 單一節點重入次數上限(防自環)

_VAR_RE = re.compile(r"\{(\w+)\}")


# --------------------------------------------------------------------------- #
# 純邏輯輔助(無 DB,便於測試)
# --------------------------------------------------------------------------- #
def _normalize(value: Any) -> Any:
    if isinstance(value, uuid.UUID):
        return str(value)
    return value


def _match(op: str, actual: Any, expected: Any) -> bool:
    """單一條件比對(降級:任何無法比較的情況一律回 False)。"""
    actual = _normalize(actual)
    expected = _normalize(expected)
    if op == "eq":
        return actual == expected
    if op == "ne":
        return actual != expected
    if op == "contains":
        if actual is None:
            return False
        if isinstance(actual, (list, tuple, set)):
            return expected in actual
        return str(expected) in str(actual)
    if op in ("gt", "lt"):
        try:
            a = float(actual)  # type: ignore[arg-type]
            e = float(expected)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return False
        return a > e if op == "gt" else a < e
    if op == "in":
        if isinstance(expected, (list, tuple, set)):
            return actual in expected
        return False
    return False


def _render(text: Any, ctx: dict[str, Any]) -> str:
    """以 ctx 內插 {var}(缺值保留原樣);任何錯誤退回原字串。"""
    if not isinstance(text, str):
        return "" if text is None else str(text)

    def sub(m: "re.Match[str]") -> str:
        key = m.group(1)
        return str(ctx[key]) if key in ctx else m.group(0)

    try:
        return _VAR_RE.sub(sub, text)
    except Exception:
        return text


def _as_uuid(value: Any) -> uuid.UUID | None:
    if isinstance(value, uuid.UUID):
        return value
    if isinstance(value, str) and value:
        try:
            return uuid.UUID(value)
        except ValueError:
            return None
    return None


def _linear_next(node: dict) -> str | None:
    """線性節點的下一步:next 為字串直接取;為 dict 取 default/next;否則無。"""
    nxt = node.get("next")
    if isinstance(nxt, str):
        return nxt or None
    if isinstance(nxt, dict):
        val = nxt.get("default") or nxt.get("next")
        return val if isinstance(val, str) and val else None
    return None


def _branch_next(node: dict, config: dict, result: bool) -> str | None:
    """condition 節點的分流:優先 next.{true|false},退回 config.next_true/next_false。"""
    nxt = node.get("next")
    key = "true" if result else "false"
    if isinstance(nxt, dict):
        val = nxt.get(key)
        if isinstance(val, str) and val:
            return val
    val = config.get("next_true" if result else "next_false")
    return val if isinstance(val, str) and val else None


# --------------------------------------------------------------------------- #
# 目錄(供前端節點編輯器)
# --------------------------------------------------------------------------- #
def get_catalog() -> dict[str, Any]:
    """回傳節點型別 / 條件運算子 / 觸發時機清單(含中文標籤與 config 欄位提示)。"""
    op_labels = {
        "eq": "等於",
        "ne": "不等於",
        "contains": "包含",
        "gt": "大於",
        "lt": "小於",
        "in": "屬於清單",
    }
    trigger_labels = {
        "manual": "手動 / 測試",
        "session_start": "會話開始",
        "keyword": "關鍵字",
        "message": "訪客訊息",
    }
    return {
        "node_types": [
            {
                "type": "message",
                "label": "發送訊息",
                "config": [{"name": "text", "type": "string", "required": True}],
                "branching": False,
            },
            {
                "type": "condition",
                "label": "條件分支",
                "config": [
                    {"name": "field", "type": "string", "required": True},
                    {"name": "op", "type": "enum", "required": True, "options": list(CONDITION_OPS)},
                    {"name": "value", "type": "any", "required": False},
                ],
                "branching": True,
            },
            {
                "type": "ai_answer",
                "label": "AI 回答",
                "config": [
                    {"name": "query", "type": "string", "required": False},
                    {"name": "send", "type": "bool", "required": False},
                ],
                "branching": False,
            },
            {
                "type": "handoff",
                "label": "轉人工",
                "config": [{"name": "skill_group_id", "type": "uuid", "required": False}],
                "branching": False,
            },
            {
                "type": "add_tag",
                "label": "加標籤",
                "config": [
                    {"name": "tag_id", "type": "uuid", "required": False},
                    {"name": "name", "type": "string", "required": False},
                ],
                "branching": False,
            },
            {"type": "end", "label": "結束", "config": [], "branching": False},
        ],
        "condition_ops": [{"op": o, "label": op_labels[o]} for o in CONDITION_OPS],
        "triggers": [{"trigger": tr, "label": trigger_labels.get(tr, tr)} for tr in TRIGGER_TYPES],
    }


# --------------------------------------------------------------------------- #
# definition 基本結構驗證
# --------------------------------------------------------------------------- #
def validate_definition(definition: Any) -> str | None:
    """驗證 definition 基本結構;合法回 None,否則回錯誤訊息。

    寬鬆策略(首版):允許未知節點型別(執行時安全略過),只擋結構性錯誤——
    definition 需為物件、nodes 為非空清單、每節點需有唯一非空 id 與字串 type、
    start(若有)須指向存在的節點。definition 為空(None/未帶)視為草稿,允許。
    """
    if definition is None:
        return None
    if not isinstance(definition, dict):
        return "definition must be an object"
    nodes = definition.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        return "definition.nodes must be a non-empty list"
    seen: set[str] = set()
    for i, node in enumerate(nodes):
        if not isinstance(node, dict):
            return f"nodes[{i}] must be an object"
        nid = node.get("id")
        if not isinstance(nid, str) or not nid:
            return f"nodes[{i}] missing non-empty id"
        if nid in seen:
            return f"duplicate node id: {nid}"
        seen.add(nid)
        ntype = node.get("type")
        if not isinstance(ntype, str) or not ntype:
            return f"node {nid} missing type"
    start = definition.get("start")
    if start is not None and start not in seen:
        return f"start references unknown node: {start}"
    return None


# --------------------------------------------------------------------------- #
# 內部:載入會話(租戶隔離)
# --------------------------------------------------------------------------- #
async def _load_session(db: AsyncSession, tenant_id: uuid.UUID, session_id: Any):
    sid = _as_uuid(session_id)
    if sid is None:
        return None
    from app.models.conversation import Session  # 延遲 import(避免模組相依環)

    return (
        await db.execute(
            select(Session).where(
                Session.id == sid,
                Session.tenant_id == tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


def _is_dry_run(ctx: dict[str, Any]) -> bool:
    """ctx.dry_run 明確為 False 才做副作用;預設(未帶)為安全乾跑。"""
    return bool(ctx.get("dry_run", True))


# --------------------------------------------------------------------------- #
# 節點執行器(各自降級:回 (下一節點 id, 軌跡條目))
# --------------------------------------------------------------------------- #
async def _exec_message(db, workflow, session, dry_run, node, config, ctx):
    text = _render(config.get("text") or config.get("content") or "", ctx)
    content_type = config.get("content_type", "text")
    sent = False
    error: str | None = None
    if text and not dry_run and session is not None:
        try:
            from app.services.conversation import add_message

            await add_message(
                db,
                workflow.tenant_id,
                session.id,
                "ai",
                text,
                content_type=content_type,
                meta={"source": "workflow", "workflow_id": str(workflow.id)},
            )
            sent = True
        except Exception as exc:  # 降級:記錄不拋
            error = str(exc)
            logger.warning("workflow message 發送失敗 wf=%s", workflow.id, exc_info=True)
    info: dict[str, Any] = {"text": text, "sent": sent}
    if error:
        info["error"] = error
    return _linear_next(node), _entry(node, "ok", info)


async def _exec_condition(db, workflow, session, dry_run, node, config, ctx):
    field = config.get("field")
    op = config.get("op", "eq")
    expected = config.get("value")
    actual = ctx.get(field) if isinstance(field, str) else None
    result = _match(op, actual, expected) if op in CONDITION_OPS else False
    goto = _branch_next(node, config, result)
    info = {
        "field": field,
        "op": op,
        "value": expected,
        "actual": _normalize(actual),
        "result": result,
        "goto": goto,
    }
    return goto, _entry(node, "ok", info)


async def _exec_ai_answer(db, workflow, session, dry_run, node, config, ctx):
    query = _render(config.get("query") or ctx.get("query") or ctx.get("content") or "", ctx)
    info: dict[str, Any] = {"query": query, "sent": False}
    if not query:
        info["error"] = "empty query"
        return _linear_next(node), _entry(node, "ok", info)
    try:
        from app.services.ai.agent import generate_answer

        result = await generate_answer(db, workflow.tenant_id, query)
        answer = result.get("answer") or ""
        confidence = result.get("confidence")
        ctx["last_answer"] = answer
        ctx["last_confidence"] = confidence
        info["answer"] = answer
        info["confidence"] = confidence
        # 選配:直接把 AI 回覆發給訪客
        if config.get("send") and not dry_run and session is not None and answer:
            try:
                from app.services.conversation import add_message

                await add_message(
                    db,
                    workflow.tenant_id,
                    session.id,
                    "ai",
                    answer,
                    meta={"source": "workflow", "workflow_id": str(workflow.id)},
                )
                info["sent"] = True
            except Exception:
                logger.warning("workflow ai_answer 發送失敗 wf=%s", workflow.id, exc_info=True)
    except Exception as exc:  # LLM / provider 故障 → 降級,不中斷流程
        info["error"] = str(exc)
        logger.warning("workflow ai_answer 生成失敗 wf=%s", workflow.id, exc_info=True)
    return _linear_next(node), _entry(node, "ok", info)


async def _exec_handoff(db, workflow, session, dry_run, node, config, ctx):
    applied = False
    if not dry_run and session is not None:
        try:
            session.handler_type = "human"
            session.status = "open"
            sg = _as_uuid(config.get("skill_group_id"))
            if sg is not None:
                session.skill_group_id = sg
            await db.flush()
            applied = True
        except Exception:
            logger.warning("workflow handoff 失敗 wf=%s", workflow.id, exc_info=True)
    return _linear_next(node), _entry(node, "ok", {"applied": applied})


async def _exec_add_tag(db, workflow, session, dry_run, node, config, ctx):
    tag_ref = config.get("name") or config.get("tag") or config.get("tag_id")
    applied = False
    if not dry_run and session is not None:
        try:
            await _apply_add_tag(db, workflow.tenant_id, session, config)
            applied = True
        except Exception:
            logger.warning("workflow add_tag 失敗 wf=%s", workflow.id, exc_info=True)
    return _linear_next(node), _entry(node, "ok", {"tag": tag_ref, "applied": applied})


async def _apply_add_tag(db, tenant_id: uuid.UUID, session, config: dict) -> None:
    """對會話加標籤(冪等);tag_id 優先,否則以 name 查/建。"""
    from app.models.tag import Tag, TagRelation  # 延遲 import(跨模組:tag)

    tag = None
    tag_id = _as_uuid(config.get("tag_id"))
    name = config.get("name") or config.get("tag")
    if tag_id is not None:
        tag = (
            await db.execute(
                select(Tag).where(
                    Tag.id == tag_id,
                    Tag.tenant_id == tenant_id,
                    Tag.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
    elif name:
        tag = (
            await db.execute(
                select(Tag).where(
                    Tag.tenant_id == tenant_id,
                    Tag.name == name,
                    Tag.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if tag is None:
            tag = Tag(tenant_id=tenant_id, name=name)
            db.add(tag)
            await db.flush()
    if tag is None:
        return
    existing = (
        await db.execute(
            select(TagRelation).where(
                TagRelation.tenant_id == tenant_id,
                TagRelation.tag_id == tag.id,
                TagRelation.target_type == "session",
                TagRelation.target_id == session.id,
                TagRelation.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        db.add(
            TagRelation(
                tenant_id=tenant_id,
                tag_id=tag.id,
                target_type="session",
                target_id=session.id,
            )
        )
        await db.flush()


_EXECUTORS = {
    "message": _exec_message,
    "condition": _exec_condition,
    "ai_answer": _exec_ai_answer,
    "handoff": _exec_handoff,
    "add_tag": _exec_add_tag,
}


def _entry(node: dict, status: str, info: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "node_id": node.get("id"),
        "type": node.get("type"),
        "status": status,
        "info": info or {},
    }


# --------------------------------------------------------------------------- #
# 主入口
# --------------------------------------------------------------------------- #
async def run_workflow(
    db: AsyncSession,
    workflow: Any,
    ctx: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """依 definition 從 start 逐節點執行,回執行結果與軌跡。**絕不拋例外**。

    回傳:
        {
          "status": "completed" | "stopped" | "error" | "empty",
          "steps": int,
          "dry_run": bool,
          "trace": [{node_id, type, status, info}, ...],
          "reason": str | None,
          "ctx": {last_answer, last_confidence}  # 執行後的重點變數
        }

    - ctx:觸發脈絡。含 session_id 且 ctx.dry_run 明確為 False 時才做副作用;
      否則(預設)乾跑,只記「將執行什麼」。無有效 session 亦自動退化為乾跑。
    """
    ctx = dict(ctx or {})
    trace: list[dict[str, Any]] = []
    result: dict[str, Any] = {"steps": 0, "trace": trace, "reason": None}

    try:
        definition = getattr(workflow, "definition", None) or {}
        invalid = validate_definition(definition)
        if invalid:
            result.update(status="empty", dry_run=True, reason=invalid)
            return result

        nodes_list = definition.get("nodes") or []
        node_map: dict[str, dict] = {
            n["id"]: n for n in nodes_list if isinstance(n, dict) and isinstance(n.get("id"), str)
        }
        if not node_map:
            result.update(status="empty", dry_run=True, reason="no nodes")
            return result

        start = definition.get("start")
        if not isinstance(start, str) or start not in node_map:
            start = nodes_list[0].get("id") if isinstance(nodes_list[0], dict) else None

        # 決定是否乾跑:需明確 dry_run=False 且有有效 session 才做副作用
        dry_run = _is_dry_run(ctx)
        session = None
        if not dry_run:
            session = await _load_session(db, workflow.tenant_id, ctx.get("session_id"))
            if session is None:
                dry_run = True  # 無有效會話 → 退化乾跑,避免誤觸副作用
        result["dry_run"] = dry_run

        current = start
        steps = 0
        visits: dict[str, int] = {}
        status = "completed"
        reason: str | None = None

        while current is not None:
            if steps >= MAX_STEPS:
                status, reason = "stopped", f"step limit {MAX_STEPS} reached"
                break
            node = node_map.get(current)
            if node is None:
                status, reason = "error", f"node not found: {current}"
                trace.append({"node_id": current, "type": None, "status": "error", "info": {"error": reason}})
                break
            steps += 1
            visits[current] = visits.get(current, 0) + 1
            if visits[current] > MAX_VISITS:
                status, reason = "stopped", f"loop guard: node {current} re-entered > {MAX_VISITS}"
                trace.append(_entry(node, "error", {"error": reason}))
                break

            ntype = node.get("type")
            config = node.get("config") or {}
            if not isinstance(config, dict):
                config = {}

            if ntype == "end":
                trace.append(_entry(node, "end", {}))
                break

            executor = _EXECUTORS.get(ntype)
            if executor is None:
                # 未知型別:安全略過,沿線性 next 前進
                trace.append(_entry(node, "skip", {"reason": f"unknown node type: {ntype}"}))
                current = _linear_next(node)
                continue

            try:
                next_id, entry = await executor(db, workflow, session, dry_run, node, config, ctx)
                trace.append(entry)
                current = next_id
            except Exception as exc:  # 單節點災難性錯誤 → 記錄並安全停止
                status, reason = "error", str(exc)
                trace.append(_entry(node, "error", {"error": str(exc)}))
                logger.exception("workflow 節點執行失敗 wf=%s node=%s", getattr(workflow, "id", None), current)
                break

        result.update(
            status=status,
            steps=steps,
            reason=reason,
            ctx={
                "last_answer": ctx.get("last_answer"),
                "last_confidence": ctx.get("last_confidence"),
            },
        )
        return result
    except Exception as exc:  # 引擎級別保底:絕不向呼叫端拋
        logger.exception("workflow run_workflow 失敗 wf=%s", getattr(workflow, "id", None))
        result.update(status="error", dry_run=result.get("dry_run", True), reason=str(exc))
        return result


# --------------------------------------------------------------------------- #
# 事件 → 流程 dispatch(把 builder 建的 bot 接上真實入站事件)
# --------------------------------------------------------------------------- #
def _workflow_trigger(workflow: Any) -> str | None:
    """取流程的觸發時機:優先 definition.trigger,退回 model 欄位 ``trigger``。

    兩處皆為「等價欄位」:CRUD 以 ``trigger`` 欄位存放,但 definition 內也允許
    以 ``trigger`` 覆寫(前端匯入 / 匯出便利)。definition.trigger 若為有效字串
    則以它為準,否則回退欄位值。
    """
    definition = getattr(workflow, "definition", None)
    if isinstance(definition, dict):
        t = definition.get("trigger")
        if isinstance(t, str) and t:
            return t
    return getattr(workflow, "trigger", None)


def _workflow_keywords(definition: Any) -> list[str]:
    """從 definition 蒐集關鍵字設定(容忍多種擺放位置)。

    支援:``definition.keywords``(list 或 str)、``definition.keyword``(str)、
    以及 ``definition.trigger_config.keywords`` / ``.keyword``。回非空字串清單。
    """
    kws: list[Any] = []
    if not isinstance(definition, dict):
        return []
    for key in ("keywords", "keyword"):
        v = definition.get(key)
        if isinstance(v, str):
            kws.append(v)
        elif isinstance(v, (list, tuple)):
            kws.extend(v)
    tc = definition.get("trigger_config")
    if isinstance(tc, dict):
        for key in ("keywords", "keyword"):
            v = tc.get(key)
            if isinstance(v, str):
                kws.append(v)
            elif isinstance(v, (list, tuple)):
                kws.extend(v)
    return [k for k in (str(x).strip() for x in kws if isinstance(x, str)) if k]


def _keyword_hit(definition: Any, message_text: str | None) -> bool:
    """keyword 型流程:訊息是否含任一設定關鍵字(不分大小寫,復用引擎既有 _match)。

    未設定關鍵字或訊息為空 → 一律 False(避免無關鍵字的流程對每則訊息誤觸)。
    """
    if not message_text:
        return False
    keywords = _workflow_keywords(definition)
    if not keywords:
        return False
    haystack = str(message_text).lower()
    return any(_match("contains", haystack, kw.lower()) for kw in keywords)


def _workflow_sort_key(workflow: Any) -> tuple:
    """命中流程排序鍵:definition.priority 升冪(數字小者優先)、再依建立時間升冪。"""
    definition = getattr(workflow, "definition", None)
    prio: float = 1_000_000.0
    if isinstance(definition, dict):
        p = definition.get("priority")
        if isinstance(p, (int, float)) and not isinstance(p, bool):
            prio = float(p)
    created = getattr(workflow, "created_at", None)
    try:
        created_key = created.timestamp() if created is not None else 0.0
    except Exception:
        created_key = 0.0
    return (prio, created_key, str(getattr(workflow, "id", "")))


def _trace_response(result: dict[str, Any]) -> tuple[bool, bool]:
    """由 run_workflow 軌跡判斷流程是否「已回應 / 接管」與是否轉人。

    回 (responded, handoff):
    - responded:流程對訪客產生了回應或接管(message 已送出 / handoff 已套用 /
      ai_answer 已送出);乾跑(dry_run)時以「軌跡含 message 或 handoff 節點」為準,
      讓測試與試跑仍能得到有意義的判定。呼叫端據 responded 決定是否跳過 RAG。
    - handoff:流程是否走到 handoff 節點(供呼叫端沿用既有轉人邏輯)。
    """
    trace = result.get("trace") or []
    dry = bool(result.get("dry_run"))
    responded = False
    handoff = False
    for e in trace:
        if not isinstance(e, dict):
            continue
        ntype = e.get("type")
        info = e.get("info") if isinstance(e.get("info"), dict) else {}
        if ntype == "handoff":
            handoff = True
            if dry or info.get("applied"):
                responded = True
        elif ntype == "message":
            if info.get("sent") or (dry and info.get("text")):
                responded = True
        elif ntype == "ai_answer":
            if info.get("sent"):
                responded = True
    return responded, handoff


async def dispatch_triggers(
    db: AsyncSession,
    tenant_id: Any,
    session: Any,
    *,
    trigger: str,
    message_text: str | None = None,
    dry_run: bool = False,
    exclude_ids: set | None = None,
) -> dict[str, Any]:
    """事件 → 流程 dispatch:把 builder 建的 bot 接上真實入站事件。**絕不拋例外**。

    找出該租戶**啟用中**(is_active、未軟刪)、觸發時機為 ``trigger`` 的 AIWorkflow;
    ``keyword`` 型再比對 ``message_text`` 是否含設定關鍵字。命中後取「優先度最高」的
    **一個**流程,以實跑(dry_run=False)呼叫 :func:`run_workflow`,並由其軌跡判定是否
    已回應 / 接管。

    參數:
    - tenant_id:租戶(uuid 或字串);查詢一律以此隔離。
    - session:目標會話 ORM 物件(需已落庫,run_workflow 會依 session_id 重新載入)。
    - trigger:``session_start`` / ``keyword`` / ``message`` / ``manual`` 之一。
    - message_text:入站訊息文字(keyword 比對與流程 ctx.content/query 用)。
    - dry_run:True 時只試跑不做副作用(測試用);生產入站固定傳 False。
    - exclude_ids:本次入站已執行過的流程 id 集合;命中篩選時排除,確保**同一入站
      訊息不對同一流程觸發兩次**。

    命中策略(取一):多流程命中時,依 ``definition.priority`` 升冪(數字小者優先)、
    再依 ``created_at`` 升冪(先建立者優先)排序,**取排序最前者執行**。單一 trigger
    呼叫只選一個流程,天然避免多 bot 對同一訊息重複回覆;不同 trigger 由於欄位互斥,
    也不會選到同一流程。

    回傳:
        {
          "trigger": str,
          "matched": int,          # 通過 trigger/keyword 篩選的流程數
          "triggered": bool,       # 是否有流程實際被執行
          "handled": bool,         # 是否「已回應 / 接管」→ 呼叫端據此跳過 RAG
          "handoff": bool,         # 是否走到 handoff(轉人)
          "workflow_id": str|None, # 被執行的流程 id
          "ran_ids": [str, ...],   # 本次實際執行過的流程 id(供呼叫端累積去重)
          "result": {...}|None,    # run_workflow 完整結果(除錯用)
        }
    """
    outcome: dict[str, Any] = {
        "trigger": trigger,
        "matched": 0,
        "triggered": False,
        "handled": False,
        "handoff": False,
        "workflow_id": None,
        "ran_ids": [],
        "result": None,
    }
    try:
        tid = _as_uuid(tenant_id) or tenant_id
        from app.models.ai_workflow import AIWorkflow  # 延遲 import(避免相依環)

        rows = (
            await db.execute(
                select(AIWorkflow).where(
                    AIWorkflow.tenant_id == tid,
                    AIWorkflow.is_active.is_(True),
                    AIWorkflow.deleted_at.is_(None),
                )
            )
        ).scalars().all()

        exclude = {str(x) for x in (exclude_ids or set())}
        matched = []
        for w in rows:
            if str(getattr(w, "id", "")) in exclude:
                continue
            if _workflow_trigger(w) != trigger:
                continue
            if trigger == "keyword" and not _keyword_hit(getattr(w, "definition", None), message_text):
                continue
            matched.append(w)

        outcome["matched"] = len(matched)
        if not matched:
            return outcome

        matched.sort(key=_workflow_sort_key)
        chosen = matched[0]

        ctx: dict[str, Any] = {
            "dry_run": bool(dry_run),
            "trigger": trigger,
            "session_id": str(getattr(session, "id", "")) if session is not None else None,
        }
        if message_text is not None:
            ctx["content"] = message_text
            ctx["query"] = message_text
            ctx["message_text"] = message_text

        result = await run_workflow(db, chosen, ctx)
        responded, handoff = _trace_response(result)
        outcome.update(
            triggered=True,
            handled=responded,
            handoff=handoff,
            workflow_id=str(chosen.id),
            ran_ids=[str(chosen.id)],
            result=result,
        )
        return outcome
    except Exception:  # dispatch 級保底:絕不拖垮入站主流程
        logger.exception("workflow dispatch_triggers 失敗 tenant=%s trigger=%s", tenant_id, trigger)
        return outcome
