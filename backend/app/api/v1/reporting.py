"""M11 報表 API(router 前綴由 main.py 掛為 /api/v1/reporting)。

固定報表端點,以 SQL 聚合為主,全部:
- 依 ``staff.tenant_id`` 做租戶隔離(絕不信任前端傳的 tenant_id);
- 需 ``report.view``(質檢/滿意度需 ``quality.view``;admin 一律放行);
- 支援可選時間區間 start/end 與技能組 skill_group_id 維度過濾;
- 回傳統一信封 ok(...)。

滿意度(CSAT)與質檢(QC)目前無專屬資料表(屬 M9/M10),故本模組以 Message.meta
JSONB 的約定鍵聚合;M9/M10 落地時只需把結果寫入下列鍵即可對接:
- 滿意度:message.meta = {"csat": {"score": 1..5}}(通常掛在會話結束的評分訊息)。
- 質檢:  message.meta = {"qc": {"status": "pass|fail|flagged", "score": 0..100}}。
"""
from __future__ import annotations

import calendar
import csv
import io
import json
import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentStaff, DbSession, Principal
from app.core.response import err, ok
from app.models.conversation import Message, Session

logger = logging.getLogger("kefu.reporting")

router = APIRouter()

# 常用查詢型別別名
StartQ = Annotated[datetime | None, Query(description="起始時間(含)")]
EndQ = Annotated[datetime | None, Query(description="結束時間(不含)")]
SkillGroupQ = Annotated[uuid.UUID | None, Query(description="技能組維度過濾")]


def _session_scope(staff: Principal, start: datetime | None, end: datetime | None, skill_group_id: uuid.UUID | None):
    """組出套用在 Session 上的租戶隔離 + 軟刪除 + 時間區間 + 技能組過濾條件。"""
    conds = [Session.tenant_id == staff.tenant_id, Session.deleted_at.is_(None)]
    if start is not None:
        conds.append(Session.created_at >= start)
    if end is not None:
        conds.append(Session.created_at < end)
    if skill_group_id is not None:
        conds.append(Session.skill_group_id == skill_group_id)
    return conds


def _first_human_subq(staff: Principal):
    """每個 session 的首次真人回覆時間(供首應/等待時長計算)。"""
    return (
        select(
            Message.session_id.label("session_id"),
            func.min(Message.created_at).label("first_at"),
        )
        .where(
            Message.tenant_id == staff.tenant_id,
            Message.sender_type == "human",
            Message.deleted_at.is_(None),
        )
        .group_by(Message.session_id)
        .subquery()
    )


def _as_utc(dt: datetime | None) -> datetime | None:
    """把無時區(naive)的 datetime 視為 UTC 補上 tzinfo;已帶時區者原樣回傳。

    FastAPI 解析 query 的 ISO 字串時,若未帶時區(如 ``2026-09-01T00:00:00``)會得到
    naive datetime。overview 需與 ``datetime.now(timezone.utc)``(aware)做區間相減,
    naive 與 aware 相減會 TypeError → 500。故一律先正規化為 aware(UTC)。
    """
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _delta_pct(cur: float | None, prev: float | None) -> float | None:
    """本期相對前期的環比變化百分比 = (本期-前期)/前期*100。

    前期為 0 或任一為 None 時回 None(前端顯示為 0/—,避免除以零與誤導性 100%)。
    """
    if cur is None or prev is None or prev == 0:
        return None
    return round((cur - prev) / prev * 100, 1)


@router.get("/conversations/volume")
async def conversations_volume(
    staff: CurrentStaff,
    db: DbSession,
    start: StartQ = None,
    end: EndQ = None,
    skill_group_id: SkillGroupQ = None,
):
    """會話量:總數、依狀態分佈、逐日新增。"""
    staff.require("report.view")
    conds = _session_scope(staff, start, end, skill_group_id)

    total = (await db.execute(select(func.count()).select_from(Session).where(and_(*conds)))).scalar_one()

    by_status_rows = (
        await db.execute(
            select(Session.status, func.count()).where(and_(*conds)).group_by(Session.status)
        )
    ).all()

    day = func.date_trunc("day", Session.created_at).label("day")
    daily_rows = (
        await db.execute(select(day, func.count()).where(and_(*conds)).group_by(day).order_by(day))
    ).all()

    return ok(
        {
            "total": int(total),
            "by_status": {status: int(cnt) for status, cnt in by_status_rows},
            "daily": [{"day": d, "count": int(c)} for d, c in daily_rows],
        }
    )


@router.get("/agents/performance")
async def agents_performance(
    staff: CurrentStaff,
    db: DbSession,
    start: StartQ = None,
    end: EndQ = None,
    skill_group_id: SkillGroupQ = None,
):
    """坐席績效:接待數、平均首次回覆時長、平均處理時長、真人回覆訊息數。"""
    staff.require("report.view")
    conds = _session_scope(staff, start, end, skill_group_id)
    fh = _first_human_subq(staff)

    # 匯入 Staff 只為顯示名稱(允許讀他模組模型,只是不改其檔案)
    from app.models.iam import Staff

    first_resp = func.avg(func.extract("epoch", fh.c.first_at - Session.created_at))
    handle = func.avg(
        func.extract("epoch", Session.closed_at - Session.created_at)
    ).filter(Session.closed_at.isnot(None))

    rows = (
        await db.execute(
            select(
                Session.handler_staff_id,
                Staff.display_name,
                func.count(func.distinct(Session.id)).label("reception"),
                first_resp.label("avg_first_response_seconds"),
                handle.label("avg_handle_seconds"),
            )
            .select_from(Session)
            .outerjoin(fh, fh.c.session_id == Session.id)
            .outerjoin(Staff, Staff.id == Session.handler_staff_id)
            .where(and_(*conds, Session.handler_staff_id.isnot(None)))
            .group_by(Session.handler_staff_id, Staff.display_name)
        )
    ).all()

    # 真人回覆訊息數(依 sender_id 聚合),另查後於 Python 併入
    msg_conds = [
        Message.tenant_id == staff.tenant_id,
        Message.deleted_at.is_(None),
        Message.sender_type == "human",
    ]
    if start is not None:
        msg_conds.append(Message.created_at >= start)
    if end is not None:
        msg_conds.append(Message.created_at < end)
    reply_rows = (
        await db.execute(
            select(Message.sender_id, func.count()).where(and_(*msg_conds)).group_by(Message.sender_id)
        )
    ).all()
    replies = {sid: int(cnt) for sid, cnt in reply_rows}

    agents = []
    for staff_id, name, reception, first_r, handle_s in rows:
        agents.append(
            {
                "staff_id": str(staff_id) if staff_id else None,
                "display_name": name,
                "reception": int(reception),
                "avg_first_response_seconds": float(first_r) if first_r is not None else None,
                "avg_handle_seconds": float(handle_s) if handle_s is not None else None,
                "reply_messages": replies.get(staff_id, 0),
            }
        )
    return ok({"agents": agents})


@router.get("/queue/wait-times")
async def queue_wait_times(
    staff: CurrentStaff,
    db: DbSession,
    start: StartQ = None,
    end: EndQ = None,
    skill_group_id: SkillGroupQ = None,
):
    """排隊/等待時長:目前排隊數、至首次真人回覆的平均/最大等待秒數。"""
    staff.require("report.view")
    conds = _session_scope(staff, start, end, skill_group_id)
    fh = _first_human_subq(staff)

    queued = (
        await db.execute(
            select(func.count()).select_from(Session).where(and_(*conds, Session.status == "queued"))
        )
    ).scalar_one()

    wait_expr = func.extract("epoch", fh.c.first_at - Session.created_at)
    wait_row = (
        await db.execute(
            select(func.avg(wait_expr), func.max(wait_expr), func.count())
            .select_from(Session)
            .join(fh, fh.c.session_id == Session.id)
            .where(and_(*conds))
        )
    ).one()
    avg_wait, max_wait, answered = wait_row

    return ok(
        {
            "currently_queued": int(queued),
            "answered_sessions": int(answered),
            "avg_wait_seconds": float(avg_wait) if avg_wait is not None else None,
            "max_wait_seconds": float(max_wait) if max_wait is not None else None,
        }
    )


