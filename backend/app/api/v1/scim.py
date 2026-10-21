"""企業 SSO — SCIM 2.0 自動佈建(Users 最小集,乾淨室,code-ready)。

前綴 ``/api/v1/scim/v2``。以 SCIM bearer 權杖鑑權:比對 ``TenantSSOConfig`` 的
``scim_bearer_token_hash`` 且 ``scim_enabled=True``,由該權杖對應到租戶(tenant)。
所有操作限定於該租戶,回應走 SCIM 2.0 JSON 格式(``application/scim+json``)。

實作端點(SCIM 2.0 Users 最小集):
- ``GET    /Users``        列出(支援 ``filter=userName eq "x"`` 與 startIndex/count 分頁)。
- ``POST   /Users``        建立 → 佈建 Staff(隨機密碼、指派預設角色)。
- ``GET    /Users/{id}``   取單一使用者。
- ``PATCH  /Users/{id}``   ``active=false`` → 停用坐席;``active=true`` → 重新啟用。
- ``DELETE /Users/{id}``   軟刪坐席(deleted_at + 停用),回 204。

**零回歸**:未啟用 SCIM(無設定 / scim_enabled=False / 權杖不符)一律 401,不影響其他登入。
"""
from __future__ import annotations

import hmac
import logging
import re
import secrets
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import func, insert, select

from app.core.deps import DbSession
from app.core.security import hash_password
from app.core.urls import external_base_url
from app.models.iam import Role, Staff, staff_role
from app.models.sso import TenantSSOConfig, hash_scim_token

logger = logging.getLogger("kefu.scim")

router = APIRouter()

_SCIM_MEDIA = "application/scim+json"
_SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User"
_SCHEMA_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
_SCHEMA_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error"

_FILTER_RE = re.compile(r'^\s*(userName|emails\.value)\s+eq\s+"([^"]*)"\s*$', re.IGNORECASE)


# =========================================================================== #
# 回應小工具(SCIM JSON 格式)
# =========================================================================== #
def _scim_json(payload: dict, status_code: int = 200, headers: dict | None = None) -> JSONResponse:
    return JSONResponse(
        content=payload, status_code=status_code, media_type=_SCIM_MEDIA, headers=headers
    )


def _scim_error(status_code: int, detail: str, scim_type: str | None = None) -> JSONResponse:
    body: dict = {"schemas": [_SCHEMA_ERROR], "status": str(status_code), "detail": detail}
    if scim_type:
        body["scimType"] = scim_type
    return _scim_json(body, status_code)


def _scim_base(request: Request) -> str:
    # reverse-proxy 感知:CF/nginx 終止 TLS 後 base_url 只見 http,SCIM 位址需對外 https。
    return f"{external_base_url(request)}/api/v1/scim/v2"


def _scim_user(staff: Staff, request: Request) -> dict:
    active = bool(staff.is_active) and staff.deleted_at is None
    return {
        "schemas": [_SCHEMA_USER],
        "id": str(staff.id),
        "userName": staff.email,
        "displayName": staff.display_name,
        "active": active,
        "emails": [{"value": staff.email, "primary": True, "type": "work"}],
        "meta": {
            "resourceType": "User",
            "created": staff.created_at.isoformat() if staff.created_at else None,
            "lastModified": staff.updated_at.isoformat() if staff.updated_at else None,
            "location": f"{_scim_base(request)}/Users/{staff.id}",
        },
    }


