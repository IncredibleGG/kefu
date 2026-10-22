"""企業 SSO — SAML 2.0(SP 端)+ 企業 SSO 設定管理端點(乾淨室,code-ready)。

前綴 ``/api/v1/saml``。設計原則:**未設定 / 未啟用則不啟用、零回歸**——所有 SAML
協定端點在租戶未建 ``TenantSSOConfig`` 或 ``saml_enabled=False`` 時一律回 SSO_DISABLED,
完全不影響既有 Google OAuth / 密碼登入。

協定端點(對接企業 IdP):
- ``GET  /metadata/{tenant_slug}``  回 SP metadata XML(entityID + ACS + NameIDFormat)。
- ``GET  /login/{tenant_slug}``     產 AuthnRequest,以 HTTP-Redirect binding 302 導向 IdP。
                                    原生 App 帶 client=native + PKCE 參數(同 Google start),
                                    RelayState 改帶伺服器 nonce(Redis,TTL 600 秒)。
- ``POST /acs/{tenant_slug}``       接 IdP 的 SAMLResponse,驗章 + 取 email → 比對既有
                                    Staff → 複用 auth._issue_token 發 token,以 URL fragment
                                    導回前端登入頁(對齊 Google OAuth callback);RelayState
                                    對到原生 nonce 時改發一次性 code 導回 App(kefu://…)。

管理端點(需 ``settings.manage``,作用於呼叫者租戶):
- ``GET  /config``       取本租戶 SSO 設定 + 衍生的 SP/SCIM URL(不回 bearer 雜湊)。
- ``PUT  /config``       upsert SAML/SCIM 設定(僅覆寫傳入欄位)。
- ``POST /scim-token``   產生 / 輪替 SCIM bearer 權杖(僅存雜湊,明文僅此次回傳)。

────────────────────────────────────────────────────────────────────────────
簽章驗證(fail-closed;重要)
────────────────────────────────────────────────────────────────────────────
正式的 SAML 簽章驗證需要 XML 正規化(C14N)+ XML-DSig 驗簽,依賴 ``signxml``
(底層需 ``lxml``)。本檔**只接受完整密碼學驗簽**:

1. 已安裝 ``signxml`` → 走完整 XML-DSig 驗簽(``_verify_signature_full``);且**只從
   signxml 回傳的「已驗證子樹」(signed_xml)取斷言/身分**,杜絕 XML Signature
   Wrapping(在文件別處塞未簽章假斷言)。驗簽後仍檢查 ``Conditions`` 時效與
   Status=Success。
2. 未安裝 ``signxml`` → **一律拒絕登入**(``SAML_SIG_UNAVAILABLE``),不再有任何
   「結構驗證」後備。舊版曾在缺 signxml 時只檢查「存在 ds:Signature 元素 + 內嵌憑證
   指紋釘選」即放行,但那並未驗 SignatureValue,攻擊者可偽造帶假 ds:Signature、省略
   內嵌憑證的回應冒充任何 staff → 簽章繞過。故已移除,改為 fail-closed。

因此:SAML 登入為 **code-ready**——要真正啟用,部署鏡像需安裝 ``signxml``(見
``pyproject.toml`` 的 ``saml`` extra);未安裝時所有 ``/acs`` 一律拒絕(不會誤放行)。
尚待補強(完整生產級 SAML):AudienceRestriction / SubjectConfirmation Recipient /
InResponseTo 綁定與斷言 ID 一次性重放快取(需持久化 AuthnRequest 狀態)。
"""
from __future__ import annotations

import base64
import logging
import secrets
import uuid
import zlib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from xml.etree import ElementTree as ET

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import RedirectResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core import ratelimit
from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.core.urls import external_base_url
from app.models.iam import Staff
from app.models.sso import TenantSSOConfig, hash_scim_token
from app.models.tenancy import Tenant

# 複用既有登入 token 簽發與 SSO 周邊(不重造):auth.py 已完整處理 grants / claims /
# 前端導回基底 / 企業安全政策(強制 2FA、IP 白名單)。SAML 對齊 Google OAuth 的行為。
from app.api.v1.auth import (
    _frontend_login_url,
    _ip_allowed,
    _issue_token,
    _load_security_policy,
    as_native_record,
    native_sso_error,
    native_sso_success,
    new_sso_state,
    parse_native_sso_request,
    pop_sso_state,
)

logger = logging.getLogger("kefu.saml")