@router.get("/satisfaction")
async def satisfaction_summary(
    staff: CurrentStaff,
    db: DbSession,
    start: StartQ = None,
    end: EndQ = None,
):
    """滿意度(CSAT)彙總:平均分、樣本數、各分數分佈。來源=M10 quality 的 csat 表。"""
    staff.require("quality.view")

    from app.models.quality import CSAT

    score = CSAT.rating
    conds = [CSAT.tenant_id == staff.tenant_id, CSAT.deleted_at.is_(None)]
    if start is not None:
        conds.append(CSAT.created_at >= start)
    if end is not None:
        conds.append(CSAT.created_at < end)

    agg = (await db.execute(select(func.avg(score), func.count()).where(and_(*conds)))).one()
    avg_score, count = agg

    dist_rows = (
        await db.execute(select(score, func.count()).where(and_(*conds)).group_by(score).order_by(score))
    ).all()

    return ok(
        {
            "responses": int(count),
            "avg_score": float(avg_score) if avg_score is not None else None,
            "distribution": {str(int(s)): int(c) for s, c in dist_rows if s is not None},
        }
    )


@router.get("/quality")
async def quality_summary(
    staff: CurrentStaff,
    db: DbSession,
    start: StartQ = None,
    end: EndQ = None,
):
    """質檢(QC)彙總:已質檢筆數、依分類(label)分佈、平均質檢分。

    真實資料來源為 M10 的 ``quality_record`` 表(app/services/quality.py 的
    flag_message / create_quality_record 為唯一寫入者),該表有可靠的 ``score``
    欄位可算平均分,分類維度為 ``label``(如:違規用語、未遵循話術、優秀案例…)。
    QualityRecord 並無獨立的 status 欄位,故 by_status 以 label 分佈呈現。

    舊版誤讀 ``Message.meta["qc"]["status"/"score"]`` 並以 ``meta["qc"]`` 過濾——
    該鍵從未被任何程式寫入(flag_message 實際寫的是 ``Message.meta["quality"]``,
    且無 status),故 reviewed / by_status / avg_score 永遠為空。此處改為直接查表。
    """
    staff.require("quality.view")

    from app.models.quality import QualityRecord

    conds = [
        QualityRecord.tenant_id == staff.tenant_id,
        QualityRecord.deleted_at.is_(None),
    ]
    if start is not None:
        conds.append(QualityRecord.created_at >= start)
    if end is not None:
        conds.append(QualityRecord.created_at < end)

    reviewed = (
        await db.execute(select(func.count()).select_from(QualityRecord).where(and_(*conds)))
    ).scalar_one()
    avg_score = (
        await db.execute(select(func.avg(QualityRecord.score)).where(and_(*conds)))
    ).scalar_one()
    by_status_rows = (
        await db.execute(
            select(QualityRecord.label, func.count())
            .where(and_(*conds))
            .group_by(QualityRecord.label)
        )
    ).all()

    return ok(
        {
            "reviewed": int(reviewed),
            "avg_score": float(avg_score) if avg_score is not None else None,
            # label 為質檢分類/旗標;None(僅評分未標註者)不計入分佈
            "by_status": {label: int(cnt) for label, cnt in by_status_rows if label is not None},
        }
    )


