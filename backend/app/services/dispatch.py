"""入站訊息編排 seam(M6 核心)。

    async def handle_inbound(db, tenant_id, session_id, message_id)

流程:
  1. 讀會話與最新入站訊息;會話 handler_type 非 "ai" → 不介入(真人已接手)。
  2. 走 RAG + LLM 產生回覆,附「來源引用 + 信心分數」(反幻覺柱)。
  3. 低信心 → 觸發 handoff:改 handler_type="human"、嘗試 routing.assign_session、
     發 realtime 事件、記一則 system 訊息;**不自動回覆**。
  4. 正常 → add_message(sender_type="ai", meta 含 sources/confidence)並
     channel_out.send_to_visitor 送出。
  5. usage.record_usage 計量(try/except 降級)。

跨模組函式(add_message / channel_out / routing / usage / realtime)一律
import + try/except 降級:對應模組尚未落地時,dispatch 仍能獨立運作/受測。
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from importlib import import_module

from sqlalchemy import func, select

from app.models.conversation import Message, Session
from app.models.visitor import Visitor
from app.services.ai.agent import generate_answer, resolve_config
from app.services.ai.profile import build_visitor_profile

logger = logging.getLogger("kefu.dispatch")

# 摘要:最多納入的訊息則數與單則截斷長度(控制 prompt 體積)
_SUMMARY_MAX_MESSAGES = 40
_SUMMARY_MAX_CHARS_PER_MSG = 500


def _optional(module_path: str, attr: str):
    """取跨模組函式;模組/函式不存在則回 None(降級,不拋)。"""
    try:
        mod = import_module(module_path)
    except Exception:
        return None
    return getattr(mod, attr, None)


async def _persist_message(db, tenant_id, session_id, *, sender_type, content, meta=None):
    """優先用 M3 的 add_message seam;不可用時退回直接 ORM 寫入,確保訊息落庫。"""
    add_message = _optional("app.services.conversation", "add_message")
    if add_message is not None:
        try:
            return await add_message(
                db,
                tenant_id=tenant_id,
                session_id=session_id,
                sender_type=sender_type,
                content=content,
                meta=meta,
            )
        except Exception:  # 簽章不符或內部錯誤 → 降級為本地寫入
            logger.warning("add_message seam 失敗,改用本地 ORM 寫入", exc_info=True)

    # 本地寫入仍套用卡號遮罩(與 add_message 一致;遮罩函式不可用時原樣)
    mask = _optional("app.services.conversation", "mask_card_numbers")
    text = content or ""
    if mask is not None:
        try:
            text = mask(text)
        except Exception:
            logger.warning("mask_card_numbers 失敗,沿用原文", exc_info=True)
    msg = Message(
        tenant_id=tenant_id,
        session_id=session_id,
        sender_type=sender_type,
        content_type="text",
        content=text,
        meta=meta,
    )
    db.add(msg)
    try:
        session = await _load_session(db, tenant_id, session_id)
    except Exception:  # 讀不到會話不影響落庫,只是事件少了 handler 等欄位
        logger.warning("降級寫入:讀取會話失敗", exc_info=True)
        session = None
    if session is not None:
        session.last_message_at = datetime.now(timezone.utc)
    await db.flush()
    # add_message 會發 message.new / session.activity;降級路徑也必須補發,
    # 否則 web 訪客(/ws/widget 只靠 message.new)收不到 AI 回覆、坐席列表也不會更新。
    await _publish_fallback_message(tenant_id, session_id, msg, session)
    return msg


async def _publish_fallback_message(tenant_id, session_id, msg, session) -> None:
    """降級寫入後補發 realtime 事件(payload 形狀與 add_message 相同);失敗只記 log。"""
    publish = _optional("app.services.realtime", "publish")
    publish_agents = _optional("app.services.realtime", "publish_agents")
    make_event = _optional("app.services.realtime", "make_event")
    if make_event is None:
        return
    content_type = getattr(msg, "content_type", None) or "text"
    message_id = str(msg.id) if getattr(msg, "id", None) else None
    if publish is not None:
        try:
            await publish(
                tenant_id,
                session_id,
                make_event(
                    "message.new",
                    {
                        "session_id": str(session_id),
                        "message_id": message_id,
                        "sender_type": msg.sender_type,
                        "sender_id": str(msg.sender_id) if msg.sender_id else None,
                        "content_type": content_type,
                        "content": msg.content,
                        "meta": msg.meta,
                    },
                ),
            )
        except Exception:
            logger.warning("降級寫入後 publish message.new 失敗", exc_info=True)
    if publish_agents is not None:
        preview_fn = _optional("app.services.conversation", "activity_preview")
        try:
            preview = preview_fn(msg.content, content_type) if preview_fn else ""
        except Exception:
            preview = ""
        last_at = getattr(session, "last_message_at", None) if session is not None else None
        try:
            await publish_agents(
                tenant_id,
                make_event(
                    "session.activity",
                    {
                        "session_id": str(session_id),
                        "last_message_at": last_at.isoformat() if last_at else None,
                        "message_id": message_id,
                        "sender_type": msg.sender_type,
                        "content_type": content_type,
                        "preview": preview,
                        "handler_type": getattr(session, "handler_type", None),
                        "handler_staff_id": str(session.handler_staff_id)
                        if session is not None and session.handler_staff_id
                        else None,
                        "status": getattr(session, "status", None),
                        "visitor_id": str(session.visitor_id)
                        if session is not None and session.visitor_id
                        else None,
                    },
                ),
            )
        except Exception:
            logger.warning("降級寫入後 publish_agents session.activity 失敗", exc_info=True)


async def _send_to_visitor(db, tenant_id, session_id, message) -> None:
    """把訊息送回訪客渠道(降級:記 log)。

    對外渠道(telegram/email)靠此 seam 真正送達;web 則 add_message 已推播,
    此處為統一出站入口。channel_out.send_to_visitor 簽名為 (…, text, content_type)。
    """
    send = _optional("app.services.channel_out", "send_to_visitor")
    if send is None:
        logger.info("channel_out.send_to_visitor 不可用,略過送出(session=%s)", session_id)
        return
    try:
        await send(
            db,
            tenant_id=tenant_id,
            session_id=session_id,
            text=getattr(message, "content", "") or "",
        )
    except Exception:
        logger.warning("send_to_visitor 失敗", exc_info=True)


async def _assign_on_shift_first(db, tenant_id, session_id):
    """在班過濾(可回退):若本租戶目前有「在班且可用」的坐席,優先只從這批人中挑一位指派。

    對齊 LiveChat 的 Work Scheduler——把「不在班」的坐席在**指派層視為不可用**
    (不改 DB presence、不加背景排程,純指派時即時判斷)。

    回傳被指派的坐席 id;若無法/不應以在班名單完成指派,回 ``None`` 通知呼叫端
    **回退**至現有全體可用坐席邏輯。回 None 的情況(零回歸護欄):
      - 排班 seam 或 routing 內部結構不可用(降級);
      - 本租戶當下無人在班(含完全沒有班表)→ 不施加限制;
      - 在班者皆滿載 / 不在候選內 → 避免因排班導致無人接待。

    設計刻意「只縮小候選、其餘沿用 routing 既有查詢與策略」:候選負載(agent_loads)、
    策略挑選(least_load / round_robin)、落地指派(_do_assign,含 round_robin 游標與
    realtime 事件)全部復用 routing 現有實作,不重複造輪、不改動既有行為。
    """
    on_shift_fn = _optional("app.api.v1.scheduling", "staff_ids_on_shift")
    if on_shift_fn is None:
        return None  # 排班模組不可用 → 回退

    on_shift = await on_shift_fn(db, tenant_id)
    if not on_shift:
        # 無班表 / 當下無人在班 → 不限制,行為與未接排班前完全一致
        return None

    # 復用 routing 既有的候選查詢、策略挑選與落地指派;任一內部符號缺失即安全回退
    agent_loads = _optional("app.services.routing", "agent_loads")
    resolve_policy = _optional("app.services.routing", "resolve_policy")
    pick_least_load = _optional("app.services.routing", "_pick_least_load")
    pick_round_robin = _optional("app.services.routing", "_pick_round_robin")
    do_assign = _optional("app.services.routing", "_do_assign")
    if not all([agent_loads, resolve_policy, pick_least_load, pick_round_robin, do_assign]):
        return None

    session = await _load_session(db, tenant_id, session_id)
    if session is None or session.status == "closed":
        return None

    # 候選 = routing 認定的可用坐席(在線 + is_active + 未達上限);再與「在班」取交集
    candidates = await agent_loads(db, tenant_id, session.skill_group_id)
    on_shift_available = [c for c in candidates if c.available and c.staff_id in on_shift]
    if not on_shift_available:
        # 在班者皆不可用 → 回退全體可用坐席邏輯(絕不因排班導致無人接待)
        return None

    policy = await resolve_policy(db, tenant_id, session.skill_group_id)
    strategy = policy.strategy if policy else "least_load"
    if strategy == "round_robin":
        chosen = pick_round_robin(on_shift_available, policy.rr_cursor if policy else None)
    else:  # least_load,以及 llm 未注入時 routing 本就回退 least_load 的等效行為
        chosen = pick_least_load(on_shift_available)
    if chosen is None:
        return None

    # 落地指派沿用 routing._do_assign:維持 handler/status、round_robin 游標與 realtime 事件語義
    return await do_assign(db, session, chosen.staff_id, policy, strategy)


async def _assign_human(db, tenant_id, session_id) -> None:
    """交由路由模組指派坐席(降級:記 log,由人工在後台認領)。

    先套用「在班過濾(可回退)」:本租戶有在班且可用的坐席時,優先指派給在班者;
    否則(無班表 / 全部離班 / 在班者皆滿載)**回退**為 routing.assign_session 的
    現有全體可用坐席邏輯,確保無班表租戶零回歸、且絕不因排班導致無人接待。
    """
    assign = _optional("app.services.routing", "assign_session")
    if assign is None:
        logger.info("routing.assign_session 不可用,session=%s 進入待認領", session_id)
        return

    # 在班過濾:成功指派給在班坐席即完成;任何例外都吞掉並回退,不影響主流程
    try:
        chosen = await _assign_on_shift_first(db, tenant_id, session_id)
        if chosen is not None:
            return
    except Exception:
        logger.warning("在班過濾指派失敗,回退全體可用坐席邏輯", exc_info=True)

    # 回退:現有全體可用坐席邏輯(零回歸)
    try:
        await assign(db, tenant_id=tenant_id, session_id=session_id)
    except Exception:
        logger.warning("assign_session 失敗", exc_info=True)


async def _emit_realtime(tenant_id, session_id, type_: str, payload: dict) -> None:
    """發坐席專用生命週期即時事件(**只發坐席頻道**)。

    低信心轉人是坐席專用的生命週期事件(payload 含 reason/confidence 等內部欄位),
    只發租戶坐席頻道 ``publish_agents``,**不進會話頻道**,以免洩漏給訪客端(/ws/widget)。
    註:訪客該看到的「已轉接真人客服」以 system 訊息經 add_message 走會話頻道送達,不受影響。
    參數保留 session_id 以維持既有簽名與呼叫端相容。
    """
    publish_agents = _optional("app.services.realtime", "publish_agents")
    make_event = _optional("app.services.realtime", "make_event")
    evt = make_event(type_, payload) if make_event else {"type": type_, "payload": payload}
    if publish_agents is not None:
        try:
            await publish_agents(tenant_id, evt)
        except Exception:
            logger.warning("realtime publish_agents 失敗", exc_info=True)


async def _record_usage(db, tenant_id, **kw) -> None:
    """LLM 用量計量(降級:靜默)。"""
    record = _optional("app.services.usage", "record_usage")
    if record is None:
        return
    try:
        await record(db, tenant_id=tenant_id, **kw)
    except Exception:
        logger.warning("record_usage 失敗", exc_info=True)


async def _update_ai_profile(db, tenant_id, session, *, force=False) -> None:
    """產生/更新該訪客的 AI 畫像並寫回 Visitor.ai_profile(降級隔離)。

    - 委由 profile.build_visitor_profile 決定是否更新(內建節流)與萃取內容;
      force=True 時強制重算(供 handoff 等關鍵節點)。
    - 對齊 set_ai_profile 端點:對既有 ai_profile 做**淺層合併**(保留 location/os
      等既有鍵),重新賦值新 dict 以確保 ORM 偵測 JSONB 變更。
    - 只 flush 不 commit:沿用 ingest_inbound 的交易邊界,由呼叫端統一提交。
    - 任何失敗一律吞掉,不影響即時回覆與主對話流程。
    """
    try:
        profile = await build_visitor_profile(db, session, force=force)
        if not profile:
            return
        visitor = (
            await db.execute(
                select(Visitor).where(
                    Visitor.id == session.visitor_id,
                    Visitor.tenant_id == tenant_id,
                    Visitor.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if visitor is None:
            return
        visitor.ai_profile = {**(visitor.ai_profile or {}), **profile}
        await db.flush()
    except Exception:
        logger.warning(
            "更新 ai_profile 失敗(session=%s)", getattr(session, "id", None), exc_info=True
        )


async def _load_session(db, tenant_id, session_id):
    return (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


async def _load_message(db, tenant_id, session_id, message_id):
    """取指定入站訊息;message_id 為空時取該會話最新一則訪客訊息。"""
    stmt = select(Message).where(
        Message.tenant_id == tenant_id,
        Message.session_id == session_id,
        Message.deleted_at.is_(None),
    )
    if message_id is not None:
        stmt = stmt.where(Message.id == message_id)
    else:
        stmt = stmt.where(Message.sender_type == "visitor").order_by(Message.created_at.desc())
    return (await db.execute(stmt)).scalars().first()


async def _count_other_messages(db, tenant_id, session_id, exclude_message_id) -> int:
    """該會話中「除本則入站訊息外」的訊息數,用於首則訊息判斷(降級:視為非首則)。"""
    stmt = select(func.count()).select_from(Message).where(
        Message.tenant_id == tenant_id,
        Message.session_id == session_id,
        Message.deleted_at.is_(None),
    )
    if exclude_message_id is not None:
        stmt = stmt.where(Message.id != exclude_message_id)
    return int((await db.execute(stmt)).scalar_one())


async def _dispatch_workflows(db, tenant_id, session, inbound, query) -> dict:
    """在 RAG 之前嘗試觸發「流程 builder 建的 bot」(全程降級不拋)。

    - 首則訊息(該 session 之前無其他訊息)→ 先觸發 ``session_start``。
    - 每則入站訊息 → 依序觸發 ``keyword``(命中關鍵字)、``message``。
    - 任一流程「已回應 / 接管」即短路;呼叫端據回傳 ``handled`` 跳過 RAG 自動回覆。
    - 已執行過的流程 id 累積於 ``exclude_ids`` 一併傳入,確保同一入站訊息不對同一
      流程觸發兩次(不同 trigger 因欄位互斥本就不會選到同一流程,此為雙保險)。

    回傳最後一次(或命中接管的那次)dispatch_triggers 的 outcome;
    引擎不可用 / 例外 / 無流程命中一律回 ``{"handled": False}``,行為與未接流程前一致。
    """
    dispatch_triggers = _optional("app.services.workflow_engine", "dispatch_triggers")
    if dispatch_triggers is None:
        return {"handled": False}

    outcome: dict = {"handled": False}
    ran_ids: set = set()
    try:
        message_id = getattr(inbound, "id", None)
        other = await _count_other_messages(db, tenant_id, session.id, message_id)
        is_first = other == 0

        plan = []
        if is_first:
            plan.append(("session_start", None))
        plan.append(("keyword", query))
        plan.append(("message", query))

        for trig, text in plan:
            res = await dispatch_triggers(
                db,
                tenant_id,
                session,
                trigger=trig,
                message_text=text,
                dry_run=False,
                exclude_ids=ran_ids,
            )
            for rid in res.get("ran_ids") or []:
                ran_ids.add(rid)
            if res.get("triggered"):
                outcome = res
            if res.get("handled"):
                return res
        return outcome
    except Exception:
        logger.warning(
            "流程 dispatch 失敗,回退 RAG 自動回覆(session=%s)",
            getattr(session, "id", None),
            exc_info=True,
        )
        return {"handled": False}


async def handle_inbound(db, tenant_id, session_id, message_id) -> dict:
    """編排一則入站訊息的 AI 處理。回處理結果摘要(供呼叫方/測試檢視)。"""
    session = await _load_session(db, tenant_id, session_id)
    if session is None:
        return {"status": "ignored", "reason": "session_not_found"}

    # 真人已接手 → AI 不介入
    if session.handler_type != "ai":
        return {"status": "ignored", "reason": "handled_by_human"}

    inbound = await _load_message(db, tenant_id, session_id, message_id)
    if inbound is None or not (inbound.content or "").strip():
        return {"status": "ignored", "reason": "no_inbound_content"}

    query = inbound.content.strip()

    # --- 流程 builder bot:接上真實入站事件,於 RAG 之前嘗試自動觸發 / 接管 ---
    # 有流程命中並已回應 / 接管 → 跳過下方 RAG 自動回覆,避免 bot 與 RAG 雙重回覆;
    # 無任何流程命中(含未啟用流程的租戶)→ outcome.handled=False,行為與現況完全一致(零回歸)。
    wf = await _dispatch_workflows(db, tenant_id, session, inbound, query)
    if wf.get("handled"):
        if wf.get("handoff"):
            # 流程走到 handoff → 沿用既有轉人邏輯:指派坐席、發坐席即時事件、刷新畫像。
            # (handler_type 已由流程 handoff 節點設為 human;此處補齊路由與通知。)
            await _assign_human(db, tenant_id, session_id)
            await _emit_realtime(
                tenant_id,
                session_id,
                "session.handoff",
                {
                    "session_id": str(session_id),
                    "reason": "workflow",
                    "workflow_id": wf.get("workflow_id"),
                },
            )
            await _update_ai_profile(db, tenant_id, session, force=True)
        return {
            "status": "workflow",
            "trigger": wf.get("trigger"),
            "workflow_id": wf.get("workflow_id"),
            "handoff": bool(wf.get("handoff")),
        }

    config = await resolve_config(db, tenant_id)
    result = await generate_answer(db, tenant_id, query, config=config)
    answer, confidence, sources = result["answer"], result["confidence"], result["sources"]

    # 計量(不因失敗中斷主流程)
    await _record_usage(
        db,
        tenant_id,
        kind="ai_reply",
        quantity=1,
        meta={"session_id": str(session_id), "provider": config.provider, "model": config.model},
    )

    # --- 低信心 → 轉人,不自動回覆 ---
    if config.handoff_enabled and confidence < config.confidence_threshold:
        session.handler_type = "human"
        session.handler_staff_id = None
        await db.flush()
        await _persist_message(
            db,
            tenant_id,
            session_id,
            sender_type="system",
            content="AI 信心不足,已轉接真人客服。",
            meta={
                "event": "handoff",
                "reason": "low_confidence",
                "confidence": confidence,
                "threshold": config.confidence_threshold,
                "draft_answer": answer,  # 保留 AI 草稿供坐席參考
                "sources": sources,
            },
        )
        await _assign_human(db, tenant_id, session_id)
        await _emit_realtime(
            tenant_id,
            session_id,
            "session.handoff",
            {"session_id": str(session_id), "reason": "low_confidence", "confidence": confidence},
        )
        # 轉人是關鍵節點:強制刷新畫像,讓接手坐席一眼掌握意圖/情緒(失敗降級)。
        await _update_ai_profile(db, tenant_id, session, force=True)
        return {"status": "handoff", "confidence": confidence, "sources": sources}

    # --- 正常 → 落庫 AI 回覆並送出 ---
    ai_msg = await _persist_message(
        db,
        tenant_id,
        session_id,
        sender_type="ai",
        content=answer,
        meta={"sources": sources, "confidence": confidence, "model": config.model},
    )
    await _send_to_visitor(db, tenant_id, session_id, ai_msg)
    # 註:add_message 已對會話/坐席頻道發 message.new + session.activity,此處不重發。
    # 回覆已送出後才更新 AI 畫像(內建節流,失敗降級),不佔用訪客的回覆延遲。
    await _update_ai_profile(db, tenant_id, session)
    mid = getattr(ai_msg, "id", None)
    return {
        "status": "replied",
        "confidence": confidence,
        "sources": sources,
        "message_id": str(mid) if mid else None,
    }


# --------------------------------------------------------------------------- #
# AI 自動摘要(供結案流程呼叫;獨立於 handle_inbound 主邏輯)
# --------------------------------------------------------------------------- #
_ROLE_LABELS = {"visitor": "訪客", "human": "客服", "ai": "AI", "system": "系統"}


async def summarize_session(db, tenant_id, session_id) -> str:
    """讀該會話訊息 → LLM 生成 2-3 句摘要(繁中)。

    設計為「結案自動摘要」掛鉤:整合者可在坐席結束會話時呼叫。任何失敗
    (無訊息、LLM 例外、供應商未就緒)一律降級回空字串,**不拋例外**,
    以免影響結案主流程。回傳純文字摘要。

    簽名:async def summarize_session(db, tenant_id, session_id) -> str
    """
    try:
        rows = (
            await db.execute(
                select(Message)
                .where(
                    Message.tenant_id == tenant_id,
                    Message.session_id == session_id,
                    Message.deleted_at.is_(None),
                )
                .order_by(Message.created_at.asc())
            )
        ).scalars().all()
        if not rows:
            return ""

        # 只取有文字內容的訊息;略過系統事件與空訊息
        lines: list[str] = []
        for m in rows:
            text = (m.content or "").strip()
            if not text:
                continue
            if len(text) > _SUMMARY_MAX_CHARS_PER_MSG:
                text = text[:_SUMMARY_MAX_CHARS_PER_MSG] + "…"
            label = _ROLE_LABELS.get(m.sender_type, m.sender_type)
            lines.append(f"{label}:{text}")
        if not lines:
            return ""
        transcript = "\n".join(lines[-_SUMMARY_MAX_MESSAGES:])

        config = await resolve_config(db, tenant_id)
        from app.services.llm.base import ChatMessage, get_provider

        provider = get_provider(config.provider, config.api_key)
        messages = [
            ChatMessage(
                role="system",
                content=(
                    "你是客服會話摘要助手。請用繁體中文,以 2-3 句話摘要以下客服對話的"
                    "重點:訪客的問題/需求、處理過程與結果。只輸出摘要本身,不要前綴或標題。"
                ),
            ),
            ChatMessage(role="user", content=transcript),
        ]
        summary = await provider.chat(messages, model=config.model, temperature=0.2)
        return (summary or "").strip()
    except Exception:
        logger.warning("summarize_session 失敗,降級回空字串(session=%s)", session_id, exc_info=True)
        return ""
