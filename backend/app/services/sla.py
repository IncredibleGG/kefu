"""SLA 服務層:純函式(due 計算 / 條件匹配 / 狀態判定)+ 掃描器 + 單會話查詢。

**自成一體**:不依賴 conversation.py 的 hook。scan() 由外部排程器定時呼叫,
掃描各租戶「未結案(open/queued)」會話,依既有 session/message 時間推導首回應與
解決狀態,upsert SLATracking;對「新出現的違約」發 realtime ``sla.breach`` 通知,
並(可選)呼叫 automation.emit_event 供自動化規則接續。

跨模組副作用(realtime / automation)一律 try/except 降級,scan 不因外部未就緒而中斷。

時間比較一律轉為 UTC-aware(_aware):pg 存 tz-aware、sqlite 存 naive,統一後可安全比較。
"""
from __future__ import annotations

import logging
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from importlib import import_module
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Channel, Message, Session
from app.models.sla import SLAPolicy, SLATracking
from app.models.tag import Tag, TagRelation
from app.models.ticket import Ticket

logger = logging.getLogger("kefu.sla")

# 已用時間比例達此門檻(且尚未達成)即視為 at_risk(接近時限)
AT_RISK_RATIO = 0.8

# 首回應由「第一則 human/ai 訊息」判定
_RESPONDER_TYPES = ("human", "ai")
# 會話未結案狀態
_OPEN_STATUSES = ("open", "queued")

# --- 工單 SLA ---
# 工單未結清狀態(仍需處理、可能逾期);resolved/closed 視為已解決
_TICKET_OPEN_STATUSES = ("open", "pending")
# 工單「已解決」狀態(供推導 resolved_at)
_TICKET_RESOLVED_STATUSES = ("resolved", "closed")
# 工單「等待客戶」狀態:auto-pause helper 據此自動停表(等客戶回覆時停 SLA 時鐘)
_TICKET_WAITING_STATUSES = ("pending",)


def _policy_target(policy: SLAPolicy) -> str:
    """政策套用目標型別;缺欄/None → session(向後相容)。"""
    return getattr(policy, "target_type", None) or "session"

# 週一~週日對應 datetime.weekday()(Monday=0);對齊 settings.business_hours["days"] 的鍵
# (刻意複製 settings.py 的最小解析邏輯,避免 import fastapi 路由大模組)
_WEEKDAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
# 營業時間往後累計的安全上限(天):避免 business_hours 完全無營業時段時無限迴圈
_BIZ_SCAN_MAX_DAYS = 400


# --------------------------------------------------------------------------- #
# 時間工具
# --------------------------------------------------------------------------- #
def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    """把 naive datetime 視為 UTC,回 tz-aware;None 原樣回。"""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


# --------------------------------------------------------------------------- #
# 純函式:期限計算與狀態判定(可直接單元測試,不碰 DB)
# --------------------------------------------------------------------------- #
# --------------------------------------------------------------------------- #
# 營業時間解析(複製 settings.py 的最小必要邏輯,不 import fastapi 路由模組)
# --------------------------------------------------------------------------- #
def _parse_hhmm(value: Any) -> time | None:
    """"HH:MM" → datetime.time;格式錯誤回 None。"""
    try:
        hh, mm = str(value).split(":")
        return time(hour=int(hh), minute=int(mm))
    except (ValueError, AttributeError, TypeError):
        return None


def _resolve_tz(name: str | None) -> ZoneInfo:
    """IANA 時區名 → ZoneInfo;缺省或無效 → UTC。"""
    try:
        return ZoneInfo(name) if name else ZoneInfo("UTC")
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return ZoneInfo("UTC")


def _biz_days_map(business_hours: Any) -> dict | None:
    """取出 business_hours["days"] 每日時段表。

    無效 / 無 days(視為全天候 24x7)→ 回 None,呼叫端據此退回連續計時。
    """
    if not business_hours or not isinstance(business_hours, dict):
        return None
    days = business_hours.get("days")
    if not isinstance(days, dict) or not days:
        return None
    return days


def _day_intervals(local_date, days_map: dict, tz: ZoneInfo) -> list[tuple[datetime, datetime]]:
    """以 local_date 為「起始日」的營業時段清單:list[(start_dt, end_dt)](tz-aware、已排序)。

    - end > start:當日時段。
    - end < start:跨午夜,結束時刻落在隔日(對齊 settings.compute_is_online 的跨午夜語義)。
    - end == start:0 長度,略過。
    """
    key = _WEEKDAY_KEYS[local_date.weekday()]
    out: list[tuple[datetime, datetime]] = []
    for rng in days_map.get(key) or []:
        if not isinstance(rng, (list, tuple)) or len(rng) != 2:
            continue
        s, e = _parse_hhmm(rng[0]), _parse_hhmm(rng[1])
        if s is None or e is None:
            continue
        start_dt = datetime.combine(local_date, s, tzinfo=tz)
        if e > s:
            end_dt = datetime.combine(local_date, e, tzinfo=tz)
        elif e < s:
            end_dt = datetime.combine(local_date + timedelta(days=1), e, tzinfo=tz)
        else:
            continue  # 0 長度時段
        out.append((start_dt, end_dt))
    out.sort()
    return out


def _business_due(
    start: datetime, minutes: int, days_map: dict, tz: ZoneInfo
) -> datetime | None:
    """從 start 起,只累計「營業時間」滿 minutes 分鐘後所落在的實際時刻(UTC-aware)。

    非營業時段(夜間 / 週末 / 休息)不計入時鐘,跨過時把時鐘「跳」到下一段營業開始。
    若在安全上限天數內都湊不滿(通常代表 business_hours 完全無營業時段),回 None,
    交由 compute_due 退回連續計時。
    """
    remaining = timedelta(minutes=minutes)
    if remaining <= timedelta(0):
        return start.astimezone(timezone.utc)
    start_local = start.astimezone(tz)
    # 從「前一天」起掃,以涵蓋昨日跨午夜延續至今日凌晨的時段
    cur_date = start_local.date() - timedelta(days=1)
    cursor = start_local  # 已累計到的時間游標(僅前進、不倒退,防重疊時段重複計算)
    for _ in range(_BIZ_SCAN_MAX_DAYS):
        for i_start, i_end in _day_intervals(cur_date, days_map, tz):
            if i_end <= start_local:
                continue
            seg_start = max(i_start, cursor)
            if seg_start >= i_end:
                continue
            seg_len = i_end - seg_start
            if seg_len >= remaining:
                return (seg_start + remaining).astimezone(timezone.utc)
            remaining -= seg_len
            cursor = i_end
        cur_date += timedelta(days=1)
    return None