@router.get("/overview")
async def overview(
    staff: CurrentStaff,
    db: DbSession,
    start: StartQ = None,
    end: EndQ = None,
    skill_group_id: SkillGroupQ = None,
):
    """報表總覽:一次回傳前端儀表板所需的全部聚合。

    回傳:逐日趨勢(會話量 / AI 解決 / 滿意度)、渠道分布、坐席績效(接待 + 滿意度)、
    四張 KPI 卡(會話總數 / AI 解決率 / 平均等待 / CSAT)含環比 delta%。全程 SQL 聚合,
    無逐列迴圈 / N+1。

    口徑:
    - **時間窗**:未帶 start/end 時預設近 14 天(對齊前端趨勢圖);**環比對照**為緊鄰的
      前一個等長區間(prev = [period_start-span, period_start))。
    - **租戶隔離**:所有查詢一律以 ``staff.tenant_id`` 過濾,絕不信任前端傳入的 tenant。
    - **AI 解決**:``status == 'closed'`` 且該會話「從無真人訊息」(未 handoff)。以是否存在
      ``sender_type == 'human'`` 的訊息判斷是否曾被真人接手(沿用本模組既有的真人判定訊號)。
      AI 解決率 = AI 解決數 / 已結束會話數。
    - **滿意度(CSAT)**:``avg(rating)`` 換算百分比(rating 1–5 → /5*100)。CSAT 屬 M10 質檢域,
      需 ``quality.view``;無此權限者滿意度相關欄位一律回 None(與舊版前端 catch /satisfaction
      403 後回退 null 的行為一致,不外洩)。
    - **渠道分布**:依 ``channel.type`` 分組計會話量。
    """
    staff.require("report.view")
    # CSAT 屬質檢域,單獨以 quality.view 軟性把關(無權限則滿意度回 None,不阻擋整份總覽)
    can_quality = "admin" in staff.roles or "quality.view" in staff.roles

    from app.models.conversation import Channel
    from app.models.iam import Staff
    from app.models.quality import CSAT

    # --- 時間窗與環比對照窗 ---
    # 傳入若為 naive datetime 一律視為 UTC 補上時區,避免與 aware now 相減時 TypeError → 500
    # (export_overview 複用本函式並可能帶入 naive datetime,故一併受此正規化保護)。
    start = _as_utc(start)
    end = _as_utc(end)
    now = datetime.now(timezone.utc)
    period_end = end or now
    period_start = start or (period_end - timedelta(days=14))
    span = period_end - period_start
    prev_end = period_start
    prev_start = period_start - span

    # 曾出現真人訊息的會話(判斷是否 handoff);不限時間——只要該會話歷史上有真人訊息即算接手
    human_sessions = (
        select(Message.session_id)
        .where(
            Message.tenant_id == staff.tenant_id,
            Message.sender_type == "human",
            Message.deleted_at.is_(None),
        )
        .group_by(Message.session_id)
        .subquery()
    )
    closed_case = case((Session.status == "closed", 1), else_=0)
    ai_resolved_case = case(
        (and_(Session.status == "closed", human_sessions.c.session_id.is_(None)), 1),
        else_=0,
    )

    def _pct(avg: float | None) -> float | None:
        """CSAT rating 平均(1–5)換算百分比(0–100)。"""
        return round(avg / 5 * 100, 1) if avg is not None else None

    def _rate(ai: int, closed: int) -> float | None:
        """AI 解決率 = AI 解決數 / 已結束會話數(百分比);無已結束會話回 None。"""
        return round(ai / closed * 100, 1) if closed else None

    async def _session_kpis(s: datetime, e: datetime) -> tuple[int, int, int]:
        """某區間的 (會話總數, 已結束數, AI 解決數)。單一聚合查詢。"""
        row = (
            await db.execute(
                select(
                    func.count(),
                    func.coalesce(func.sum(closed_case), 0),
                    func.coalesce(func.sum(ai_resolved_case), 0),
                )
                .select_from(Session)
                .outerjoin(human_sessions, human_sessions.c.session_id == Session.id)
                .where(and_(*_session_scope(staff, s, e, skill_group_id)))
            )
        ).one()
        return int(row[0]), int(row[1]), int(row[2])

    async def _avg_wait(s: datetime, e: datetime) -> float | None:
        """某區間至首次真人回覆的平均等待秒數。"""
        fh = _first_human_subq(staff)
        wait_expr = func.extract("epoch", fh.c.first_at - Session.created_at)
        val = (
            await db.execute(
                select(func.avg(wait_expr))
                .select_from(Session)
                .join(fh, fh.c.session_id == Session.id)
                .where(and_(*_session_scope(staff, s, e, skill_group_id)))
            )
        ).scalar_one()
        return float(val) if val is not None else None

    async def _csat_avg(s: datetime, e: datetime) -> tuple[float | None, int]:
        """某區間 CSAT (平均 rating, 樣本數);無 quality.view 則回 (None, 0)。"""
        if not can_quality:
            return None, 0
        row = (
            await db.execute(
                select(func.avg(CSAT.rating), func.count()).where(
                    CSAT.tenant_id == staff.tenant_id,
                    CSAT.deleted_at.is_(None),
                    CSAT.created_at >= s,
                    CSAT.created_at < e,
                )
            )
        ).one()
        return (float(row[0]) if row[0] is not None else None, int(row[1]))

    # --- 本期 / 前期 KPI ---
    cur_total, cur_closed, cur_ai = await _session_kpis(period_start, period_end)
    prev_total, prev_closed, prev_ai = await _session_kpis(prev_start, prev_end)
    cur_wait = await _avg_wait(period_start, period_end)
    prev_wait = await _avg_wait(prev_start, prev_end)
    cur_csat_avg, cur_csat_n = await _csat_avg(period_start, period_end)
    prev_csat_avg, _ = await _csat_avg(prev_start, prev_end)

    cur_ai_rate = _rate(cur_ai, cur_closed)
    prev_ai_rate = _rate(prev_ai, prev_closed)
    cur_csat_pct = _pct(cur_csat_avg)
    prev_csat_pct = _pct(prev_csat_avg)

    kpi = {
        "conversations": {
            "value": cur_total,
            "prev": prev_total,
            "delta_pct": _delta_pct(cur_total, prev_total),
        },
        "ai_resolution_rate": {
            "value": cur_ai_rate,
            "prev": prev_ai_rate,
            "delta_pct": _delta_pct(cur_ai_rate, prev_ai_rate),
        },
        "avg_wait_seconds": {
            "value": cur_wait,
            "prev": prev_wait,
            # 等待變短為改善;此處僅回原始環比,由前端決定漲跌語意色彩
            "delta_pct": _delta_pct(cur_wait, prev_wait),
        },
        "csat": {
            "value": cur_csat_pct,
            "prev": prev_csat_pct,
            "delta_pct": _delta_pct(cur_csat_pct, prev_csat_pct),
            "responses": cur_csat_n,
        },
    }

    # --- 逐日趨勢:會話量 + AI 解決(皆為 count) ---
    day = func.date_trunc("day", Session.created_at).label("day")
    daily_rows = (
        await db.execute(
            select(day, func.count(), func.coalesce(func.sum(ai_resolved_case), 0))
            .select_from(Session)
            .outerjoin(human_sessions, human_sessions.c.session_id == Session.id)
            .where(and_(*_session_scope(staff, period_start, period_end, skill_group_id)))
            .group_by(day)
            .order_by(day)
        )
    ).all()

    # --- 逐日滿意度(CSAT 平均換百分比;需 quality.view) ---
    csat_by_day: dict[str, float | None] = {}
    if can_quality:
        cday = func.date_trunc("day", CSAT.created_at).label("day")
        csat_rows = (
            await db.execute(
                select(cday, func.avg(CSAT.rating))
                .where(
                    CSAT.tenant_id == staff.tenant_id,
                    CSAT.deleted_at.is_(None),
                    CSAT.created_at >= period_start,
                    CSAT.created_at < period_end,
                )
                .group_by(cday)
                .order_by(cday)
            )
        ).all()
        csat_by_day = {d.isoformat(): _pct(float(a)) for d, a in csat_rows if a is not None}

    series = [
        {
            "day": d.isoformat(),
            "conversations": int(cnt),
            "ai_resolved": int(ai_cnt),
            # 當日無 CSAT 回應則為 None(趨勢線斷開,不以 0 誤導)
            "csat": csat_by_day.get(d.isoformat()),
        }
        for d, cnt, ai_cnt in daily_rows
    ]

    # --- 渠道分布:依 channel.type 分組計會話量 ---
    ch_rows = (
        await db.execute(
            select(Channel.type, func.count())
            .select_from(Session)
            .join(Channel, Channel.id == Session.channel_id)
            .where(and_(*_session_scope(staff, period_start, period_end, skill_group_id)))
            .group_by(Channel.type)
            .order_by(func.count().desc())
        )
    ).all()
    channel_breakdown = [{"type": t, "count": int(c)} for t, c in ch_rows]

    # --- 坐席績效:接待數(distinct 會話)+ 滿意度(該坐席經手會話的 CSAT 平均) ---
    recep_rows = (
        await db.execute(
            select(
                Session.handler_staff_id,
                Staff.display_name,
                func.count(func.distinct(Session.id)),
            )
            .select_from(Session)
            .outerjoin(Staff, Staff.id == Session.handler_staff_id)
            .where(
                and_(
                    *_session_scope(staff, period_start, period_end, skill_group_id),
                    Session.handler_staff_id.isnot(None),
                )
            )
            .group_by(Session.handler_staff_id, Staff.display_name)
        )
    ).all()

    agent_csat: dict[uuid.UUID, float | None] = {}
    if can_quality:
        ac_rows = (
            await db.execute(
                select(Session.handler_staff_id, func.avg(CSAT.rating))
                .select_from(CSAT)
                .join(Session, Session.id == CSAT.session_id)
                .where(
                    CSAT.tenant_id == staff.tenant_id,
                    CSAT.deleted_at.is_(None),
                    CSAT.created_at >= period_start,
                    CSAT.created_at < period_end,
                    Session.handler_staff_id.isnot(None),
                )
                .group_by(Session.handler_staff_id)
            )
        ).all()
        agent_csat = {sid: _pct(float(a)) for sid, a in ac_rows if a is not None}

    agent_performance = sorted(
        (
            {
                "staff_id": str(sid) if sid else None,
                "display_name": name,
                "reception": int(cnt),
                "csat": agent_csat.get(sid),
            }
            for sid, name, cnt in recep_rows
        ),
        key=lambda a: a["reception"],
        reverse=True,
    )

    return ok(
        {
            "period": {"start": period_start.isoformat(), "end": period_end.isoformat()},
            "kpi": kpi,
            "series": series,
            "channel_breakdown": channel_breakdown,
            "agent_performance": agent_performance,
        }
    )


# ============================== 聚合洞察(Insights) ==============================
# 對齊 LiveChat 的「Insights」:用 LLM 掃近 N 天訪客訊息,產出每週熱門問題 / 主題、
# 整體情緒趨勢與建議關注點——「30 秒讀完上千則對話」。純衍生資料,以進程內快取
# (tenant+days 為 key、TTL 1 小時)避免每次請求都打 LLM;LLM 失敗一律降級不 500。

_SENTIMENTS = {"positive", "neutral", "negative"}

_INSIGHTS_CACHE: dict[str, tuple[float, dict]] = {}
_INSIGHTS_TTL_SECONDS = 3600.0     # 1 小時
_INSIGHTS_CACHE_MAX = 256
_INSIGHTS_SAMPLE_CAP = 300         # 帶入 LLM 的訪客訊息樣本上限(數百則,控制 prompt 體積)
_INSIGHTS_CONTENT_CHARS = 200      # 每則訊息截斷長度
_INSIGHTS_MAX_TOPICS = 10          # 回傳的熱門主題上限
_INSIGHTS_MIN_SAMPLES = 5          # 少於此樣本數視為資料不足,不打 LLM

