"""對外 Webhook 管理 API:endpoint CRUD + 測試發送。

掛載前綴(整合方於 main.py 註冊):/api/v1/webhooks
權限:一律需 ``webhook.manage``(admin 亦可)。因回應涉及簽章金鑰(即使遮罩),
列表 / 讀取亦要求此權限,較自動化模組更嚴。

成功走 response.ok 信封;錯誤一律 raise HTTPException(正確狀態碼, detail={code,message}),
由全域處理器包成統一信封並保留狀態碼(查無 → 404 not_found,輸入不合法 →
400 bad_request,SSRF 阻擋 → 400 WEBHOOK_URL_FORBIDDEN)。絕不信任用戶端傳入的 tenant_id。
"""
from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import ok
from app.models.webhook import WEBHOOK_EVENTS, WebhookEndpoint
from app.services import webhooks as webhooks_svc
from app.services.ingest import net_guard

router = APIRouter()

_PERM = "webhook.manage"


# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #
class EndpointCreate(BaseModel):
    url: str = Field(min_length=1, max_length=1000)
    events: list[str] = Field(default_factory=list)
    secret: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=300)
    is_active: bool = True


class EndpointUpdate(BaseModel):
    url: str | None = Field(default=None, min_length=1, max_length=1000)
    events: list[str] | None = None
    secret: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=300)
    is_active: bool | None = None


def _mask_secret(secret: str | None) -> str | None:
    """回應時遮罩簽章金鑰,只露頭尾便於辨識。"""
    if not secret:
        return secret
    if len(secret) <= 8:
        return "****"
    return f"{secret[:4]}…{secret[-4:]}"


def _serialize(e: WebhookEndpoint) -> dict:
    return {
        "id": str(e.id),
        "url": e.url,
        "events": e.events or [],
        "secret": _mask_secret(e.secret),
        "description": e.description,
        "is_active": e.is_active,
        "created_at": e.created_at.isoformat() if e.created_at else None,
        "updated_at": e.updated_at.isoformat() if e.updated_at else None,
    }


def _validate_events(events: list[str] | None) -> str | None:
    """驗證訂閱事件名皆為合法值;不合法回錯誤訊息,否則 None。"""
    for ev in events or []:
        if ev not in WEBHOOK_EVENTS:
            return f"invalid event: {ev}"
    return None


async def _validate_webhook_url(url: str) -> str | None:
    """SSRF 防護:複用 ingest.net_guard 驗證 webhook 目標 URL。

    僅允許 http/https,且主機經 DNS 解析後所有 IP 均為公網位址(擋 loopback /
    私網 / link-local 含雲端 metadata 169.254.169.254 / multicast / reserved /
    CGNAT 等,以及 file://gopher://ftp:// 等非法 scheme)。

    通過回 None;被拒回錯誤訊息字串(供 raise HTTPException(400,
    {"code":"WEBHOOK_URL_FORBIDDEN","message":...}))。
    """
    try:
        await net_guard.assert_url_public_async(url)
    except net_guard.BlockedURLError as exc:
        return str(exc)
    return None