# --------------------------------------------------------------------------- #
# 期限計算
# --------------------------------------------------------------------------- #
def compute_due(
    created_at: datetime | None,
    minutes: int | None,
    business_hours: dict | None = None,
    tz_name: str | None = None,
) -> datetime | None:
    """SLA 到期時刻。

    - **無 business_hours(或全天候 24x7)** → 連續掛鐘計時 ``created_at + minutes``
      (預設行為,零回歸)。
    - **有營業時間設定** → 從 created_at 起「只累計營業時間」滿 minutes 分鐘後的實際時刻;
      非營業時段不計入 SLA 時鐘(對齊 LiveChat business-hours SLA)。時區取
      ``business_hours["timezone"]`` 或 ``tz_name``,無效 → UTC。若 business_hours 完全
      無可用營業時段,安全退回連續計時。

    任一必要輸入為 None 則回 None。
    """
    if created_at is None or minutes is None:
        return None
    start = _aware(created_at)
    days_map = _biz_days_map(business_hours)
    if days_map is None:
        # 未設營業時間 / 全天候 → 連續計時(零回歸)
        return start + timedelta(minutes=minutes)
    bh_tz = business_hours.get("timezone") if isinstance(business_hours, dict) else None
    tz = _resolve_tz(bh_tz or tz_name)
    due = _business_due(start, minutes, days_map, tz)
    if due is None:
        # business_hours 無任何可用營業時段 → 安全退回連續計時
        return start + timedelta(minutes=minutes)
    return due


def match_conditions(conditions: dict | None, ctx: dict[str, Any]) -> bool:
    """判斷會話情境 ctx 是否命中規則條件 conditions。

    - conditions 空 / None → 命中全部(回 True)。
    - 每個 (key, expected):expected 可為純量或列表。
        * ctx[key] 為列表(如 tags)→ 只要 expected 任一值落在該列表即命中該鍵。
        * ctx[key] 為純量 → 相等、或(expected 為列表時)落在列表中即命中。
    - conditions 指定了 ctx 沒有的鍵 → 視為不命中(保守:避免規則誤套)。
    """
    if not conditions:
        return True
    for key, expected in conditions.items():
        if key not in ctx:
            return False
        actual = ctx[key]
        expected_list = expected if isinstance(expected, (list, tuple, set)) else [expected]
        if isinstance(actual, (list, tuple, set)):
            if not any(e in actual for e in expected_list):
                return False
        else:
            if actual not in expected_list:
                return False
    return True


def pick_policy(policies: Iterable[SLAPolicy], ctx: dict[str, Any]) -> SLAPolicy | None:
    """在(已啟用)規則中,依 priority 由高到低取第一條命中者。"""
    ordered = sorted(policies, key=lambda p: (p.priority or 0), reverse=True)
    for p in ordered:
        if match_conditions(p.conditions, ctx):
            return p
    return None


def _dim_state(
    due: datetime | None,
    actual: datetime | None,
    now: datetime,
    created_at: datetime | None,
    at_risk_ratio: float,
) -> str:
    """單一維度(首回應 or 解決)狀態:none|met|breached|at_risk|on_track。"""
    due = _aware(due)
    if due is None:
        return "none"
    actual = _aware(actual)
    now = _aware(now)
    if actual is not None:
        return "breached" if actual > due else "met"
    # 尚未達成
    if now > due:
        return "breached"
    created_at = _aware(created_at)
    if created_at is not None:
        total = (due - created_at).total_seconds()
        used = (now - created_at).total_seconds()
        if total > 0 and used / total >= at_risk_ratio:
            return "at_risk"
    return "on_track"


@dataclass
class SLAEval:
    """一次評估的結果(純資料,供掃描器落庫與前端顯示)。"""

    status: str
    breached_first: bool
    breached_resolution: bool
    first_state: str
    resolution_state: str


def evaluate(
    *,
    created_at: datetime | None,
    first_response_due: datetime | None,
    resolution_due: datetime | None,
    first_response_at: datetime | None,
    resolved_at: datetime | None,
    now: datetime | None = None,
    at_risk_ratio: float = AT_RISK_RATIO,
) -> SLAEval:
    """綜合首回應與解決兩維度,推導整體 SLA 狀態與違約旗標。

    整體狀態優先序:任一維度 breached → breached;否則已結案(resolved_at 有值)
    且無違約 → met;否則任一維度 at_risk → at_risk;否則 on_track。
    """
    now = _aware(now) or _utcnow()
    first_state = _dim_state(first_response_due, first_response_at, now, created_at, at_risk_ratio)
    res_state = _dim_state(resolution_due, resolved_at, now, created_at, at_risk_ratio)
    breached_first = first_state == "breached"
    breached_resolution = res_state == "breached"
    states = {first_state, res_state}
    if "breached" in states:
        status = "breached"
    elif resolved_at is not None:
        status = "met"
    elif "at_risk" in states:
        status = "at_risk"
    else:
        status = "on_track"
    return SLAEval(status, breached_first, breached_resolution, first_state, res_state)


def _remaining_seconds(due: datetime | None, ref: datetime | None, now: datetime) -> int | None:
    """距期限剩餘秒數;已達成(ref 有值)以 ref 計、否則以 now 計。負值=已逾時。"""
    due = _aware(due)
    if due is None:
        return None
    base = _aware(ref) or _aware(now)
    return int((due - base).total_seconds())


