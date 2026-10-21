"""第一方整合 / 插件:目錄常數(INTEGRATION_CATALOG)+ 每租戶啟用狀態表。

定位:本系統所有整合都是**第一方自研**,集中在一個目錄裡;客戶端(租戶)只是按
需以 on/off 開關啟用/停用,並在需要時填入金鑰。這**不是**給外部開發者的公開 App
商店——目錄項是程式常數,執行邏輯亦由本專案維護,故無需審核/OAuth 授權那一套。

兩個部分:
- ``INTEGRATION_CATALOG``:目錄項(程式常數)。每項描述一個可啟用的整合:key(唯一
  識別)、name/description(繁中,供 UI 直接顯示)、category(分類)、requires_config
  (是否需填金鑰才有意義)、config_schema(需設定者的欄位定義;``secret: true`` 的欄位
  回傳時遮罩、落庫前靜態加密)。目前執行邏輯先為「已註冊、開關可切」的框架
  (code-ready),真正串接外部服務由後續補上——各整合的消費點以
  ``is_integration_enabled(db, tenant_id, key)`` 查詢開關即可。
- ``TenantIntegration``:每租戶每整合一列的啟用狀態與設定。

整合者注意:本模組**不**修改 ``app/models/__init__.py``。請於該檔補一行:
    from app.models.integration import TenantIntegration  # noqa: F401
讓 Alembic autogenerate 與 ``Base.metadata.create_all`` 看見 ``tenant_integration`` 表。
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import Boolean, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin

# --------------------------------------------------------------------------- #
# 整合目錄(第一方,程式常數)
#
# config_schema 欄位形狀(對齊前端表單渲染,近似 prechat_fields):
#   {
#     "key": "access_token",         # config dict 內的鍵
#     "label": "Admin API Token",    # 表單標籤(繁中)
#     "type": "text" | "password" | "textarea",
#     "required": true,              # 是否必填
#     "secret": true,                # 機敏:回傳遮罩、落庫前靜態加密(crypto)
#     "placeholder": "…",            # 選填:輸入提示
#     "help": "…"                    # 選填:欄位說明
#   }
# --------------------------------------------------------------------------- #
INTEGRATION_CATALOG: list[dict[str, Any]] = [
    {
        "key": "shopify",
        "name": "Shopify 訂單脈絡",
        "description": "在會話側欄帶出訪客的 Shopify 訂單與消費歷史,客服接手即掌握下單脈絡。",
        "category": "ecommerce",
        "requires_config": True,
        "config_schema": [
            {
                "key": "shop_domain",
                "label": "商店網域",
                "type": "text",
                "required": True,
                "placeholder": "your-store.myshopify.com",
            },
            {
                "key": "access_token",
                "label": "Admin API Access Token",
                "type": "password",
                "required": True,
                "secret": True,
                "help": "Shopify 後台 → Apps → 私有應用取得;唯讀 orders 權限即可。",
            },
        ],
    },
    {
        "key": "slack_notify",
        "name": "Slack 通知",
        "description": "新會話 / 新工單即時推送到指定 Slack 頻道,團隊不漏接。",
        "category": "notification",
        "requires_config": True,
        "config_schema": [
            {
                "key": "webhook_url",
                "label": "Incoming Webhook URL",
                "type": "password",
                "required": True,
                "secret": True,
                "placeholder": "https://hooks.slack.com/services/…",
            },
            {
                "key": "channel",
                "label": "頻道(選填,覆寫 webhook 預設)",
                "type": "text",
                "required": False,
                "placeholder": "#support",
            },
        ],
    },
    {
        "key": "webhook_relay",
        "name": "通用事件轉發",
        "description": "把會話 / 訊息 / 工單等事件以 JSON POST 轉發到你的端點,串接自有系統。",
        "category": "developer",
        "requires_config": True,
        "config_schema": [
            {
                "key": "target_url",
                "label": "目標 URL",
                "type": "text",
                "required": True,
                "placeholder": "https://api.example.com/kefu/events",
            },
            {
                "key": "signing_secret",
                "label": "簽章密鑰(HMAC-SHA256)",
                "type": "password",
                "required": False,
                "secret": True,
                "help": "設定後,轉發請求會帶 X-Kefu-Signature 供你驗簽。",
            },
        ],
    },
    {
        "key": "google_analytics",
        "name": "Google Analytics 事件上報",
        "description": "將會話開啟 / 轉換等事件經 Measurement Protocol 上報到 GA4。",
        "category": "analytics",
        "requires_config": True,
        "config_schema": [
            {
                "key": "measurement_id",
                "label": "Measurement ID",
                "type": "text",
                "required": True,
                "placeholder": "G-XXXXXXXXXX",
            },
            {
                "key": "api_secret",
                "label": "API Secret",
                "type": "password",
                "required": True,
                "secret": True,
                "help": "GA4 → 管理 → 資料串流 → Measurement Protocol API secrets。",
            },
        ],
    },
    {
        "key": "mailchimp",
        "name": "Mailchimp 聯絡人同步",
        "description": "將客服聯絡人同步到 Mailchimp 受眾,銜接後續行銷自動化。",
        "category": "marketing",
        "requires_config": True,
        "config_schema": [
            {
                "key": "api_key",
                "label": "API Key",
                "type": "password",
                "required": True,
                "secret": True,
                "placeholder": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-us21",
            },
            {
                "key": "audience_id",
                "label": "受眾 ID(Audience / List ID)",
                "type": "text",
                "required": True,
                "placeholder": "a1b2c3d4e5",
            },
        ],
    },
]

# key → 目錄項 的快取映射(啟動時建一次;目錄為不可變常數)。
CATALOG_BY_KEY: dict[str, dict[str, Any]] = {item["key"]: item for item in INTEGRATION_CATALOG}


def secret_field_keys(integration_key: str) -> set[str]:
    """回傳某整合 config_schema 中標記 ``secret: true`` 的欄位鍵集合(供遮罩/加密)。"""
    entry = CATALOG_BY_KEY.get(integration_key)
    if not entry:
        return set()
    return {f["key"] for f in (entry.get("config_schema") or []) if f.get("secret")}


class TenantIntegration(Base, TenantScopedMixin):
    """某租戶對某一目錄整合的啟用狀態與設定(每租戶每 key 唯一一列)。

    - ``integration_key``:對應 INTEGRATION_CATALOG 的 key(值在目錄內才允許寫入)。
    - ``enabled``:開關;預設 False(目錄項一律「已註冊但預設停用」)。
    - ``config``:該整合的設定 / 金鑰(JSONB)。機敏欄位(config_schema secret=true)
      落庫前經 ``app.core.crypto`` 靜態加密,API 回傳時遮罩,前端永不觸及明文。
    """

    __tablename__ = "tenant_integration"
    __table_args__ = (
        # 每租戶每整合僅一份狀態
        UniqueConstraint("tenant_id", "integration_key", name="uq_tenant_integration_key"),
    )

    integration_key: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