async def _get_owned(db, staff, endpoint_id: uuid.UUID) -> WebhookEndpoint | None:
    return (
        await db.execute(
            select(WebhookEndpoint).where(
                WebhookEndpoint.id == endpoint_id,
                WebhookEndpoint.tenant_id == staff.tenant_id,
                WebhookEndpoint.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


# --------------------------------------------------------------------------- #
# 目錄:可訂閱事件清單
# --------------------------------------------------------------------------- #
@router.get("/events")
async def list_events(staff: CurrentStaff):
    """回傳可訂閱的 webhook 事件名清單。"""
    staff.require(_PERM)
    return ok({"events": list(WEBHOOK_EVENTS)})


# --------------------------------------------------------------------------- #
# CRUD
# --------------------------------------------------------------------------- #
@router.get("/endpoints")
async def list_endpoints(
    staff: CurrentStaff,
    db: DbSession,
    is_active: bool | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    """列出本租戶的 webhook endpoints(secret 遮罩)。"""
    staff.require(_PERM)
    conds = [
        WebhookEndpoint.tenant_id == staff.tenant_id,
        WebhookEndpoint.deleted_at.is_(None),
    ]
    if is_active is not None:
        conds.append(WebhookEndpoint.is_active.is_(is_active))
    total = (
        await db.execute(select(func.count()).select_from(WebhookEndpoint).where(*conds))
    ).scalar_one()
    rows = (
        await db.execute(
            select(WebhookEndpoint)
            .where(*conds)
            .order_by(WebhookEndpoint.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
    ).scalars().all()
    return ok(
        {
            "items": [_serialize(e) for e in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    )


@router.get("/endpoints/{endpoint_id}")
async def get_endpoint(endpoint_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """單筆 endpoint(租戶隔離;secret 遮罩)。"""
    staff.require(_PERM)
    e = await _get_owned(db, staff, endpoint_id)
    if e is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "webhook endpoint not found"},
        )
    return ok(_serialize(e))


@router.post("/endpoints")
async def create_endpoint(body: EndpointCreate, staff: CurrentStaff, db: DbSession):
    """建立 endpoint(需 webhook.manage)。未帶 secret 則自動產生。"""
    staff.require(_PERM)
    invalid = _validate_events(body.events)
    if invalid:
        raise HTTPException(
            status_code=400, detail={"code": "bad_request", "message": invalid}
        )

    forbidden = await _validate_webhook_url(body.url)
    if forbidden:
        raise HTTPException(
            status_code=400,
            detail={"code": "WEBHOOK_URL_FORBIDDEN", "message": forbidden},
        )

    secret = body.secret or secrets.token_urlsafe(32)
    e = WebhookEndpoint(
        tenant_id=staff.tenant_id,
        url=body.url,
        events=list(body.events),
        secret=secret,
        description=body.description,
        is_active=body.is_active,
    )
    db.add(e)
    await db.commit()
    await db.refresh(e)
    # 建立時回傳一次明文 secret(之後只遮罩顯示),方便租戶配置驗章
    data = _serialize(e)
    data["secret"] = secret
    return ok(data)


@router.patch("/endpoints/{endpoint_id}")
async def update_endpoint(
    endpoint_id: uuid.UUID, body: EndpointUpdate, staff: CurrentStaff, db: DbSession
):
    """更新 endpoint(需 webhook.manage)。只更新有帶的欄位。"""
    staff.require(_PERM)
    e = await _get_owned(db, staff, endpoint_id)
    if e is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "webhook endpoint not found"},
        )

    invalid = _validate_events(body.events)
    if invalid:
        raise HTTPException(
            status_code=400, detail={"code": "bad_request", "message": invalid}
        )

    data = body.model_dump(exclude_unset=True)
    if "url" in data:
        forbidden = await _validate_webhook_url(data["url"])
        if forbidden:
            raise HTTPException(
                status_code=400,
                detail={"code": "WEBHOOK_URL_FORBIDDEN", "message": forbidden},
            )
        e.url = data["url"]
    if "events" in data and body.events is not None:
        e.events = list(body.events)
    if "secret" in data and body.secret:
        e.secret = body.secret
    if "description" in data:
        e.description = data["description"]
    if "is_active" in data and body.is_active is not None:
        e.is_active = body.is_active

    await db.commit()
    await db.refresh(e)
    return ok(_serialize(e))


@router.delete("/endpoints/{endpoint_id}")
async def delete_endpoint(endpoint_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """軟刪 endpoint(需 webhook.manage)。"""
    staff.require(_PERM)
    e = await _get_owned(db, staff, endpoint_id)
    if e is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "webhook endpoint not found"},
        )
    e.deleted_at = datetime.now(UTC)
    e.is_active = False
    await db.commit()
    return ok({"id": str(endpoint_id), "deleted": True})


# --------------------------------------------------------------------------- #
# 測試發送
# --------------------------------------------------------------------------- #
@router.post("/endpoints/{endpoint_id}/test")
async def test_endpoint(endpoint_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """對指定 endpoint 送一則測試事件,回報是否成功(需 webhook.manage)。"""
    staff.require(_PERM)
    e = await _get_owned(db, staff, endpoint_id)
    if e is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "webhook endpoint not found"},
        )
    delivered = await webhooks_svc.send_test(
        e.url, e.secret, data={"endpoint_id": str(e.id), "tenant_id": str(staff.tenant_id)}
    )
    return ok({"endpoint_id": str(endpoint_id), "delivered": delivered})
