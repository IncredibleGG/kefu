"""原生 App 裝置登記 API(docs/NATIVE-CLIENTS.md §4.1)。前綴 ``/api/v1/devices``,需登入。

- ``POST /``:``{token, platform, device_id, app_version, os_version?, locale?}`` → upsert,
  回 ``{id, push_enabled}``。
  - 同一 token 若屬於別的坐席 / 別的裝置(共用手機換人登入),先刪掉舊列,權杖「搬家」。
  - 以 ``(staff_id, device_id)`` 為鍵 upsert;清除 ``revoked_at``、更新 ``last_seen_at``。
  - 每位坐席最多 ``MAX_DEVICES_PER_STAFF`` 台未撤銷裝置,超過時撤銷最久未見的。
  - 桌面(Tauri)沒有 FCM 權杖:token 可省略,以 ``desktop:{device_id}`` 合成識別值(只登記不推)。
- ``DELETE /{device_id}``:撤銷**自己的**裝置(設 ``revoked_at``);登出時前端先呼叫再清 token。
  冪等:查無(或屬於他人)時回 ``revoked:false``,不揭露他人裝置是否存在。
- ``GET /``:列出自己的裝置(預設只列未撤銷;``include_revoked=true`` 含已撤銷)。不回傳權杖。

推播是否真的會送出由 ``push.is_configured()`` 決定;未設定時照常收 token,``push_enabled`` 為 false。
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, or_, select
from sqlalchemy.exc import IntegrityError

from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.models.device import DeviceToken
from app.services import push

router = APIRouter()

# 每位坐席最多保留的未撤銷裝置數
MAX_DEVICES_PER_STAFF = 10
# device_id:App 安裝時產生的穩定 UUID;只收安全字元(與 presence.clean_device_id 一致)
_DEVICE_ID_PATTERN = r"^[A-Za-z0-9._:-]{1,128}$"
# FCM 權杖實際約 150~300 字;上限 2048(ASCII)以保 PostgreSQL btree 唯一索引不超過單列上限
_TOKEN_MAX = 2048


class DeviceIn(BaseModel):
    token: str = Field(default="", max_length=_TOKEN_MAX)
    platform: Literal["ios", "android", "desktop"]
    device_id: str = Field(pattern=_DEVICE_ID_PATTERN)
    app_version: str = Field(default="", max_length=32)
    os_version: str | None = Field(default=None, max_length=32)
    locale: str | None = Field(default=None, max_length=16)


def _serialize(d: DeviceToken) -> dict:
    return {
        "id": str(d.id),
        "device_id": d.device_id,
        "platform": d.platform,
        "provider": d.provider,
        "app_version": d.app_version,
        "os_version": d.os_version,
        "locale": d.locale,
        "last_seen_at": d.last_seen_at.isoformat() if d.last_seen_at else None,
        "created_at": d.created_at.isoformat() if d.created_at else None,
        "revoked_at": d.revoked_at.isoformat() if d.revoked_at else None,
    }


def _push_enabled() -> bool:
    try:
        return bool(push.is_configured())
    except Exception:  # noqa: BLE001
        return False


async def _upsert(db, staff, body: DeviceIn, token: str) -> DeviceToken:
    """權杖搬家 + (staff_id, device_id) upsert + 每人上限;只 flush,由呼叫端 commit。"""
    now = datetime.now(UTC)

    # 1) 權杖搬家:同一 token 掛在別的坐席或本人別的裝置 → 刪除舊列(避免推給上一位使用者)
    await db.execute(
        delete(DeviceToken).where(
            DeviceToken.token == token,
            or_(DeviceToken.staff_id != staff.staff_id, DeviceToken.device_id != body.device_id),
        )
    )

    # 2) 以 (staff_id, device_id) upsert
    device = (
        await db.execute(
            select(DeviceToken).where(
                DeviceToken.staff_id == staff.staff_id,
                DeviceToken.device_id == body.device_id,
            )
        )
    ).scalar_one_or_none()
    if device is None:
        device = DeviceToken(
            tenant_id=staff.tenant_id,
            staff_id=staff.staff_id,
            device_id=body.device_id,
            token=token,
            platform=body.platform,
        )
        db.add(device)
    device.tenant_id = staff.tenant_id
    device.token = token
    device.platform = body.platform
    device.provider = "fcm"
    device.app_version = body.app_version.strip()
    device.os_version = (body.os_version or "").strip() or None
    device.locale = (body.locale or "").strip() or None
    device.last_seen_at = now
    device.revoked_at = None
    device.deleted_at = None
    await db.flush()

    # 3) 每人上限:撤銷超出上限中最久未見的(本次登記的裝置一定保留)
    active = list(
        (
            await db.execute(
                select(DeviceToken)
                .where(
                    DeviceToken.staff_id == staff.staff_id,
                    DeviceToken.revoked_at.is_(None),
                    DeviceToken.id != device.id,
                )
                .order_by(DeviceToken.last_seen_at.desc(), DeviceToken.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    for old in active[MAX_DEVICES_PER_STAFF - 1 :]:
        old.revoked_at = now
    return device


@router.post("")
async def register_device(body: DeviceIn, staff: CurrentStaff, db: DbSession):
    """登記 / 更新本人的裝置推播權杖(upsert)。"""
    token = body.token.strip()
    if not token:
        if body.platform != "desktop":
            return err("bad_request", "token is required for mobile devices")
        token = f"desktop:{body.device_id}"
    if any(ch.isspace() for ch in token):
        return err("bad_request", "invalid token")
    # 併發登記同一新裝置 / 同一權杖時可能撞唯一約束:回滾後重做一次(第二次必看得到對方的列)
    for attempt in range(2):
        try:
            device = await _upsert(db, staff, body, token)
            await db.commit()
            break
        except IntegrityError:
            await db.rollback()
            if attempt:
                return err("conflict", "device registration conflict, please retry")
    return ok({"id": str(device.id), "push_enabled": _push_enabled()})


@router.delete("/{device_id}")
async def revoke_device(device_id: str, staff: CurrentStaff, db: DbSession):
    """撤銷本人的某台裝置(登出時呼叫)。只能撤銷自己的;冪等。"""
    device = (
        await db.execute(
            select(DeviceToken).where(
                DeviceToken.staff_id == staff.staff_id,
                DeviceToken.tenant_id == staff.tenant_id,
                DeviceToken.device_id == device_id,
            )
        )
    ).scalar_one_or_none()
    if device is None:
        return ok({"device_id": device_id, "revoked": False})
    if device.revoked_at is None:
        device.revoked_at = datetime.now(UTC)
        await db.commit()
    return ok({"device_id": device_id, "revoked": True})


@router.get("")
async def list_devices(
    staff: CurrentStaff,
    db: DbSession,
    include_revoked: bool = Query(default=False),
):
    """列出本人的裝置(依最後使用時間新到舊)。不回傳推播權杖。"""
    stmt = select(DeviceToken).where(
        DeviceToken.staff_id == staff.staff_id,
        DeviceToken.tenant_id == staff.tenant_id,
        DeviceToken.deleted_at.is_(None),
    )
    if not include_revoked:
        stmt = stmt.where(DeviceToken.revoked_at.is_(None))
    rows = (await db.execute(stmt.order_by(DeviceToken.last_seen_at.desc()))).scalars().all()
    return ok({"items": [_serialize(d) for d in rows], "push_enabled": _push_enabled()})
