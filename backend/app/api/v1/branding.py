"""白牌自訂網域綁定 + 依網域解析租戶品牌。

本模組提供兩塊(以兩個 router 分離,方便掛在不同前綴):

1) 公開品牌解析(public_router,**無 JWT**)
   - GET /branding?host=<域名>
   - 依 host 正規化後查 TenantDomain → 找到回該租戶品牌;找不到回 kefu 預設品牌(不報錯)。
   - 前端載入時以 window.location.host 呼叫,取得 logo/品牌色/名稱。

2) 租戶網域管理(router,JWT admin,tenant 隔離)
   - POST   /domains            綁定網域(正規化、查重、產生 verify_token、回 DNS 設定指示)
   - GET    /domains            列本租戶已綁網域(含 verified 狀態)
   - DELETE /domains/{id}       解除綁定(硬刪,釋放全域唯一的 domain 以便日後重綁)
   - POST   /domains/{id}/verify  檢查 DNS TXT(有 dnspython 才自動查;無則回「待驗證」)

掛載建議(main.py,兩個 router 分別掛):
    from app.api.v1 import branding
    app.include_router(branding.public_router, prefix="/api/v1/public", tags=["branding"])
    app.include_router(branding.router, prefix="/api/v1/branding", tags=["branding"])
  → 公開端點:GET /api/v1/public/branding
  → 管理端點:/api/v1/branding/domains ...

品牌本身(logo/色/名)沿用租戶設定(Tenant.branding + Tenant.name/slug),
更新 branding 已由既有 tenancy PATCH /tenants/{id} 負責,本模組只補「網域」這塊。

規則:回應統一走 ok()/err();租戶隔離一律以 principal.tenant_id 過濾。
"""
from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.config import settings
from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.models.tenancy import Tenant, TenantDomain

# 公開解析 router(無 JWT);管理 router(需 JWT)
public_router = APIRouter()
router = APIRouter()

# 平台入口:租戶把自訂網域 CNAME/A 指到這裡(部署時可調整)。
PLATFORM_CNAME_TARGET = "ingress.kefu.app"
# DNS TXT 驗證主機前綴。
VERIFY_TXT_PREFIX = "_kefu-verify"


# --------------------------------------------------------------------------- #
# host 正規化:去 scheme、去 path/query、去 port、去 www.、小寫、去結尾點
# --------------------------------------------------------------------------- #
def normalize_host(host: str | None) -> str:
    """把使用者/瀏覽器傳來的 host 正規化成純網域名。

    範例:
        "HTTPS://WWW.Support.ClientA.com:8443/path?x=1" -> "support.clienta.com"
        "www.example.com."                              -> "example.com"
    """
    if not host:
        return ""
    h = host.strip().lower()
    # 去 scheme
    if "://" in h:
        h = h.split("://", 1)[1]
    # 去 path / query / fragment(取第一段)
    for sep in ("/", "?", "#"):
        if sep in h:
            h = h.split(sep, 1)[0]
    # 去 userinfo(user:pass@host)
    if "@" in h:
        h = h.rsplit("@", 1)[1]
    # 去 port(IPv6 字面量 [::1]:port 不在白牌情境,簡化處理:只在無方括號時切 port)
    if not h.startswith("[") and ":" in h:
        h = h.split(":", 1)[0]
    # 去結尾點(FQDN 尾點)
    h = h.rstrip(".")
    # 去 www.
    if h.startswith("www."):
        h = h[4:]
    return h


# --------------------------------------------------------------------------- #
# 品牌序列化:取自 Tenant.branding + Tenant.name/slug
# --------------------------------------------------------------------------- #
def _brand_from_tenant(t: Tenant) -> dict:
    b = t.branding or {}
    return {
        "tenant_slug": t.slug,
        "name": b.get("name") or b.get("brand_name") or t.name,
        "logo_url": b.get("logo_url"),
        "primary_color": b.get("primary_color") or b.get("theme_color"),
        "branding": b,  # 完整白牌設定,供前端取用其餘 token
        "is_default": False,
    }


def _default_brand() -> dict:
    """kefu 預設品牌:host 查無對應租戶網域時回傳,不報錯。"""
    return {
        "tenant_slug": None,
        "name": settings.app_name,  # "kefu"
        "logo_url": None,
        "primary_color": "#2563eb",
        "branding": {},
        "is_default": True,
    }


