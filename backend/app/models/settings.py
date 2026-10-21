"""P0 租戶級客服設定:營業時間 / 離線留言 / pre-chat 表單 / widget 主題。

一租戶一列(tenant_id 唯一)。此表存「渠道無關」的全域客服設定;widget 的公開
端點只回可公開欄位(營業狀態 + 離線留言 + prechat + 主題),不回機敏內容。

business_hours(JSONB)建議形狀:
    {
        "timezone": "Asia/Taipei",       # IANA 時區;判斷 is_online 用
        "days": {                          # 週一~週日各自的營業時段(可多段)
            "mon": [["09:00", "18:00"]],
            "tue": [["09:00", "12:00"], ["13:00", "18:00"]],
            ...
            "sun": []                      # 空陣列 = 全天休息
        }
    }
時段跨午夜(end <= start,例如 ["22:00","02:00"])亦支援。

prechat_fields(JSONB)建議形狀(供 widget 渲染開場表單):
    [{"key": "name", "label": "稱呼", "type": "text", "required": true}, ...]

widget_theme(JSONB)建議形狀:
    {"primary_color": "#2563eb", "logo_url": "https://...", "welcome": "您好,請問..."}

整合者注意:本模組**不**修改 main.py / models/__init__.py。請於
`app/models/__init__.py` 補一行:
    from app.models.settings import TenantSettings  # noqa: F401
讓 Alembic autogenerate 與 SQLAlchemy mapper 看見此表。
"""
from __future__ import annotations

from sqlalchemy import String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin


class TenantSettings(Base, TenantScopedMixin):
    """租戶的全域客服設定(每租戶唯一一列)。"""

    __tablename__ = "tenant_settings"
    # 一租戶只有一份全域設定
    __table_args__ = (
        UniqueConstraint("tenant_id", name="uq_tenant_settings_tenant"),
    )

    # 營業時間(含時區與各週日時段);None 視為「全天營業」
    business_hours: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # 離線(非營業時間)自動回覆訊息
    offline_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 是否啟用 pre-chat 開場表單
    prechat_enabled: Mapped[bool] = mapped_column(default=False, nullable=False)
    # pre-chat 表單欄位定義(list[dict])
    prechat_fields: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # widget 外觀主題(主色 / logo / 歡迎語…)
    widget_theme: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # 預留:時區冗餘欄位(business_hours 內亦帶 timezone,此欄供快速讀取/覆寫)
    timezone: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # =========================================================================
    # 企業安全政策(租戶級;對標 LiveChat 企業版)。皆存於本表,由 auth.py 的
    # security-policy 端點讀寫,並於登入流程強制。
    # =========================================================================
    # 組織強制 2FA:開啟後,本租戶「一般坐席」登入時若尚未啟用 2FA,登入不發正式 token,
    # 改回強制設定流程(requires_2fa_enrollment),完成 2FA 綁定後才自動登入。
    # 平台超級管理員(is_platform_admin)不受此租戶政策約束(break-glass,避免自鎖)。
    require_2fa: Mapped[bool] = mapped_column(default=False, nullable=False)
    # 登入來源 IP 白名單(IP 或 CIDR 字串清單,IPv4/IPv6 皆可)。**非空**時僅允許名單內
    # 來源登入;**空 / None = 不限制**(避免預設把所有人鎖死)。真實客戶端 IP 以
    # ratelimit.client_ip(可信代理跳數)取得,不信任裸 X-Forwarded-For。
    # 平台超級管理員豁免(break-glass);設定端另有「當前 IP 未涵蓋則拒存」的自鎖護欄。
    login_ip_allowlist: Mapped[list | None] = mapped_column(JSONB, nullable=True)
