"""對外整合模型:WebhookEndpoint(事件外送)與 ApiKey(開放 API 認證)。

兩張表皆屬租戶所有(TenantScopedMixin 提供 id / tenant_id / 時間戳 / 軟刪)。

安全要點:
- WebhookEndpoint.secret 為 HMAC 簽章金鑰,僅本租戶管理端可見(API 回應遮罩)。
- ApiKey 只存 key_hash(SHA-256),明文金鑰僅在建立當下回傳一次,之後無法還原;
  key_prefix 供列表辨識與遮罩顯示。

注意:本模型「未」登記進 app/models/__init__.py(依交付規則不得改該檔)。只要 webhooks
的服務或路由被匯入,SQLAlchemy 即會把此 mapper 註冊到 Base.metadata;正式建表請由
整合方於 app/models/__init__.py 補一行匯入(見交付報告)。所有查詢一律以 tenant_id 過濾。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin

# --- 對外 Webhook 事件名(供派送與 API 驗證共用)-----------------------------
# 埋點見 services/conversation.py(created/message/closed)與
# api/v1/conversation.py(transferred)。
WEBHOOK_EVENTS = (
    "conversation.created",      # 新會話建立
    "message.created",           # 新訊息寫入(任一 sender_type)
    "conversation.closed",       # 會話結束
    "conversation.transferred",  # 會話轉接完成
)


class WebhookEndpoint(Base, TenantScopedMixin):
    """租戶設定的一個對外 webhook 目標:訂閱若干事件,命中即 POST 過去。"""

    __tablename__ = "webhook_endpoint"

    # 目標 URL(接收 POST JSON)
    url: Mapped[str] = mapped_column(String(1000), nullable=False)
    # 訂閱的事件名清單(值 ∈ WEBHOOK_EVENTS);空清單視為不訂閱任何事件
    events: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    # HMAC-SHA256 簽章金鑰(隨機產生;用於 X-Kefu-Signature)
    secret: Mapped[str] = mapped_column(String(255), nullable=False)
    # 顯示用描述(選填)
    description: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # 是否啟用;停用者不參與派送
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, index=True)


class ApiKey(Base, TenantScopedMixin):
    """開放 API 金鑰:只存雜湊,明文僅建立時回傳一次。"""

    __tablename__ = "api_key"

    # 顯示名稱(便於辨識用途)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # 明文金鑰前綴(可見,供列表辨識與遮罩;例:kefu_ab12cd)
    key_prefix: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    # 金鑰雜湊(SHA-256 hexdigest;不存明文)
    key_hash: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    # 是否啟用;撤銷後為 False
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, index=True)
    # 最後使用時間(每次以此金鑰通過認證時更新)
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
