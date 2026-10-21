"""M8 routing 會話分配服務。

對外主入口:

    async def assign_session(db, tenant_id, session_id) -> uuid.UUID | None

依規則把會話指派給某坐席,或留在佇列(回傳 None)。流程:

  1. 讀取會話(租戶隔離);已關閉/不存在則不分配。
  2. 依 session.skill_group_id 找該技能組的 RoutingPolicy(找不到回退租戶預設,
     再找不到用內建預設 least_load / max_load=5)。
  3. 取候選坐席:屬於該技能組、在線(Staff.status == 'online')、is_active。
     會話無技能組時,取租戶內所有在線坐席。
  4. 計算每位候選的目前負載(該坐席正在接待的 open 人工會話數),過濾掉已達上限者。
  5. 依策略挑選:
       - least_load:負載最少者(同分以 id 穩定排序,近似輪詢)。
       - round_robin:游標之後的下一位。
       - llm:呼叫智能分配掛鉤;預設未注入 → 回退 least_load。
  6. 有可用坐席 → 指派(handler_staff_id/handler_type='human'、status='open'),
     更新 round_robin 游標;否則會話入佇列(status='queued'、handler_staff_id=None)。
  7. 發 realtime 事件(import try/except 降級,realtime 模組缺席不影響分配)。

在線與負載採「查 Session/Staff 統計」實作(不強依賴 Redis),部署無 Redis 亦可運作。
"""
from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

from app.models.conversation import Session
from app.models.iam import Staff, staff_skillgroup
from app.models.routing import (
    DEFAULT_MAX_LOAD,
    DEFAULT_STRATEGY,
    RoutingPolicy,
)

# ---------------------------------------------------------------------------
# 智能分配掛鉤(可選 LLM)
# ---------------------------------------------------------------------------
# 介面:async (tenant_id, session, candidates) -> uuid.UUID | None
#   - 回傳某候選 id → 採用該指派
#   - 回傳 None      → 交回規則式(least_load)決定
# 預設不注入(_llm_assigner is None),整合方可用 set_llm_assigner() 掛入。
LLMAssigner = Callable[[uuid.UUID, Session, "list[AgentLoad]"], Awaitable[uuid.UUID | None]]
_llm_assigner: LLMAssigner | None = None


def set_llm_assigner(fn: LLMAssigner | None) -> None:
    """注入(或清除)LLM 智能分配掛鉤。預設走規則式。"""
    global _llm_assigner
    _llm_assigner = fn


@dataclass
class AgentLoad:
    """一位候選坐席的即時負載快照。"""

    staff_id: uuid.UUID
    current_load: int
    max_load: int

    @property
    def available(self) -> bool:
        return self.current_load < self.max_load


# ---------------------------------------------------------------------------
# realtime 事件(缺席時降級)
# ---------------------------------------------------------------------------
async def _emit(tenant_id: uuid.UUID, event_type: str, payload: dict) -> None:
    """把會話生命週期事件發到「租戶坐席工作台」頻道;realtime 缺席時安靜降級。

    session.queued / session.assigned 屬會話列表層級的生命週期事件,依 realtime.py
    的頻道設計應走 ``publish_agents(tenant_id, event)``——投遞到 ``rt:{tenant}:agents``,
    供坐席工作台(/ws/agent)即時更新佇列/接待列表。事件需為統一封包 {type, payload,
    ts},故先以 ``make_event(type, payload)`` 包好再送。

    註:realtime.publish 的正確簽名為 ``publish(tenant_id, session_id, event)``(單一
    會話頻道),舊版誤以 ``publish(event, payload)`` 兩參呼叫,每次都 TypeError 而被
    ``except: pass`` 吞掉,事件從未送達。改為正確的 publish_agents 呼叫。
    """
    try:  # realtime 為選配:模組尚未落地時安靜降級,不影響分配主流程
        from app.services import realtime  # type: ignore
    except ImportError:
        return

    try:
        event = realtime.make_event(event_type, payload)
        await realtime.publish_agents(tenant_id, event)
    except Exception:  # noqa: BLE001
        # 事件僅為通知用途,失敗不阻斷分配主流程;但改為記錄而非靜默吞掉——
        # 否則 TypeError(簽名不符)之類的真錯誤會再次被藏起來。
        logger.exception("realtime publish_agents 失敗:event=%s payload=%s", event_type, payload)