# --------------------------------------------------------------------------- #
# 純函式:SLA 暫停(等待客戶時停表)——「停表」語義,可直接單元測試,不碰 DB
# --------------------------------------------------------------------------- #
# 模型:
#   * paused_total_seconds(P):已完成暫停的累計秒數。
#   * paused_at:目前正在進行的暫停起點(None = 未暫停)。
# 「停表」以兩件事合成,兩者相加即等效「時鐘在暫停期間不前進、期限往後推」:
#   1) 期限外推:effective_due = base_due + P(把已完成暫停時間加回到期限)。
#   2) 評估時鐘凍結:暫停中把 now 凍結在 paused_at(目前這段暫停不推進)。
# 於是暫停期間 remaining/狀態完全凍結;恢復瞬間 P 併入這段長度、now 解凍,remaining 連續不跳變。
def paused_seconds(
    paused_at: datetime | None,
    paused_total_seconds: int | None,
    now: datetime | None = None,
) -> int:
    """總暫停秒數 = 已完成累計 P +(暫停中則含目前這段 now - paused_at)。

    純供顯示/遙測;due/remaining 的實際扣除由 effective_due + frozen_now 合成。
    時鐘倒退等異常夾為 0。
    """
    total = int(paused_total_seconds or 0)
    pa = _aware(paused_at)
    if pa is not None:
        ref = _aware(now) or _utcnow()
        total += max(0, int((ref - pa).total_seconds()))
    return total


def effective_due(base_due: datetime | None, *, paused_total_seconds: int | None) -> datetime | None:
    """把「已完成暫停」秒數加回到基準期限:effective_due = base_due + P。

    只加 P(已完成暫停);目前進行中的那段由 frozen_now 凍結時鐘表示,兩者不重複計入。
    base_due=None(未設限)原樣回。
    """
    base_due = _aware(base_due)
    if base_due is None:
        return None
    return base_due + timedelta(seconds=max(0, int(paused_total_seconds or 0)))


def frozen_now(now: datetime | None, *, paused_at: datetime | None) -> datetime:
    """評估時鐘:暫停中凍結在暫停起點 paused_at,否則用 now。"""
    pa = _aware(paused_at)
    if pa is not None:
        return pa
    return _aware(now) or _utcnow()


def begin_pause(*, paused_at: datetime | None, now: datetime | None = None) -> datetime:
    """開始暫停 → 回新的 paused_at。已在暫停中則保留原起點(冪等,不重置累計)。"""
    return _aware(paused_at) or (_aware(now) or _utcnow())


def end_pause(
    *, paused_at: datetime | None, paused_total_seconds: int | None, now: datetime | None = None
) -> tuple[None, int]:
    """結束暫停 → 回 (None, 新累計):把本段暫停時長併入 paused_total_seconds。

    未在暫停中(paused_at=None)則原樣回 (None, 原累計)(冪等)。
    """
    total = int(paused_total_seconds or 0)
    pa = _aware(paused_at)
    if pa is None:
        return (None, total)
    ref = _aware(now) or _utcnow()
    return (None, total + max(0, int((ref - pa).total_seconds())))


@dataclass
class PausedDue:
    """套用暫停後、可直接餵入 evaluate / _remaining_seconds 的期限與評估時鐘。"""

    first_response_due: datetime | None
    resolution_due: datetime | None
    eval_now: datetime


def apply_pause(
    *,
    first_response_due: datetime | None,
    resolution_due: datetime | None,
    paused_at: datetime | None,
    paused_total_seconds: int | None,
    now: datetime,
) -> PausedDue:
    """把暫停(停表)套到兩維度期限與評估時鐘上。

    未暫停且無累計(paused_at=None、P=0)→ 期限與 now 原樣不變(零回歸)。
    """
    p = int(paused_total_seconds or 0)
    return PausedDue(
        first_response_due=effective_due(first_response_due, paused_total_seconds=p),
        resolution_due=effective_due(resolution_due, paused_total_seconds=p),
        eval_now=frozen_now(now, paused_at=paused_at),
    )


# --------------------------------------------------------------------------- #
# 跨模組副作用(降級)
# --------------------------------------------------------------------------- #
def _optional(module_path: str, attr: str):
    try:
        mod = import_module(module_path)
    except Exception:  # noqa: BLE001
        return None
    return getattr(mod, attr, None)


async def _notify_breach(tenant_id: uuid.UUID, payload: dict) -> None:
    """發 realtime ``sla.breach`` 到租戶坐席頻道;失敗僅記 log 不中斷掃描。"""
    publish_agents = _optional("app.services.realtime", "publish_agents")
    make_event = _optional("app.services.realtime", "make_event")
    if publish_agents is None:
        return
    evt = make_event("sla.breach", payload) if make_event else {"type": "sla.breach", "payload": payload}
    try:
        await publish_agents(tenant_id, evt)
    except Exception:  # noqa: BLE001
        logger.warning("realtime publish_agents(sla.breach) 失敗", exc_info=True)


async def _emit_automation(db: AsyncSession, tenant_id: uuid.UUID, ctx: dict) -> None:
    """可選:觸發自動化事件 sla.breach。automation 未就緒則略過。"""
    emit = _optional("app.services.automation", "emit_event")
    if emit is None:
        return
    try:
        await emit(db, tenant_id, "sla.breach", ctx)
    except Exception:  # noqa: BLE001
        logger.warning("automation.emit_event(sla.breach) 失敗", exc_info=True)