_INSIGHTS_SYSTEM_PROMPT = (
    "你是資深客服數據分析師。以下是近期多位訪客傳來的訊息樣本(每行一則)。"
    "請歸納整體趨勢,只用繁體中文輸出一個 JSON 物件,不要輸出 JSON 以外的任何文字,"
    "也不要用 Markdown 圍欄。JSON 需包含以下欄位:\n"
    '- "topics":熱門問題 / 主題陣列(最多 8 項,依常見程度排序)。每項為物件,含 '
    '"topic"(主題短語,20 字內)、"count"(這批樣本中大約有幾則屬於此主題的整數估計)、'
    '"example"(一則能代表該主題的訪客原話,40 字內)。\n'
    '- "sentiment":物件,含 "overall"(只能是 "positive"、"neutral"、"negative" 三者之一)'
    '與 "summary"(1-2 句話描述整體情緒趨勢)。\n'
    '- "recommendations":給客服團隊的 1-5 條「建議關注點」,元素為字串的陣列。'
)


def _insights_clean(value, *, limit: int) -> str | None:
    """轉字串、去空白;空值回 None;過長截斷補省略號(與 ai/insight 風格一致)。"""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    if len(s) > limit:
        s = s[:limit].rstrip() + "…"
    return s


def _insights_extract_json(text: str) -> dict:
    """從 LLM 回應擷取第一個 JSON 物件(容忍前後雜訊與程式碼圍欄)。"""
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


def _insights_cache_get(key: str) -> dict | None:
    entry = _INSIGHTS_CACHE.get(key)
    if entry is None:
        return None
    ts, value = entry
    if time.monotonic() - ts > _INSIGHTS_TTL_SECONDS:
        _INSIGHTS_CACHE.pop(key, None)
        return None
    return value


def _insights_cache_put(key: str, value: dict) -> None:
    # 粗略防漲:超過上限直接清空(洞察為衍生資料,重算成本可接受)。
    if len(_INSIGHTS_CACHE) >= _INSIGHTS_CACHE_MAX:
        _INSIGHTS_CACHE.clear()
    _INSIGHTS_CACHE[key] = (time.monotonic(), value)


