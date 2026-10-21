"""坐席排班 Work Scheduler API(對齊 LiveChat 的 Work Scheduler)。

以「每週循環班表」表示坐席每天的上線時段(分鐘為單位,0=午夜),供:
- 顯示與維護某坐席每週的上線時段;
- 查詢「目前在班」的坐席清單(依**租戶當地時區**換算的 weekday + 分鐘落點)。

在班判斷一律以租戶時區為基準(而非伺服器本地 naive 時間),避免跨時區租戶
「在班/離班」誤判。時區來源見 ``_resolve_tenant_tz``;查無設定時退回 UTC。

註冊建議(由 main.py 掛載):
    app.include_router(scheduling.router, prefix="/api/v1/scheduling", tags=["scheduling"])

規則:
- 所有查詢一律以 principal.tenant_id 過濾(租戶隔離)。
- 讀取(列班表 / 在班)僅需登入(CurrentStaff);整組覆寫需 staff.manage。
- 回應統一走 ok()/err() 信封;業務驗證錯誤回 err() 而非 422。
- weekday 對齊模型:0=週一 … 6=週日(與 Python datetime.weekday() 相同)。
"""
from __future__ import annotations

import uuid
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.models.iam import Staff
from app.models.scheduling import StaffShift
from app.models.settings import TenantSettings

router = APIRouter()

MINUTES_PER_DAY = 1440


# --------------------------------------------------------------------------- #
# 租戶時區 → 「當地此刻」的 weekday/分鐘(在班判斷的基準)
# --------------------------------------------------------------------------- #
async def _resolve_tenant_tz(db, tenant_id) -> ZoneInfo:
    """解析租戶時區,回 ZoneInfo。

    來源優先序(不臆造欄位,完全沿用既有 TenantSettings 結構):
      1. ``TenantSettings.timezone``(冗餘快取欄,見 models/settings.py);
      2. ``TenantSettings.business_hours["timezone"]``(is_online 判斷同源);
      3. 皆無 / 無效 IANA 名稱 → 退回 UTC。
    """
    row = (
        await db.execute(
            select(TenantSettings.timezone, TenantSettings.business_hours).where(
                TenantSettings.tenant_id == tenant_id,
                TenantSettings.deleted_at.is_(None),
            )
        )
    ).first()
    tz_name: str | None = None
    if row is not None:
        tz_name = row[0]
        if not tz_name and isinstance(row[1], dict):
            tz_name = row[1].get("timezone")
    if not tz_name:
        return ZoneInfo("UTC")
    try:
        return ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        return ZoneInfo("UTC")


async def _tenant_local_weekday_minute(db, tenant_id) -> tuple[int, int]:
    """回租戶當地此刻的 (weekday, minute):weekday 0=週一…6=週日,minute=0..1439。"""
    now = datetime.now(await _resolve_tenant_tz(db, tenant_id))
    return now.weekday(), now.hour * 60 + now.minute


async def staff_ids_on_shift(db, tenant_id) -> set[uuid.UUID]:
    """回本租戶「目前在班」的坐席 id 集合(依租戶當地時區換算的落點)。

    僅計 ``enabled`` 且時段涵蓋當下(``start_minute <= 分鐘 < end_minute``)的班次。
    無班表 / 當下無人在班 → 回空集合(由呼叫端決定回退策略)。

    供 API ``/on-shift`` 與 dispatch 的「在班過濾(可回退)」共用,確保兩處判斷同源。
    """
    weekday, minute = await _tenant_local_weekday_minute(db, tenant_id)
    rows = (
        await db.execute(
            select(StaffShift.staff_id)
            .where(
                StaffShift.tenant_id == tenant_id,
                StaffShift.deleted_at.is_(None),
                StaffShift.enabled.is_(True),
                StaffShift.weekday == weekday,
                StaffShift.start_minute <= minute,
                StaffShift.end_minute > minute,
            )
            .distinct()
        )
    ).scalars().all()
    return set(rows)


# --------------------------------------------------------------------------- #
# Pydantic schema
# --------------------------------------------------------------------------- #
class ShiftIn(BaseModel):
    """單一上線時段(整組覆寫時的元素)。範圍驗證在 handler 內以 err() 回覆。"""

    weekday: int
    start_minute: int
    end_minute: int
    enabled: bool = True


