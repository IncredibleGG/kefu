"""P0 租戶客服設定 API:營業時間 / 離線留言 / pre-chat / widget 主題。

掛載前綴(整合者於 main.py 註冊):`/api/v1/settings`
    app.include_router(settings.router, prefix="/api/v1/settings", tags=["settings"])

端點:
- GET  `/api/v1/settings`                 取本租戶設定(admin;無則回預設)。
- PUT  `/api/v1/settings`                 建立/更新本租戶設定(admin,upsert)。
- GET  `/api/v1/settings/public/{channel_key}`  公開端點(無 JWT),供 widget 讀取:
       回 營業狀態 is_online + 離線留言 + prechat 設定 + widget_theme(不含機敏)。

規則:管理端一律以 principal.tenant_id 過濾;公開端以 channel_key(渠道 public_key)
定位租戶,再讀該租戶設定。所有回應走 ok()/err()。
"""
from __future__ import annotations

from datetime import datetime, time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.v1.channel import _channel_by_public_key
from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.models.settings import TenantSettings

router = APIRouter()

# 週一~週日對應 Python datetime.weekday()(Monday=0)的鍵
_WEEKDAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


# --------------------------------------------------------------------------- #
# Pydantic schema
# --------------------------------------------------------------------------- #
class SettingsUpdateIn(BaseModel):
    """PUT 內容;皆選填,傳入即整段覆寫該欄位。"""

    business_hours: dict | None = None
    offline_message: str | None = Field(default=None, max_length=2000)
    prechat_enabled: bool | None = None
    prechat_fields: list | None = None
    widget_theme: dict | None = None
    timezone: str | None = Field(default=None, max_length=64)


# --------------------------------------------------------------------------- #
# 營業時間判定(純函式,便於測試)
# --------------------------------------------------------------------------- #
def _parse_hhmm(value: str) -> time | None:
    try:
        hh, mm = value.split(":")
        return time(hour=int(hh), minute=int(mm))
    except (ValueError, AttributeError):
        return None


def compute_is_online(business_hours: dict | None, now: datetime | None = None) -> bool:
    """依 business_hours 與其時區,判斷「現在」是否營業。

    - business_hours 為 None / 無 days → 視為全天營業(True)。
    - days[<weekday>] 為 [[start, end], ...] 的時段清單;空清單 = 當日休息。
    - end <= start 視為跨午夜時段(例如 22:00~02:00)。
    - 時區取 business_hours["timezone"](IANA),無效或缺省則用 UTC。
    """
    if not business_hours or not isinstance(business_hours, dict):
        return True
    days = business_hours.get("days")
    if not isinstance(days, dict) or not days:
        return True

    tz_name = business_hours.get("timezone") or "UTC"
    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        tz = ZoneInfo("UTC")

    ref = now.astimezone(tz) if now is not None else datetime.now(tz)
    cur = ref.time()

    def _in_ranges(ranges) -> bool:
        for rng in ranges or []:
            if not isinstance(rng, (list, tuple)) or len(rng) != 2:
                continue
            start, end = _parse_hhmm(rng[0]), _parse_hhmm(rng[1])
            if start is None or end is None:
                continue
            if start < end and start <= cur < end:
                return True
            # 跨午夜:落在 start~24:00 或 00:00~end
            if end < start and (cur >= start or cur < end):
                return True
            # start == end:視為 0 長度,不營業
        return False

    today_key = _WEEKDAY_KEYS[ref.weekday()]
    if _in_ranges(days.get(today_key)):
        return True
    # 跨午夜時段可能屬於「昨天」延續到今日凌晨
    yday_key = _WEEKDAY_KEYS[(ref.weekday() - 1) % 7]
    for rng in days.get(yday_key) or []:
        if not isinstance(rng, (list, tuple)) or len(rng) != 2:
            continue
        start, end = _parse_hhmm(rng[0]), _parse_hhmm(rng[1])
        if start is None or end is None:
            continue
        if end < start and cur < end:  # 昨日跨午夜段延續至今日凌晨
            return True
    return False