def _insights_degraded(days: int, sample_size: int, status: str) -> dict:
    """降級 / 資料不足時的空殼結果(結構與正常一致,前端據 status 顯示對應狀態)。"""
    return {
        "days": days,
        "sample_size": sample_size,
        "status": status,  # "insufficient"(資料不足)| "unavailable"(LLM 失敗)
        "topics": [],
        "sentiment": {"overall": "neutral", "summary": None},
        "recommendations": [],
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def _coerce_insights(raw: dict, days: int, sample_size: int) -> dict:
    """把 LLM 產出收斂成型別安全、前端相容的洞察結構;share 一律由 count 重算。"""
    topics: list[dict] = []
    topics_raw = raw.get("topics")
    if isinstance(topics_raw, list):
        for item in topics_raw:
            if not isinstance(item, dict):
                continue
            topic = _insights_clean(item.get("topic"), limit=60)
            if not topic:
                continue
            try:
                count = int(item.get("count"))
            except (TypeError, ValueError):
                count = 0
            count = max(0, min(count, sample_size))  # 夾在 [0, 樣本數],避免 LLM 亂估
            share = round(count / sample_size * 100, 1) if sample_size else 0.0
            topics.append(
                {
                    "topic": topic,
                    "count": count,
                    "share": share,
                    "example": _insights_clean(item.get("example"), limit=200),
                }
            )
    topics.sort(key=lambda x: x["count"], reverse=True)
    topics = topics[:_INSIGHTS_MAX_TOPICS]

    overall = "neutral"
    summary = None
    sentiment_raw = raw.get("sentiment")
    if isinstance(sentiment_raw, dict):
        o = sentiment_raw.get("overall")
        if isinstance(o, str) and o.strip().lower() in _SENTIMENTS:
            overall = o.strip().lower()
        summary = _insights_clean(sentiment_raw.get("summary"), limit=400)
    elif isinstance(sentiment_raw, str):
        summary = _insights_clean(sentiment_raw, limit=400)

    recommendations: list[str] = []
    recs_raw = raw.get("recommendations")
    if isinstance(recs_raw, list):
        for r in recs_raw:
            s = _insights_clean(r, limit=200)
            if s:
                recommendations.append(s)
    elif isinstance(recs_raw, str):
        s = _insights_clean(recs_raw, limit=200)
        if s:
            recommendations.append(s)
    recommendations = recommendations[:5]

    return {
        "days": days,
        "sample_size": sample_size,
        "status": "ok",
        "topics": topics,
        "sentiment": {"overall": overall, "summary": summary},
        "recommendations": recommendations,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


DaysQ = Annotated[int, Query(ge=1, le=90, description="回溯天數(如 7 / 30)")]


@router.get("/insights")
async def insights(staff: CurrentStaff, db: DbSession, days: DaysQ = 7):
    """聚合洞察:LLM 掃近 N 天訪客訊息 → 熱門問題/主題、情緒趨勢、建議關注點。

    - 租戶隔離:僅取 ``staff.tenant_id`` 的訪客訊息(絕不信任前端 tenant)。
    - 樣本:近 N 天、純文字 / markdown 的訪客訊息,取最新最多 300 則。
    - 快取:進程內以 ``tenant:days`` 為 key、TTL 1 小時;避免每次請求都打 LLM。
      「ok / 資料不足」皆快取;「LLM 失敗(unavailable)」不快取以便下次重試。
    - 降級:LLM / provider / 解析任一失敗即回結構化空殼(status=unavailable),不 500。

    回傳(信封 data):
    ``{days, sample_size, status, topics:[{topic,count,share,example}],
       sentiment:{overall,summary}, recommendations:[...], generated_at}``
    """
    staff.require("report.view")

    cache_key = f"{staff.tenant_id}:{days}"
    cached = _insights_cache_get(cache_key)
    if cached is not None:
        return ok(cached)

    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = (
        await db.execute(
            select(Message.content)
            .where(
                Message.tenant_id == staff.tenant_id,
                Message.sender_type == "visitor",
                Message.deleted_at.is_(None),
                Message.created_at >= since,
                Message.content_type.in_(("text", "markdown")),
            )
            .order_by(Message.created_at.desc())
            .limit(_INSIGHTS_SAMPLE_CAP)
        )
    ).scalars().all()

    samples: list[str] = []
    for content in rows:
        s = (content or "").strip()
        if s:
            samples.append(s[:_INSIGHTS_CONTENT_CHARS])
    sample_size = len(samples)

    # 樣本太少:資料不足,直接回空殼(快取,避免短時間反覆空打)。
    if sample_size < _INSIGHTS_MIN_SAMPLES:
        result = _insights_degraded(days, sample_size, "insufficient")
        _insights_cache_put(cache_key, result)
        return ok(result)

    try:
        # 延遲 import:與本檔既有風格一致,且避免載入期循環相依。
        from app.services.ai.agent import resolve_config
        from app.services.llm.base import ChatMessage, get_provider

        config = await resolve_config(db, staff.tenant_id)
        provider = get_provider(config.provider, config.api_key)
        transcript = "\n".join(f"{i + 1}. {s}" for i, s in enumerate(samples))
        messages = [
            ChatMessage(role="system", content=_INSIGHTS_SYSTEM_PROMPT),
            ChatMessage(
                role="user",
                content=(
                    f"樣本共 {sample_size} 則訪客訊息,請依系統指示歸納並輸出 JSON:\n\n"
                    + transcript
                ),
            ),
        ]
        # 分析類任務用低溫度求穩定;靠 _insights_extract_json 容錯,不依賴 provider 特有 response_format。
        answer = await provider.chat(messages, model=config.model, temperature=0.2)
        result = _coerce_insights(_insights_extract_json(answer), days, sample_size)
    except Exception:
        # LLM / provider / 解析任一失敗 → 降級,不快取(留待下次重試),端點不 500。
        logger.warning("insights LLM 產生失敗,降級為暫無", exc_info=True)
        return ok(_insights_degraded(days, sample_size, "unavailable"))

    _insights_cache_put(cache_key, result)
    return ok(result)


# ============================== 銷售追蹤(Sales) ==============================
# 對齊 LiveChat 的 Goals & Sales tracker:把 GoalConversion(目標達成)併入報表——
# 近 N 天的總成交數 / 總金額(分幣別)、逐目標明細、逐坐席 sales 排行(依成交歸因的
# staff_id 聚合)。全程 SQL 聚合、單趟查詢、無 N+1;租戶隔離;需 report.view。


@router.get("/sales")
async def sales(
    staff: CurrentStaff,
    db: DbSession,
    days: Annotated[int, Query(ge=1, le=365, description="回溯天數")] = 30,
):
    """銷售追蹤彙總:近 N 天的成交總覽 / 逐目標明細 / 逐坐席排行。

    - **總覽(分幣別)**:各幣別的成交筆數與總金額(value_cents 為達成當下記錄值)。
    - **逐目標明細**:窗內有成交的目標,各自成交數 / 總金額(依金額降序)。
    - **逐坐席排行**:依成交歸因的 ``staff_id`` 聚合,含未歸因(staff_id 為 NULL,
      display_name=None)一列以利對帳;多幣別時同一坐席按幣別分列。依金額降序。

    金額跨幣別不可直接相加,故總覽與坐席排行皆以「幣別」為聚合維度之一(單趟 SQL,
    無逐列迴圈 / N+1)。GoalConversion 的 currency 取自其所屬 Goal(join 取得)。
    """
    staff.require("report.view")

    from app.models.goals import Goal, GoalConversion
    from app.models.iam import Staff

    since = datetime.now(timezone.utc) - timedelta(days=days)
    # 三個聚合(總覽/逐目標/逐坐席)皆 join Goal 並共用此 conds,故在此統一過濾
    # 已軟刪的目標(Goal.deleted_at)——否則已刪目標的成交仍會計入 totals/明細/排行,
    # 與 /goals、/goals/summary(皆有 Goal.deleted_at.is_(None))口徑不一致。
    conds = [
        GoalConversion.tenant_id == staff.tenant_id,
        GoalConversion.deleted_at.is_(None),
        GoalConversion.occurred_at >= since,
        Goal.deleted_at.is_(None),
    ]
    conv_count = func.count(GoalConversion.id)
    conv_sum = func.coalesce(func.sum(GoalConversion.value_cents), 0)

    # --- 總覽:依幣別彙總 ---
    totals_rows = (
        await db.execute(
            select(Goal.currency, conv_count, conv_sum)
            .select_from(GoalConversion)
            .join(Goal, Goal.id == GoalConversion.goal_id)
            .where(and_(*conds))
            .group_by(Goal.currency)
            .order_by(conv_sum.desc())
        )
    ).all()

    # --- 逐目標明細:窗內有成交的目標(依總金額降序) ---
    goal_rows = (
        await db.execute(
            select(Goal.id, Goal.name, Goal.kind, Goal.currency, conv_count, conv_sum)
            .select_from(GoalConversion)
            .join(Goal, Goal.id == GoalConversion.goal_id)
            .where(and_(*conds))
            .group_by(Goal.id, Goal.name, Goal.kind, Goal.currency)
            .order_by(conv_sum.desc())
        )
    ).all()

    # --- 逐坐席排行:依 staff_id 聚合(outerjoin Staff 取名;NULL=未歸因) ---
    # Staff join 帶 tenant 條件於 ON,確保跨租戶不誤配且不破壞 outer 性質。
    staff_rows = (
        await db.execute(
            select(
                GoalConversion.staff_id,
                Staff.display_name,
                Goal.currency,
                conv_count,
                conv_sum,
            )
            .select_from(GoalConversion)
            .join(Goal, Goal.id == GoalConversion.goal_id)
            .outerjoin(
                Staff,
                and_(
                    Staff.id == GoalConversion.staff_id,
                    Staff.tenant_id == staff.tenant_id,
                ),
            )
            .where(and_(*conds))
            .group_by(GoalConversion.staff_id, Staff.display_name, Goal.currency)
            .order_by(conv_sum.desc())
        )
    ).all()

    return ok(
        {
            "days": days,
            "totals": [
                {
                    "currency": currency,
                    "conversions": int(n),
                    "total_value_cents": int(s),
                }
                for currency, n, s in totals_rows
            ],
            "goals": [
                {
                    "id": str(gid),
                    "name": name,
                    "kind": kind,
                    "currency": currency,
                    "conversions": int(n),
                    "total_value_cents": int(s),
                }
                for gid, name, kind, currency, n, s in goal_rows
            ],
            "agents": [
                {
                    "staff_id": str(sid) if sid else None,
                    "display_name": name,
                    "currency": currency,
                    "conversions": int(n),
                    "total_value_cents": int(s),
                }
                for sid, name, currency, n, s in staff_rows
            ],
        }
    )


# ============================== 坐席工時 / 活動報表(Agent Activity) ==============================
# 對齊 LiveChat 的 Agent activity / work time:不新增 presence 表,一律由既有訊息 / 會話
# 時間戳推導——逐坐席的處理會話數、送出訊息數、首末活動時間、活躍小時數(以「有活動的
# 小時桶數」近似工時)、平均首次回覆 / 處理時長。全程 SQL 聚合、常數次查詢、無 N+1;
# 租戶隔離;需 report.view。


@router.get("/agent-activity")
async def agent_activity(staff: CurrentStaff, db: DbSession, days: DaysQ = 7):
    """坐席工時 / 活動報表:近 N 天逐坐席的活動彙總 + 逐日趨勢。

    口徑:
    - **送出訊息數 / 首末活動 / 活躍小時數**:由該坐席(``Message.sender_id``)近 N 天的
      真人訊息(``sender_type='human'``)推導。活躍小時數 = 該坐席有發訊的「不同小時桶」
      (``date_trunc('hour', created_at)``)數量,作為工時的近似(無需 presence 表)。
    - **處理會話數 / 平均首次回覆 / 平均處理時長**:由 ``Session.handler_staff_id`` 近 N 天
      經手的會話推導;首次回覆 = 首則真人訊息時間 - 會話建立(沿用本模組 ``_first_human_subq``),
      處理時長 = 結束 - 建立(僅計已結束會話)。
    - 兩個維度以 staff_id 取聯集合併(只發訊未經手、或只經手未發訊者皆會出現)。
    - 逐日趨勢:每日送出訊息數與活躍坐席數(供逐日圖)。

    共 4 次聚合查詢(訊息面 / 會話面 / 坐席名 / 逐日),無逐列迴圈 / N+1;租戶隔離。
    """
    staff.require("report.view")
    from app.models.iam import Staff

    since = datetime.now(timezone.utc) - timedelta(days=days)

    # --- 訊息面:逐坐席送出訊息數 / 首末活動 / 活躍小時數(工時近似) ---
    hour_bucket = func.date_trunc("hour", Message.created_at)
    msg_rows = (
        await db.execute(
            select(
                Message.sender_id,
                func.count().label("sent_messages"),
                func.min(Message.created_at).label("first_activity"),
                func.max(Message.created_at).label("last_activity"),
                func.count(func.distinct(hour_bucket)).label("active_hours"),
            )
            .where(
                Message.tenant_id == staff.tenant_id,
                Message.sender_type == "human",
                Message.deleted_at.is_(None),
                Message.created_at >= since,
                Message.sender_id.isnot(None),
            )
            .group_by(Message.sender_id)
        )
    ).all()

    # --- 會話面:逐坐席處理會話數 / 平均首次回覆 / 平均處理時長 ---
    fh = _first_human_subq(staff)
    first_resp = func.avg(func.extract("epoch", fh.c.first_at - Session.created_at))
    handle = func.avg(
        func.extract("epoch", Session.closed_at - Session.created_at)
    ).filter(Session.closed_at.isnot(None))
    sess_rows = (
        await db.execute(
            select(
                Session.handler_staff_id,
                func.count(func.distinct(Session.id)).label("handled_sessions"),
                first_resp.label("avg_first_response_seconds"),
                handle.label("avg_handle_seconds"),
            )
            .select_from(Session)
            .outerjoin(fh, fh.c.session_id == Session.id)
            .where(
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
                Session.created_at >= since,
                Session.handler_staff_id.isnot(None),
            )
            .group_by(Session.handler_staff_id)
        )
    ).all()

    # --- 坐席名稱(一次帶出,避免 N+1) ---
    name_rows = (
        await db.execute(
            select(Staff.id, Staff.display_name).where(Staff.tenant_id == staff.tenant_id)
        )
    ).all()
    names = {sid: name for sid, name in name_rows}

    # 合併訊息面 + 會話面(staff_id 取聯集)
    msg_by = {r.sender_id: r for r in msg_rows}
    sess_by = {r.handler_staff_id: r for r in sess_rows}
    all_ids = {*msg_by.keys(), *sess_by.keys()}

    agents: list[dict[str, Any]] = []
    for sid in all_ids:
        if sid is None:
            continue
        m = msg_by.get(sid)
        s = sess_by.get(sid)
        agents.append(
            {
                "staff_id": str(sid),
                "display_name": names.get(sid),
                "handled_sessions": int(s.handled_sessions) if s else 0,
                "sent_messages": int(m.sent_messages) if m else 0,
                "active_hours": int(m.active_hours) if m else 0,
                "first_activity": m.first_activity.isoformat() if m and m.first_activity else None,
                "last_activity": m.last_activity.isoformat() if m and m.last_activity else None,
                "avg_first_response_seconds": (
                    float(s.avg_first_response_seconds)
                    if s and s.avg_first_response_seconds is not None
                    else None
                ),
                "avg_handle_seconds": (
                    float(s.avg_handle_seconds)
                    if s and s.avg_handle_seconds is not None
                    else None
                ),
            }
        )
    agents.sort(key=lambda a: (a["sent_messages"], a["handled_sessions"]), reverse=True)

    # --- 逐日趨勢:每日送出訊息數 + 活躍坐席數 ---
    day = func.date_trunc("day", Message.created_at).label("day")
    daily_rows = (
        await db.execute(
            select(day, func.count(), func.count(func.distinct(Message.sender_id)))
            .where(
                Message.tenant_id == staff.tenant_id,
                Message.sender_type == "human",
                Message.deleted_at.is_(None),
                Message.created_at >= since,
                Message.sender_id.isnot(None),
            )
            .group_by(day)
            .order_by(day)
        )
    ).all()
    daily = [
        {"day": d.isoformat(), "messages": int(cnt), "active_agents": int(agents_n)}
        for d, cnt, agents_n in daily_rows
    ]

    return ok({"days": days, "agents": agents, "daily": daily})


# ============================== 排程 / 訂閱式報表(Scheduled reports) ==============================
# 對齊 LiveChat 的 Scheduled reports:定期把報表寄到信箱。ReportSchedule 承載訂閱設定 +
# 排程游標;到期時由背景排程器呼叫 run_due_report_schedules 產出報表(複用既有聚合 + CSV)
# 並寄給收件人。CRUD 需 report.view(讀)/ settings.manage(寫);租戶隔離。

from app.models.report_schedule import (  # noqa: E402  (延遲於區段開頭匯入,與本檔風格一致)
    FREQUENCIES,
    REPORT_FORMATS,
    REPORT_TYPES,
    ReportSchedule,
)

# 每輪排程執行的到期訂閱撿選上限(避免單輪爆量;報表產出含 SMTP I/O)
_SCHEDULE_RUN_BATCH = 50

# 報表類型 → 顯示名(信件主旨 / 摘要標題用)
_REPORT_LABELS = {
    "overview": "總覽",
    "agents": "坐席績效",
    "sales": "銷售追蹤",
    "satisfaction": "滿意度 CSAT",
    "activity": "坐席工時 / 活動",
}

# CSV/試算表公式注入危險字元(與 exports.py 同一道防線;此處自足實作不跨檔耦合)
_CSV_INJECTION_PREFIXES = frozenset("=+-@\t\r")


def _csv_safe(value: Any) -> Any:
    """中和 CSV/試算表公式注入:字串若以危險字元開頭,前置單引號讓其被當純文字。"""
    if isinstance(value, str) and value and value[0] in _CSV_INJECTION_PREFIXES:
        return "'" + value
    return value


# --------------------------------------------------------------------------- #
# Pydantic schemas(inline,與 goals.py / auth.py 慣例一致,不動共用 schema 檔)
# --------------------------------------------------------------------------- #
class ReportScheduleCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    report_type: str = Field(..., description="overview|agents|sales|satisfaction|activity")
    frequency: str = Field(..., description="daily|weekly|monthly")
    recipients: list[str] = Field(default_factory=list, description="收件人 email 清單")
    format: str = Field(default="summary", description="summary|csv")
    is_active: bool = True


class ReportScheduleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    report_type: str | None = None
    frequency: str | None = None
    recipients: list[str] | None = None
    format: str | None = None
    is_active: bool | None = None


def _serialize_schedule(s: ReportSchedule) -> dict[str, Any]:
    return {
        "id": str(s.id),
        "name": s.name,
        "report_type": s.report_type,
        "frequency": s.frequency,
        "recipients": list(s.recipients or []),
        "format": s.format,
        "last_run_at": s.last_run_at.isoformat() if s.last_run_at else None,
        "next_run_at": s.next_run_at.isoformat() if s.next_run_at else None,
        "is_active": s.is_active,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }


def _clean_recipients(recipients: list[str] | None) -> list[str]:
    """去空白、去空字串、去重(保序);非字串忽略。"""
    out: list[str] = []
    seen: set[str] = set()
    for r in recipients or []:
        if not isinstance(r, str):
            continue
        v = r.strip()
        if v and v not in seen:
            seen.add(v)
            out.append(v)
    return out


def _add_one_month(dt: datetime) -> datetime:
    """加一個日曆月;夾住當月最後一天(避免 1/31 → 2/31 溢位)。"""
    year = dt.year + (1 if dt.month == 12 else 0)
    month = 1 if dt.month == 12 else dt.month + 1
    day = min(dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def _compute_next_run(frequency: str, base: datetime) -> datetime:
    """依頻率從 base 前推下次執行時刻。未知頻率後備為每日。"""
    if frequency == "weekly":
        return base + timedelta(days=7)
    if frequency == "monthly":
        return _add_one_month(base)
    return base + timedelta(days=1)  # daily(含未知後備)


def _validate_schedule_fields(
    report_type: str | None, frequency: str | None, fmt: str | None
) -> JSONResponse | None:
    """檢核 report_type / frequency / format 三個列舉欄位;不合法回 400 JSONResponse。"""
    if report_type is not None and report_type not in REPORT_TYPES:
        return JSONResponse(
            status_code=400,
            content=err("SCHEDULE_INVALID_TYPE", f"不支援的報表類型:{report_type}"),
        )
    if frequency is not None and frequency not in FREQUENCIES:
        return JSONResponse(
            status_code=400,
            content=err("SCHEDULE_INVALID_FREQUENCY", f"不支援的頻率:{frequency}"),
        )
    if fmt is not None and fmt not in REPORT_FORMATS:
        return JSONResponse(
            status_code=400,
            content=err("SCHEDULE_INVALID_FORMAT", f"不支援的格式:{fmt}"),
        )
    return None


async def _get_owned_schedule(
    db: AsyncSession, tenant_id: uuid.UUID, schedule_id: uuid.UUID
) -> ReportSchedule | None:
    return (
        await db.execute(
            select(ReportSchedule).where(
                ReportSchedule.id == schedule_id,
                ReportSchedule.tenant_id == tenant_id,
                ReportSchedule.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


@router.get("/schedules")
async def list_schedules(staff: CurrentStaff, db: DbSession):
    """列出本租戶的排程報表訂閱(最新在前)。需 report.view。"""
    staff.require("report.view")
    rows = (
        await db.execute(
            select(ReportSchedule)
            .where(
                ReportSchedule.tenant_id == staff.tenant_id,
                ReportSchedule.deleted_at.is_(None),
            )
            .order_by(ReportSchedule.created_at.desc())
        )
    ).scalars().all()
    return ok([_serialize_schedule(s) for s in rows])


@router.post("/schedules")
async def create_schedule(body: ReportScheduleCreate, staff: CurrentStaff, db: DbSession):
    """建立排程報表訂閱。需 settings.manage(admin 自動放行)。

    初始 ``next_run_at`` 設為 now → 下一輪排程即產出第一份;之後依 frequency 前推。
    """
    staff.require("settings.manage")
    if (invalid := _validate_schedule_fields(body.report_type, body.frequency, body.format)) is not None:
        return invalid

    now = datetime.now(timezone.utc)
    sched = ReportSchedule(
        tenant_id=staff.tenant_id,
        name=body.name.strip(),
        report_type=body.report_type,
        frequency=body.frequency,
        recipients=_clean_recipients(body.recipients),
        format=body.format,
        is_active=body.is_active,
        # 立即到期:下一輪排程即發第一份(訂閱後盡快收到);之後按頻率前推
        next_run_at=now if body.is_active else None,
    )
    db.add(sched)
    await db.commit()
    await db.refresh(sched)
    return ok(_serialize_schedule(sched))


@router.patch("/schedules/{schedule_id}")
async def update_schedule(
    schedule_id: uuid.UUID, body: ReportScheduleUpdate, staff: CurrentStaff, db: DbSession
):
    """更新排程報表訂閱(部分欄位)。需 settings.manage。

    - 變更 frequency 會依 now 重算 next_run_at;
    - 由停用轉啟用(is_active False→True)且無 next_run_at 時,設 next_run_at=now 使其重新排程。
    """
    staff.require("settings.manage")
    sched = await _get_owned_schedule(db, staff.tenant_id, schedule_id)
    if sched is None:
        return JSONResponse(status_code=404, content=err("SCHEDULE_NOT_FOUND", "排程報表不存在"))
    if (invalid := _validate_schedule_fields(body.report_type, body.frequency, body.format)) is not None:
        return invalid

    now = datetime.now(timezone.utc)
    if body.name is not None:
        sched.name = body.name.strip()
    if body.report_type is not None:
        sched.report_type = body.report_type
    if body.frequency is not None:
        sched.frequency = body.frequency
        sched.next_run_at = _compute_next_run(body.frequency, now)
    if body.recipients is not None:
        sched.recipients = _clean_recipients(body.recipients)
    if body.format is not None:
        sched.format = body.format
    if body.is_active is not None:
        was_active = sched.is_active
        sched.is_active = body.is_active
        if body.is_active and not was_active and sched.next_run_at is None:
            sched.next_run_at = now  # 重新啟用 → 立即排程
    await db.commit()
    await db.refresh(sched)
    return ok(_serialize_schedule(sched))


@router.delete("/schedules/{schedule_id}")
async def delete_schedule(schedule_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """刪除排程報表訂閱(軟刪 + 停用)。需 settings.manage。"""
    staff.require("settings.manage")
    sched = await _get_owned_schedule(db, staff.tenant_id, schedule_id)
    if sched is None:
        return JSONResponse(status_code=404, content=err("SCHEDULE_NOT_FOUND", "排程報表不存在"))
    sched.deleted_at = datetime.now(timezone.utc)
    sched.is_active = False
    await db.commit()
    return ok({"id": str(schedule_id), "deleted": True})


# --------------------------------------------------------------------------- #
# 報表產出(複用既有聚合)→ CSV / 摘要文字
# --------------------------------------------------------------------------- #
def _fmt_cell(v: Any) -> Any:
    """None → 空字串;其餘原樣(數字交給 csv.writer 序列化)。"""
    return "" if v is None else v


def _report_tabular(report_type: str, data: dict[str, Any]) -> tuple[list[str], list[list[Any]]]:
    """把某報表的聚合結果收斂成 (表頭, 逐列) 表格;CSV 與摘要共用同一結構。"""
    if report_type == "overview":
        kpi = data.get("kpi", {})
        period = data.get("period", {})
        conv = kpi.get("conversations", {})
        ai = kpi.get("ai_resolution_rate", {})
        wait = kpi.get("avg_wait_seconds", {})
        csat = kpi.get("csat", {})
        headers = ["指標", "本期值", "前期值", "環比百分比"]
        rows = [
            ["統計期間(起)", _fmt_cell(period.get("start")), "", ""],
            ["統計期間(迄)", _fmt_cell(period.get("end")), "", ""],
            ["會話總數", _fmt_cell(conv.get("value")), _fmt_cell(conv.get("prev")), _fmt_cell(conv.get("delta_pct"))],
            ["AI 解決率(%)", _fmt_cell(ai.get("value")), _fmt_cell(ai.get("prev")), _fmt_cell(ai.get("delta_pct"))],
            ["平均等待秒數", _fmt_cell(wait.get("value")), _fmt_cell(wait.get("prev")), _fmt_cell(wait.get("delta_pct"))],
            ["滿意度 CSAT(%)", _fmt_cell(csat.get("value")), _fmt_cell(csat.get("prev")), _fmt_cell(csat.get("delta_pct"))],
            ["CSAT 回應數", _fmt_cell(csat.get("responses")), "", ""],
        ]
        return headers, rows

    if report_type == "agents":
        headers = ["坐席", "接待數", "回覆訊息", "平均首次回覆(秒)", "平均處理時長(秒)"]
        rows = [
            [
                _fmt_cell(a.get("display_name")),
                _fmt_cell(a.get("reception")),
                _fmt_cell(a.get("reply_messages")),
                _fmt_cell(a.get("avg_first_response_seconds")),
                _fmt_cell(a.get("avg_handle_seconds")),
            ]
            for a in data.get("agents", [])
        ]
        return headers, rows

    if report_type == "sales":
        headers = ["幣別", "成交數", "總金額(分)"]
        rows = [
            [_fmt_cell(t.get("currency")), _fmt_cell(t.get("conversions")), _fmt_cell(t.get("total_value_cents"))]
            for t in data.get("totals", [])
        ]
        return headers, rows

    if report_type == "satisfaction":
        headers = ["指標", "值"]
        rows: list[list[Any]] = [
            ["回應數", _fmt_cell(data.get("responses"))],
            ["平均分(1-5)", _fmt_cell(data.get("avg_score"))],
        ]
        for star, cnt in sorted((data.get("distribution") or {}).items()):
            rows.append([f"{star} 星份數", _fmt_cell(cnt)])
        return headers, rows

    if report_type == "activity":
        headers = ["坐席", "處理會話", "送出訊息", "活躍小時", "平均首次回覆(秒)", "平均處理時長(秒)"]
        rows = [
            [
                _fmt_cell(a.get("display_name")),
                _fmt_cell(a.get("handled_sessions")),
                _fmt_cell(a.get("sent_messages")),
                _fmt_cell(a.get("active_hours")),
                _fmt_cell(a.get("avg_first_response_seconds")),
                _fmt_cell(a.get("avg_handle_seconds")),
            ]
            for a in data.get("agents", [])
        ]
        return headers, rows

    # 未知型別:退化為單格 JSON 摘要,不致失敗
    return ["內容"], [[json.dumps(data, ensure_ascii=False)]]


def _report_to_csv(report_type: str, data: dict[str, Any]) -> str:
    """把報表表格序列化為 CSV 文字(含 UTF-8 BOM + 公式注入中和)。"""
    headers, rows = _report_tabular(report_type, data)
    buf = io.StringIO()
    buf.write("﻿")  # BOM:Excel 開繁中不亂碼
    writer = csv.writer(buf)
    writer.writerow([_csv_safe(h) for h in headers])
    for row in rows:
        writer.writerow([_csv_safe(c) for c in row])
    return buf.getvalue()


def _report_to_summary(report_type: str, data: dict[str, Any], label: str) -> str:
    """把報表表格渲染為可讀純文字摘要(信件內文用)。"""
    headers, rows = _report_tabular(report_type, data)
    lines = [f"{label}報表", "-" * 24, " | ".join(str(h) for h in headers)]
    for row in rows:
        lines.append(" | ".join("" if c is None else str(c) for c in row))
    if not rows:
        lines.append("(本期無資料)")
    return "\n".join(lines)


async def _render_scheduled_report(
    db: AsyncSession, sched: ReportSchedule, now: datetime
) -> tuple[str, str]:
    """複用既有 reporting 聚合產出報表,依 format 回 (主旨, 內文)。

    以合成的租戶內管理者 Principal(roles=['admin'])直接呼叫既有端點函式(與
    exports.py 複用 reporting.overview 的作法一致),tenant 隔離仍由各函式以
    sched.tenant_id 過濾保證;staff_id 僅為佔位,不參與任何查詢過濾。
    """
    principal = Principal(staff_id=uuid.uuid4(), tenant_id=sched.tenant_id, roles=["admin"])
    rtype = sched.report_type
    if rtype == "agents":
        envelope = await agents_performance(principal, db)
    elif rtype == "sales":
        envelope = await sales(principal, db)
    elif rtype == "satisfaction":
        envelope = await satisfaction_summary(principal, db)
    elif rtype == "activity":
        envelope = await agent_activity(principal, db)
    else:  # overview(含未知後備)
        rtype = "overview"
        envelope = await overview(principal, db)

    data = envelope.get("data", {}) if isinstance(envelope, dict) else {}
    label = _REPORT_LABELS.get(rtype, rtype)
    subject = f"[排程報表] {sched.name} — {label}({now:%Y-%m-%d})"
    if sched.format == "csv":
        body = _report_to_csv(rtype, data)
    else:
        body = _report_to_summary(rtype, data, label)
    return subject, body


async def _resolve_tenant_smtp(db: AsyncSession, tenant_id: uuid.UUID) -> dict[str, Any]:
    """取租戶啟用中 email 渠道的 SMTP 設定(複用 auth.py 的渠道查找模式);無則回 {}。"""
    from app.models.conversation import Channel

    channel = (
        await db.execute(
            select(Channel).where(
                Channel.tenant_id == tenant_id,
                Channel.type == "email",
                Channel.is_active.is_(True),
                Channel.deleted_at.is_(None),
            )
        )
    ).scalars().first()
    return ((channel.config or {}).get("smtp") if channel and channel.config else None) or {}


async def _deliver_report(db: AsyncSession, sched: ReportSchedule, subject: str, body: str) -> bool:
    """把報表寄給訂閱收件人;無收件人 / 無 SMTP / 全數寄送失敗 → 回 False(僅記 log 不阻斷)。"""
    recipients = _clean_recipients(sched.recipients)
    if not recipients:
        logger.info("排程報表 %s 無收件人,略過寄送", sched.id)
        return False
    smtp_cfg = await _resolve_tenant_smtp(db, sched.tenant_id)
    if not smtp_cfg.get("host"):
        # 無 SMTP 基建:記 log 不阻斷(排程游標照常前推,避免每輪重打)。
        logger.info("租戶 %s 未設定 SMTP,排程報表 %s 僅記錄不寄送", sched.tenant_id, sched.id)
        return False

    from app.services.email import send_email

    sent_any = False
    for addr in recipients:
        try:
            await send_email(smtp_cfg, addr, subject, body)
            sent_any = True
        except Exception:  # noqa: BLE001 - 單一收件人失敗不影響其餘
            logger.warning("排程報表 %s 寄送至 %s 失敗", sched.id, addr, exc_info=True)
    return sent_any


async def run_due_report_schedules(db: AsyncSession, now: datetime | None = None) -> dict[str, Any]:
    """執行所有到期(``next_run_at <= now``)的排程報表,回傳本輪摘要。

    設計對齊既有 worker 慣例(見 app/workers/csat_followup.py):
    - **不 commit**:交易邊界交由呼叫端(排程器 / run_due_jobs)決定。呼叫端請在其後 commit。
    - 每一筆各自包 SAVEPOINT(``begin_nested``)+ try/except:單筆失敗(含報表產出 / SMTP /
      DB 錯誤)只回滾該筆(含其排程游標更新),不影響同批其餘,也不向外拋。
    - 產出報表複用既有 reporting 聚合 + CSV;寄信複用 app.services.email.send_email
      (無 SMTP 則記 log 不阻斷)。成功 / 略過(無收件人或無 SMTP)皆前推排程游標,
      避免每輪重打;唯有例外(begin_nested 內拋出)才不前推,留待下輪重試。

    **排程器接線**(由主 session 完成):可於 app/workers/ 新增一支 worker 以
    ``@register_worker`` 呼叫本函式並在 jobs.py 匯入,或於 main.py 的 leader 區塊
    直接 ``await run_due_report_schedules(db)`` 後 commit。

    回傳:``{"due": n, "sent": n, "skipped": n, "failed": n}``。
    """
    now = now or datetime.now(timezone.utc)

    due = (
        await db.execute(
            select(ReportSchedule)
            .where(
                ReportSchedule.is_active.is_(True),
                ReportSchedule.deleted_at.is_(None),
                or_(ReportSchedule.next_run_at.is_(None), ReportSchedule.next_run_at <= now),
            )
            .order_by(ReportSchedule.next_run_at.asc().nullsfirst())
            .limit(_SCHEDULE_RUN_BATCH)
        )
    ).scalars().all()

    summary = {"due": len(due), "sent": 0, "skipped": 0, "failed": 0}
    for sched in due:
        try:
            async with db.begin_nested():
                subject, body = await _render_scheduled_report(db, sched, now)
                delivered = await _deliver_report(db, sched, subject, body)
                # 前推排程游標(成功或略過皆前推,避免每輪重打)
                sched.last_run_at = now
                sched.next_run_at = _compute_next_run(sched.frequency, now)
                await db.flush()
            summary["sent" if delivered else "skipped"] += 1
        except Exception:  # noqa: BLE001 - 單筆失敗不拖垮其餘;不前推游標→下輪重試
            summary["failed"] += 1
            logger.exception("排程報表執行失敗:%s", getattr(sched, "id", "?"))

    if summary["due"]:
        logger.info(
            "排程報表本輪:到期=%d 寄出=%d 略過=%d 失敗=%d",
            summary["due"],
            summary["sent"],
            summary["skipped"],
            summary["failed"],
        )
    return summary
