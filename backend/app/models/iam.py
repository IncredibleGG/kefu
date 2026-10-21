"""M2 iam: Staff (agents), Role, Permission, SkillGroup, and their links (RBAC)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Column,
    DateTime,
    ForeignKey,
    String,
    Table,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin

# association tables
staff_role = Table(
    "staff_role", Base.metadata,
    Column("staff_id", UUID(as_uuid=True), ForeignKey("staff.id", ondelete="CASCADE"), primary_key=True),
    Column("role_id", UUID(as_uuid=True), ForeignKey("role.id", ondelete="CASCADE"), primary_key=True),
)
role_permission = Table(
    "role_permission", Base.metadata,
    Column("role_id", UUID(as_uuid=True), ForeignKey("role.id", ondelete="CASCADE"), primary_key=True),
    Column("permission_id", UUID(as_uuid=True), ForeignKey("permission.id", ondelete="CASCADE"), primary_key=True),
)
staff_skillgroup = Table(
    "staff_skillgroup", Base.metadata,
    Column("staff_id", UUID(as_uuid=True), ForeignKey("staff.id", ondelete="CASCADE"), primary_key=True),
    Column("skillgroup_id", UUID(as_uuid=True), ForeignKey("skill_group.id", ondelete="CASCADE"), primary_key=True),
)


class Staff(Base, TenantScopedMixin):
    """A human agent / admin user within a tenant."""

    __tablename__ = "staff"
    __table_args__ = (UniqueConstraint("tenant_id", "email", name="uq_staff_tenant_email"),)

    email: Mapped[str] = mapped_column(String(255), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organization.id", ondelete="SET NULL"), nullable=True
    )
    # presence: online / busy / away / offline (live status lives in Redis; this is last-known)
    status: Mapped[str] = mapped_column(String(20), default="offline", nullable=False)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)
    # 坐席個人簽名檔:回覆時可自動附加於訊息末(純文字;None/空=不附加)
    signature: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 兩步驗證(2FA/TOTP):密鑰以 app.core.crypto(Fernet,enc:: 前綴)靜態加密後存放,
    # 與其他機敏欄位(bot_token / SMTP 密碼等)一致,不再明文落地。既有明文值仍可相容讀取
    # (crypto.decrypt 對非 enc:: 值原樣回傳),首次成功驗證 / 啟用後就地升級為密文。
    # 密文長度約 145 字元(明文 base32 約 32),故欄位由 varchar(64) 放寬至 varchar(255);
    # 需由 DB 遷移同步放寬此欄(schema 由主 session 部署),否則寫入密文會因超長被 DB 拒絕。
    totp_secret: Mapped[str | None] = mapped_column(String(255), nullable=True)
    totp_enabled: Mapped[bool] = mapped_column(default=False, nullable=False)
    # 2FA 防重放:上次成功驗證所命中的 TOTP 時間窗序號(counter = int(unix // period))。
    # 登入驗 OTP 成功時更新;同一或更舊的時間窗序號一律拒絕,杜絕同窗內重複使用同一 code。
    # 用 BigInteger:counter 隨時間單調成長,int32 於遙遠未來會溢位,BigInteger 保險。
    totp_last_counter: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # 2FA 備援碼(recovery / backup codes):啟用 2FA 時產生一組(預設 10 個)一次性碼,
    # **僅存雜湊、不存明文**(sha256 + pepper);明文只在產生當下回傳一次,之後無法再取得。
    # 形狀:list[{"hash": "<sha256 hex>", "used": bool}]。登入 OTP 步驟可用「未使用」的備援碼
    # 替代 TOTP(命中即標記 used,每碼僅一次)。重新產生會整組覆寫使舊碼全部作廢。
    # None / 空清單 = 尚未產生(或已用罄)。走 JSONB,無需固定欄寬。
    totp_recovery_codes: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # 密碼版本綁定(重設 token 單次使用):任何「改密入口」(change-password /
    # accept-invite 設密碼 / reset-password)成功時設為 now。reset-password 驗證時,
    # 若本欄 >= 重設 token 的簽發時刻 iat,代表該 token 已被用過、或密碼已被其他途徑變更,
    # 一律拒(INVALID_TOKEN)。這使重設 token 單次使用,且任何改密後舊重設連結立即失效。
    # None 表示此帳號從未改過密(reset 首次使用時放行,成功後才寫入)。
    password_changed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # 坐席邀請流程:
    # - invited_at:邀請(或重寄)時設。用途有二:(1) 辨識 pending 邀請
    #   (is_active=False AND invite_accepted_at IS NULL AND invited_at IS NOT NULL);
    #   (2) 綁定邀請 token 版本(token 帶 iv=int(invited_at.timestamp())),重寄時
    #   更新 invited_at 使舊 token 失效。
    # - invite_accepted_at:接受邀請時設。單次使用保證:非 NULL 即不得再次 accept,
    #   即使 token 未過期、即使帳號後來被停用,亦無法二次接管。
    invited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    invite_accepted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # 平台超級管理員(跨租戶):標記「平台方 / 轉售者」帳號,可凌駕單一租戶管理所有租戶。
    # 認證由 app/api/v1/platform.py 的 require_platform_admin 依 JWT 的 is_platform_admin
    # claim 判定;此欄位為持久真實來源,整合者於登入簽發 JWT 時應據此放入該 claim。
    is_platform_admin: Mapped[bool] = mapped_column(default=False, nullable=False, index=True)


class Role(Base, TenantScopedMixin):
    __tablename__ = "role"
    # 角色名在同一租戶內唯一,避免重名混淆
    __table_args__ = (UniqueConstraint("tenant_id", "name", name="uq_role_tenant_name"),)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(String(300), nullable=True)
    is_system: Mapped[bool] = mapped_column(default=False, nullable=False)


class Permission(Base, TenantScopedMixin):
    """e.g. code='conversation.assign', 'report.view'. Seeded per tenant."""

    __tablename__ = "permission"
    # 權限碼在同一租戶內唯一(種子與自訂皆走此表)
    __table_args__ = (UniqueConstraint("tenant_id", "code", name="uq_permission_tenant_code"),)
    code: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(String(300), nullable=True)


class SkillGroup(Base, TenantScopedMixin):
    """Routing target: agents grouped by skill/queue."""

    __tablename__ = "skill_group"
    # 技能組名在同一租戶內唯一
    __table_args__ = (UniqueConstraint("tenant_id", "name", name="uq_skillgroup_tenant_name"),)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(String(300), nullable=True)
