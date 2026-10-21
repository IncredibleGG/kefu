"""企業 SSO:租戶級 SAML 2.0 + SCIM 2.0 自動佈建設定(乾淨室)。

一張表 ``tenant_sso_config``,每租戶最多一列(uq_sso_tenant),存放:
- SAML SP↔IdP 對接設定(IdP entityID / SSO URL / 簽章驗證用 x509 憑證,ACS 為衍生值)。
- SCIM 2.0 自動佈建設定(啟用開關、bearer 權杖雜湊、佈建坐席的預設角色)。

**零回歸**:未建列 / 未啟用時,SAML 與 SCIM 端點一律回 disabled,不影響既有
Google OAuth / 密碼登入。SCIM bearer 權杖**僅存雜湊**(sha256 + pepper),明文只在
產生當下回傳一次;此檔提供 ``hash_scim_token`` 供 saml.py(產生/輪替)與
scim.py(鑑權比對)共用,避免兩處各自實作雜湊而不一致。
"""
from __future__ import annotations

import hashlib

from sqlalchemy import String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.config import settings
from app.core.db import Base
from app.models.base import TenantScopedMixin


def _scim_pepper() -> bytes:
    """SCIM 權杖雜湊的 pepper:沿用既有 secret_key(退回 jwt_secret),與 2FA 備援碼一致。"""
    return (settings.secret_key or settings.jwt_secret or "kefu-dev-secret").encode("utf-8")


def hash_scim_token(token: str | None) -> str:
    """對 SCIM bearer 權杖做 sha256(pepper || token),回十六進位雜湊。

    bearer 為高熵隨機值(≥32 bytes),sha256 + pepper 已不可字典逆推,無需慢雜湊;
    比對時走 ``hmac.compare_digest`` 常數時間(見 scim.py / saml.py)。
    """
    return hashlib.sha256(_scim_pepper() + (token or "").encode("utf-8")).hexdigest()


class TenantSSOConfig(Base, TenantScopedMixin):
    """每租戶一列的企業 SSO 設定(SAML + SCIM)。"""

    __tablename__ = "tenant_sso_config"
    # 每租戶僅一列:設定為 upsert 語義(見 saml.py 的 /config)
    __table_args__ = (UniqueConstraint("tenant_id", name="uq_sso_tenant"),)

    # ---- SAML 2.0(SP 端對接 IdP)----
    # 總開關:False 時 /login /metadata /acs 一律回 SSO_DISABLED(零回歸)
    saml_enabled: Mapped[bool] = mapped_column(default=False, nullable=False)
    # IdP 的 entityID(AuthnRequest 不需,但保留供比對 Response 的 Issuer)
    saml_idp_entity_id: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # IdP 的 SSO 端點(HTTP-Redirect binding):/login 產 AuthnRequest 後導向此處
    saml_idp_sso_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    # IdP 的簽章驗證憑證(X.509 PEM 或裸 base64 DER);驗 SAMLResponse 簽章用。
    # 為公開憑證(非私鑰),存明文;可含多行,故用 Text。
    saml_idp_x509_cert: Mapped[str | None] = mapped_column(Text, nullable=True)
    # SP 的 ACS(Assertion Consumer Service)URL:衍生值。留空時由請求 base 於執行期
    # 推導(str(request.url_for("saml_acs", ...))),此欄供反代 / 自訂網域情境覆寫。
    saml_sp_acs_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)

    # ---- SCIM 2.0(IdP → 本系統的自動佈建)----
    # 總開關:False 時 /scim/v2/* 一律 401(即使 bearer 相符)
    scim_enabled: Mapped[bool] = mapped_column(default=False, nullable=False)
    # SCIM 用的 bearer 權杖**雜湊**(僅存雜湊,不存明文);tenant 由此權杖對應。
    scim_bearer_token_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)

    # ---- 共用 ----
    # SAML 登入首次比對到 / SCIM 佈建出的坐席,指派的預設角色名(租戶內既有角色;預設 agent)。
    default_role: Mapped[str | None] = mapped_column(String(100), nullable=True)