class ShiftsPutIn(BaseModel):
    shifts: list[ShiftIn] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# 序列化
# --------------------------------------------------------------------------- #
def _shift_dict(s: StaffShift) -> dict:
    return {
        "id": str(s.id),
        "staff_id": str(s.staff_id),
        "weekday": s.weekday,
        "start_minute": s.start_minute,
        "end_minute": s.end_minute,
        "enabled": s.enabled,
    }


async def _staff_in_tenant(db, tenant_id, staff_id) -> Staff | None:
    return (
        await db.execute(
            select(Staff).where(
                Staff.id == staff_id,
                Staff.tenant_id == tenant_id,
                Staff.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


# =========================================================================== #
# 班表 CRUD
# =========================================================================== #
@router.get("/shifts")
async def list_shifts(
    principal: CurrentStaff,
    db: DbSession,
    staff_id: uuid.UUID | None = Query(None, description="僅列出指定坐席的班表;省略則列全租戶"),
):
    """列出班表(租戶隔離;可 ?staff_id= 篩選單一坐席)。"""
    stmt = select(StaffShift).where(
        StaffShift.tenant_id == principal.tenant_id,
        StaffShift.deleted_at.is_(None),
    )
    if staff_id is not None:
        stmt = stmt.where(StaffShift.staff_id == staff_id)
    rows = (
        await db.execute(
            stmt.order_by(
                StaffShift.staff_id, StaffShift.weekday, StaffShift.start_minute
            )
        )
    ).scalars().all()
    return ok({"items": [_shift_dict(s) for s in rows], "total": len(rows)})


@router.put("/staff/{staff_id}/shifts")
async def set_staff_shifts(
    staff_id: uuid.UUID, body: ShiftsPutIn, principal: CurrentStaff, db: DbSession
):
    """整組覆寫某坐席的每週班表(先清空該坐席既有班次,再依 body 重建)。"""
    principal.require("staff.manage")
    staff = await _staff_in_tenant(db, principal.tenant_id, staff_id)
    if not staff:
        return err("STAFF_NOT_FOUND", "坐席不存在或不屬本租戶")

    # 逐筆驗證:weekday 0-6、0 ≤ start < end ≤ 1440
    for s in body.shifts:
        if not (0 <= s.weekday <= 6):
            return err("SCHEDULE_INVALID_WEEKDAY", f"weekday 需為 0-6:{s.weekday}")
        if not (0 <= s.start_minute < s.end_minute <= MINUTES_PER_DAY):
            return err(
                "SCHEDULE_INVALID_RANGE",
                f"時段需滿足 0 ≤ start < end ≤ {MINUTES_PER_DAY}:{s.start_minute}-{s.end_minute}",
            )

    # 整組覆寫:硬刪該坐席既有班次(本租戶),再插入新集合
    await db.execute(
        delete(StaffShift).where(
            StaffShift.tenant_id == principal.tenant_id,
            StaffShift.staff_id == staff_id,
        )
    )
    for s in body.shifts:
        db.add(
            StaffShift(
                tenant_id=principal.tenant_id,
                staff_id=staff_id,
                weekday=s.weekday,
                start_minute=s.start_minute,
                end_minute=s.end_minute,
                enabled=s.enabled,
            )
        )
    await db.commit()

    rows = (
        await db.execute(
            select(StaffShift)
            .where(
                StaffShift.tenant_id == principal.tenant_id,
                StaffShift.staff_id == staff_id,
                StaffShift.deleted_at.is_(None),
            )
            .order_by(StaffShift.weekday, StaffShift.start_minute)
        )
    ).scalars().all()
    return ok({"staff_id": str(staff_id), "items": [_shift_dict(s) for s in rows]})


@router.get("/on-shift")
async def on_shift(principal: CurrentStaff, db: DbSession):
    """回目前「在班」的坐席 id 清單:依**租戶當地時區**的 weekday + 分鐘,落在某 enabled 班次內。"""
    weekday, minute = await _tenant_local_weekday_minute(db, principal.tenant_id)
    ids = await staff_ids_on_shift(db, principal.tenant_id)
    return ok(
        {"staff_ids": [str(i) for i in ids], "weekday": weekday, "minute": minute}
    )