def _coerce_bool(value, default: bool) -> bool:
    """SCIM active 值可能為 bool 或字串 "true"/"false"。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() == "true"
    return default


# =========================================================================== #
# 鑑權:以 bearer 權杖對應租戶
# =========================================================================== #
async def _authenticate(request: Request, db) -> TenantSSOConfig | None:
    """以 Authorization: Bearer 權杖比對 scim_bearer_token_hash;成功回該租戶設定,否則 None。

    比對走常數時間(hmac.compare_digest);要求 scim_enabled=True 且未軟刪。
    """
    authz = request.headers.get("authorization") or ""
    if not authz.lower().startswith("bearer "):
        return None
    token = authz.split(" ", 1)[1].strip()
    if not token:
        return None
    token_hash = hash_scim_token(token)
    rows = (
        await db.execute(
            select(TenantSSOConfig).where(
                TenantSSOConfig.scim_enabled.is_(True),
                TenantSSOConfig.scim_bearer_token_hash.is_not(None),
                TenantSSOConfig.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    for cfg in rows:
        if cfg.scim_bearer_token_hash and hmac.compare_digest(cfg.scim_bearer_token_hash, token_hash):
            return cfg
    return None


# =========================================================================== #
# 佈建小工具
# =========================================================================== #
def _extract_username(body: dict) -> str:
    """從 SCIM User body 取 email(userName 優先,退回 emails[0].value)。"""
    username = (body.get("userName") or "").strip().lower()
    if username:
        return username
    emails = body.get("emails")
    if isinstance(emails, list):
        for e in emails:
            if isinstance(e, dict) and e.get("value"):
                return str(e["value"]).strip().lower()
    return ""


def _extract_display_name(body: dict, fallback: str) -> str:
    dn = (body.get("displayName") or "").strip()
    if dn:
        return dn
    name = body.get("name")
    if isinstance(name, dict):
        parts = [name.get("givenName") or "", name.get("familyName") or ""]
        joined = " ".join(p for p in parts if p).strip()
        if joined:
            return joined
    return fallback


async def _assign_default_role(db, staff: Staff, cfg: TenantSSOConfig) -> None:
    """指派設定的預設角色(預設 agent);租戶內無此角色則略過(不自動建角色)。"""
    role_name = (cfg.default_role or "agent").strip() or "agent"
    role = (
        await db.execute(
            select(Role).where(
                Role.tenant_id == cfg.tenant_id,
                Role.name == role_name,
                Role.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if not role:
        return
    exists = (
        await db.execute(
            select(staff_role.c.staff_id).where(
                staff_role.c.staff_id == staff.id, staff_role.c.role_id == role.id
            )
        )
    ).first()
    if not exists:
        await db.execute(insert(staff_role).values(staff_id=staff.id, role_id=role.id))


async def _load_scim_staff(db, cfg: TenantSSOConfig, user_id: str) -> Staff | None:
    try:
        sid = uuid.UUID(str(user_id))
    except (ValueError, TypeError):
        return None
    return (
        await db.execute(
            select(Staff).where(Staff.id == sid, Staff.tenant_id == cfg.tenant_id)
        )
    ).scalar_one_or_none()


# =========================================================================== #
# SCIM Users 端點
# =========================================================================== #
@router.get("/Users")
async def list_users(request: Request, db: DbSession):
    """列出本租戶坐席(SCIM ListResponse)。支援 filter=userName eq "x" 與分頁。"""
    cfg = await _authenticate(request, db)
    if cfg is None:
        return _scim_error(401, "SCIM 鑑權失敗或未啟用")

    q = request.query_params
    stmt = select(Staff).where(Staff.tenant_id == cfg.tenant_id, Staff.deleted_at.is_(None))
    # 極簡 filter:僅支援 userName eq / emails.value eq(其餘忽略,回全量)
    flt = (q.get("filter") or "").strip()
    if flt:
        m = _FILTER_RE.match(flt)
        if m:
            stmt = stmt.where(func.lower(Staff.email) == m.group(2).strip().lower())

    rows = (await db.execute(stmt.order_by(Staff.created_at.asc()))).scalars().all()
    try:
        start_index = max(int(q.get("startIndex", "1")), 1)
    except ValueError:
        start_index = 1
    try:
        count = q.get("count")
        count_n = int(count) if count is not None else None
    except ValueError:
        count_n = None
    total = len(rows)
    page = rows[start_index - 1 :]
    if count_n is not None:
        page = page[: max(count_n, 0)]
    return _scim_json(
        {
            "schemas": [_SCHEMA_LIST],
            "totalResults": total,
            "startIndex": start_index,
            "itemsPerPage": len(page),
            "Resources": [_scim_user(s, request) for s in page],
        }
    )


@router.post("/Users")
async def create_user(request: Request, db: DbSession):
    """建立(佈建)使用者 → 建 Staff。已存在(啟用中)回 409;軟刪者則重新啟用。"""
    cfg = await _authenticate(request, db)
    if cfg is None:
        return _scim_error(401, "SCIM 鑑權失敗或未啟用")
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return _scim_error(400, "請求內容非有效 JSON", "invalidSyntax")
    if not isinstance(body, dict):
        return _scim_error(400, "請求內容格式不正確", "invalidSyntax")

    email = _extract_username(body)
    if not email or "@" not in email:
        return _scim_error(400, "缺少有效的 userName / email", "invalidValue")
    display_name = _extract_display_name(body, email)
    raw_active = body.get("active", True)
    active = raw_active if isinstance(raw_active, bool) else True

    # 租戶內 email 唯一(含軟刪列,因唯一約束不排除軟刪)
    existing = (
        await db.execute(
            select(Staff).where(
                Staff.tenant_id == cfg.tenant_id, func.lower(Staff.email) == email
            )
        )
    ).scalars().first()
    if existing is not None:
        if existing.deleted_at is None:
            return _scim_error(409, f"userName 已存在:{email}", "uniqueness")
        # 軟刪者:重新啟用(SCIM 再佈建)
        existing.deleted_at = None
        existing.is_active = active
        existing.display_name = display_name
        await _assign_default_role(db, existing, cfg)
        await db.commit()
        await db.refresh(existing)
        location = f"{_scim_base(request)}/Users/{existing.id}"
        return _scim_json(_scim_user(existing, request), 201, {"Location": location})

    staff = Staff(
        tenant_id=cfg.tenant_id,
        email=email,
        # SCIM 佈建的帳號經 SAML SSO 登入,不走密碼;給高熵隨機密碼(對方無從得知)
        password_hash=hash_password(secrets.token_urlsafe(24)),
        display_name=display_name,
        status="offline",
        is_active=active,
        is_platform_admin=False,
    )
    db.add(staff)
    await db.flush()  # 取得 staff.id
    await _assign_default_role(db, staff, cfg)
    await db.commit()
    await db.refresh(staff)
    logger.info("SCIM 佈建坐席 tenant=%s email=%s active=%s", cfg.tenant_id, email, active)
    location = f"{_scim_base(request)}/Users/{staff.id}"
    return _scim_json(_scim_user(staff, request), 201, {"Location": location})


@router.get("/Users/{user_id}")
async def get_user(user_id: str, request: Request, db: DbSession):
    """取單一使用者(限本租戶)。查無回 404。"""
    cfg = await _authenticate(request, db)
    if cfg is None:
        return _scim_error(401, "SCIM 鑑權失敗或未啟用")
    staff = await _load_scim_staff(db, cfg, user_id)
    if staff is None or staff.deleted_at is not None:
        return _scim_error(404, f"找不到使用者:{user_id}")
    return _scim_json(_scim_user(staff, request))


@router.patch("/Users/{user_id}")
async def patch_user(user_id: str, request: Request, db: DbSession):
    """PATCH:支援 replace active(停用 / 啟用)與 displayName。"""
    cfg = await _authenticate(request, db)
    if cfg is None:
        return _scim_error(401, "SCIM 鑑權失敗或未啟用")
    staff = await _load_scim_staff(db, cfg, user_id)
    if staff is None or staff.deleted_at is not None:
        return _scim_error(404, f"找不到使用者:{user_id}")
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return _scim_error(400, "請求內容非有效 JSON", "invalidSyntax")

    operations = body.get("Operations") if isinstance(body, dict) else None
    if not isinstance(operations, list):
        return _scim_error(400, "缺少 Operations", "invalidSyntax")

    for op in operations:
        if not isinstance(op, dict):
            continue
        action = (op.get("op") or "").strip().lower()
        if action not in {"replace", "add"}:
            continue  # 最小集只處理 replace/add
        path = (op.get("path") or "").strip()
        value = op.get("value")
        if path.lower() == "active":
            staff.is_active = _coerce_bool(value, staff.is_active)
        elif path.lower() == "displayname":
            if isinstance(value, str) and value.strip():
                staff.display_name = value.strip()
        elif path == "" and isinstance(value, dict):
            # 無 path:value 為屬性字典(企業 IdP 常見寫法)
            if "active" in value:
                staff.is_active = _coerce_bool(value.get("active"), staff.is_active)
            dn = value.get("displayName")
            if isinstance(dn, str) and dn.strip():
                staff.display_name = dn.strip()

    await db.commit()
    await db.refresh(staff)
    logger.info("SCIM PATCH 坐席 tenant=%s id=%s active=%s", cfg.tenant_id, staff.id, staff.is_active)
    return _scim_json(_scim_user(staff, request))


@router.delete("/Users/{user_id}")
async def delete_user(user_id: str, request: Request, db: DbSession):
    """DELETE:軟刪坐席(deleted_at + 停用),回 204。"""
    cfg = await _authenticate(request, db)
    if cfg is None:
        return _scim_error(401, "SCIM 鑑權失敗或未啟用")
    staff = await _load_scim_staff(db, cfg, user_id)
    if staff is None or staff.deleted_at is not None:
        return _scim_error(404, f"找不到使用者:{user_id}")
    staff.deleted_at = datetime.now(timezone.utc)
    staff.is_active = False
    await db.commit()
    logger.info("SCIM DELETE(軟刪)坐席 tenant=%s id=%s", cfg.tenant_id, staff.id)
    return JSONResponse(content=None, status_code=204, media_type=_SCIM_MEDIA)
