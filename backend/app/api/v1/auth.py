"""Foundation auth routes:登入 / who-am-i / 改密碼,以及認證周邊。

本檔在既有 login / me / change-password 之上,乾淨室擴充「認證周邊」:
- 自助註冊 ``POST /register``:公開建立新租戶 + admin 坐席 + 預設角色/權限/方案。
- 忘記 / 重設密碼 ``POST /forgot-password`` / ``POST /reset-password``:
  以短時效簽名權杖(purpose=pwreset)驗證;SMTP 已設定則寄信,否則 dev 回傳 token 供測試。
- 兩步驗證(TOTP)``/2fa/setup|enable|disable|status``:密鑰存 Staff.totp_secret。
- login 改造:啟用 2FA 的坐席,第一步驗密碼通過後回 ``requires_2fa + challenge``,
  需再帶 OTP(或一次於 login body 帶 otp)才發正式 token;未啟用 2FA 者流程完全不變。

完整 IAM CRUD 仍在 M2(iam.py);本檔僅擴充不破壞既有端點。
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import logging
import os
import re
import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from jose import JWTError, jwt
from pydantic import BaseModel, Field
from sqlalchemy import func, insert, select

from app.core import crypto, ratelimit

from app.core.config import settings
from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.core.security import create_access_token, hash_password, verify_password
from app.models.conversation import Channel
from app.models.iam import Permission, Role, Staff, role_permission, staff_role
from app.models.settings import TenantSettings
from app.models.tenancy import Tenant
from app.services import plans as plan_svc
from app.services import totp
from app.services.iam import seed_default_permissions

logger = logging.getLogger("kefu.auth")

router = APIRouter()

# 基本 email 格式(防濫用用途,非 RFC 完整驗證)
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# 簽名權杖用途 claim(與正式 access token 區隔,避免混用)
_PURPOSE_RESET = "pwreset"      # 重設密碼權杖
_PURPOSE_2FA = "2fa"            # 2FA 待驗證 challenge
_PURPOSE_2FA_ENROLL = "2fa_enroll"  # 組織強制 2FA:未啟用者登入後的設定流程 challenge
_PURPOSE_INVITE = "invite"      # 坐席邀請權杖(接受後設密碼並啟用)

# 2FA 備援碼:一次產生的組數(對標 LiveChat / GitHub 慣例的 10 組)
_RECOVERY_CODE_COUNT = 10

# 邀請權杖時效:7 天(對齊 LiveChat 坐席邀請的合理視窗)
_INVITE_TTL_MINUTES = 7 * 24 * 60

# Google OAuth 端點(單一登入;client_id/secret 走環境變數,不入 config.py)
_GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"


# =========================================================================== #
# Pydantic schema
# =========================================================================== #
class LoginIn(BaseModel):
    # email/password 為一般登入;challenge 為 2FA 第一步後回帶(免再送密碼);
    # otp 為 2FA 驗證碼(可與 email/password 一次送出,或第二步帶 challenge 送出)。
    email: str | None = None
    password: str | None = None
    otp: str | None = None
    challenge: str | None = None


class ChangePasswordIn(BaseModel):
    old_password: str
    new_password: str


class RegisterIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    # 不設 min_length:交由 handler 統一回 WEAK_PASSWORD 信封(與 change-password 一致);
    # 僅保留 max_length 作為長度上限的健全性防護。
    password: str = Field(max_length=128)
    tenant_name: str = Field(min_length=1, max_length=200)
    display_name: str | None = Field(default=None, max_length=200)
    slug: str | None = Field(default=None, max_length=100)


class ForgotPasswordIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)


class ResetPasswordIn(BaseModel):
    token: str
    # 不設 min_length:交由 handler 統一回 WEAK_PASSWORD 信封(與 change-password 一致)。
    new_password: str = Field(max_length=128)


class InviteIn(BaseModel):
    # 坐席邀請:於本租戶建帳號並簽發邀請權杖。role 為角色名(預設 agent)。
    email: str = Field(min_length=3, max_length=255)
    display_name: str | None = Field(default=None, max_length=200)
    role: str | None = Field(default=None, max_length=100)


class AcceptInviteIn(BaseModel):
    # 接受邀請:以邀請權杖驗證身分,設定密碼並啟用帳號(自動登入)。
    token: str
    # 不設 min_length:交由 handler 統一回 WEAK_PASSWORD 信封(與 change-password 一致)。
    password: str = Field(max_length=128)
    display_name: str | None = Field(default=None, max_length=200)


class TwoFaEnableIn(BaseModel):
    code: str = Field(min_length=6, max_length=10)


class TwoFaDisableIn(BaseModel):
    # 停用需再次驗證身分:提供有效 OTP,或帳號密碼(擇一)。
    code: str | None = None
    password: str | None = None


class TwoFaEnrollVerifyIn(BaseModel):
    # 組織強制 2FA 設定流程第二步:challenge 為 login 回的 enroll 權杖,code 為驗證器動態碼。
    challenge: str
    code: str = Field(min_length=6, max_length=10)


class SecurityPolicyIn(BaseModel):
    # 租戶企業安全政策(皆選填,傳入即覆寫該欄位)。
    require_2fa: bool | None = None
    login_ip_allowlist: list[str] | None = None


# =========================================================================== #
# 小工具:簽名權杖(重設密碼 / 2FA challenge)
# =========================================================================== #
def _make_purpose_token(
    staff: Staff, purpose: str, minutes: int, extra_claims: dict | None = None
) -> str:
    """以 jwt_secret 簽發短時效、帶 purpose claim 的權杖(與正式 access token 區隔)。

    extra_claims 供邀請權杖夾帶版本號(iv),使重寄後舊權杖因版本不符而失效。
    """
    now = datetime.now(timezone.utc)
    claims = {
        "sub": str(staff.id),
        "tenant_id": str(staff.tenant_id),
        "purpose": purpose,
        "iat": now,
        "exp": now + timedelta(minutes=minutes),
    }
    if extra_claims:
        claims.update(extra_claims)
    return jwt.encode(claims, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def _invite_version(staff: Staff) -> int:
    """邀請 token 綁定的版本號:以 invited_at 的整秒 epoch 表示。

    重寄邀請會更新 invited_at → 版本改變 → 舊 token 帶的 iv 不再相符而失效。
    invited_at 為 None(非邀請帳號)時回 0;搭配 accept 端的嚴格比對達成 fail-closed。
    """
    if not staff.invited_at:
        return 0
    return int(staff.invited_at.timestamp())


def _decode_purpose_token(token: str, purpose: str) -> dict | None:
    """驗證權杖簽章、時效與 purpose;不符回 None。"""
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return None
    if payload.get("purpose") != purpose:
        return None
    return payload


def _is_dev() -> bool:
    """dev / 測試環境:忘記密碼在無 SMTP 時可回傳 token 供測試;正式環境一律不外洩。"""
    env = (settings.environment or "").lower()
    return env in {"dev", "development", "local", "test"} or bool(settings.debug)


def _verify_totp_and_counter(secret: str | None, code: str | None, *, window: int = 1) -> int | None:
    """驗證 TOTP,成功時回傳「命中的時間窗序號 counter」,失敗回 None。

    與 ``totp.verify`` 同語意(容忍前後 ``window`` 個時間窗、常數時間比較),但額外回傳
    命中的 counter,供上層做防重放:記錄使用者上次成功的 counter,拒絕同窗或更舊的重放。
    僅使用 totp 服務的公開 API(``totp_now``)重建各候選窗的 code 比對,不改動 totp 服務。
    以單一 ``time.time()`` 快照推導 now_counter,避免與服務內部各自取時造成跨窗不一致。
    """
    if not secret or not code:
        return None
    cleaned = str(code).strip().replace(" ", "")
    if not cleaned.isdigit() or len(cleaned) != totp.DEFAULT_DIGITS:
        return None
    period = totp.DEFAULT_PERIOD
    now_counter = int(time.time() // period)
    for offset in range(-window, window + 1):
        candidate = now_counter + offset
        if candidate < 0:
            continue
        try:
            expected = totp.totp_now(secret, timestamp=candidate * period)
        except (ValueError, TypeError):
            return None
        if hmac.compare_digest(expected, cleaned):
            return candidate
    return None


def _reencrypt_if_plaintext(row: Staff) -> None:
    """既有明文 totp_secret 於首次成功驗證 / 啟用後就地升級為密文(enc:: 前綴)。

    導入靜態加密前寫入的密鑰為明文;crypto.decrypt 對其原樣回傳(相容讀取),
    此函式在驗證成功的路徑上把它改存密文,使既有明文逐步淘汰。已是密文則不動
    (crypto.is_encrypted 判斷),避免無謂改寫(Fernet 每次密文都不同)。
    呼叫端負責 commit。
    """
    if row.totp_secret and not crypto.is_encrypted(row.totp_secret):
        row.totp_secret = crypto.encrypt(row.totp_secret)


# =========================================================================== #
# 小工具:2FA 備援碼(recovery / backup codes)
#
# 備援碼為高熵隨機值(48 bits),故以 sha256(帶 pepper)雜湊即足夠(不可字典逆推),
# 不需 bcrypt 之類慢雜湊;比對走 hmac.compare_digest 常數時間。**僅存雜湊、不存明文**。
# =========================================================================== #
def _recovery_pepper() -> bytes:
    """備援碼雜湊的 pepper:沿用既有 secret_key(退回 jwt_secret),與其他機敏處理一致。"""
    return (settings.secret_key or settings.jwt_secret or "kefu-dev-secret").encode("utf-8")


def _normalize_recovery_code(code: str | None) -> str:
    """正規化備援碼輸入:去空白 / 連字號等分隔、轉小寫,使顯示格式與比對一致。"""
    return re.sub(r"[^a-z0-9]", "", (code or "").strip().lower())


def _hash_recovery_code(code: str | None) -> str:
    """對正規化後的備援碼做 sha256(pepper || code),回十六進位雜湊。"""
    norm = _normalize_recovery_code(code)
    return hashlib.sha256(_recovery_pepper() + norm.encode("utf-8")).hexdigest()


def generate_recovery_codes(count: int = _RECOVERY_CODE_COUNT) -> tuple[list[str], list[dict]]:
    """產生一組備援碼:回 ``(明文清單, 儲存用雜湊結構)``。明文僅此次可見。

    每碼 12 位十六進位(約 48 bits 熵),顯示為 ``xxxx-xxxx-xxxx`` 便於抄寫;
    儲存結構為 ``[{"hash": <sha256>, "used": False}, ...]``,不含明文。
    """
    plain: list[str] = []
    stored: list[dict] = []
    for _ in range(count):
        raw = secrets.token_hex(6)  # 12 個十六進位字元
        display = f"{raw[0:4]}-{raw[4:8]}-{raw[8:12]}"
        plain.append(display)
        stored.append({"hash": _hash_recovery_code(raw), "used": False})
    return plain, stored


def _consume_recovery_code(row: Staff, code: str | None) -> bool:
    """比對備援碼:命中「未使用」者即標記 used 並回 True(呼叫端負責 commit)。

    - 命中已使用的碼一律回 False(每碼僅一次)。
    - 比對走常數時間;JSONB 欄位以重新賦值觸發 SQLAlchemy 變更追蹤。
    """
    codes = row.totp_recovery_codes
    if not isinstance(codes, list) or not codes or not _normalize_recovery_code(code):
        return False
    target = _hash_recovery_code(code)
    for i, entry in enumerate(codes):
        if not isinstance(entry, dict):
            continue
        stored_hash = entry.get("hash")
        if not isinstance(stored_hash, str):
            continue
        if hmac.compare_digest(stored_hash, target) and not entry.get("used", False):
            new_codes = list(codes)
            new_codes[i] = {**entry, "used": True}
            row.totp_recovery_codes = new_codes  # 重新賦值:JSONB 變更才會被寫回
            return True
    return False


def _recovery_codes_remaining(row: Staff) -> int:
    """尚未使用的備援碼數量(供狀態顯示)。"""
    codes = row.totp_recovery_codes
    if not isinstance(codes, list):
        return 0
    return sum(1 for e in codes if isinstance(e, dict) and not e.get("used", False))


# =========================================================================== #
# 小工具:登入 IP 白名單(IP / CIDR)與租戶安全政策讀取
# =========================================================================== #
def _validate_ip_entry(entry: str | None) -> str | None:
    """驗證單一白名單項(IP 或 CIDR;IPv4/IPv6);合法回正規化字串,非法回 None。"""
    entry = (entry or "").strip()
    if not entry:
        return None
    try:
        if "/" in entry:
            return str(ipaddress.ip_network(entry, strict=False))
        return str(ipaddress.ip_address(entry))
    except ValueError:
        return None


def _ip_matches(ip_str: str, entry: str) -> bool:
    """ip_str 是否落在單一白名單項(IP 相等或屬於 CIDR 網段)內。"""
    try:
        ip = ipaddress.ip_address(ip_str)
        entry = (entry or "").strip()
        if "/" in entry:
            return ip in ipaddress.ip_network(entry, strict=False)
        return ip == ipaddress.ip_address(entry)
    except ValueError:
        return False


def _ip_allowed(allowlist, ip_str: str) -> bool:
    """白名單為空 / None → 不限制(True);否則須命中任一項。"""
    if not allowlist or not isinstance(allowlist, list):
        return True
    return any(_ip_matches(ip_str, e) for e in allowlist if isinstance(e, str))


async def _load_security_policy(db, tenant_id) -> tuple[bool, list | None]:
    """讀本租戶安全政策 ``(require_2fa, login_ip_allowlist)``;查無回 ``(False, None)``。"""
    row = (
        await db.execute(
            select(TenantSettings.require_2fa, TenantSettings.login_ip_allowlist).where(
                TenantSettings.tenant_id == tenant_id,
                TenantSettings.deleted_at.is_(None),
            )
        )
    ).first()
    if row is None:
        return (False, None)
    return (bool(row[0]), row[1])


def _otpauth_for(row: Staff, secret: str) -> str:
    """以坐席 email 產生 otpauth URI(供前端顯示 QR / 手動加入)。"""
    return totp.otpauth_uri(secret, row.email, issuer=settings.app_name or "kefu")


# =========================================================================== #
# 小工具:發 token 前解析坐席權限(role 名 + 權限碼合併進 roles claim)
# =========================================================================== #
async def _grants_for_staff(db, staff: Staff) -> list[str]:
    role_names = (
        await db.execute(
            select(Role.name)
            .join(staff_role, staff_role.c.role_id == Role.id)
            .where(staff_role.c.staff_id == staff.id)
        )
    ).scalars().all()
    perm_codes = (
        await db.execute(
            select(Permission.code)
            .join(role_permission, role_permission.c.permission_id == Permission.id)
            .join(staff_role, staff_role.c.role_id == role_permission.c.role_id)
            .where(staff_role.c.staff_id == staff.id)
        )
    ).scalars().all()
    return sorted(set(role_names) | set(perm_codes))


async def _issue_token(db, staff: Staff) -> dict:
    """簽發正式 access token(含 roles / is_platform_admin claim),回登入信封。"""
    grants = await _grants_for_staff(db, staff)
    token = create_access_token(
        {
            "sub": str(staff.id),
            "tenant_id": str(staff.tenant_id),
            "roles": grants,
            "is_platform_admin": bool(staff.is_platform_admin),
        }
    )
    return ok(
        {
            "access_token": token,
            "token_type": "bearer",
            "staff_id": str(staff.id),
            "is_platform_admin": bool(staff.is_platform_admin),
        }
    )


async def _resolve_login_staff(db, body: LoginIn) -> Staff | None:
    """定位登入坐席:優先用 2FA challenge(免再送密碼),否則以 email + 密碼逐一比對。

    email 僅在租戶內唯一,同一 email 可能存在多個租戶,故以密碼比對定位正確帳號,
    避免 scalar_one_or_none 在多筆時拋 MultipleResultsFound → 500。
    """
    if body.challenge:
        payload = _decode_purpose_token(body.challenge, _PURPOSE_2FA)
        if not payload:
            return None
        try:
            sid = uuid.UUID(str(payload["sub"]))
        except (KeyError, ValueError):
            return None
        return (
            await db.execute(select(Staff).where(Staff.id == sid, Staff.is_active.is_(True)))
        ).scalar_one_or_none()

    if not body.email or not body.password:
        return None
    candidates = (
        await db.execute(select(Staff).where(Staff.email == body.email, Staff.is_active.is_(True)))
    ).scalars().all()
    return next((s for s in candidates if verify_password(body.password, s.password_hash)), None)


# =========================================================================== #
# 登入(支援 2FA)
# =========================================================================== #
@router.post("/login")
async def login(body: LoginIn, db: DbSession, request: Request):
    """一般登入;若坐席已啟用 2FA,密碼通過後需再帶 OTP 才發正式 token。

    - 未啟用 2FA:流程與既有完全一致(email + password → token)。
    - 已啟用 2FA 且未帶 otp:回 ``{requires_2fa: true, challenge}``(不發正式 token)。
      前端可帶 challenge + otp(免重送密碼)或 email + password + otp 再呼叫一次。
    - challenge 僅對已啟用 2FA 的坐席有效,單獨憑 challenge 無 otp 不得登入。
    - 速率限制:每 IP 5 分鐘 30 次(防撞庫);OTP 每帳號 5 分鐘 10 次(防暴力破解)。
    """
    ip = ratelimit.client_ip(request)
    if not await ratelimit.hit(f"login-ip:{ip}", limit=30, window_seconds=300):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="too many attempts")

    staff = await _resolve_login_staff(db, body)
    if staff is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")

    # 停用租戶的坐席不得登入(平台超管可停用租戶)
    tenant_active = (
        await db.execute(select(Tenant.is_active).where(Tenant.id == staff.tenant_id))
    ).scalar_one_or_none()
    if tenant_active is False:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="tenant suspended")

    # 企業安全政策(租戶級):強制 2FA / 登入 IP 白名單
    require_2fa, ip_allowlist = await _load_security_policy(db, staff.tenant_id)

    # 登入 IP 白名單:非空時僅允許名單內來源。真實客戶端 IP 以可信代理跳數推導
    # (ratelimit.client_ip),不信任裸 XFF 最左跳。平台超管豁免(break-glass,避免自鎖)。
    if not staff.is_platform_admin and not _ip_allowed(ip_allowlist, ip):
        return err("LOGIN_IP_BLOCKED", "您目前的網路位址不在允許登入的名單內,請聯絡管理員")

    # 防禦:challenge 只對已啟用 2FA 的坐席成立;否則須走密碼流程
    if body.challenge and not staff.totp_enabled:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="invalid credentials")

    # 組織強制 2FA:政策開啟且該坐席「尚未啟用」2FA → 不發正式 token,回強制設定流程。
    # 平台超管豁免(break-glass)。已啟用 2FA 者不受此分支影響(走下方 OTP 驗證)。
    if require_2fa and not staff.totp_enabled and not staff.is_platform_admin:
        # 產生(或沿用既有未啟用的)密鑰,回 otpauth 供前端顯示 QR,並簽發短時效 enroll challenge。
        secret = crypto.decrypt(staff.totp_secret) if staff.totp_secret else None
        if not secret:
            secret = totp.generate_secret()
            staff.totp_secret = crypto.encrypt(secret)
            await db.commit()
        enroll = _make_purpose_token(staff, _PURPOSE_2FA_ENROLL, minutes=10)
        return ok(
            {
                "requires_2fa_enrollment": True,
                "enroll_challenge": enroll,
                "secret": secret,
                "otpauth_uri": _otpauth_for(staff, secret),
                "digits": totp.DEFAULT_DIGITS,
                "period": totp.DEFAULT_PERIOD,
            }
        )

    if staff.totp_enabled:
        if not body.otp:
            # 密碼(或 challenge)已通過,回 challenge 讓前端補 OTP,不發正式 token
            challenge = _make_purpose_token(staff, _PURPOSE_2FA, minutes=5)
            return ok({"requires_2fa": True, "challenge": challenge})
        # OTP 暴力破解防護:每帳號 5 分鐘最多 10 次驗證(TOTP 與備援碼共用此限流)
        if not await ratelimit.hit(f"otp:{staff.id}", limit=10, window_seconds=300):
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="too many attempts")
        # totp_secret 靜態加密存放:算 TOTP 前先解密(既有明文由 decrypt 原樣回傳)
        matched = _verify_totp_and_counter(crypto.decrypt(staff.totp_secret), body.otp)
        if matched is None:
            # 備援碼:TOTP 不符時,允許以「未使用」的一次性備援碼替代;命中即作廢該碼。
            if _consume_recovery_code(staff, body.otp):
                await db.commit()
                return await _issue_token(db, staff)
            return err("INVALID_OTP", "驗證碼不正確或已過期")
        # 防重放:同一或更舊時間窗的 code 不得二次使用(TOTP 一碼於 window 內可反覆算出)。
        if staff.totp_last_counter is not None and matched <= staff.totp_last_counter:
            return err("INVALID_OTP", "此驗證碼已使用過,請使用下一組新的驗證碼")
        # 記錄本次命中的時間窗序號;expire_on_commit=False 故 commit 後仍可續用 staff 屬性發 token
        staff.totp_last_counter = matched
        _reencrypt_if_plaintext(staff)  # 既有明文密鑰於首次成功驗證後就地升級為密文
        await db.commit()

    return await _issue_token(db, staff)


@router.get("/me")
async def me(staff: CurrentStaff, db: DbSession):
    row = (await db.execute(select(Staff).where(Staff.id == staff.staff_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="staff not found")
    return ok(
        {
            "staff_id": str(row.id),
            "tenant_id": str(row.tenant_id),
            "email": row.email,
            "display_name": row.display_name,
            "roles": staff.roles,
            # 供前端安全設定頁顯示 2FA 狀態(額外欄位,不影響既有映射)
            "totp_enabled": bool(row.totp_enabled),
        }
    )


@router.post("/change-password")
async def change_password(body: ChangePasswordIn, staff: CurrentStaff, db: DbSession):
    """坐席自助修改密碼:先以 old_password 驗證當前密碼,通過才更新為 new_password。

    new_password 最短 6 碼。錯誤以 err() 回覆(信封 ok=false),前端據 code 顯示訊息。
    """
    if len(body.new_password) < 6:
        return err("WEAK_PASSWORD", "新密碼至少 6 碼")
    row = (await db.execute(select(Staff).where(Staff.id == staff.staff_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="staff not found")
    if not verify_password(body.old_password, row.password_hash):
        return err("INVALID_OLD_PASSWORD", "舊密碼不正確")
    row.password_hash = hash_password(body.new_password)
    # 密碼版本綁定:改密即刷新時刻 → 任何先前簽發的重設連結因 iat 早於此而立即失效
    row.password_changed_at = datetime.now(timezone.utc)
    await db.commit()
    return ok({"staff_id": str(row.id), "password_changed": True})


# =========================================================================== #
# 自助註冊(公開):建租戶 + admin 坐席 + 預設角色/權限/方案
# =========================================================================== #
def _slugify(text: str) -> str:
    """把名稱轉為 URL-safe slug(小寫、非英數轉 '-'、去頭尾 '-')。空結果回 'tenant'。"""
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return slug[:80] or "tenant"


async def _unique_slug(db, base: str) -> str:
    """確保 slug 全域唯一(Tenant.slug unique);衝突時附短隨機尾碼重試。"""
    slug = base
    for _ in range(20):
        exists = (
            await db.execute(select(Tenant.id).where(Tenant.slug == slug))
        ).scalar_one_or_none()
        if not exists:
            return slug
        slug = f"{base[:70]}-{secrets.token_hex(3)}"
    return f"{base[:64]}-{secrets.token_hex(6)}"


@router.post("/register")
async def register(body: RegisterIn, db: DbSession, request: Request):
    """公開自助註冊:建立新租戶 + 第一個 admin 坐席 + 預設權限/admin 角色/Free 訂閱。

    與 platform.provision_tenant / tenancy.create_tenant 相同的開通邏輯,但為公開端點
    (無需平台超管)。email 於新租戶內必然唯一;slug 未給則由租戶名衍生並確保全域唯一。
    成功即自動登入(回正式 token),前端可直接進工作台。
    速率限制:每 IP 每小時最多 5 次註冊,防大量開租戶濫用。
    """
    ip = ratelimit.client_ip(request)
    if not await ratelimit.hit(f"register-ip:{ip}", limit=5, window_seconds=3600):
        return err("RATE_LIMITED", "註冊過於頻繁,請稍後再試")
    email = body.email.strip()
    if not _EMAIL_RE.match(email):
        return err("INVALID_EMAIL", "電子郵件格式不正確")
    if len(body.password) < 6:
        return err("WEAK_PASSWORD", "密碼至少 6 碼")

    slug = await _unique_slug(db, _slugify(body.slug or body.tenant_name))

    # 1) 建租戶
    tenant = Tenant(name=body.tenant_name.strip(), slug=slug, is_active=True)
    db.add(tenant)
    await db.flush()  # 取得 tenant.id

    # 2) 種預設權限碼 + admin 系統角色(與 platform / tenancy 開通一致)
    await seed_default_permissions(db, tenant.id)
    admin_role = Role(
        tenant_id=tenant.id, name="admin", description="系統管理員(全權)", is_system=True
    )
    db.add(admin_role)
    await db.flush()  # 取得 admin_role.id

    # 3) 種預設方案(Free/Pro/Enterprise)並指派 Free 訂閱
    await plan_svc.seed_default_plans(db, tenant.id)
    await plan_svc.ensure_free_subscription(db, tenant.id)

    # 4) 第一個 admin 坐席(租戶管理員,非平台超管)
    admin_staff = Staff(
        tenant_id=tenant.id,
        email=email,
        password_hash=hash_password(body.password),
        display_name=(body.display_name or email).strip(),
        status="offline",
        is_active=True,
        is_platform_admin=False,
    )
    db.add(admin_staff)
    await db.flush()  # 取得 admin_staff.id
    await db.execute(insert(staff_role).values(staff_id=admin_staff.id, role_id=admin_role.id))

    await db.commit()
    await db.refresh(admin_staff)

    # 註冊即自動登入(新帳號無 2FA,可直接發正式 token)
    session = await _issue_token(db, admin_staff)
    session["data"].update(
        {
            "tenant": {"id": str(tenant.id), "name": tenant.name, "slug": tenant.slug},
            "email": admin_staff.email,
            "display_name": admin_staff.display_name,
        }
    )
    return session


# =========================================================================== #
# 坐席邀請(email / 連結)
# =========================================================================== #
@router.post("/invite")
async def invite_staff(body: InviteIn, principal: CurrentStaff, db: DbSession):
    """管理者邀請坐席:於本租戶建 pending 帳號(隨機密碼、停用、指派角色),回可發送的邀請連結。

    - 需 ``staff.manage`` 權限;一律以 principal.tenant_id 作用於本租戶。
    - email 於本租戶內唯一(uq_staff_tenant_email);重複回 STAFF_EMAIL_TAKEN。
    - role 為角色名(預設 agent),須為本租戶既有角色;查無回 ROLE_NOT_FOUND。
    - 帳號先給隨機密碼且 ``is_active=False``(pending),接受邀請設定密碼後才啟用可登入;
      未接受的邀請帳號因停用不會被當成有效坐席。
    - 記錄 invited_at(pending 辨識 + token 版本綁定)。
    - 簽發 purpose=invite、帶版本 iv 的 7 天短期權杖,回相對路徑 invite_url(/accept-invite?token=…)。
    - 若租戶已設定 Email 寄送渠道,另寄出含連結的邀請信(寄信失敗只記 log,仍回 invite_url 供複製)。
    """
    principal.require("staff.manage")
    email = body.email.strip()
    if not _EMAIL_RE.match(email):
        return err("INVALID_EMAIL", "電子郵件格式不正確")

    # 本租戶內 email 唯一(避免撞 uq_staff_tenant_email)
    dup = (
        await db.execute(
            select(Staff).where(
                Staff.tenant_id == principal.tenant_id, Staff.email == email
            )
        )
    ).scalar_one_or_none()
    if dup:
        return err("STAFF_EMAIL_TAKEN", f"email 已存在: {email}")

    # 解析指派角色(預設 agent);須為本租戶既有角色
    role_name = (body.role or "agent").strip() or "agent"
    role = (
        await db.execute(
            select(Role).where(
                Role.tenant_id == principal.tenant_id,
                Role.name == role_name,
                Role.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if not role:
        return err("ROLE_NOT_FOUND", f"角色不存在: {role_name}")

    # 建立坐席:隨機密碼(對方無法直接登入)、pending(停用,接受後才啟用)、記 invited_at
    staff = Staff(
        tenant_id=principal.tenant_id,
        email=email,
        password_hash=hash_password(secrets.token_urlsafe(24)),
        display_name=(body.display_name or email).strip(),
        status="offline",
        is_active=False,
        is_platform_admin=False,
        invited_at=datetime.now(timezone.utc),
    )
    db.add(staff)
    await db.flush()  # 取得 staff.id
    await db.execute(insert(staff_role).values(staff_id=staff.id, role_id=role.id))
    await db.commit()
    await db.refresh(staff)

    # 權杖夾帶版本 iv(綁 invited_at):重寄後版本改變,舊權杖即失效
    token = _make_purpose_token(
        staff, _PURPOSE_INVITE, minutes=_INVITE_TTL_MINUTES, extra_claims={"iv": _invite_version(staff)}
    )
    invite_url = f"/accept-invite?token={token}"
    email_sent = await _try_send_invite_email(db, staff, invite_url)
    return ok(
        {
            "staff_id": str(staff.id),
            "email": staff.email,
            "display_name": staff.display_name,
            "role": role.name,
            "email_sent": email_sent,
            # 相對路徑;前端可自行前綴 window.location.origin 組成完整連結
            "invite_url": invite_url,
        }
    )


@router.post("/accept-invite")
async def accept_invite(body: AcceptInviteIn, db: DbSession, request: Request):
    """公開接受邀請:以邀請權杖(purpose=invite)驗證後設定密碼並啟用,回登入 token(自動登入)。

    安全(單次使用 + 版本綁定,修補「邀請 token 可重放接管帳號」P1):
    - 單次使用:要求該坐席 ``invite_accepted_at IS NULL``,否則回 INVITE_ALREADY_USED。
      成功時設 invite_accepted_at=now。這保證即使 token 未過期、即使帳號後來被停用,
      同一連結也無法二次 accept(不會被重放重設密碼 + 自動登入接管)。
    - 版本綁定:比對 token 的 iv 與該坐席目前 invited_at 版本;不符(已被重寄使舊連結作廢、
      或非邀請帳號)回 INVALID_TOKEN。
    - 已撤銷(deleted_at 非空)一律回 INVALID_TOKEN。
    - 權杖無效 / 過期回 INVALID_TOKEN;密碼 < 6 回 WEAK_PASSWORD。
    - 速率限制:每 IP 10 分鐘 20 次(權杖為簽名 JWT,暴力破解不可行,此為額外保底)。
    """
    ip = ratelimit.client_ip(request)
    if not await ratelimit.hit(f"accept-invite-ip:{ip}", limit=20, window_seconds=600):
        return err("RATE_LIMITED", "操作過於頻繁,請稍後再試")
    if len(body.password) < 6:
        return err("WEAK_PASSWORD", "密碼至少 6 碼")

    payload = _decode_purpose_token(body.token, _PURPOSE_INVITE)
    if not payload:
        return err("INVALID_TOKEN", "邀請連結無效或已過期,請洽管理員重新邀請")
    try:
        sid = uuid.UUID(str(payload["sub"]))
        tid = uuid.UUID(str(payload["tenant_id"]))
    except (KeyError, ValueError):
        return err("INVALID_TOKEN", "邀請連結無效或已過期,請洽管理員重新邀請")

    staff = (
        await db.execute(select(Staff).where(Staff.id == sid, Staff.tenant_id == tid))
    ).scalar_one_or_none()
    if not staff or staff.deleted_at is not None:
        return err("INVALID_TOKEN", "邀請連結無效或已過期,請洽管理員重新邀請")

    # 單次使用:已接受過的邀請不得再 accept(擋重放接管;即使帳號後來被停用亦然)
    if staff.invite_accepted_at is not None:
        return err("INVITE_ALREADY_USED", "此邀請連結已被使用,請洽管理員重新邀請")

    # 版本綁定:token 的 iv 必須與目前 invited_at 版本相符(重寄後舊連結失效;fail-closed)
    token_iv = payload.get("iv")
    if not isinstance(token_iv, int) or token_iv != _invite_version(staff):
        return err("INVALID_TOKEN", "邀請連結無效或已過期,請洽管理員重新邀請")

    staff.password_hash = hash_password(body.password)
    staff.is_active = True
    staff.invite_accepted_at = datetime.now(timezone.utc)
    # 密碼版本綁定:設密碼即刷新時刻 → 任何先前簽發的重設連結立即失效(與 reset 單次使用機制並存)
    staff.password_changed_at = datetime.now(timezone.utc)
    if body.display_name and body.display_name.strip():
        staff.display_name = body.display_name.strip()
    await db.commit()
    await db.refresh(staff)

    # 接受即自動登入(回正式 token,前端可直接進工作台)
    return await _issue_token(db, staff)


# --------------------------------------------------------------------------- #
# pending 邀請管理:列出 / 重寄 / 撤銷(皆需 staff.manage,作用於本租戶)
# --------------------------------------------------------------------------- #
async def _load_pending_invite(db, tenant_id: uuid.UUID, staff_id: uuid.UUID) -> Staff | None:
    """定位一筆本租戶「尚未接受」的 pending 邀請坐席;非 pending / 已接受 / 已撤銷回 None。

    pending 判定:invited_at 非空(確為邀請帳號)且 invite_accepted_at 為空(尚未接受)
    且 deleted_at 為空(未撤銷)。
    """
    staff = (
        await db.execute(
            select(Staff).where(Staff.id == staff_id, Staff.tenant_id == tenant_id)
        )
    ).scalar_one_or_none()
    if (
        not staff
        or staff.deleted_at is not None
        or staff.invited_at is None
        or staff.invite_accepted_at is not None
    ):
        return None
    return staff


@router.get("/invites/pending")
async def list_pending_invites(principal: CurrentStaff, db: DbSession):
    """列出本租戶尚未接受的 pending 邀請(email / 角色 / 邀請時間)。需 staff.manage。"""
    principal.require("staff.manage")
    rows = (
        await db.execute(
            select(Staff)
            .where(
                Staff.tenant_id == principal.tenant_id,
                Staff.is_active.is_(False),
                Staff.invite_accepted_at.is_(None),
                Staff.invited_at.is_not(None),
                Staff.deleted_at.is_(None),
            )
            .order_by(Staff.invited_at.desc())
        )
    ).scalars().all()

    invites = []
    for s in rows:
        role_names = (
            await db.execute(
                select(Role.name)
                .join(staff_role, staff_role.c.role_id == Role.id)
                .where(staff_role.c.staff_id == s.id)
            )
        ).scalars().all()
        invites.append(
            {
                "staff_id": str(s.id),
                "email": s.email,
                "display_name": s.display_name,
                "roles": sorted(role_names),
                "invited_at": s.invited_at.isoformat() if s.invited_at else None,
            }
        )
    return ok({"invites": invites})


@router.post("/invite/{staff_id}/resend")
async def resend_invite(staff_id: uuid.UUID, principal: CurrentStaff, db: DbSession):
    """對尚未接受的 pending 坐席重簽邀請 token,回新 invite_url。需 staff.manage。

    重簽會更新 invited_at → token 版本(iv)改變 → 先前發出的舊連結因版本不符而失效
    (即使舊連結尚未過期);故重寄後只有最新連結可用。若租戶已設 Email 渠道,另寄新信。
    非 pending(查無 / 已接受 / 已撤銷)回 INVITE_NOT_PENDING。
    """
    principal.require("staff.manage")
    staff = await _load_pending_invite(db, principal.tenant_id, staff_id)
    if not staff:
        return err("INVITE_NOT_PENDING", "找不到待處理的邀請,或該邀請已被接受")

    staff.invited_at = datetime.now(timezone.utc)  # 更新版本 → 舊 token 失效
    staff.is_active = False  # 維持 pending(接受前不得登入)
    await db.commit()
    await db.refresh(staff)

    token = _make_purpose_token(
        staff, _PURPOSE_INVITE, minutes=_INVITE_TTL_MINUTES, extra_claims={"iv": _invite_version(staff)}
    )
    invite_url = f"/accept-invite?token={token}"
    email_sent = await _try_send_invite_email(db, staff, invite_url)
    return ok(
        {
            "staff_id": str(staff.id),
            "email": staff.email,
            "display_name": staff.display_name,
            "email_sent": email_sent,
            "invite_url": invite_url,
        }
    )


@router.post("/invite/{staff_id}/revoke")
async def revoke_invite(staff_id: uuid.UUID, principal: CurrentStaff, db: DbSession):
    """撤銷尚未接受的 pending 邀請:軟刪該坐席(deleted_at 標記 + 停用)。需 staff.manage。

    僅限尚未 accept 者;非 pending 回 INVITE_NOT_PENDING。撤銷後其邀請連結因 deleted_at
    非空而於 accept 端被拒(INVALID_TOKEN)。
    """
    principal.require("staff.manage")
    staff = await _load_pending_invite(db, principal.tenant_id, staff_id)
    if not staff:
        return err("INVITE_NOT_PENDING", "找不到待處理的邀請,或該邀請已被接受")

    staff.deleted_at = datetime.now(timezone.utc)
    staff.is_active = False
    await db.commit()
    return ok({"staff_id": str(staff_id), "revoked": True})


# =========================================================================== #
# 忘記 / 重設密碼
# =========================================================================== #
def _invite_link(invite_url: str) -> str:
    """把相對 invite_url 前綴 KEFU_FRONTEND_BASE 組成寄信用的完整連結(未設則維持相對)。"""
    base = (os.environ.get("KEFU_FRONTEND_BASE") or "").rstrip("/")
    return f"{base}{invite_url}" if base else invite_url


async def _try_send_invite_email(db, staff: Staff, invite_url: str) -> bool:
    """若該租戶有啟用中的 email 渠道且設有 SMTP,寄出坐席邀請信;成功回 True。

    複用 _try_send_reset_email 的渠道查找 / SMTP 取用模式;寄送失敗只記 log 回 False
    (呼叫端仍回 invite_url 供複製,寄信失敗不阻斷邀請流程)。
    """
    channel = (
        await db.execute(
            select(Channel).where(
                Channel.tenant_id == staff.tenant_id,
                Channel.type == "email",
                Channel.is_active.is_(True),
                Channel.deleted_at.is_(None),
            )
        )
    ).scalars().first()
    smtp_cfg = ((channel.config or {}).get("smtp") if channel and channel.config else None) or {}
    if not smtp_cfg.get("host"):
        return False
    try:
        from app.services.email import send_email  # 延遲匯入,避免載入 smtplib 相關成本

        link = _invite_link(invite_url)
        subject = "您已受邀加入客服團隊"
        text = (
            "您好,\n\n"
            "您受邀加入客服團隊。請於 7 天內點擊下列連結,設定您的登入密碼以完成加入:\n\n"
            f"{link}\n\n"
            "此連結僅能使用一次,設定密碼後即失效。\n"
            "若您並未預期收到此邀請,請忽略本信。\n"
        )
        await send_email(smtp_cfg, staff.email, subject, text)
        return True
    except Exception:  # noqa: BLE001 — 寄信失敗不應讓邀請流程報錯
        logger.exception("寄送邀請郵件失敗 staff=%s", staff.id)
        return False


async def _try_send_reset_email(db, staff: Staff, token: str) -> bool:
    """若該租戶有啟用中的 email 渠道且設有 SMTP,寄出重設密碼信;成功回 True。

    找不到 SMTP 設定或寄送失敗一律回 False(呼叫端據此決定 dev 降級回傳 token)。
    """
    channel = (
        await db.execute(
            select(Channel).where(
                Channel.tenant_id == staff.tenant_id,
                Channel.type == "email",
                Channel.is_active.is_(True),
                Channel.deleted_at.is_(None),
            )
        )
    ).scalars().first()
    smtp_cfg = ((channel.config or {}).get("smtp") if channel and channel.config else None) or {}
    if not smtp_cfg.get("host"):
        return False
    try:
        from app.services.email import send_email  # 延遲匯入,避免載入 smtplib 相關成本

        subject = "重設您的密碼"
        text = (
            "您好,\n\n"
            "我們收到了重設此帳號密碼的請求。請使用下列重設權杖(30 分鐘內有效):\n\n"
            f"{token}\n\n"
            "於重設密碼頁面貼上此權杖並設定新密碼即可。\n"
            "若非您本人操作,請忽略本信,您的密碼不會變更。\n"
        )
        await send_email(smtp_cfg, staff.email, subject, text)
        return True
    except Exception:  # noqa: BLE001 — 寄信失敗不應讓忘記密碼流程報錯
        logger.exception("寄送重設密碼郵件失敗 staff=%s", staff.id)
        return False


@router.post("/forgot-password")
async def forgot_password(body: ForgotPasswordIn, db: DbSession, request: Request):
    """公開忘記密碼:為符合的坐席簽發短時效重設權杖。

    - 一律回傳相同的通用訊息,避免以回應內容枚舉帳號是否存在。
    - 該租戶已設定 SMTP(email 渠道)→ 寄出重設信。
    - 無 SMTP:dev / 測試環境回傳 token 供測試;正式環境僅記錄日誌不外洩。
    """
    ip = ratelimit.client_ip(request)
    if not await ratelimit.hit(f"forgot-ip:{ip}", limit=10, window_seconds=600):
        # 一律回通用訊息,不因限流洩漏帳號存在與否
        return ok({"message": "若該信箱存在,我們已寄出重設密碼連結,請至信箱查收。"})
    email = body.email.strip()
    staffs = (
        await db.execute(select(Staff).where(Staff.email == email, Staff.is_active.is_(True)))
    ).scalars().all()

    email_sent = False
    for s in staffs:
        token = _make_purpose_token(s, _PURPOSE_RESET, minutes=30)
        sent = await _try_send_reset_email(db, s, token)
        email_sent = email_sent or sent
        # 安全:重設權杖絕不放進 HTTP 回應(否則知道 email 即可接管帳號)。
        # dev / 測試環境為方便測試,僅將 token 寫進伺服器日誌;正式環境連日誌都不記 token。
        if _is_dev():
            logger.info("forgot-password token staff=%s tenant=%s email_sent=%s token=%s", s.id, s.tenant_id, sent, token)
        else:
            logger.info("forgot-password 已簽發重設權杖 staff=%s tenant=%s email_sent=%s", s.id, s.tenant_id, sent)

    # 一律回相同通用訊息(不論帳號是否存在、不外洩任何 token),避免帳號枚舉與 token 外洩。
    return ok({"message": "若該信箱存在,我們已寄出重設密碼連結,請至信箱查收。"})


@router.post("/reset-password")
async def reset_password(body: ResetPasswordIn, db: DbSession):
    """以重設權杖(purpose=pwreset)驗證後更新密碼。權杖無效 / 過期回 INVALID_TOKEN。

    單次使用 + 改密即失效(密碼版本綁定,修補「重設 token 可重放」P2):
    - token 夾帶簽發時刻 ``iat``(_make_purpose_token 既有)。驗證時比對該坐席的
      ``password_changed_at``:若已設定且 ``>= iat``,代表此 token 於簽發後已被用來改密、
      或密碼已被其他途徑(change-password / accept-invite)變更 → 一律拒 INVALID_TOKEN。
    - 首次使用(password_changed_at 為 None,或早於 iat)才放行;成功後寫入
      ``password_changed_at=now``,使同一 token 二次重放立即失效(now > iat)。
    - 缺 iat 的異常 token 一律 fail-closed 拒絕。
    - 與 accept-invite 的 ``invite_accepted_at`` 單次使用機制彼此獨立、可並存。
    """
    if len(body.new_password) < 6:
        return err("WEAK_PASSWORD", "新密碼至少 6 碼")
    payload = _decode_purpose_token(body.token, _PURPOSE_RESET)
    if not payload:
        return err("INVALID_TOKEN", "重設連結無效或已過期,請重新申請")
    try:
        sid = uuid.UUID(str(payload["sub"]))
        tid = uuid.UUID(str(payload["tenant_id"]))
    except (KeyError, ValueError):
        return err("INVALID_TOKEN", "重設連結無效或已過期,請重新申請")

    # token 簽發時刻(jose 以整秒 epoch 回傳);缺失或非數值 → fail-closed
    token_iat = payload.get("iat")
    if not isinstance(token_iat, (int, float)):
        return err("INVALID_TOKEN", "重設連結無效或已過期,請重新申請")

    staff = (
        await db.execute(select(Staff).where(Staff.id == sid, Staff.tenant_id == tid))
    ).scalar_one_or_none()
    if not staff:
        return err("INVALID_TOKEN", "重設連結無效或已過期,請重新申請")

    # 密碼版本綁定:改密時刻 >= token 簽發時刻 → 此連結已被用過或密碼已變更,拒絕(單次使用)
    if staff.password_changed_at is not None and staff.password_changed_at.timestamp() >= token_iat:
        return err("INVALID_TOKEN", "此重設連結已失效(已使用或密碼已變更),請重新申請")

    staff.password_hash = hash_password(body.new_password)
    staff.password_changed_at = datetime.now(timezone.utc)
    await db.commit()
    return ok({"staff_id": str(staff.id), "password_reset": True})


@router.post("/staff/{staff_id}/reset-link")
async def staff_reset_link(staff_id: uuid.UUID, principal: CurrentStaff, db: DbSession):
    """管理員為本租戶指定坐席產生密碼重設連結(需 staff.manage,tenant 隔離)。

    解決「demo / 未設 SMTP 時公開 forgot-password 走不通」:公開端點基於安全一律不外洩
    token,無 SMTP 時使用者實際無法重設。此端點讓已驗身且具權限的管理員主動產生重設連結
    (類比坐席邀請的 copy-link),安全且可用。
    - tenant 隔離:僅能對本租戶(principal.tenant_id)、未軟刪的坐席簽發;查無回 STAFF_NOT_FOUND。
    - 回相對 reset_url(/reset-password?token=…)供管理員複製轉交。管理員已驗身+授權,回連結給他
      是可接受的(有別於公開 forgot-password 絕不可回 token)。
    - 若租戶已設 SMTP(email 渠道),另嘗試寄出重設信(複用 _try_send_reset_email),回 email_sent。
    - 重設 token 維持單次使用:reset-password 端以 password_changed_at 綁定簽發時刻 iat,
      連結一經使用或密碼經其他途徑變更即立即失效(此處不需額外處理)。
    """
    principal.require("staff.manage")
    staff = (
        await db.execute(
            select(Staff).where(
                Staff.id == staff_id,
                Staff.tenant_id == principal.tenant_id,
                Staff.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if not staff:
        return err("STAFF_NOT_FOUND", "找不到該坐席")

    token = _make_purpose_token(staff, _PURPOSE_RESET, minutes=30)
    reset_url = f"/reset-password?token={token}"
    email_sent = await _try_send_reset_email(db, staff, token)
    return ok(
        {
            "staff_id": str(staff.id),
            "email": staff.email,
            # 相對路徑;前端可前綴 window.location.origin 組成完整連結
            "reset_url": reset_url,
            "email_sent": email_sent,
        }
    )


# =========================================================================== #
# 兩步驗證(TOTP)
# =========================================================================== #
async def _load_staff(db, staff_id: uuid.UUID) -> Staff | None:
    return (await db.execute(select(Staff).where(Staff.id == staff_id))).scalar_one_or_none()


@router.get("/2fa/status")
async def twofa_status(staff: CurrentStaff, db: DbSession):
    """回目前登入坐席的 2FA 狀態(是否已啟用 / 是否已產生密鑰待啟用)。"""
    row = await _load_staff(db, staff.staff_id)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="staff not found")
    return ok(
        {
            "totp_enabled": bool(row.totp_enabled),
            "has_secret": bool(row.totp_secret),
            # 備援碼狀態(供安全設定頁顯示剩餘數 / 是否已產生);額外欄位,不影響既有映射
            "recovery_codes_remaining": _recovery_codes_remaining(row),
            "recovery_codes_generated": bool(row.totp_recovery_codes),
        }
    )


@router.post("/2fa/setup")
async def twofa_setup(staff: CurrentStaff, db: DbSession):
    """產生新的 TOTP 密鑰並存入 Staff.totp_secret(尚未啟用),回 otpauth URI 供掃碼/手動加入。

    已啟用 2FA 時拒絕(避免覆寫既有密鑰);需先 disable 再重新 setup。
    """
    row = await _load_staff(db, staff.staff_id)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="staff not found")
    if row.totp_enabled:
        return err("TWOFA_ALREADY_ENABLED", "兩步驗證已啟用;請先停用再重新設定")

    secret = totp.generate_secret()
    # 靜態加密後存放(與其他機敏欄位一致,不明文落地);otpauth_uri 仍以明文 secret 產生
    row.totp_secret = crypto.encrypt(secret)
    await db.commit()
    uri = totp.otpauth_uri(secret, row.email, issuer=settings.app_name or "kefu")
    return ok(
        {
            "secret": secret,
            "otpauth_uri": uri,
            "digits": totp.DEFAULT_DIGITS,
            "period": totp.DEFAULT_PERIOD,
        }
    )


@router.post("/2fa/enable")
async def twofa_enable(body: TwoFaEnableIn, staff: CurrentStaff, db: DbSession):
    """驗證使用者以驗證器 App 產生的 code,通過即把 totp_enabled 設為 true。"""
    row = await _load_staff(db, staff.staff_id)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="staff not found")
    if not row.totp_secret:
        return err("TWOFA_NOT_SETUP", "尚未產生密鑰,請先執行設定")
    if row.totp_enabled:
        return ok({"totp_enabled": True})  # 冪等
    if not totp.verify(crypto.decrypt(row.totp_secret), body.code):
        return err("INVALID_OTP", "驗證碼不正確,請確認驗證器時間同步後重試")
    _reencrypt_if_plaintext(row)  # 既有明文密鑰於啟用時就地升級為密文
    row.totp_enabled = True
    # 啟用即產生一組備援碼(明文僅此次回傳;之後只能重新產生,無法再取得原碼)
    plain, stored = generate_recovery_codes()
    row.totp_recovery_codes = stored
    await db.commit()
    return ok({"totp_enabled": True, "recovery_codes": plain})


@router.post("/2fa/disable")
async def twofa_disable(body: TwoFaDisableIn, staff: CurrentStaff, db: DbSession):
    """停用 2FA:需提供有效 OTP 或帳號密碼再次驗證身分;通過後清除密鑰並關閉。"""
    row = await _load_staff(db, staff.staff_id)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="staff not found")
    if not row.totp_enabled:
        return ok({"totp_enabled": False})  # 已停用,冪等

    verified = False
    if body.code and totp.verify(crypto.decrypt(row.totp_secret), body.code):
        verified = True
    elif body.password and verify_password(body.password, row.password_hash):
        verified = True
    if not verified:
        return err("TWOFA_VERIFY_REQUIRED", "請提供有效的驗證碼或帳號密碼以停用兩步驗證")

    row.totp_enabled = False
    row.totp_secret = None
    row.totp_recovery_codes = None  # 停用即清除備援碼(重新啟用時另產生一組新的)
    await db.commit()
    return ok({"totp_enabled": False})


@router.post("/2fa/enroll/verify")
async def twofa_enroll_verify(body: TwoFaEnrollVerifyIn, db: DbSession, request: Request):
    """組織強制 2FA 設定流程第二步:驗證掃碼後的動態碼,通過即啟用 2FA 並自動登入(發正式 token)。

    - challenge 為 login 在 ``requires_2fa_enrollment`` 時回的短時效 enroll 權杖(purpose=2fa_enroll)。
    - 通過後:``totp_enabled=True``、產生一組備援碼(明文僅此次回傳)、簽發正式 token。
    - 一併重查 IP 白名單(與 login 同一把關,平台超管豁免),避免繞過。
    - OTP 暴力破解防護沿用每帳號限流。
    """
    payload = _decode_purpose_token(body.challenge, _PURPOSE_2FA_ENROLL)
    if not payload:
        return err("INVALID_TOKEN", "設定連結無效或已過期,請重新登入")
    try:
        sid = uuid.UUID(str(payload["sub"]))
    except (KeyError, ValueError):
        return err("INVALID_TOKEN", "設定連結無效或已過期,請重新登入")
    staff = (
        await db.execute(select(Staff).where(Staff.id == sid, Staff.is_active.is_(True)))
    ).scalar_one_or_none()
    if not staff:
        return err("INVALID_TOKEN", "設定連結無效或已過期,請重新登入")

    # 租戶停用不得登入(對齊 /login)
    tenant_active = (
        await db.execute(select(Tenant.is_active).where(Tenant.id == staff.tenant_id))
    ).scalar_one_or_none()
    if tenant_active is False:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="tenant suspended")

    # 登入 IP 白名單再把關(平台超管豁免)
    ip = ratelimit.client_ip(request)
    _, ip_allowlist = await _load_security_policy(db, staff.tenant_id)
    if not staff.is_platform_admin and not _ip_allowed(ip_allowlist, ip):
        return err("LOGIN_IP_BLOCKED", "您目前的網路位址不在允許登入的名單內,請聯絡管理員")

    # OTP 暴力破解防護:每帳號 5 分鐘最多 10 次驗證
    if not await ratelimit.hit(f"otp:{staff.id}", limit=10, window_seconds=300):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="too many attempts")

    if not staff.totp_secret:
        return err("TWOFA_NOT_SETUP", "尚未產生密鑰,請重新登入以開始設定")
    if not totp.verify(crypto.decrypt(staff.totp_secret), body.code):
        return err("INVALID_OTP", "驗證碼不正確,請確認驗證器時間同步後重試")

    _reencrypt_if_plaintext(staff)
    staff.totp_enabled = True
    plain, stored = generate_recovery_codes()
    staff.totp_recovery_codes = stored
    await db.commit()

    # 完成 2FA 綁定即自動登入;備援碼明文僅此次回傳,提醒使用者妥善保存
    session = await _issue_token(db, staff)
    session["data"]["recovery_codes"] = plain
    return session


@router.post("/2fa/recovery-codes/regenerate")
async def twofa_regenerate_recovery_codes(staff: CurrentStaff, db: DbSession):
    """重新產生一組 2FA 備援碼(整組覆寫使舊碼全部作廢),回新碼明文(僅此次顯示)。

    需登入且已啟用 2FA;未啟用回 TWOFA_NOT_ENABLED。
    """
    row = await _load_staff(db, staff.staff_id)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="staff not found")
    if not row.totp_enabled:
        return err("TWOFA_NOT_ENABLED", "尚未啟用兩步驗證,請先啟用再產生備援碼")
    plain, stored = generate_recovery_codes()
    row.totp_recovery_codes = stored
    await db.commit()
    return ok({"recovery_codes": plain, "count": len(plain)})


# =========================================================================== #
# 租戶企業安全政策(強制 2FA / 登入 IP 白名單)—— 需 settings.manage
# =========================================================================== #
@router.get("/security-policy")
async def get_security_policy(staff: CurrentStaff, db: DbSession, request: Request):
    """取本租戶企業安全政策。需 settings.manage。

    另回 ``current_ip``:呼叫者目前的真實來源 IP,供設定白名單時避免把自己鎖在門外。
    """
    staff.require("settings.manage")
    require_2fa, ip_allowlist = await _load_security_policy(db, staff.tenant_id)
    return ok(
        {
            "require_2fa": require_2fa,
            "login_ip_allowlist": ip_allowlist or [],
            "current_ip": ratelimit.client_ip(request),
        }
    )


@router.put("/security-policy")
async def put_security_policy(
    body: SecurityPolicyIn, staff: CurrentStaff, db: DbSession, request: Request
):
    """更新本租戶企業安全政策(upsert)。需 settings.manage。

    護欄(避免管理員把自己鎖死):
    - login_ip_allowlist 每項須為合法 IP 或 CIDR(IPv4/IPv6);含非法項回 INVALID_IP。
      清單會去重與正規化(如 CIDR 主機位元歸零)。
    - 若要設定「非空」白名單,且呼叫者(非平台超管)目前 IP 不在名單內 → 拒 IP_SELF_LOCKOUT,
      避免一存就把自己鎖在門外(前端會顯示 current_ip 供加入)。平台超管本就不受名單約束,免此限。
    - 空清單 / None = 解除 IP 限制。
    - require_2fa 為租戶級開關;開啟後未啟用 2FA 的坐席下次登入將被導向強制設定流程。
    """
    staff.require("settings.manage")
    current_ip = ratelimit.client_ip(request)
    data = body.model_dump(exclude_unset=True)

    normalized_allowlist: list | None = None
    allowlist_touched = "login_ip_allowlist" in data
    if allowlist_touched:
        raw = data["login_ip_allowlist"] or []
        if not isinstance(raw, list):
            return err("INVALID_IP", "白名單格式不正確")
        normalized: list[str] = []
        for item in raw:
            norm = _validate_ip_entry(item) if isinstance(item, str) else None
            if norm is None:
                return err("INVALID_IP", f"無效的 IP 或 CIDR:{item}")
            if norm not in normalized:
                normalized.append(norm)
        # 自鎖護欄:非空白名單須涵蓋呼叫者當前 IP(平台超管豁免,其本就不受名單限制)
        row_self = await _load_staff(db, staff.staff_id)
        caller_is_platform_admin = bool(row_self and row_self.is_platform_admin)
        if normalized and not caller_is_platform_admin and not _ip_allowed(normalized, current_ip):
            return err(
                "IP_SELF_LOCKOUT",
                f"白名單未包含您目前的 IP({current_ip});為避免將自己鎖在門外,"
                "請先把此 IP 或其所屬網段加入名單再儲存",
            )
        normalized_allowlist = normalized or None

    row = (
        await db.execute(
            select(TenantSettings).where(
                TenantSettings.tenant_id == staff.tenant_id,
                TenantSettings.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if row is None:
        row = TenantSettings(tenant_id=staff.tenant_id)
        db.add(row)

    if "require_2fa" in data and data["require_2fa"] is not None:
        row.require_2fa = bool(data["require_2fa"])
    if allowlist_touched:
        row.login_ip_allowlist = normalized_allowlist

    await db.commit()
    await db.refresh(row)
    return ok(
        {
            "require_2fa": bool(row.require_2fa),
            "login_ip_allowlist": row.login_ip_allowlist or [],
            "current_ip": current_ip,
        }
    )


# =========================================================================== #
# 單一登入(Google OAuth 2.0 / OpenID Connect)
#
# 設計:僅允許「既有坐席」以 Google 登入(比對 email),不自動開帳號(安全)。
# 所有設定走環境變數(不動 config.py):
#   - KEFU_GOOGLE_CLIENT_ID      Google OAuth 用戶端 ID(未設 → SSO 停用)
#   - KEFU_GOOGLE_CLIENT_SECRET  用戶端密鑰(換 token 需要)
#   - KEFU_GOOGLE_REDIRECT       callback 網址(未設 → 依請求推導)
#   - KEFU_FRONTEND_BASE         前端基底(用於登入後導回;未設 → 相對 /login)
# =========================================================================== #
def _google_client_id() -> str | None:
    return os.environ.get("KEFU_GOOGLE_CLIENT_ID") or None


def _google_redirect_uri(request: Request) -> str:
    """OAuth callback 網址:優先取 KEFU_GOOGLE_REDIRECT,否則依請求推導。"""
    explicit = os.environ.get("KEFU_GOOGLE_REDIRECT")
    if explicit:
        return explicit
    return str(request.url_for("google_oauth_callback"))


def _frontend_login_url() -> str:
    """登入頁基底:KEFU_FRONTEND_BASE 有設則絕對,否則相對 /login(同源反代情境)。"""
    base = (os.environ.get("KEFU_FRONTEND_BASE") or "").rstrip("/")
    return f"{base}/login" if base else "/login"


@router.get("/oauth/google/start")
async def google_oauth_start(request: Request):
    """導向 Google OAuth 同意畫面;未設定 client_id 時回 SSO_DISABLED(前端據此提示)。"""
    client_id = _google_client_id()
    if not client_id:
        return err("SSO_DISABLED", "尚未設定 Google 單一登入,請聯絡管理員")
    params = {
        "client_id": client_id,
        "redirect_uri": _google_redirect_uri(request),
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "online",
        "prompt": "select_account",
    }
    return RedirectResponse(f"{_GOOGLE_AUTH_URL}?{urlencode(params)}", status_code=302)


@router.get("/oauth/google/callback", name="google_oauth_callback")
async def google_oauth_callback(
    request: Request,
    db: DbSession,
    code: str | None = None,
    error: str | None = None,
):
    """Google 回呼:以 code 換 token→取 email→比對既有 Staff;成功導回前端(帶 token)。

    - 找不到對應坐席 → 導回登入頁帶 sso_error=SSO_NOT_INVITED(不自動開帳號)。
    - 任一步失敗(缺 secret / 換 token / 取 userinfo)全程 try/except 降級,導回帶 sso_error。
    - 成功:以 URL fragment 傳 token(#sso_token=…),避免落入伺服器日誌 / Referer。
    """
    login_url = _frontend_login_url()
    if error or not code:
        return RedirectResponse(f"{login_url}?{urlencode({'sso_error': 'OAUTH_FAILED'})}", status_code=302)

    client_id = _google_client_id()
    client_secret = os.environ.get("KEFU_GOOGLE_CLIENT_SECRET")
    if not client_id or not client_secret:
        return RedirectResponse(f"{login_url}?{urlencode({'sso_error': 'SSO_DISABLED'})}", status_code=302)

    try:
        import httpx  # 延遲匯入,對齊他處慣例

        async with httpx.AsyncClient(timeout=10.0) as client:
            token_res = await client.post(
                _GOOGLE_TOKEN_URL,
                data={
                    "code": code,
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "redirect_uri": _google_redirect_uri(request),
                    "grant_type": "authorization_code",
                },
            )
            access = (token_res.json() or {}).get("access_token")
            if not access:
                logger.warning("Google OAuth 換 token 失敗 status=%s", token_res.status_code)
                return RedirectResponse(f"{login_url}?{urlencode({'sso_error': 'OAUTH_FAILED'})}", status_code=302)
            info_res = await client.get(
                _GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {access}"}
            )
            info = info_res.json() or {}
    except Exception:  # noqa: BLE001 — SSO 任一步失敗一律降級導回登入頁
        logger.exception("Google OAuth callback 失敗")
        return RedirectResponse(f"{login_url}?{urlencode({'sso_error': 'OAUTH_FAILED'})}", status_code=302)

    email = (info.get("email") or "").strip().lower()
    email_verified = info.get("email_verified", True)
    if not email or not email_verified:
        return RedirectResponse(f"{login_url}?{urlencode({'sso_error': 'OAUTH_FAILED'})}", status_code=302)

    # 比對既有 Staff(email,大小寫不敏感);email 僅租戶內唯一,跨租戶多筆時取第一個啟用者。
    staff = (
        await db.execute(
            select(Staff).where(func.lower(Staff.email) == email, Staff.is_active.is_(True))
        )
    ).scalars().first()
    if not staff:
        # 不自動開帳號:未被邀請的 Google 帳號一律拒絕(安全)
        return RedirectResponse(f"{login_url}?{urlencode({'sso_error': 'SSO_NOT_INVITED'})}", status_code=302)

    # 停用租戶的坐席不得登入(對齊 /login 的租戶檢查)
    tenant_active = (
        await db.execute(select(Tenant.is_active).where(Tenant.id == staff.tenant_id))
    ).scalar_one_or_none()
    if tenant_active is False:
        return RedirectResponse(f"{login_url}?{urlencode({'sso_error': 'SSO_NOT_INVITED'})}", status_code=302)

    # 企業安全政策亦適用於 SSO(平台超管豁免),避免以 SSO 繞過 IP 白名單 / 強制 2FA:
    # - IP 不在白名單 → 導回登入頁帶 LOGIN_IP_BLOCKED。
    # - 組織強制 2FA 但該坐席未啟用 → 導回帶 TWOFA_ENROLL_REQUIRED,要求改用帳密登入完成 2FA 綁定
    #   (SSO 路徑不便內嵌設定流程,故引導至帳密登入的強制設定;取捨見回報說明)。
    require_2fa, ip_allowlist = await _load_security_policy(db, staff.tenant_id)
    if not staff.is_platform_admin:
        if not _ip_allowed(ip_allowlist, ratelimit.client_ip(request)):
            return RedirectResponse(f"{login_url}?{urlencode({'sso_error': 'LOGIN_IP_BLOCKED'})}", status_code=302)
        if require_2fa and not staff.totp_enabled:
            return RedirectResponse(f"{login_url}?{urlencode({'sso_error': 'TWOFA_ENROLL_REQUIRED'})}", status_code=302)

    session = await _issue_token(db, staff)
    token = session["data"]["access_token"]
    # token 以 fragment 傳遞(不進伺服器日誌 / Referer);前端 LoginPage 讀 hash 完成登入
    return RedirectResponse(f"{login_url}#sso_token={token}", status_code=302)