# --------------------------------------------------------------------------- #
# DB 輔助:批次取上下文(channel_type / tags / first_response_at)
# --------------------------------------------------------------------------- #
async def _channel_types(db: AsyncSession, channel_ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not channel_ids:
        return {}
    rows = (
        await db.execute(select(Channel.id, Channel.type).where(Channel.id.in_(channel_ids)))
    ).all()
    return {cid: ctype for cid, ctype in rows}


async def _session_tags(
    db: AsyncSession, tenant_id: uuid.UUID, session_ids: set[uuid.UUID]
) -> dict[uuid.UUID, list[str]]:
    if not session_ids:
        return {}
    rows = (
        await db.execute(
            select(TagRelation.target_id, Tag.name)
            .join(Tag, Tag.id == TagRelation.tag_id)
            .where(
                TagRelation.tenant_id == tenant_id,
                TagRelation.target_type == "session",
                TagRelation.target_id.in_(session_ids),
            )
        )
    ).all()
    out: dict[uuid.UUID, list[str]] = {}
    for sid, name in rows:
        out.setdefault(sid, []).append(name)
    return out


async def _first_response_map(
    db: AsyncSession, tenant_id: uuid.UUID, session_ids: set[uuid.UUID]
) -> dict[uuid.UUID, datetime]:
    """每會話第一則 human/ai 訊息時間。"""
    if not session_ids:
        return {}
    rows = (
        await db.execute(
            select(Message.session_id, func.min(Message.created_at))
            .where(
                Message.tenant_id == tenant_id,
                Message.session_id.in_(session_ids),
                Message.sender_type.in_(_RESPONDER_TYPES),
            )
            .group_by(Message.session_id)
        )
    ).all()
    return {sid: ts for sid, ts in rows if ts is not None}


async def _load_business_hours(
    db: AsyncSession,
) -> dict[uuid.UUID, tuple[dict | None, str | None]]:
    """預取各租戶 business_hours + timezone,回 {tenant_id: (business_hours, timezone)}。

    **防禦式降級**:TenantSettings 模組/表不可用(如精簡測試環境未建 tenant_settings 表)
    或查詢失敗時,rollback 重置 session 並回空 dict → 各會話退回連續計時(compute_due),
    確保零回歸。不 import 大模組,僅動態取模型。
    """
    tenant_settings = _optional("app.models.settings", "TenantSettings")
    if tenant_settings is None:
        return {}
    try:
        rows = (
            await db.execute(
                select(
                    tenant_settings.tenant_id,
                    tenant_settings.business_hours,
                    tenant_settings.timezone,
                ).where(tenant_settings.deleted_at.is_(None))
            )
        ).all()
    except Exception:  # noqa: BLE001  缺表 / DB 未就緒 → 降級為連續計時
        logger.warning("讀取 TenantSettings.business_hours 失敗,SLA 退回連續計時", exc_info=True)
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return {}
    return {tid: (bh, tz) for tid, bh, tz in rows}


async def _tenant_business_hours(
    db: AsyncSession, tenant_id: uuid.UUID
) -> tuple[dict | None, str | None]:
    """單租戶 business_hours + timezone;不可用 → (None, None)(退回連續計時)。防禦式同上。"""
    tenant_settings = _optional("app.models.settings", "TenantSettings")
    if tenant_settings is None:
        return (None, None)
    try:
        row = (
            await db.execute(
                select(tenant_settings.business_hours, tenant_settings.timezone).where(
                    tenant_settings.tenant_id == tenant_id,
                    tenant_settings.deleted_at.is_(None),
                )
            )
        ).first()
    except Exception:  # noqa: BLE001
        logger.warning("讀取 TenantSettings.business_hours 失敗,SLA 退回連續計時", exc_info=True)
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return (None, None)
    if row is None:
        return (None, None)
    return (row[0], row[1])


def _build_ctx(session: Session, channel_type: str | None, tags: list[str]) -> dict[str, Any]:
    """組會話匹配上下文;鍵名對齊 SLAPolicy.conditions 可用鍵。"""
    ctx: dict[str, Any] = {
        "status": session.status,
        "handler_type": session.handler_type,
    }
    if channel_type is not None:
        ctx["channel_type"] = channel_type
    # tag / tags 皆可作為條件鍵(值為該會話標籤名列表)
    ctx["tag"] = tags
    ctx["tags"] = tags
    return ctx


def _build_ticket_ctx(ticket: Ticket) -> dict[str, Any]:
    """組工單匹配上下文;鍵名對齊 SLAPolicy.conditions 可用鍵。

    工單無 channel;可依 status / priority / tag(工單自帶 tags JSONB 字串陣列)/
    是否已指派(assigned)匹配。
    """
    tags = [t for t in (ticket.tags or []) if isinstance(t, str)]
    return {
        "status": ticket.status,
        "priority": ticket.priority,
        "assigned": ticket.assignee_staff_id is not None,
        "tag": tags,
        "tags": tags,
    }


def _ticket_resolved_at(ticket: Ticket) -> datetime | None:
    """工單「解決」時刻:resolved_at 優先,否則 closed_at(closed 亦視為已解決)。"""
    return ticket.resolved_at or ticket.closed_at


def _ticket_responded(ticket: Ticket) -> bool:
    """工單是否已「首回應」:已指派坐席,或狀態已離開 open(進入處理/已解決)。

    工單無訊息流水,故以「有人接手」作為首回應代理信號(對齊 LiveChat 工單首回應語義)。
    """
    return ticket.assignee_staff_id is not None or ticket.status in (
        "pending",
        "resolved",
        "closed",
    )


def _ticket_first_response_at(
    ticket: Ticket, existing_first_at: datetime | None, now: datetime
) -> datetime | None:
    """推導工單首回應達成時刻。

    - 追蹤列已記錄過(existing_first_at)→ 維持不動(黏著,避免每次掃描漂移)。
    - 尚未記錄但已回應 → 以掃描當下 now 記錄;若工單已解決且解決早於 now,取解決時刻
      (首回應不晚於解決)。
    - 尚未回應 → None(首回應仍待辦,可能違約)。

    取捨:工單無逐則訊息時間,首回應時刻以掃描器首次觀察到「已接手」時落點近似,
    最多落後一個掃描週期。
    """
    if existing_first_at is not None:
        return existing_first_at
    if not _ticket_responded(ticket):
        return None
    resolved_at = _aware(_ticket_resolved_at(ticket))
    now = _aware(now)
    if resolved_at is not None and resolved_at < now:
        return resolved_at
    return now


# --------------------------------------------------------------------------- #
# 掃描器(外部排程器定時呼叫)
# --------------------------------------------------------------------------- #
async def scan(db: AsyncSession, now: datetime | None = None) -> dict[str, Any]:
    """掃描各租戶未結案會話 + 收尾已結案但未定案的追蹤,upsert SLATracking。

    回統計摘要 dict。新違約會發 realtime 通知並(可選)觸發 automation。
    掃描本身不 commit;由呼叫端(排程器)決定交易邊界。
    """
    now = _aware(now) or _utcnow()
    stats = {
        "scanned": 0,
        "matched": 0,
        "tracked": 0,
        "at_risk": 0,
        "breached": 0,
        "met": 0,
        "new_breaches": 0,
        "policies": 0,
    }

    # 營業時間感知:預取各租戶 business_hours(缺表/失敗即降級為連續計時)。
    # 置於最前(尚無任何寫入),萬一查詢失敗需 rollback 也不影響後續載入。
    biz_by_tenant = await _load_business_hours(db)

    # 載入所有啟用規則,按租戶分組
    policies = (
        await db.execute(
            select(SLAPolicy).where(
                SLAPolicy.is_active.is_(True), SLAPolicy.deleted_at.is_(None)
            )
        )
    ).scalars().all()
    stats["policies"] = len(policies)
    # 依租戶 + 目標型別分組:會話只套 session 政策、工單只套 ticket 政策
    by_tenant: dict[uuid.UUID, list[SLAPolicy]] = {}
    ticket_by_tenant: dict[uuid.UUID, list[SLAPolicy]] = {}
    for p in policies:
        if _policy_target(p) == "ticket":
            ticket_by_tenant.setdefault(p.tenant_id, []).append(p)
        else:
            by_tenant.setdefault(p.tenant_id, []).append(p)

    # 掃描對象:①未結案 open/queued ②已結案但既有追蹤尚未定案(resolved_at 為空)→ 收尾
    inflight = (
        await db.execute(
            select(Session).where(
                Session.status.in_(_OPEN_STATUSES), Session.deleted_at.is_(None)
            )
        )
    ).scalars().all()
    pending_close = (
        await db.execute(
            select(Session)
            .join(SLATracking, SLATracking.session_id == Session.id)
            .where(
                Session.status == "closed",
                Session.deleted_at.is_(None),
                SLATracking.resolved_at.is_(None),
            )
        )
    ).scalars().all()

    sessions = list(inflight) + list(pending_close)
    stats["scanned"] += len(sessions)

    breach_events: list[tuple[uuid.UUID, dict]] = []

    if sessions:
        # 批次預取上下文
        session_ids = {s.id for s in sessions}
        channel_ids = {s.channel_id for s in sessions}
        ch_types = await _channel_types(db, channel_ids)
        # tags / first_response 需按租戶查(tenant 隔離)
        tenants = {s.tenant_id for s in sessions}
        tags_map: dict[uuid.UUID, list[str]] = {}
        fr_map: dict[uuid.UUID, datetime] = {}
        for tid in tenants:
            sids = {s.id for s in sessions if s.tenant_id == tid}
            tags_map.update(await _session_tags(db, tid, sids))
            fr_map.update(await _first_response_map(db, tid, sids))

        # 既有追蹤索引(限 session 目標列)
        existing_rows = (
            await db.execute(
                select(SLATracking).where(
                    SLATracking.session_id.in_(session_ids),
                    SLATracking.target_type == "session",
                )
            )
        ).scalars().all()
        existing: dict[uuid.UUID, SLATracking] = {r.session_id: r for r in existing_rows}

        for s in sessions:
            tenant_policies = by_tenant.get(s.tenant_id, [])
            ctx = _build_ctx(s, ch_types.get(s.channel_id), tags_map.get(s.id, []))
            policy = pick_policy(tenant_policies, ctx)
            row = existing.get(s.id)
            if policy is None:
                # 無規則命中:不新建追蹤(既有列則保留原樣,不更動)
                continue
            stats["matched"] += 1

            bh, tz_name = biz_by_tenant.get(s.tenant_id, (None, None))
            first_due = compute_due(s.created_at, policy.first_response_minutes, bh, tz_name)
            res_due = compute_due(s.created_at, policy.resolution_minutes, bh, tz_name)
            first_at = fr_map.get(s.id)
            resolved_at = s.closed_at if s.status == "closed" else None

            # 套用暫停(停表):讀既有列的 paused_at/paused_total_seconds;無暫停 → 零回歸
            pd = apply_pause(
                first_response_due=first_due,
                resolution_due=res_due,
                paused_at=row.paused_at if row else None,
                paused_total_seconds=row.paused_total_seconds if row else 0,
                now=now,
            )
            ev = evaluate(
                created_at=s.created_at,
                first_response_due=pd.first_response_due,
                resolution_due=pd.resolution_due,
                first_response_at=first_at,
                resolved_at=resolved_at,
                now=pd.eval_now,
            )

            # 偵測「新違約」:此次為違約、而既有列尚未標記該維度
            new_first = ev.breached_first and not (row.breached_first if row else False)
            new_res = ev.breached_resolution and not (row.breached_resolution if row else False)

            if row is None:
                row = SLATracking(tenant_id=s.tenant_id, session_id=s.id, target_type="session")
                db.add(row)
                existing[s.id] = row
            row.policy_id = policy.id
            row.first_response_due = first_due
            row.resolution_due = res_due
            row.first_response_at = first_at
            row.resolved_at = resolved_at
            row.breached_first = ev.breached_first
            row.breached_resolution = ev.breached_resolution
            row.status = ev.status

            stats["tracked"] += 1
            if ev.status == "at_risk":
                stats["at_risk"] += 1
            elif ev.status == "breached":
                stats["breached"] += 1
            elif ev.status == "met":
                stats["met"] += 1

            if new_first or new_res:
                stats["new_breaches"] += 1
                breach_events.append(
                    (
                        s.tenant_id,
                        {
                            "target_type": "session",
                            "session_id": str(s.id),
                            "policy_id": str(policy.id),
                            "policy_name": policy.name,
                            "breached_first": ev.breached_first,
                            "breached_resolution": ev.breached_resolution,
                            "first_response_due": (
                                pd.first_response_due.isoformat() if pd.first_response_due else None
                            ),
                            "resolution_due": (
                                pd.resolution_due.isoformat() if pd.resolution_due else None
                            ),
                            "status": ev.status,
                        },
                    )
                )

    # 工單 SLA 掃描(僅在有 ticket 政策時觸發;缺表則防禦式降級)
    await _scan_tickets(db, now, biz_by_tenant, ticket_by_tenant, stats, breach_events)

    # 落庫後再發告警(即便通知失敗,追蹤已更新)
    await db.flush()
    for tenant_id, payload in breach_events:
        await _notify_breach(tenant_id, payload)
        await _emit_automation(db, tenant_id, payload)

    return stats


async def _scan_tickets(
    db: AsyncSession,
    now: datetime,
    biz_by_tenant: dict[uuid.UUID, tuple[dict | None, str | None]],
    ticket_by_tenant: dict[uuid.UUID, list[SLAPolicy]],
    stats: dict[str, Any],
    breach_events: list[tuple[uuid.UUID, dict]],
) -> None:
    """工單 SLA 掃描:對象 ①未結清 open/pending ②已解決但既有追蹤尚未定案 → 收尾。

    僅在該環境有 ticket 政策時執行;查 Ticket 失敗(如精簡測試環境未建 ticket 表)則
    rollback 降級並略過,不影響會話 SLA(零回歸)。
    """
    if not ticket_by_tenant:
        return
    try:
        inflight = (
            await db.execute(
                select(Ticket).where(
                    Ticket.status.in_(_TICKET_OPEN_STATUSES), Ticket.deleted_at.is_(None)
                )
            )
        ).scalars().all()
        pending_close = (
            await db.execute(
                select(Ticket)
                .join(SLATracking, SLATracking.ticket_id == Ticket.id)
                .where(
                    Ticket.status.in_(_TICKET_RESOLVED_STATUSES),
                    Ticket.deleted_at.is_(None),
                    SLATracking.resolved_at.is_(None),
                )
            )
        ).scalars().all()
    except Exception:  # noqa: BLE001  缺表 / DB 未就緒 → 降級,略過工單 SLA
        logger.warning("讀取 Ticket 失敗,略過工單 SLA 掃描", exc_info=True)
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return

    tickets = list(inflight) + list(pending_close)
    stats["scanned"] += len(tickets)
    if not tickets:
        return

    ticket_ids = {t.id for t in tickets}
    existing_rows = (
        await db.execute(
            select(SLATracking).where(
                SLATracking.ticket_id.in_(ticket_ids),
                SLATracking.target_type == "ticket",
            )
        )
    ).scalars().all()
    existing: dict[uuid.UUID, SLATracking] = {r.ticket_id: r for r in existing_rows}

    for t in tickets:
        tenant_policies = ticket_by_tenant.get(t.tenant_id, [])
        ctx = _build_ticket_ctx(t)
        policy = pick_policy(tenant_policies, ctx)
        row = existing.get(t.id)
        if policy is None:
            continue
        stats["matched"] += 1

        bh, tz_name = biz_by_tenant.get(t.tenant_id, (None, None))
        first_due = compute_due(t.created_at, policy.first_response_minutes, bh, tz_name)
        res_due = compute_due(t.created_at, policy.resolution_minutes, bh, tz_name)
        first_at = _ticket_first_response_at(t, row.first_response_at if row else None, now)
        resolved_at = _ticket_resolved_at(t)

        pd = apply_pause(
            first_response_due=first_due,
            resolution_due=res_due,
            paused_at=row.paused_at if row else None,
            paused_total_seconds=row.paused_total_seconds if row else 0,
            now=now,
        )
        ev = evaluate(
            created_at=t.created_at,
            first_response_due=pd.first_response_due,
            resolution_due=pd.resolution_due,
            first_response_at=first_at,
            resolved_at=resolved_at,
            now=pd.eval_now,
        )

        new_first = ev.breached_first and not (row.breached_first if row else False)
        new_res = ev.breached_resolution and not (row.breached_resolution if row else False)

        if row is None:
            row = SLATracking(tenant_id=t.tenant_id, ticket_id=t.id, target_type="ticket")
            db.add(row)
            existing[t.id] = row
        row.policy_id = policy.id
        row.first_response_due = first_due
        row.resolution_due = res_due
        row.first_response_at = first_at
        row.resolved_at = resolved_at
        row.breached_first = ev.breached_first
        row.breached_resolution = ev.breached_resolution
        row.status = ev.status

        stats["tracked"] += 1
        if ev.status == "at_risk":
            stats["at_risk"] += 1
        elif ev.status == "breached":
            stats["breached"] += 1
        elif ev.status == "met":
            stats["met"] += 1

        if new_first or new_res:
            stats["new_breaches"] += 1
            breach_events.append(
                (
                    t.tenant_id,
                    {
                        "target_type": "ticket",
                        "ticket_id": str(t.id),
                        "policy_id": str(policy.id),
                        "policy_name": policy.name,
                        "breached_first": ev.breached_first,
                        "breached_resolution": ev.breached_resolution,
                        "first_response_due": (
                            pd.first_response_due.isoformat() if pd.first_response_due else None
                        ),
                        "resolution_due": (
                            pd.resolution_due.isoformat() if pd.resolution_due else None
                        ),
                        "status": ev.status,
                    },
                )
            )


# --------------------------------------------------------------------------- #
# 單會話 SLA 狀態(供前端顯示倒數/狀態)
# --------------------------------------------------------------------------- #
async def status_for_session(
    db: AsyncSession, tenant_id: uuid.UUID, session_id: uuid.UUID
) -> dict[str, Any]:
    """回某會話目前 SLA 狀態與倒數。

    優先讀既有 SLATracking(掃描器結果);若尚無追蹤列,則即時比對規則計算一份
    「暫態」結果(不落庫),讓前端在首次掃描前也有東西可顯示。查無會話回 tracked=False。
    """
    now = _utcnow()
    # 先取營業時間(尚無任何載入,失敗 rollback 也不影響後續);既有追蹤列已存好 due 不需重算,
    # 僅暫態即時計算分支會用到。
    bh, tz_name = await _tenant_business_hours(db, tenant_id)
    session = (
        await db.execute(
            select(Session).where(Session.id == session_id, Session.tenant_id == tenant_id)
        )
    ).scalar_one_or_none()
    if session is None:
        return {"tracked": False, "session_id": str(session_id), "reason": "SLA_SESSION_NOT_FOUND"}

    row = (
        await db.execute(
            select(SLATracking).where(
                SLATracking.session_id == session_id,
                SLATracking.tenant_id == tenant_id,
                SLATracking.target_type == "session",
                SLATracking.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()

    if row is not None:
        first_due = row.first_response_due
        res_due = row.resolution_due
        first_at = row.first_response_at
        resolved_at = row.resolved_at
        policy_id = str(row.policy_id) if row.policy_id else None
        paused_at = row.paused_at
        paused_total = row.paused_total_seconds
    else:
        # 即時暫態計算(僅套 session 政策)
        policies = (
            await db.execute(
                select(SLAPolicy).where(
                    SLAPolicy.tenant_id == tenant_id,
                    SLAPolicy.is_active.is_(True),
                    SLAPolicy.deleted_at.is_(None),
                )
            )
        ).scalars().all()
        session_policies = [p for p in policies if _policy_target(p) == "session"]
        ch_type = (
            await db.execute(select(Channel.type).where(Channel.id == session.channel_id))
        ).scalar_one_or_none()
        tags = (await _session_tags(db, tenant_id, {session_id})).get(session_id, [])
        ctx = _build_ctx(session, ch_type, tags)
        policy = pick_policy(session_policies, ctx)
        if policy is None:
            return {
                "tracked": False,
                "session_id": str(session_id),
                "reason": "SLA_NO_MATCHING_POLICY",
            }
        first_due = compute_due(session.created_at, policy.first_response_minutes, bh, tz_name)
        res_due = compute_due(session.created_at, policy.resolution_minutes, bh, tz_name)
        first_at = (await _first_response_map(db, tenant_id, {session_id})).get(session_id)
        resolved_at = session.closed_at if session.status == "closed" else None
        policy_id = str(policy.id)
        paused_at = None
        paused_total = 0

    payload = _build_status_payload(
        created_at=session.created_at,
        first_due=first_due,
        res_due=res_due,
        first_at=first_at,
        resolved_at=resolved_at,
        policy_id=policy_id,
        paused_at=paused_at,
        paused_total=paused_total,
        now=now,
        tracking_id=str(row.id) if row is not None else None,
    )
    payload["target_type"] = "session"
    payload["session_id"] = str(session_id)
    return payload


def _build_status_payload(
    *,
    created_at: datetime | None,
    first_due: datetime | None,
    res_due: datetime | None,
    first_at: datetime | None,
    resolved_at: datetime | None,
    policy_id: str | None,
    paused_at: datetime | None,
    paused_total: int | None,
    now: datetime,
    tracking_id: str | None = None,
) -> dict[str, Any]:
    """共用:套用暫停後評估並序列化前端所需的 SLA 狀態/倒數(會話與工單共用)。

    回傳的 due 為「已含暫停外推」的有效期限;remaining 亦已扣除暫停(暫停中則凍結)。

    tracking_id:對應的 SLATracking 列 id(僅在已落庫追蹤列時有值)。前端據此呼叫
    pause/resume 端點——這些端點以 tracking_id 定位列;暫態(尚未落庫)結果為 None,
    此時暫停/恢復不適用(需等掃描器先建立追蹤列)。
    """
    pd = apply_pause(
        first_response_due=first_due,
        resolution_due=res_due,
        paused_at=paused_at,
        paused_total_seconds=paused_total,
        now=now,
    )
    ev = evaluate(
        created_at=created_at,
        first_response_due=pd.first_response_due,
        resolution_due=pd.resolution_due,
        first_response_at=first_at,
        resolved_at=resolved_at,
        now=pd.eval_now,
    )
    return {
        "tracked": True,
        "tracking_id": tracking_id,
        "policy_id": policy_id,
        "status": ev.status,
        "first_response_state": ev.first_state,
        "resolution_state": ev.resolution_state,
        "breached_first": ev.breached_first,
        "breached_resolution": ev.breached_resolution,
        "first_response_due": (
            _aware(pd.first_response_due).isoformat() if pd.first_response_due else None
        ),
        "resolution_due": _aware(pd.resolution_due).isoformat() if pd.resolution_due else None,
        "first_response_at": _aware(first_at).isoformat() if first_at else None,
        "resolved_at": _aware(resolved_at).isoformat() if resolved_at else None,
        "first_response_remaining_seconds": _remaining_seconds(
            pd.first_response_due, first_at, pd.eval_now
        ),
        "resolution_remaining_seconds": _remaining_seconds(
            pd.resolution_due, resolved_at, pd.eval_now
        ),
        "paused": paused_at is not None,
        "paused_at": _aware(paused_at).isoformat() if paused_at else None,
        "paused_total_seconds": int(paused_total or 0),
    }


# --------------------------------------------------------------------------- #
# 單工單 SLA 狀態(供前端顯示倒數/狀態)
# --------------------------------------------------------------------------- #
async def status_for_ticket(
    db: AsyncSession, tenant_id: uuid.UUID, ticket_id: uuid.UUID
) -> dict[str, Any]:
    """回某工單目前 SLA 狀態與倒數(對稱於 status_for_session)。

    優先讀既有 SLATracking(ticket 目標);無追蹤列則即時比對 ticket 政策算暫態(不落庫)。
    查無工單回 tracked=False / reason=SLA_TICKET_NOT_FOUND。
    """
    now = _utcnow()
    bh, tz_name = await _tenant_business_hours(db, tenant_id)
    ticket = (
        await db.execute(
            select(Ticket).where(
                Ticket.id == ticket_id,
                Ticket.tenant_id == tenant_id,
                Ticket.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if ticket is None:
        return {"tracked": False, "ticket_id": str(ticket_id), "reason": "SLA_TICKET_NOT_FOUND"}

    row = (
        await db.execute(
            select(SLATracking).where(
                SLATracking.ticket_id == ticket_id,
                SLATracking.tenant_id == tenant_id,
                SLATracking.target_type == "ticket",
                SLATracking.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()

    if row is not None:
        first_due = row.first_response_due
        res_due = row.resolution_due
        first_at = row.first_response_at
        resolved_at = row.resolved_at
        policy_id = str(row.policy_id) if row.policy_id else None
        paused_at = row.paused_at
        paused_total = row.paused_total_seconds
    else:
        policies = (
            await db.execute(
                select(SLAPolicy).where(
                    SLAPolicy.tenant_id == tenant_id,
                    SLAPolicy.is_active.is_(True),
                    SLAPolicy.deleted_at.is_(None),
                )
            )
        ).scalars().all()
        ticket_policies = [p for p in policies if _policy_target(p) == "ticket"]
        ctx = _build_ticket_ctx(ticket)
        policy = pick_policy(ticket_policies, ctx)
        if policy is None:
            return {
                "tracked": False,
                "ticket_id": str(ticket_id),
                "reason": "SLA_NO_MATCHING_POLICY",
            }
        first_due = compute_due(ticket.created_at, policy.first_response_minutes, bh, tz_name)
        res_due = compute_due(ticket.created_at, policy.resolution_minutes, bh, tz_name)
        first_at = _ticket_first_response_at(ticket, None, now)
        resolved_at = _ticket_resolved_at(ticket)
        policy_id = str(policy.id)
        paused_at = None
        paused_total = 0

    payload = _build_status_payload(
        created_at=ticket.created_at,
        first_due=first_due,
        res_due=res_due,
        first_at=first_at,
        resolved_at=resolved_at,
        policy_id=policy_id,
        paused_at=paused_at,
        paused_total=paused_total,
        now=now,
        tracking_id=str(row.id) if row is not None else None,
    )
    payload["target_type"] = "ticket"
    payload["ticket_id"] = str(ticket_id)
    return payload


# --------------------------------------------------------------------------- #
# SLA 暫停 / 恢復(DB 級:操作既有 SLATracking 列)
# --------------------------------------------------------------------------- #
async def _load_tracking(
    db: AsyncSession, tenant_id: uuid.UUID, tracking_id: uuid.UUID
) -> SLATracking | None:
    return (
        await db.execute(
            select(SLATracking).where(
                SLATracking.id == tracking_id,
                SLATracking.tenant_id == tenant_id,
                SLATracking.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


async def pause_tracking(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    tracking_id: uuid.UUID,
    now: datetime | None = None,
) -> SLATracking | None:
    """暫停某追蹤列的 SLA 時鐘(等待客戶時停表)。冪等:已暫停則不變。回更新後的列;查無回 None。

    只設 paused_at(停表起點);breach/status 快取由掃描器定期重算,而即時狀態一律走
    status_for_session/ticket(讀取時才套用暫停,永遠新鮮)。不 commit,交易邊界由呼叫端決定。
    """
    now = _aware(now) or _utcnow()
    row = await _load_tracking(db, tenant_id, tracking_id)
    if row is None:
        return None
    if row.paused_at is None:
        row.paused_at = begin_pause(paused_at=row.paused_at, now=now)
    return row


async def resume_tracking(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    tracking_id: uuid.UUID,
    now: datetime | None = None,
) -> SLATracking | None:
    """恢復某追蹤列的 SLA 時鐘:把本段暫停時長併入 paused_total_seconds。冪等:未暫停則不變。

    回更新後的列;查無回 None。不 commit。
    """
    now = _aware(now) or _utcnow()
    row = await _load_tracking(db, tenant_id, tracking_id)
    if row is None:
        return None
    if row.paused_at is not None:
        _, total = end_pause(
            paused_at=row.paused_at, paused_total_seconds=row.paused_total_seconds, now=now
        )
        row.paused_at = None
        row.paused_total_seconds = total
    return row


async def sync_pause_for_status(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    *,
    target_type: str,
    target_id: uuid.UUID,
    status: str,
    now: datetime | None = None,
    waiting_statuses: Iterable[str] | None = None,
) -> SLATracking | None:
    """狀態變更時的自動暫停/恢復 helper(可由 conversation/ticket 狀態變更呼叫)。

    - target_type: "session" | "ticket";target_id 為對應 session_id / ticket_id。
    - status 落在 waiting_statuses(工單預設 {"pending"};會話由呼叫端指定其「等待客戶」狀態)
      → 暫停;否則 → 恢復。
    - 僅在已有對應追蹤列時作用(暫態未落庫者由掃描器建立後下次狀態變更再同步)。查無回 None。

    不 commit。此為「依狀態自動暫停」的接點;顯式操作見 pause_tracking/resume_tracking。
    """
    now = _aware(now) or _utcnow()
    if target_type == "ticket":
        cond = SLATracking.ticket_id == target_id
        waiting = tuple(waiting_statuses) if waiting_statuses is not None else _TICKET_WAITING_STATUSES
    else:
        cond = SLATracking.session_id == target_id
        waiting = tuple(waiting_statuses) if waiting_statuses is not None else ()
    row = (
        await db.execute(
            select(SLATracking).where(
                cond,
                SLATracking.tenant_id == tenant_id,
                SLATracking.target_type == target_type,
                SLATracking.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    if status in waiting:
        return await pause_tracking(db, tenant_id, row.id, now=now)
    return await resume_tracking(db, tenant_id, row.id, now=now)