# --------------------------------------------------------------------------- #
# 序列化
# --------------------------------------------------------------------------- #
def _full_dict(s: TenantSettings) -> dict:
    return {
        "tenant_id": str(s.tenant_id),
        "business_hours": s.business_hours,
        "offline_message": s.offline_message,
        "prechat_enabled": s.prechat_enabled,
        "prechat_fields": s.prechat_fields,
        "widget_theme": s.widget_theme,
        "timezone": s.timezone,
        "updated_at": s.updated_at.isoformat() if s.updated_at else None,
    }


def _defaults_dict(tenant_id) -> dict:
    """尚未建立設定時回傳的預設(視為全天營業、無 prechat)。"""
    return {
        "tenant_id": str(tenant_id),
        "business_hours": None,
        "offline_message": None,
        "prechat_enabled": False,
        "prechat_fields": None,
        "widget_theme": None,
        "timezone": None,
        "updated_at": None,
    }


def _public_dict(s: TenantSettings | None) -> dict:
    """widget 可讀的公開子集(不含機敏)。s 為 None 時回全天營業預設。"""
    bh = s.business_hours if s else None
    return {
        "is_online": compute_is_online(bh),
        "offline_message": (s.offline_message if s else None),
        "prechat_enabled": (s.prechat_enabled if s else False),
        "prechat_fields": (s.prechat_fields if s else None),
        "widget_theme": (s.widget_theme if s else None),
        "business_hours": bh,
        "timezone": (s.timezone if s else None) or (bh.get("timezone") if isinstance(bh, dict) else None),
    }


# --------------------------------------------------------------------------- #
# DB 取用
# --------------------------------------------------------------------------- #
async def _get_settings(db, tenant_id) -> TenantSettings | None:
    return (
        await db.execute(
            select(TenantSettings).where(
                TenantSettings.tenant_id == tenant_id,
                TenantSettings.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


# --------------------------------------------------------------------------- #
# 管理端(需 JWT + admin/settings.manage)
# --------------------------------------------------------------------------- #
@router.get("")
async def get_settings(staff: CurrentStaff, db: DbSession):
    """取本租戶客服設定;尚未建立則回預設值。"""
    staff.require("settings.manage")
    row = await _get_settings(db, staff.tenant_id)
    if row is None:
        return ok(_defaults_dict(staff.tenant_id))
    return ok(_full_dict(row))


@router.put("")
async def put_settings(body: SettingsUpdateIn, staff: CurrentStaff, db: DbSession):
    """建立/更新本租戶客服設定(upsert)。傳入的欄位整段覆寫。"""
    staff.require("settings.manage")
    row = await _get_settings(db, staff.tenant_id)
    if row is None:
        row = TenantSettings(tenant_id=staff.tenant_id)
        db.add(row)

    data = body.model_dump(exclude_unset=True)
    if "business_hours" in data:
        row.business_hours = data["business_hours"]
    if "offline_message" in data:
        row.offline_message = data["offline_message"]
    if "prechat_enabled" in data and data["prechat_enabled"] is not None:
        row.prechat_enabled = data["prechat_enabled"]
    if "prechat_fields" in data:
        row.prechat_fields = data["prechat_fields"]
    if "widget_theme" in data:
        row.widget_theme = data["widget_theme"]
    if "timezone" in data:
        row.timezone = data["timezone"]

    await db.commit()
    await db.refresh(row)
    return ok(_full_dict(row))


# --------------------------------------------------------------------------- #
# 公開端(無 JWT):widget 讀營業狀態 + prechat + 主題
# --------------------------------------------------------------------------- #
@router.get("/public/{channel_key}")
async def public_settings(channel_key: str, db: DbSession):
    """widget 依 channel_key(渠道 public_key)取公開設定與即時營業狀態。"""
    channel = await _channel_by_public_key(db, channel_key)
    if channel is None:
        return JSONResponse(status_code=404, content=err("CHANNEL_NOT_FOUND", "渠道不存在"))
    row = await _get_settings(db, channel.tenant_id)
    return ok(_public_dict(row))