router = APIRouter()

# XML 命名空間
_NS_SAMLP = "urn:oasis:names:tc:SAML:2.0:protocol"
_NS_SAML = "urn:oasis:names:tc:SAML:2.0:assertion"
_NS_DS = "http://www.w3.org/2000/09/xmldsig#"

# NameID 格式
_NAMEID_EMAIL = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"

# 常見的 email 屬性名(不同 IdP 慣例不一)
_EMAIL_ATTR_NAMES = {
    "email",
    "mail",
    "emailaddress",
    "urn:oid:0.9.2342.19200300.100.1.3",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    "http://schemas.xmlsoap.org/claims/emailaddress",
}

# Conditions 時效比對容忍的時鐘偏移
_CLOCK_SKEW = timedelta(seconds=120)

# 是否有完整 XML-DSig 驗簽能力(signxml,底層需 lxml/xmlsec)。缺則走結構驗證。
try:  # pragma: no cover - 取決於部署環境是否加裝依賴
    import signxml  # noqa: F401

    _SIGNXML_AVAILABLE = True
except Exception:  # noqa: BLE001
    _SIGNXML_AVAILABLE = False


# =========================================================================== #
# Pydantic schema
# =========================================================================== #
class SsoConfigIn(BaseModel):
    """SSO 設定更新(皆選填;傳入即覆寫,字串傳空字串等同清空為 None)。"""

    saml_enabled: bool | None = None
    saml_idp_entity_id: str | None = Field(default=None, max_length=500)
    saml_idp_sso_url: str | None = Field(default=None, max_length=1000)
    saml_idp_x509_cert: str | None = None
    saml_sp_acs_url: str | None = Field(default=None, max_length=1000)
    scim_enabled: bool | None = None
    default_role: str | None = Field(default=None, max_length=100)


