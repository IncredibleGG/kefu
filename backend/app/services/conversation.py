"""M3 會話核心服務:開/取會話、寫訊息、結束會話。

這些是本模組對外的 seam(簽名見 DEV-PLAN 3.5),供 API 層與其他模組
(如 M6 AI 自動回覆、各渠道 webhook)重用。所有查詢一律以 tenant_id 過濾,
寫入訊息與生命週期變更會經 realtime 推送。
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Message, Session
from app.services import realtime

logger = logging.getLogger("kefu.conversation")


# --------------------------- 信用卡號遮罩 --------------------------- #
# 卡號候選:13–16 位數字,允許數字間以單一空格或連字號分隔;前後不緊貼其他數字或
# 小數點,避免咬進更長的數字串(訂單號/流水號)或金額小數。
# ``(?:\d[ -]?){12,15}\d`` = 12–15 個「數字+選填分隔」再加一個結尾數字 = 13–16 位。
# 卡號候選:抓「最大」的數字-分隔混合串(13 位數字以上),分隔可為空白(含空格 / tab /
# 換行 / NBSP / 全形空格)、點、連字號、斜線,每兩位數字間 0–3 個(涵蓋雙空格、"4111.1111"、
# CRLF 貼上、"4111 -1111"、"4111/1111" 等所有常見格式)。**不再用邊界 lookaround** ——
# 過往版本靠 (?<!\d)/(?!\.\d) 之類斷言區分小數 / 句點,反覆在雙空格 / 點分隔 / 小數後綴等
# 情形把卡號「切斷」成 <13 位而整段漏遮(PII/PCI 外洩)。改為:先抓下最大的候選串,
# 是否遮罩一律交給 _sub 內的「Luhn 有效視窗掃描」決定 —— 只有真含 Luhn 有效卡號才遮。
# {0,3} 有界,無災難性回溯。代價:少數「恰含 Luhn 有效視窗」的相鄰數字 / 小數會被一併
# 遮罩(誤遮),此權衡刻意偏向「絕不漏卡」。
_CARD_CANDIDATE_RE = re.compile(r"\d(?:[\s.\-/]{0,3}\d){12,}")


def _luhn_ok(digits: str) -> bool:
    """Luhn(mod-10)校驗:信用卡號的標準檢核,用來濾掉純湊數字的誤判。

    由右至左,奇數索引位(從 0 起算的第 1、3、5…位)加倍後若 >9 減 9,總和 % 10 == 0 即通過。
    """
    total = 0
    for idx, ch in enumerate(reversed(digits)):
        d = ord(ch) - 48  # ch 必為 '0'-'9'(呼叫端已去除非數字)
        if idx % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _mask_digits(digits: str) -> str:
    """把一串卡號數字遮成只留末 4 碼,並以每 4 碼一組(靠右對齊)呈現。

    例:16 碼 → ``•••• •••• •••• 1234``;15 碼 → ``••• •••• •••• 1234``。
    """
    masked = "•" * (len(digits) - 4) + digits[-4:]
    groups: list[str] = []
    i = len(masked)
    while i > 0:
        groups.append(masked[max(0, i - 4):i])
        i -= 4
    groups.reverse()
    return " ".join(groups)


def mask_card_numbers(text: str) -> str:
    """偵測並遮罩文字中的信用卡號,只保留末 4 碼。

    規則:抓 13–16 位、可含空格/連字號的數字序列,且**通過 Luhn 校驗**才遮罩,
    以避免誤傷訂單號、電話、會員編號等(它們鮮少同時滿足長度與 Luhn)。
    非卡號內容原樣保留;可同時遮罩一段文字中的多個卡號。

    安全優先:當一段數字串「含」有效卡號但整段不是乾淨 13–16 位卡時(前綴/後綴
    帶外來數字,或位數 >16),掃描內嵌的 13–16 位 Luhn 有效視窗,命中即把整段數字
    全部遮罩(絕不讓卡號任何位數外露)。代價是少數「恰好內嵌 Luhn 有效視窗」的
    非卡號長數字串會被一併遮罩(誤遮),此權衡刻意偏向不漏卡。

    測試思路(供日後補單元測試):
    - 有效卡號 "4111 1111 1111 1111"、"4111-1111-1111-1111"、"4111111111111111"
      → 皆遮成 "•••• •••• •••• 1111";夾在句子中只遮卡號、其餘文字不變。
    - 前綴外來數字 "5 4111 1111 1111 1111"、"5 371449635398431"(Amex)→ 整段遮罩
      (含前綴數字),不漏任何卡號位。
    - 電話 "0912345678"(10 位)、訂單號 "1000001"(位數不足)、電話帶連字號
      "0912-345-678" → 不遮(無 13+ 位有效視窗)。
    - Luhn 不過但內嵌有效視窗的 16 位 "1234 5678 9012 3456"、連續長串
      "184111111111111111" → 安全優先遮罩(誤遮可接受,不漏卡優先)。
    """
    if not text:
        return text

    def _sub(m: re.Match) -> str:
        raw = m.group(0)
        digits = re.sub(r"\D", "", raw)
        n = len(digits)
        if n < 13:
            return raw
        # 常見情形:整段恰為 13–16 位且 Luhn 通過 → 遮成保留末 4 碼。
        if 13 <= n <= 16 and _luhn_ok(digits):
            return _mask_digits(digits)
        # 邊界情形:整段位數 >16,或含一位「外來數字」使整段 Luhn 不過(如
        # "5 371449635398431" —— 前綴 5 + 15 位 Amex)。此時掃描是否內嵌任一
        # 13–16 位的 Luhn 有效視窗;命中即把整段數字全部遮罩(安全優先,絕不
        # 讓任何卡號位數外露),分隔符原樣保留。非卡號長數字串(無有效視窗)不動。
        for length in range(16, 12, -1):
            if length > n:
                continue
            for start in range(0, n - length + 1):
                if _luhn_ok(digits[start : start + length]):
                    return "".join("•" if c.isdigit() else c for c in raw)
        return raw  # 無任何有效卡號視窗:視為一般數字,原樣保留

    return _CARD_CANDIDATE_RE.sub(_sub, text)


def _mask_card_meta(meta: dict | None) -> dict | None:
    """對 card 型訊息的 ``meta.card`` 內「承載文字」欄位套卡號遮罩,回傳新 dict。

    不就地改動呼叫端傳入的 meta / card(避免污染 realtime、webhook 等共用參照),
    而是淺拷貝出遮罩後的副本。遮罩範圍(對齊卡片契約 meta.card =
    {title?, text?, image_url?, buttons:[{label, url?|reply?}]}):
    - ``title`` / ``text``:卡片主體可讀文字。
    - ``content``:少數卡片可能放的可讀回退文字(存在才處理,防禦性)。
    - ``buttons[].label``:按鈕顯示文字。
    URL 類欄位(``image_url`` / button ``url``)與 button ``reply``(快捷回覆 payload)
    及其他結構欄位一律不動,只處理會顯示給人看的文字。meta 非 dict 或無合法 card
    物件時原樣回傳(呼叫端行為不變)。
    """
    if not isinstance(meta, dict):
        return meta
    single = meta.get("card")
    cards = meta.get("cards")
    has_single = isinstance(single, dict)
    has_carousel = isinstance(cards, list)
    if not has_single and not has_carousel:
        return meta
    new_meta = dict(meta)
    # 單卡:meta.card
    if has_single:
        new_meta["card"] = _mask_single_card(single)
    # 輪播:meta.cards = [card, ...](逐張遮罩,非 dict 原樣保留)
    if has_carousel:
        new_meta["cards"] = [
            _mask_single_card(c) if isinstance(c, dict) else c for c in cards
        ]
    return new_meta


def _mask_single_card(card: dict) -> dict:
    """對單張卡片的承載文字欄位(title/text/content/buttons[].label)套卡號遮罩,
    回傳淺拷貝的新 dict;URL 類與 reply payload 不動。"""
    new_card = dict(card)
    for field in ("title", "text", "content"):
        val = new_card.get(field)
        if isinstance(val, str):
            new_card[field] = mask_card_numbers(val)
    buttons = new_card.get("buttons")
    if isinstance(buttons, list):
        masked_buttons: list = []
        for b in buttons:
            if isinstance(b, dict):
                nb = dict(b)
                label = nb.get("label")
                if isinstance(label, str):
                    nb["label"] = mask_card_numbers(label)
                masked_buttons.append(nb)
            else:
                masked_buttons.append(b)
        new_card["buttons"] = masked_buttons
    return new_card


async def _emit_automation(
    db: AsyncSession, tenant_id: uuid.UUID, event: str, context: dict
) -> None:
    """觸發自動化規則引擎(M 自動化)。以延遲 import 取用,失敗一律降級不影響主流程。

    emit_event 本身已全程 try/except 降級,此處再包一層以確保連 import 失敗
    (模組未就緒)也不會波及會話核心流程。
    """
    try:
        from app.services import automation

        await automation.emit_event(db, tenant_id, event, context)
    except Exception:  # 自動化為加值層,任何失敗(含 import)都不影響主流程
        logger.warning("automation emit_event 失敗(event=%s)", event, exc_info=True)


async def _deliver_webhook(
    db: AsyncSession, tenant_id: uuid.UUID, event: str, payload: dict
) -> None:
    """派送對外 Webhook(對外整合)。以延遲 import 取用,失敗一律降級不影響主流程。

    與 _emit_automation 並存、互不影響:deliver_event 本身已全程 try/except 降級,
    此處再包一層以確保連 import 失敗(模組未就緒)也不會波及會話核心流程。
    """
    try:
        from app.services import webhooks

        await webhooks.deliver_event(db, tenant_id, event, payload)
    except Exception:  # webhook 為加值層,任何失敗(含 import)都不影響主流程
        logger.warning("webhook deliver_event 失敗(event=%s)", event, exc_info=True)


async def get_or_open_session(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    channel_id: uuid.UUID,
    visitor_id: uuid.UUID,
) -> Session:
    """取得該訪客在該渠道當前未結束的會話;沒有則開一個新的(預設 AI 接手)。

    回傳的 Session 已 flush(具備 id),但由呼叫端決定何時 commit。
    新開會話會對坐席工作台頻道發 ``session.opened`` 事件。
    """
    existing = (
        await db.execute(
            select(Session).where(
                Session.tenant_id == tenant_id,
                Session.channel_id == channel_id,
                Session.visitor_id == visitor_id,
                Session.status != "closed",
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    session = Session(
        tenant_id=tenant_id,
        channel_id=channel_id,
        visitor_id=visitor_id,
        status="open",
        handler_type="ai",  # 預設先由 AI 接待,之後可 handoff 給人工
    )
    db.add(session)
    await db.flush()

    await realtime.publish_agents(
        tenant_id,
        realtime.make_event(
            "session.opened",
            {
                "session_id": str(session.id),
                "channel_id": str(channel_id),
                "visitor_id": str(visitor_id),
                "status": session.status,
            },
        ),
    )

    # 自動化事件:新會話建立(emit 失敗不影響開會話)
    await _emit_automation(
        db,
        tenant_id,
        "session.created",
        {
            "session_id": str(session.id),
            "channel_id": str(channel_id),
            "visitor_id": str(visitor_id),
        },
    )

    # 對外 Webhook:新會話建立(派送失敗不影響開會話)
    await _deliver_webhook(
        db,
        tenant_id,
        "conversation.created",
        {
            "session_id": str(session.id),
            "channel_id": str(channel_id),
            "visitor_id": str(visitor_id),
            "status": session.status,
            "handler_type": session.handler_type,
        },
    )
    return session


async def add_message(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    session_id: uuid.UUID,
    sender_type: str,
    content: str,
    *,
    sender_id: uuid.UUID | None = None,
    content_type: str = "text",
    meta: dict | None = None,
) -> Message:
    """在會話中寫入一則訊息,更新會話活躍時間,並經 realtime 推送。

    - sender_type: visitor | ai | human | system
    - 會對會話頻道發 ``message.new``,並對坐席頻道發 ``session.activity``。
    呼叫端須確保 session 屬於該租戶(本函式亦以 tenant_id 過濾載入)。
    """
    # content_type 白名單(縱深防禦):訪客可控此欄,限制在已知安全型別,
    # 未知型別一律降為純文字,避免被導向非預期的渲染分支。
    if content_type not in ("text", "markdown", "image", "file", "card", "system"):
        content_type = "text"

    # 信用卡號遮罩(縱深防禦 / 合規):對**所有承載文字的內容**偵測卡號並只留末 4 碼。
    # 訪客可能直接貼卡號、真人 / AI 回覆亦可能複述,且 content_type 由訪客可控——不能只靠
    # 型別 gate,否則訪客改送 content_type=card(或 image/file)即可讓完整卡號明文落庫:
    # - text / markdown:對 content 遮罩(既有行為)。
    # - card:content(可讀回退)照樣遮罩,並額外對 meta.card 內文字欄位
    #   (title / text / 按鈕 label / 可讀回退 content)遮罩;URL 不動。
    # - 其餘型別(image / file / system):對 content(可讀文字 / 檔名)遮罩即可(URL 不動)。
    # 不分 sender_type 一律套用(system 內部訊息多為固定字串,遮罩為 no-op,不影響)。
    # 遮罩後的 content / meta 會一致地用於落庫、realtime 推送與對外 webhook(不外洩原始卡號)。
    content = mask_card_numbers(content)
    if content_type == "card":
        meta = _mask_card_meta(meta)

    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        raise ValueError("session not found")

    message = Message(
        tenant_id=tenant_id,
        session_id=session_id,
        sender_type=sender_type,
        sender_id=sender_id,
        content_type=content_type,
        content=content,
        meta=meta,
    )
    db.add(message)
    # 更新最後訊息時間,供列表依活躍度排序
    session.last_message_at = datetime.now(timezone.utc)
    await db.flush()

    payload = {
        "session_id": str(session_id),
        "message_id": str(message.id),
        "sender_type": sender_type,
        "sender_id": str(sender_id) if sender_id else None,
        "content_type": content_type,
        "content": content,
        "meta": meta,
    }
    await realtime.publish(tenant_id, session_id, realtime.make_event("message.new", payload))
    await realtime.publish_agents(
        tenant_id,
        realtime.make_event(
            "session.activity",
            {"session_id": str(session_id), "last_message_at": session.last_message_at.isoformat()},
        ),
    )

    # 自動化事件:訪客訊息(僅 visitor;emit 失敗不影響寫訊)。
    # 注意:auto_reply 動作走 channel_out 不經 add_message,不會再觸發本事件成環。
    if sender_type == "visitor":
        await _emit_automation(
            db,
            tenant_id,
            "message.visitor",
            {
                "session_id": str(session_id),
                "visitor_id": str(sender_id) if sender_id else None,
                "content": content,
                "content_type": content_type,
                "channel_id": str(session.channel_id),
            },
        )

    # 對外 Webhook:新訊息(任一 sender_type;派送失敗不影響寫訊)。
    # webhook 為對外 HTTP 外送,不經 add_message,不會成環。
    await _deliver_webhook(
        db,
        tenant_id,
        "message.created",
        {
            "session_id": str(session_id),
            "message_id": str(message.id),
            "sender_type": sender_type,
            "sender_id": str(sender_id) if sender_id else None,
            "content_type": content_type,
            "content": content,
            "channel_id": str(session.channel_id),
        },
    )
    return message


async def close_session(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    session_id: uuid.UUID,
    *,
    closed_by: uuid.UUID | None = None,
) -> Session:
    """結束會話:status=closed、記錄 closed_at,寫一則 system 訊息並推送事件。"""
    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        raise ValueError("session not found")

    session.status = "closed"
    session.closed_at = datetime.now(timezone.utc)

    # 以 system 訊息留下結束軌跡
    db.add(
        Message(
            tenant_id=tenant_id,
            session_id=session_id,
            sender_type="system",
            sender_id=closed_by,
            content_type="text",
            content="會話已結束",
            meta={"event": "session.closed", "closed_by": str(closed_by) if closed_by else None},
        )
    )
    await db.flush()

    event = realtime.make_event(
        "session.closed",
        {
            "session_id": str(session_id),
            "closed_by": str(closed_by) if closed_by else None,
            "closed_at": session.closed_at.isoformat(),
        },
    )
    await realtime.publish(tenant_id, session_id, event)
    await realtime.publish_agents(tenant_id, event)

    # 自動化事件:會話結束(emit 失敗不影響結案)
    await _emit_automation(
        db,
        tenant_id,
        "session.closed",
        {
            "session_id": str(session_id),
            "closed_by": str(closed_by) if closed_by else None,
        },
    )

    # 對外 Webhook:會話結束(派送失敗不影響結案)
    await _deliver_webhook(
        db,
        tenant_id,
        "conversation.closed",
        {
            "session_id": str(session_id),
            "closed_by": str(closed_by) if closed_by else None,
            "closed_at": session.closed_at.isoformat(),
        },
    )
    return session