# ---------------------------------------------------------------------------
# 策略/負載查詢
# ---------------------------------------------------------------------------
async def resolve_policy(
    db: AsyncSession, tenant_id: uuid.UUID, skill_group_id: uuid.UUID | None
) -> RoutingPolicy | None:
    """取該技能組策略;找不到回退租戶預設(skill_group_id 為 NULL)。皆無回傳 None。"""
    if skill_group_id is not None:
        policy = (
            await db.execute(
                select(RoutingPolicy).where(
                    RoutingPolicy.tenant_id == tenant_id,
                    RoutingPolicy.skill_group_id == skill_group_id,
                    RoutingPolicy.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if policy is not None:
            return policy
    # 回退租戶預設
    return (
        await db.execute(
            select(RoutingPolicy).where(
                RoutingPolicy.tenant_id == tenant_id,
                RoutingPolicy.skill_group_id.is_(None),
                RoutingPolicy.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


async def _online_agents(
    db: AsyncSession, tenant_id: uuid.UUID, skill_group_id: uuid.UUID | None
) -> list[uuid.UUID]:
    """取候選坐席 id:在線 + is_active + 租戶隔離;有技能組則限該組成員。"""
    stmt = select(Staff.id).where(
        Staff.tenant_id == tenant_id,
        Staff.is_active.is_(True),
        Staff.status == "online",
        Staff.deleted_at.is_(None),
    )
    if skill_group_id is not None:
        stmt = stmt.join(
            staff_skillgroup, staff_skillgroup.c.staff_id == Staff.id
        ).where(staff_skillgroup.c.skillgroup_id == skill_group_id)
    return list((await db.execute(stmt.order_by(Staff.id))).scalars().all())


async def _current_loads(
    db: AsyncSession, tenant_id: uuid.UUID, staff_ids: list[uuid.UUID]
) -> dict[uuid.UUID, int]:
    """計算每位坐席目前接待中的 open 人工會話數(租戶隔離)。"""
    if not staff_ids:
        return {}
    rows = (
        await db.execute(
            select(Session.handler_staff_id, func.count(Session.id))
            .where(
                Session.tenant_id == tenant_id,
                Session.handler_staff_id.in_(staff_ids),
                Session.handler_type == "human",
                Session.status == "open",
                Session.deleted_at.is_(None),
            )
            .group_by(Session.handler_staff_id)
        )
    ).all()
    loads = {sid: 0 for sid in staff_ids}
    for sid, cnt in rows:
        loads[sid] = cnt
    return loads


async def agent_loads(
    db: AsyncSession, tenant_id: uuid.UUID, skill_group_id: uuid.UUID | None
) -> list[AgentLoad]:
    """回傳候選坐席的負載快照列表(供分配決策與 API 佇列/儀表板查詢)。"""
    policy = await resolve_policy(db, tenant_id, skill_group_id)
    max_load = policy.max_load if policy else DEFAULT_MAX_LOAD
    staff_ids = await _online_agents(db, tenant_id, skill_group_id)
    loads = await _current_loads(db, tenant_id, staff_ids)
    # 依 id 穩定排序,round_robin 與 least_load 同分挑選皆可預期
    return [AgentLoad(staff_id=sid, current_load=loads[sid], max_load=max_load) for sid in staff_ids]


def _pick_least_load(candidates: list[AgentLoad]) -> AgentLoad | None:
    """挑負載最少的可用坐席(同分取 id 較小者,穩定)。"""
    available = [c for c in candidates if c.available]
    if not available:
        return None
    return min(available, key=lambda c: (c.current_load, c.staff_id.bytes))


def _pick_round_robin(
    candidates: list[AgentLoad], cursor: uuid.UUID | None
) -> AgentLoad | None:
    """輪詢:挑游標之後的下一位可用坐席(candidates 已依 id 排序)。"""
    available = [c for c in candidates if c.available]
    if not available:
        return None
    if cursor is None:
        return available[0]
    # 找出游標在可用列表中的位置,取其後一位(繞回)
    ids = [c.staff_id for c in available]
    if cursor in ids:
        idx = ids.index(cursor)
        return available[(idx + 1) % len(available)]
    # 游標坐席已不在可用列表:取第一位 id 大於游標者,否則繞回第一位
    for c in available:
        if c.staff_id.bytes > cursor.bytes:
            return c
    return available[0]


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------
async def assign_session(
    db: AsyncSession, tenant_id: uuid.UUID, session_id: uuid.UUID
) -> uuid.UUID | None:
    """依規則指派會話給某坐席;無可用坐席則入佇列。回傳被指派的坐席 id 或 None。"""
    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None or session.status == "closed":
        return None

    policy = await resolve_policy(db, tenant_id, session.skill_group_id)
    strategy = policy.strategy if policy else DEFAULT_STRATEGY
    candidates = await agent_loads(db, tenant_id, session.skill_group_id)

    chosen: AgentLoad | None = None
    if strategy == "llm" and _llm_assigner is not None:
        picked_id = await _llm_assigner(tenant_id, session, candidates)
        if picked_id is not None:
            chosen = next(
                (c for c in candidates if c.staff_id == picked_id and c.available), None
            )
        # LLM 回 None 或挑了不可用坐席 → 回退規則式
        if chosen is None:
            chosen = _pick_least_load(candidates)
    elif strategy == "round_robin":
        chosen = _pick_round_robin(candidates, policy.rr_cursor if policy else None)
    else:  # least_load(含 llm 未注入時的回退)
        chosen = _pick_least_load(candidates)

    if chosen is None:
        # 無可用坐席 → 入佇列
        await _enqueue(db, session)
        return None

    return await _do_assign(db, session, chosen.staff_id, policy, strategy)


async def _enqueue(db: AsyncSession, session: Session) -> None:
    """會話入佇列(尚無可用坐席)。"""
    session.status = "queued"
    session.handler_staff_id = None
    await db.commit()
    await db.refresh(session)
    await _emit(
        session.tenant_id,
        "session.queued",
        {
            "tenant_id": str(session.tenant_id),
            "session_id": str(session.id),
            "skill_group_id": str(session.skill_group_id) if session.skill_group_id else None,
        },
    )


async def _do_assign(
    db: AsyncSession,
    session: Session,
    staff_id: uuid.UUID,
    policy: RoutingPolicy | None,
    strategy: str,
) -> uuid.UUID:
    """落實指派:更新會話持有人,round_robin 更新游標,發事件。"""
    session.handler_staff_id = staff_id
    session.handler_type = "human"
    session.status = "open"
    if strategy == "round_robin" and policy is not None:
        policy.rr_cursor = staff_id
    await db.commit()
    await db.refresh(session)
    await _emit(
        session.tenant_id,
        "session.assigned",
        {
            "tenant_id": str(session.tenant_id),
            "session_id": str(session.id),
            "staff_id": str(staff_id),
            "strategy": strategy,
        },
    )
    return staff_id


async def manual_assign(
    db: AsyncSession, tenant_id: uuid.UUID, session_id: uuid.UUID, staff_id: uuid.UUID
) -> uuid.UUID | None:
    """手動把會話指派給指定坐席(需同租戶且 active)。成功回傳 staff_id,否則 None。"""
    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None or session.status == "closed":
        return None
    staff = (
        await db.execute(
            select(Staff).where(
                Staff.id == staff_id,
                Staff.tenant_id == tenant_id,
                Staff.is_active.is_(True),
                Staff.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if staff is None:
        return None
    # 手動指派不受策略/上限限制(主管可強制指派)
    return await _do_assign(db, session, staff_id, None, "manual")


async def list_queue(
    db: AsyncSession, tenant_id: uuid.UUID, skill_group_id: uuid.UUID | None = None
) -> list[Session]:
    """列出佇列中(status='queued')的會話,租戶隔離,可選技能組過濾。"""
    stmt = select(Session).where(
        Session.tenant_id == tenant_id,
        Session.status == "queued",
        Session.deleted_at.is_(None),
    )
    if skill_group_id is not None:
        stmt = stmt.where(Session.skill_group_id == skill_group_id)
    return list((await db.execute(stmt.order_by(Session.created_at))).scalars().all())