# =========================================================================== #
# 小工具:設定讀取 / URL 衍生
# =========================================================================== #
async def _load_config(db, tenant_id) -> TenantSSOConfig | None:
    return (
        await db.execute(
            select(TenantSSOConfig).where(
                TenantSSOConfig.tenant_id == tenant_id,
                TenantSSOConfig.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()


async def _load_by_slug(db, slug: str) -> tuple[Tenant | None, TenantSSOConfig | None]:
    """以 tenant slug 定位租戶與其 SSO 設定;租戶不存在 / 停用回 (None, None)。"""
    tenant = (
        await db.execute(
            select(Tenant).where(Tenant.slug == slug, Tenant.is_active.is_(True))
        )
    ).scalar_one_or_none()
    if not tenant:
        return None, None
    return tenant, await _load_config(db, tenant.id)


def _backend_base(request: Request) -> str:
    """後端對外基底(含 scheme+host),用於組 SP metadata / ACS / SCIM URL。

    走 reverse-proxy 感知的 external_base_url:Cloudflare/nginx 終止 TLS 後
    request.base_url 只見 http://,會使 SAML entityID/ACS 變 http 與 IdP 登記不符而
    握手失敗;改依 X-Forwarded-Proto/Host 還原對外 https。
    """
    return external_base_url(request)


def _acs_url(request: Request, slug: str, cfg: TenantSSOConfig | None) -> str:
    """SP ACS URL:優先取設定覆寫(反代 / 自訂網域情境),否則依請求 base 推導。"""
    if cfg and cfg.saml_sp_acs_url:
        return cfg.saml_sp_acs_url
    return f"{_backend_base(request)}/api/v1/saml/acs/{slug}"


def _metadata_url(request: Request, slug: str) -> str:
    return f"{_backend_base(request)}/api/v1/saml/metadata/{slug}"


def _sp_entity_id(request: Request, slug: str) -> str:
    """SP entityID:採 metadata URL 作為 entityID(常見慣例,全域唯一)。"""
    return _metadata_url(request, slug)


def _scim_base_url(request: Request) -> str:
    return f"{_backend_base(request)}/api/v1/scim/v2"


# =========================================================================== #
# 小工具:X.509 憑證處理(簽章驗證用)
# =========================================================================== #
def _load_x509(cert_str: str | None):
    """把設定的憑證字串(PEM 或裸 base64 DER)載為 cryptography 憑證物件;失敗回 None。"""
    s = (cert_str or "").strip()
    if not s:
        return None
    try:
        from cryptography import x509

        if "BEGIN CERTIFICATE" in s:
            return x509.load_pem_x509_certificate(s.encode("utf-8"))
        der = base64.b64decode("".join(s.split()))
        return x509.load_der_x509_certificate(der)
    except Exception:  # noqa: BLE001 — 憑證格式不合法一律視為不可用
        return None


def _cert_pem(cert_str: str | None) -> str | None:
    """把設定憑證正規化為 PEM 文字(供 signxml 完整驗簽使用)。"""
    s = (cert_str or "").strip()
    if not s:
        return None
    if "BEGIN CERTIFICATE" in s:
        return s
    b64 = "".join(s.split())
    body = "\n".join(b64[i : i + 64] for i in range(0, len(b64), 64))
    return f"-----BEGIN CERTIFICATE-----\n{body}\n-----END CERTIFICATE-----\n"


def _fingerprint_sha256(cert) -> str | None:
    try:
        from cryptography.hazmat.primitives import hashes

        return cert.fingerprint(hashes.SHA256()).hex()
    except Exception:  # noqa: BLE001
        return None


# =========================================================================== #
# 小工具:安全 XML 解析 + 取值
# =========================================================================== #
def _safe_fromstring(xml_bytes: bytes) -> ET.Element | None:
    """解析 XML;先擋 DOCTYPE/ENTITY(緩解 XXE / billion-laughs,因未裝 defusedxml)。

    stdlib ElementTree 的 expat 預設不解析外部實體;此處再拒絕含 DTD 的輸入以求穩健。
    無法解析回 None。
    """
    try:
        head = xml_bytes[:4096].lower()
        if b"<!doctype" in head or b"<!entity" in head:
            logger.warning("SAMLResponse 含 DTD/ENTITY,拒絕解析")
            return None
        return ET.fromstring(xml_bytes)
    except Exception:  # noqa: BLE001
        return None


def _local(tag: str) -> str:
    """取 XML tag 的 local name(去命名空間)。"""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _parse_saml_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        v = value.strip()
        if v.endswith("Z"):
            v = v[:-1] + "+00:00"
        dt = datetime.fromisoformat(v)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:  # noqa: BLE001
        return None


@dataclass
class _SamlResult:
    email: str
    name_id: str
    issuer: str | None
    mode: str  # "full"(signxml 完整 XML-DSig 驗簽;目前唯一放行模式)


def _verify_signature_full(xml_bytes: bytes, cfg: TenantSSOConfig) -> bytes | None:
    """完整 XML-DSig 驗簽(僅在 signxml 可用時)。

    回傳「已被密碼學驗證的子樹」序列化 bytes(signxml 的 ``signed_xml``),供呼叫端**只**
    從這棵已驗證的樹取身分,杜絕 XML Signature Wrapping(在文件別處塞未簽章的假斷言、
    再用另一次解析挑到假斷言)。任何異常 / 無簽章結果 → 回 None(視為驗簽失敗)。
    """
    try:  # pragma: no cover - 取決於是否裝 signxml
        from lxml import etree as _lxml_etree
        from signxml import XMLVerifier

        pem = _cert_pem(cfg.saml_idp_x509_cert)
        if not pem:
            return None
        result = XMLVerifier().verify(xml_bytes, x509_cert=pem)
        signed = getattr(result, "signed_xml", None)
        if signed is None:
            return None
        return _lxml_etree.tostring(signed)
    except Exception:  # noqa: BLE001
        logger.warning("SAML 完整驗簽失敗", exc_info=True)
        return None


def _extract_email(assertion: ET.Element, name_id: str, name_id_format: str | None) -> str:
    """從 NameID(email 格式)或 AttributeStatement 取出 email(小寫)。"""
    if name_id and ("@" in name_id or name_id_format == _NAMEID_EMAIL):
        if "@" in name_id:
            return name_id.strip().lower()
    for attr in assertion.iter():
        if _local(attr.tag) != "Attribute":
            continue
        name = (attr.get("Name") or attr.get("FriendlyName") or "").strip().lower()
        if name in _EMAIL_ATTR_NAMES:
            for child in attr:
                if _local(child.tag) == "AttributeValue" and child.text and "@" in child.text:
                    return child.text.strip().lower()
    # 後備:NameID 本身含 @ 才視為 email
    return name_id.strip().lower() if name_id and "@" in name_id else ""


def _verify_and_extract(xml_bytes: bytes, cfg: TenantSSOConfig) -> tuple[_SamlResult | None, str]:
    """驗證 SAMLResponse 並取出 email。回 (結果, "") 或 (None, 失敗碼)。

    失敗碼(供日誌 / 導回登入頁的 sso_error):
    SAML_PARSE_ERROR / SAML_STATUS_FAILED / SAML_ENCRYPTED_UNSUPPORTED /
    SAML_NO_ASSERTION / SAML_NO_CERT / SAML_SIG_UNAVAILABLE / SAML_EXPIRED /
    SAML_NO_EMAIL / SAML_SIG_INVALID
    """
    root = _safe_fromstring(xml_bytes)
    if root is None:
        return None, "SAML_PARSE_ERROR"

    # Status = Success
    status_ok = False
    for el in root.iter():
        if _local(el.tag) == "StatusCode":
            val = el.get("Value") or ""
            if val.endswith(":status:Success"):
                status_ok = True
            break
    if not status_ok:
        return None, "SAML_STATUS_FAILED"

    # 不支援加密斷言(code-ready 框架不含解密)
    for el in root.iter():
        if _local(el.tag) == "EncryptedAssertion":
            return None, "SAML_ENCRYPTED_UNSUPPORTED"

    # ---- 簽章驗證 ----
    cert = _load_x509(cfg.saml_idp_x509_cert)
    if cert is None:
        return None, "SAML_NO_CERT"

    if not _SIGNXML_AVAILABLE:
        # fail-closed:缺完整 XML-DSig 能力(signxml/lxml)時**絕不放行**。
        # 舊版曾有「結構驗證」後備(只要求存在 ds:Signature 元素、對內嵌憑證做指紋
        # 釘選),但那並未對 SignatureValue 做密碼學驗簽 → 攻擊者可偽造一個帶任意
        # ds:Signature、省略內嵌憑證的 SAMLResponse 冒充任何 staff 登入(簽章繞過)。
        # 故此處直接拒絕;要啟用 SAML 登入,部署需安裝 signxml(底層 lxml)。
        logger.error("SAML 驗簽不可用(未安裝 signxml/lxml),拒絕以策安全;tenant cert 已設定但無法驗簽")
        return None, "SAML_SIG_UNAVAILABLE"

    # 完整 XML-DSig 驗簽 → 只信任「已驗證子樹」內的斷言(防 XSW)。
    verified_bytes = _verify_signature_full(xml_bytes, cfg)
    if verified_bytes is None:
        return None, "SAML_SIG_INVALID"
    verified_root = _safe_fromstring(verified_bytes)
    if verified_root is None:
        return None, "SAML_SIG_INVALID"
    if _local(verified_root.tag) == "Assertion":
        assertion = verified_root
    else:
        assertion = None
        for el in verified_root.iter():
            if _local(el.tag) == "Assertion":
                assertion = el
                break
    if assertion is None:
        return None, "SAML_NO_ASSERTION"
    mode = "full"

    # ---- Conditions 時效 ----
    now = datetime.now(timezone.utc)
    for el in assertion:
        if _local(el.tag) == "Conditions":
            nb = _parse_saml_time(el.get("NotBefore"))
            noa = _parse_saml_time(el.get("NotOnOrAfter"))
            if nb and now + _CLOCK_SKEW < nb:
                return None, "SAML_EXPIRED"
            if noa and now - _CLOCK_SKEW >= noa:
                return None, "SAML_EXPIRED"
            break

    # ---- Issuer / NameID / email(一律取自已驗證斷言,XSW-safe)----
    issuer = None
    for el in assertion.iter():
        if _local(el.tag) == "Issuer":
            issuer = (el.text or "").strip() or None
            break

    name_id, name_id_format = "", None
    for el in assertion.iter():
        if _local(el.tag) == "NameID":
            name_id = (el.text or "").strip()
            name_id_format = el.get("Format")
            break

    email = _extract_email(assertion, name_id, name_id_format)
    if not email:
        return None, "SAML_NO_EMAIL"

    return _SamlResult(email=email, name_id=name_id, issuer=issuer, mode=mode), ""


# =========================================================================== #
# 小工具:AuthnRequest / SP metadata XML 產生
# =========================================================================== #
def _build_authn_request(sso_url: str, acs_url: str, sp_entity_id: str) -> str:
    req_id = "_" + uuid.uuid4().hex
    issue_instant = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return (
        f'<samlp:AuthnRequest xmlns:samlp="{_NS_SAMLP}" xmlns:saml="{_NS_SAML}" '
        f'ID="{req_id}" Version="2.0" IssueInstant="{issue_instant}" '
        f'Destination="{sso_url}" '
        f'ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" '
        f'AssertionConsumerServiceURL="{acs_url}">'
        f"<saml:Issuer>{sp_entity_id}</saml:Issuer>"
        f'<samlp:NameIDPolicy Format="{_NAMEID_EMAIL}" AllowCreate="true"/>'
        f"</samlp:AuthnRequest>"
    )


def _redirect_encode(xml: str) -> str:
    """HTTP-Redirect binding:DEFLATE(RFC1951,無 zlib 標頭)+ base64。"""
    compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
    deflated = compressor.compress(xml.encode("utf-8")) + compressor.flush()
    return base64.b64encode(deflated).decode("ascii")


def _sp_metadata_xml(sp_entity_id: str, acs_url: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" '
        f'entityID="{sp_entity_id}">'
        '<md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" '
        'protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">'
        f"<md:NameIDFormat>{_NAMEID_EMAIL}</md:NameIDFormat>"
        '<md:AssertionConsumerService '
        'Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" '
        f'Location="{acs_url}" index="0" isDefault="true"/>'
        "</md:SPSSODescriptor>"
        "</md:EntityDescriptor>"
    )


# =========================================================================== #
# 管理端點:SSO 設定(需 settings.manage)
# =========================================================================== #
def _config_view(request: Request, slug: str, cfg: TenantSSOConfig | None) -> dict:
    """組管理端回傳(不含 bearer 雜湊;含衍生的 SP/SCIM URL)。"""
    return {
        "saml_enabled": bool(cfg.saml_enabled) if cfg else False,
        "saml_idp_entity_id": (cfg.saml_idp_entity_id if cfg else None),
        "saml_idp_sso_url": (cfg.saml_idp_sso_url if cfg else None),
        "saml_idp_x509_cert": (cfg.saml_idp_x509_cert if cfg else None),
        "scim_enabled": bool(cfg.scim_enabled) if cfg else False,
        "scim_token_set": bool(cfg and cfg.scim_bearer_token_hash),
        "default_role": (cfg.default_role if cfg else None),
        # 衍生值(唯讀,供管理員填入 IdP / SCIM 用戶端)
        "sp_entity_id": _sp_entity_id(request, slug),
        "sp_acs_url": _acs_url(request, slug, cfg),
        "sp_metadata_url": _metadata_url(request, slug),
        "scim_base_url": _scim_base_url(request),
        # 誠實標明目前驗簽能力:full=可完整 XML-DSig 驗簽;unavailable=未裝 signxml,
        # SAML 登入一律拒絕(需先安裝依賴才可啟用)。
        "signature_verification": "full" if _SIGNXML_AVAILABLE else "unavailable",
    }


async def _tenant_slug(db, tenant_id) -> str:
    slug = (
        await db.execute(select(Tenant.slug).where(Tenant.id == tenant_id))
    ).scalar_one_or_none()
    return slug or str(tenant_id)


@router.get("/config")
async def get_sso_config(staff: CurrentStaff, db: DbSession, request: Request):
    """取本租戶 SSO 設定 + 衍生 SP/SCIM URL。需 settings.manage。"""
    staff.require("settings.manage")
    cfg = await _load_config(db, staff.tenant_id)
    slug = await _tenant_slug(db, staff.tenant_id)
    return ok(_config_view(request, slug, cfg))


@router.put("/config")
async def put_sso_config(body: SsoConfigIn, staff: CurrentStaff, db: DbSession, request: Request):
    """upsert 本租戶 SSO 設定(僅覆寫傳入欄位)。需 settings.manage。"""
    staff.require("settings.manage")
    data = body.model_dump(exclude_unset=True)

    cfg = await _load_config(db, staff.tenant_id)
    if cfg is None:
        cfg = TenantSSOConfig(tenant_id=staff.tenant_id)
        db.add(cfg)

    if "saml_enabled" in data and data["saml_enabled"] is not None:
        cfg.saml_enabled = bool(data["saml_enabled"])
    if "scim_enabled" in data and data["scim_enabled"] is not None:
        cfg.scim_enabled = bool(data["scim_enabled"])
    # 字串欄位:傳空字串 → 清為 None
    for field in (
        "saml_idp_entity_id",
        "saml_idp_sso_url",
        "saml_idp_x509_cert",
        "saml_sp_acs_url",
        "default_role",
    ):
        if field in data:
            val = (data[field] or "").strip() if isinstance(data[field], str) else data[field]
            setattr(cfg, field, val or None)

    await db.commit()
    await db.refresh(cfg)
    slug = await _tenant_slug(db, staff.tenant_id)
    return ok(_config_view(request, slug, cfg))


@router.post("/scim-token")
async def generate_scim_token(staff: CurrentStaff, db: DbSession, request: Request):
    """產生 / 輪替 SCIM bearer 權杖(僅存雜湊;明文僅此次回傳)。需 settings.manage。

    產生新權杖會使舊權杖立即失效(整組覆寫雜湊)。回傳明文供貼入 IdP 的 SCIM 用戶端。
    """
    staff.require("settings.manage")
    cfg = await _load_config(db, staff.tenant_id)
    if cfg is None:
        cfg = TenantSSOConfig(tenant_id=staff.tenant_id)
        db.add(cfg)
    token = secrets.token_urlsafe(32)
    cfg.scim_bearer_token_hash = hash_scim_token(token)
    await db.commit()
    return ok(
        {
            "token": token,
            "scim_base_url": _scim_base_url(request),
            "note": "此權杖僅顯示一次,請立即保存並貼入 IdP 的 SCIM 用戶端設定。",
        }
    )


# =========================================================================== #
# SAML 協定端點
# =========================================================================== #
@router.get("/metadata/{tenant_slug}", name="saml_metadata")
async def saml_metadata(tenant_slug: str, db: DbSession, request: Request):
    """回 SP metadata XML。租戶不存在 / 未啟用 SAML → SSO_DISABLED。"""
    tenant, cfg = await _load_by_slug(db, tenant_slug)
    if not tenant or not cfg or not cfg.saml_enabled:
        return err("SSO_DISABLED", "此租戶尚未啟用 SAML 單一登入")
    xml = _sp_metadata_xml(
        _sp_entity_id(request, tenant_slug), _acs_url(request, tenant_slug, cfg)
    )
    return Response(content=xml, media_type="application/samlmetadata+xml")


@router.get("/login/{tenant_slug}", name="saml_login")
async def saml_login(
    tenant_slug: str,
    db: DbSession,
    request: Request,
    client: str | None = None,
    redirect_uri: str | None = None,
    state: str | None = None,
    code_challenge: str | None = None,
    code_challenge_method: str | None = None,
):
    """產 AuthnRequest 並 302 導向 IdP SSO URL(HTTP-Redirect binding)。

    未啟用 / 未設定 IdP SSO URL → 回 SSO_DISABLED(前端據此提示,不離開頁面)。
    原生(client=native):參數驗證同 Google start;RelayState 帶伺服器 nonce(Redis 存
    redirect_uri / app_state / code_challenge / tenant_slug),失敗導回 App 帶 sso_error。
    Web:RelayState 維持 tenant slug(與既有行為相同;ACS 不依賴它)。
    """
    ip = ratelimit.client_ip(request)
    if not await ratelimit.hit(f"saml-login-ip:{ip}", limit=30, window_seconds=300):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="too many attempts")

    if client not in (None, "", "web", "native"):
        return err("INVALID_REQUEST", "client 參數不正確")
    native: dict | None = None
    if client == "native":
        native, failure = parse_native_sso_request(
            redirect_uri, state, code_challenge, code_challenge_method
        )
        if native is None:
            return failure

    tenant, cfg = await _load_by_slug(db, tenant_slug)
    if not tenant or not cfg or not cfg.saml_enabled or not cfg.saml_idp_sso_url:
        if native:
            return native_sso_error(native, "SSO_DISABLED")
        return err("SSO_DISABLED", "此租戶尚未啟用 SAML 單一登入")

    relay_state = tenant_slug
    if native:
        nonce = await new_sso_state({**native, "provider": "saml", "tenant_slug": tenant.slug})
        if nonce is None:
            return native_sso_error(native, "SSO_UNAVAILABLE")
        relay_state = nonce

    authn = _build_authn_request(
        cfg.saml_idp_sso_url,
        _acs_url(request, tenant_slug, cfg),
        _sp_entity_id(request, tenant_slug),
    )
    params = {"SAMLRequest": _redirect_encode(authn), "RelayState": relay_state}
    sep = "&" if "?" in cfg.saml_idp_sso_url else "?"
    return RedirectResponse(f"{cfg.saml_idp_sso_url}{sep}{urlencode(params)}", status_code=302)


@router.post("/acs/{tenant_slug}", name="saml_acs")
async def saml_acs(tenant_slug: str, db: DbSession, request: Request):
    """IdP 回呼(HTTP-POST binding):驗證 SAMLResponse → 比對既有 Staff → 發 token 導回前端。

    對齊 Google OAuth callback:成功以 URL fragment 帶 token(#sso_token=…)導回登入頁,
    失敗以 query 帶 sso_error 導回。任一步失敗一律降級(不 500)。
    RelayState 若對到原生 nonce(GETDEL 單次使用,且須屬同一租戶),成功改發一次性 code
    導回 App、失敗導回 App 帶 sso_error;否則(Web / IdP 發起)維持既有行為。
    """
    login_url = _frontend_login_url()
    native: dict | None = None

    def _fail(code: str) -> RedirectResponse:
        if native:
            return native_sso_error(native, code)
        return RedirectResponse(
            f"{login_url}?{urlencode({'sso_error': code})}", status_code=302
        )

    ip = ratelimit.client_ip(request)
    if not await ratelimit.hit(f"saml-acs-ip:{ip}", limit=30, window_seconds=300):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="too many attempts")

    # 取 SAMLResponse(HTTP-POST binding,application/x-www-form-urlencoded)
    try:
        form = await request.form()
    except Exception:  # noqa: BLE001
        return _fail("SAML_PARSE_ERROR")

    # RelayState → 原生 nonce(Web 流程為 slug 或缺省,查不到即走既有 Web 行為)
    relay_state = form.get("RelayState")
    record = await pop_sso_state(relay_state if isinstance(relay_state, str) else None)
    native = as_native_record(record)
    if record is not None and record.get("client") == "native":
        if native is None:
            return _fail("SAML_STATE_INVALID")
        if record.get("provider") != "saml" or record.get("tenant_slug") != tenant_slug:
            return _fail("SAML_STATE_INVALID")

    tenant, cfg = await _load_by_slug(db, tenant_slug)
    if not tenant or not cfg or not cfg.saml_enabled:
        return _fail("SSO_DISABLED")

    saml_response_b64 = form.get("SAMLResponse")
    if not saml_response_b64 or not isinstance(saml_response_b64, str):
        return _fail("SAML_PARSE_ERROR")
    try:
        xml_bytes = base64.b64decode(saml_response_b64)
    except Exception:  # noqa: BLE001
        return _fail("SAML_PARSE_ERROR")

    result, reason = _verify_and_extract(xml_bytes, cfg)
    if result is None:
        logger.warning("SAML ACS 驗證失敗 tenant=%s reason=%s", tenant.slug, reason)
        return _fail(reason)
    logger.info("SAML ACS 驗證通過 tenant=%s mode=%s email=%s", tenant.slug, result.mode, result.email)

    # 比對既有 Staff(email,大小寫不敏感;僅本租戶、啟用中)。
    # 不自動開帳號;若 SCIM 已佈建,該 Staff 已存在即可命中。
    staff_row = (
        await db.execute(
            select(Staff).where(
                Staff.tenant_id == tenant.id,
                func.lower(Staff.email) == result.email,
                Staff.is_active.is_(True),
                Staff.deleted_at.is_(None),
            )
        )
    ).scalars().first()
    if not staff_row:
        return _fail("SSO_NOT_INVITED")

    # 企業安全政策亦適用於 SAML(對齊 Google OAuth;平台超管豁免):
    # IP 白名單 / 強制 2FA。避免以 SSO 繞過。
    require_2fa, ip_allowlist = await _load_security_policy(db, tenant.id)
    if not staff_row.is_platform_admin:
        if not _ip_allowed(ip_allowlist, ip):
            return _fail("LOGIN_IP_BLOCKED")
        if require_2fa and not staff_row.totp_enabled:
            return _fail("TWOFA_ENROLL_REQUIRED")

    if native:
        return await native_sso_success(staff_row, native)

    session = await _issue_token(db, staff_row)
    token = session["data"]["access_token"]
    # token 以 fragment 傳遞(不進伺服器日誌 / Referer);前端 LoginPage 讀 hash 完成登入
    return RedirectResponse(f"{login_url}#sso_token={token}", status_code=302)
