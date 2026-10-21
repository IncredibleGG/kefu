"""自動化規則引擎(條件→動作)服務層。

對外主入口:

    async def emit_event(db, tenant_id, event, context: dict) -> None

事件點(services/conversation.py、api/v1/conversation.py)在會話生命週期關鍵處
呼叫 emit_event。引擎流程:

  1. 取該租戶、該事件、is_active 的規則,依 priority 升冪(數字小者先)排序。
  2. 逐條比對 conditions(AND;全部成立才命中)。可比對的欄位來自 context 與
     session 屬性(外加衍生的 channel_type),op 支援 eq/ne/contains/gt/lt/in。
  3. 命中則依序執行 actions:add_tag / assign_skill_group / assign_staff /
     set_status / notify_agents / auto_reply。

設計要點:
- **全程 try/except 降級不拋**:emit_event 絕不向呼叫端拋例外,單條規則或單一
  動作失敗只記錄、不影響其餘規則與主流程(呼叫端交易照常提交)。
- **不自行 commit**:動作對 session 的變更與新增的 TagRelation 皆併入呼叫端交易,
  由呼叫端 commit(與 add_message 一致的作法)。
- **防遞迴**:auto_reply 一律走 channel_out.send_to_visitor,**不經 add_message**,
  因此不會再觸發 message 事件,避免規則自我觸發成環。
- **跨模組延遲 import**:channel_out / realtime / tag 等在動作內才 import,
  他模組缺席時該動作降級略過,不拖垮引擎。
- **效能**:無命中規則時提早返回(不載入 session / channel),避免熱路徑額外查詢。

所有 DB 查詢一律以 tenant_id 過濾。
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.automation import (
    ACTION_TYPES,
    CONDITION_OPS,
    TRIGGER_EVENTS,
    AutomationRule,
)
from app.models.conversation import Session

logger = logging.getLogger("kefu.automation")

# 供 _build_values 讀取的 session 屬性(可作為條件欄位)
_SESSION_FIELDS = (
    "status",
    "handler_type",
    "handler_staff_id",
    "skill_group_id",
    "channel_id",
    "visitor_id",
    "visitor_lang",
    "agent_lang",
    "translate_enabled",
)


# --------------------------------------------------------------------------- #
# 純邏輯:條件比對(無 DB,便於單元測試)
# --------------------------------------------------------------------------- #
def _normalize(value: Any) -> Any:
    """把不易與 JSON 值比較的型別正規化(UUID → str),其餘原樣。"""
    if isinstance(value, uuid.UUID):
        return str(value)
    return value


def match(op: str, actual: Any, expected: Any) -> bool:
    """單一條件比對。actual 為解析後的實際值,expected 為規則設定值。

    - eq / ne:相等 / 不相等(以正規化後的值比較)。
    - contains:actual 為序列 → expected 是否為成員;否則字串子字串包含。
    - gt / lt:數值比較(兩邊可轉 float 才比;否則 False)。
    - in:expected 為清單時,actual 是否屬於該清單。
    任何無法比較的情況一律回 False(降級,不拋)。
    """
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
    # 未知運算子 → 不命中
    return False


def evaluate_conditions(conditions: list[dict] | None, values: dict[str, Any]) -> bool:
    """比對整組條件(AND)。空清單 / None 視為必命中(True)。

    values 為欲比對欄位的實際值(field → value)。任何一條不成立即回 False。
    """
    if not conditions:
        return True
    for cond in conditions:
        if not isinstance(cond, dict):
            return False
        field = cond.get("field")
        op = cond.get("op")
        expected = cond.get("value")
        if op not in CONDITION_OPS:
            return False
        actual = values.get(field)
        if not match(op, actual, expected):
            return False
    return True


# --------------------------------------------------------------------------- #
# 目錄(供前端規則建構器)
# --------------------------------------------------------------------------- #
def get_catalog() -> dict[str, Any]:
    """回傳可用的 events / condition 欄位 / condition 運算子 / action 型別清單。"""
    op_labels = {
        "eq": "等於",
        "ne": "不等於",
        "contains": "包含",
        "gt": "大於",
        "lt": "小於",
        "in": "屬於清單",
    }
    event_labels = {
        "message.visitor": "訪客傳送訊息",
        "session.created": "會話建立",
        "session.closed": "會話結束",
        "session.transfer": "會話轉接",
    }
    return {
        "events": [{"event": e, "label": event_labels.get(e, e)} for e in TRIGGER_EVENTS],
        "condition_ops": [{"op": o, "label": op_labels[o]} for o in CONDITION_OPS],
        "condition_fields": [
            {"field": "content", "label": "訊息內容", "type": "string"},
            {"field": "channel_type", "label": "渠道型別", "type": "string"},
            {"field": "status", "label": "會話狀態", "type": "string"},
            {"field": "handler_type", "label": "接待者型別", "type": "string"},
            {"field": "skill_group_id", "label": "技能組", "type": "uuid"},
            {"field": "handler_staff_id", "label": "接待坐席", "type": "uuid"},
            {"field": "visitor_id", "label": "訪客", "type": "uuid"},
            {"field": "visitor_lang", "label": "訪客語言", "type": "string"},
        ],
        "action_types": [
            {
                "type": "add_tag",
                "label": "加標籤",
                "params": [
                    {"name": "tag_id", "type": "uuid", "required": False},
                    {"name": "name", "type": "string", "required": False},
                ],
            },
            {
                "type": "assign_skill_group",
                "label": "指派技能組",
                "params": [{"name": "skill_group_id", "type": "uuid", "required": True}],
            },
            {
                "type": "assign_staff",
                "label": "指派坐席",
                "params": [{"name": "staff_id", "type": "uuid", "required": True}],
            },
            {
                "type": "set_status",
                "label": "設定會話狀態",
                "params": [{"name": "status", "type": "string", "required": True}],
            },
            {
                "type": "notify_agents",
                "label": "通知坐席",
                "params": [{"name": "message", "type": "string", "required": True}],
            },
            {
                "type": "auto_reply",
                "label": "自動回覆訪客",
                "params": [
                    {"name": "text", "type": "string", "required": False},
                    {"name": "canned_id", "type": "uuid", "required": False},
                    {"name": "canned_shortcut", "type": "string", "required": False},
                ],
            },
        ],
    }


# --------------------------------------------------------------------------- #
# 引擎:載入規則 / 脈絡
# --------------------------------------------------------------------------- #
def _as_uuid(value: Any) -> uuid.UUID | None:
    """把 str / UUID 轉成 UUID;無法轉則回 None。"""
    if isinstance(value, uuid.UUID):
        return value
    if isinstance(value, str) and value:
        try:
            return uuid.UUID(value)
        except ValueError:
            return None
    return None


async def _load_active_rules(
    db: AsyncSession, tenant_id: uuid.UUID, event: str
) -> list[AutomationRule]:
    """取該租戶、該事件、啟用中的規則,依 priority 升冪、created_at 先後排序。"""
    rows = (
        await db.execute(
            select(AutomationRule)
            .where(
                AutomationRule.tenant_id == tenant_id,
                AutomationRule.trigger_event == event,
                AutomationRule.is_active.is_(True),
                AutomationRule.deleted_at.is_(None),
            )
            .order_by(AutomationRule.priority.asc(), AutomationRule.created_at.asc())
        )
    ).scalars().all()
    return list(rows)


async def _load_session(
    db: AsyncSession, tenant_id: uuid.UUID, session_id: Any
) -> Session | None:
    """載入會話(租戶隔離);session_id 缺席或查無則回 None。"""
    sid = _as_uuid(session_id)
    if sid is None:
        return None
    return (
        await db.execute(
            select(Session).where(
                Session.id == sid,
                Session.tenant_id == tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


async def _channel_type(
    db: AsyncSession, tenant_id: uuid.UUID, channel_id: Any
) -> str | None:
    """由 channel_id 解析渠道型別(供 channel_type 條件欄位);查無回 None。"""
    cid = _as_uuid(channel_id)
    if cid is None:
        return None
    # 延遲 import:避免與 conversation 模組互相牽連
    from app.models.conversation import Channel

    return (
        await db.execute(
            select(Channel.type).where(
                Channel.id == cid, Channel.tenant_id == tenant_id
            )
        )
    ).scalar_one_or_none()


async def _build_values(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    context: dict[str, Any],
    session: Session | None,
) -> dict[str, Any]:
    """組出可供條件比對的欄位值:session 屬性 + context(context 優先)+ channel_type。"""
    values: dict[str, Any] = {}
    if session is not None:
        for attr in _SESSION_FIELDS:
            values[attr] = _normalize(getattr(session, attr, None))
    # context 覆蓋 session 同名欄位(事件當下的值優先)
    for key, val in (context or {}).items():
        values[key] = _normalize(val)
    # 衍生 channel_type:context 未帶時由 session→channel 解析
    ctype = context.get("channel_type") if context else None
    if ctype is None and session is not None:
        ctype = await _channel_type(db, tenant_id, session.channel_id)
    values["channel_type"] = ctype
    return values


# --------------------------------------------------------------------------- #
# 動作
# --------------------------------------------------------------------------- #
async def _action_add_tag(
    db: AsyncSession, tenant_id: uuid.UUID, session: Session, params: dict
) -> None:
    """對會話加標籤(冪等)。params 可帶 tag_id,或 name(不存在則建立標籤)。"""
    # 延遲 import(跨模組:tag)
    from app.models.tag import Tag, TagRelation

    tag = None
    tag_id = _as_uuid(params.get("tag_id"))
    name = params.get("name") or params.get("tag")
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

    # 冪等:已有關聯就不重複加
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


async def _action_notify_agents(
    tenant_id: uuid.UUID, session: Session | None, params: dict
) -> None:
    """對租戶坐席工作台頻道發一則自動化通知事件。"""
    # 延遲 import(跨模組:realtime)
    from app.services import realtime

    message = params.get("message") or params.get("text") or "自動化通知"
    await realtime.publish_agents(
        tenant_id,
        realtime.make_event(
            "automation.notify",
            {
                "session_id": str(session.id) if session is not None else None,
                "message": message,
                "params": params,
            },
        ),
    )


async def _action_auto_reply(
    db: AsyncSession, tenant_id: uuid.UUID, session: Session, params: dict
) -> None:
    """對訪客自動回覆。text 直接送;或以 canned_id / canned_shortcut 取罐頭內容。

    送達方式(與 dispatch 的 AI 回覆一致):
    - `add_message(sender_type="ai")`:落庫並發 message.new(web widget 經此收到)
      + session.activity(坐席工作台即時顯示)。
    - `channel_out.send_to_visitor`:對外渠道(telegram/email)真正送出;web 為 no-op
      (已由 add_message 送達),故不重複。
    **不會遞迴**:add_message 的自動化 hook 只對 sender_type=="visitor" 觸發,
    這裡是 "ai",不會再觸發 message.visitor 事件。
    """
    text = params.get("text") or params.get("content")
    if not text:
        canned_id = _as_uuid(params.get("canned_id"))
        shortcut = params.get("canned_shortcut") or params.get("shortcut")
        if canned_id is not None or shortcut:
            # 延遲 import(跨模組:canned 模型)
            from app.models.canned import CannedResponse

            stmt = select(CannedResponse).where(
                CannedResponse.tenant_id == tenant_id,
                CannedResponse.deleted_at.is_(None),
            )
            if canned_id is not None:
                stmt = stmt.where(CannedResponse.id == canned_id)
            else:
                stmt = stmt.where(CannedResponse.shortcut == shortcut)
            canned = (await db.execute(stmt)).scalars().first()
            if canned is not None:
                text = canned.content
    if not text:
        return

    content_type = params.get("content_type", "text")
    # 1) 落庫並推播(web widget 經 message.new 收到、工作台即時顯示)
    try:
        from app.services.conversation import add_message

        await add_message(
            db, tenant_id, session.id, "ai", text,
            content_type=content_type, meta={"source": "automation"},
        )
    except Exception:
        logger.warning("auto_reply add_message 失敗", exc_info=True)
    # 2) 對外渠道真正送出(telegram/email);web 為 no-op,不會重複
    try:
        from app.services import channel_out

        await channel_out.send_to_visitor(
            db, tenant_id, session.id, text, content_type=content_type
        )
    except Exception:
        logger.warning("auto_reply send_to_visitor 失敗", exc_info=True)


async def _dispatch_action(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    session: Session | None,
    atype: str,
    params: dict,
) -> None:
    """依動作型別執行。需要 session 的動作在 session 缺席時略過。"""
    if atype == "add_tag":
        if session is not None:
            await _action_add_tag(db, tenant_id, session, params)
    elif atype == "assign_skill_group":
        if session is not None:
            sg = _as_uuid(params.get("skill_group_id"))
            if sg is not None:
                session.skill_group_id = sg
                await db.flush()
    elif atype == "assign_staff":
        if session is not None:
            staff_id = _as_uuid(params.get("staff_id"))
            if staff_id is not None:
                session.handler_staff_id = staff_id
                session.handler_type = "human"
                session.status = "open"
                await db.flush()
    elif atype == "set_status":
        if session is not None:
            status = params.get("status")
            if status:
                session.status = status
                await db.flush()
    elif atype == "notify_agents":
        await _action_notify_agents(tenant_id, session, params)
    elif atype == "auto_reply":
        if session is not None:
            await _action_auto_reply(db, tenant_id, session, params)
    else:
        logger.warning("automation:未知動作型別 %s", atype)


async def _run_actions(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    session: Session | None,
    actions: list[dict] | None,
) -> None:
    """依序執行動作;單一動作失敗只記錄,不影響其餘動作。"""
    for action in actions or []:
        if not isinstance(action, dict):
            continue
        atype = action.get("type")
        params = action.get("params") or {}
        if atype not in ACTION_TYPES:
            logger.warning("automation:略過未知動作 %s", atype)
            continue
        try:
            await _dispatch_action(db, tenant_id, session, atype, params)
        except Exception:  # 動作降級,不拋
            logger.exception("automation:動作執行失敗 type=%s", atype)


# --------------------------------------------------------------------------- #
# 主入口
# --------------------------------------------------------------------------- #
async def emit_event(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    event: str,
    context: dict[str, Any],
) -> None:
    """發出一個事件,跑該租戶對應規則。**絕不拋例外**(失敗一律降級記錄)。

    - event:見 models.automation.TRIGGER_EVENTS。
    - context:事件當下的脈絡(至少含 session_id;訊息事件另含 content 等)。
    """
    try:
        rules = await _load_active_rules(db, tenant_id, event)
        if not rules:
            return  # 熱路徑:無規則直接返回,不做額外查詢

        session = await _load_session(db, tenant_id, (context or {}).get("session_id"))
        values = await _build_values(db, tenant_id, context or {}, session)

        for rule in rules:
            try:
                if not evaluate_conditions(rule.conditions or [], values):
                    continue
                await _run_actions(db, tenant_id, session, rule.actions or [])
            except Exception:  # 單條規則降級,不影響其餘
                logger.exception(
                    "automation:規則執行失敗 rule=%s", getattr(rule, "id", None)
                )
    except Exception:  # emit_event 絕不向主流程拋
        logger.exception("automation:emit_event 失敗 event=%s tenant=%s", event, tenant_id)