# --------------------------------------------------------------------------- #
# 公開品牌解析(無 JWT)
# --------------------------------------------------------------------------- #
@public_router.get("/branding")
async def resolve_branding(
    db: DbSession,
    host: str | None = Query(default=None, description="當前網域,通常帶 window.location.host"),
):
    """依 host 解析租戶品牌;查無、未驗證或租戶停用一律回預設品牌(HTTP 200,不報錯)。

    網域搶佔防護:**只對已通過 DNS 所有權驗證(verified=True)的網域回傳該租戶品牌**。
    未驗證的網域一律回預設品牌(視同未生效),避免他人綁定並非其所有的網域即冒用
    租戶品牌。綁定/驗證流程(POST /domains、/verify)不變,惟在驗證通過前該網域
    不會被此公開品牌端採用。
    """
    norm = normalize_host(host)
    if not norm:
        return ok(_default_brand())

    domain_row = (
        await db.execute(
            select(TenantDomain).where(
                TenantDomain.domain == norm,
                TenantDomain.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if not domain_row:
        return ok(_default_brand())

    # 未驗證的網域不生效:回預設品牌,不查租戶、不揭露租戶品牌(消除品牌劫持面)。
    if not domain_row.verified:
        return ok(_default_brand())

    tenant = (
        await db.execute(select(Tenant).where(Tenant.id == domain_row.tenant_id))
    ).scalar_one_or_none()
    if not tenant or not tenant.is_active:
        return ok(_default_brand())

    result = _brand_from_tenant(tenant)
    result["domain"] = domain_row.domain
    result["verified"] = domain_row.verified
    return ok(result)


# --------------------------------------------------------------------------- #
# 租戶網域管理(JWT admin,tenant 隔離)
# --------------------------------------------------------------------------- #
class DomainCreateIn(BaseModel):
    domain: str = Field(min_length=1, max_length=253)
    is_primary: bool = False


def _dns_instructions(domain: str, token: str) -> dict:
    """回給前端的 DNS 設定指示:先加 TXT 驗證,再把網域指到平台入口。"""
    return {
        "txt": {
            "host": f"{VERIFY_TXT_PREFIX}.{domain}",
            "type": "TXT",
            "value": token,
        },
        "cname": {
            "host": domain,
            "type": "CNAME",
            "value": PLATFORM_CNAME_TARGET,
        },
        "note": (
            f"1) 於 DNS 新增一筆 TXT:{VERIFY_TXT_PREFIX}.{domain} = {token};"
            f"2) 將 {domain} 以 CNAME(或 A)指向平台入口 {PLATFORM_CNAME_TARGET};"
            "3) 生效後呼叫 POST /domains/{id}/verify 完成驗證。"
        ),
    }


def _domain_dict(d: TenantDomain, *, with_dns: bool = False) -> dict:
    out = {
        "id": str(d.id),
        "tenant_id": str(d.tenant_id),
        "domain": d.domain,
        "is_primary": d.is_primary,
        "verified": d.verified,
        "created_at": d.created_at.isoformat() if d.created_at else None,
    }
    if with_dns and not d.verified and d.verify_token:
        # 未驗證時附上 token 與 DNS 指示,方便前端持續顯示待辦
        out["verify_token"] = d.verify_token
        out["dns_instructions"] = _dns_instructions(d.domain, d.verify_token)
    return out


async def _get_domain(db, tenant_id: uuid.UUID, domain_id: uuid.UUID) -> TenantDomain | None:
    return (
        await db.execute(
            select(TenantDomain).where(
                TenantDomain.id == domain_id,
                TenantDomain.tenant_id == tenant_id,
                TenantDomain.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


@router.post("/domains")
async def bind_domain(body: DomainCreateIn, principal: CurrentStaff, db: DbSession):
    """綁定自訂網域:正規化 → 格式/查重檢查 → 產生 verify_token → 回 DNS 設定指示。"""
    principal.require("tenant.manage")

    norm = normalize_host(body.domain)
    if not norm or "." not in norm or " " in norm:
        return err("DOMAIN_INVALID", f"網域格式不正確: {body.domain}")

    # 全域查重(跨租戶唯一)
    dup = (
        await db.execute(
            select(TenantDomain).where(
                TenantDomain.domain == norm,
                TenantDomain.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if dup:
        return err("DOMAIN_TAKEN", f"網域已被綁定: {norm}")

    token = secrets.token_urlsafe(24)

    # 若指定為主網域,先把本租戶其他網域的 is_primary 取消(僅一個主網域)
    if body.is_primary:
        rows = (
            await db.execute(
                select(TenantDomain).where(
                    TenantDomain.tenant_id == principal.tenant_id,
                    TenantDomain.is_primary.is_(True),
                    TenantDomain.deleted_at.is_(None),
                )
            )
        ).scalars().all()
        for r in rows:
            r.is_primary = False

    d = TenantDomain(
        tenant_id=principal.tenant_id,
        domain=norm,
        is_primary=body.is_primary,
        verified=False,
        verify_token=token,
    )
    db.add(d)
    await db.commit()
    await db.refresh(d)

    out = _domain_dict(d)
    out["verify_token"] = token
    out["dns_instructions"] = _dns_instructions(norm, token)
    return ok(out)


@router.get("/domains")
async def list_domains(principal: CurrentStaff, db: DbSession):
    """列本租戶已綁網域(含 verified 狀態;未驗證者附 DNS 指示)。"""
    rows = (
        await db.execute(
            select(TenantDomain).where(
                TenantDomain.tenant_id == principal.tenant_id,
                TenantDomain.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    items = [_domain_dict(d, with_dns=True) for d in rows]
    return ok({"items": items, "total": len(items)})


@router.delete("/domains/{domain_id}")
async def unbind_domain(domain_id: uuid.UUID, principal: CurrentStaff, db: DbSession):
    """解除綁定。硬刪:domain 為全域唯一,硬刪才能釋放該網域供日後重綁。"""
    principal.require("tenant.manage")
    d = await _get_domain(db, principal.tenant_id, domain_id)
    if not d:
        return err("DOMAIN_NOT_FOUND", "網域不存在或不屬於本租戶")
    await db.delete(d)
    await db.commit()
    return ok({"id": str(domain_id), "deleted": True})


def _check_dns_txt(domain: str, token: str) -> dict:
    """查 _kefu-verify.<domain> 的 TXT 是否含 token。

    無 dnspython 時不強制:回 status="pending" 並說明,不視為錯誤。
    回傳 {"ok": bool, "status": str, "detail": str}。
    """
    fqdn = f"{VERIFY_TXT_PREFIX}.{domain}"
    try:
        import dns.resolver  # type: ignore
    except Exception:
        return {
            "ok": False,
            "status": "pending",
            "detail": "伺服器未安裝 dnspython,無法自動查詢 TXT;請確認 DNS 已生效後再試,或由平台端人工確認。",
        }
    try:
        answers = dns.resolver.resolve(fqdn, "TXT")
    except Exception as exc:  # NXDOMAIN / NoAnswer / Timeout 等
        return {
            "ok": False,
            "status": "pending",
            "detail": f"查無 TXT 記錄({fqdn}):{exc}",
        }
    values: list[str] = []
    for rr in answers:
        strings = getattr(rr, "strings", None)
        if strings:
            txt = "".join(s.decode() if isinstance(s, bytes) else str(s) for s in strings)
        else:
            txt = str(rr).strip('"')
        values.append(txt.strip('"'))
    if token in values:
        return {"ok": True, "status": "verified", "detail": "TXT 驗證成功"}
    return {
        "ok": False,
        "status": "pending",
        "detail": f"TXT 記錄未包含正確 token(host={fqdn})",
    }


@router.post("/domains/{domain_id}/verify")
async def verify_domain(domain_id: uuid.UUID, principal: CurrentStaff, db: DbSession):
    """檢查 DNS TXT 完成驗證。驗證未過(含無 dns 套件)不報錯,回 pending 狀態與說明。"""
    principal.require("tenant.manage")
    d = await _get_domain(db, principal.tenant_id, domain_id)
    if not d:
        return err("DOMAIN_NOT_FOUND", "網域不存在或不屬於本租戶")
    if d.verified:
        return ok({"id": str(d.id), "domain": d.domain, "verified": True, "status": "verified"})

    result = _check_dns_txt(d.domain, d.verify_token or "")
    if result["ok"]:
        d.verified = True
        await db.commit()
        await db.refresh(d)
        return ok({"id": str(d.id), "domain": d.domain, "verified": True, "status": "verified"})

    # 待驗證:附回 DNS 指示方便使用者對照
    return ok(
        {
            "id": str(d.id),
            "domain": d.domain,
            "verified": False,
            "status": result["status"],
            "detail": result["detail"],
            "dns_instructions": _dns_instructions(d.domain, d.verify_token or ""),
        }
    )
