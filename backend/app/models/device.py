"""原生 App 裝置推播權杖(docs/NATIVE-CLIENTS.md §4.1 / §4.3)。

一張表 ``device_token``:每位坐席的每台裝置(App 安裝時產生的穩定 ``device_id``)一列,
存放 FCM 註冊權杖(Android 與 iOS 皆經 FCM;桌面只登記不推送)。

- ``token`` 全域唯一:共用手機換人登入時,同一權杖會「搬家」到新坐席(舊列刪除)。
- ``(staff_id, device_id)`` 唯一:同一坐席同一裝置重複登記為 upsert。
- 撤銷(登出 / FCM 回報權杖失效 / 超過每人上限)一律設 ``revoked_at``,不硬刪,
  重新登記時清除 ``revoked_at`` 即復用。
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin

# 允許的平台值(與前端 platform adapter 一致)
DEVICE_PLATFORMS = ("ios", "android", "desktop")
# 會經 FCM 推送的平台(桌面靠系統匣常駐 + WS + 本機通知,不推)
PUSH_PLATFORMS = ("ios", "android")


class DeviceToken(Base, TenantScopedMixin):
    """坐席裝置的推播權杖登記。"""

    __tablename__ = "device_token"
    __table_args__ = (
        UniqueConstraint("token", name="uq_device_token_token"),
        UniqueConstraint("staff_id", "device_id", name="uq_device_token_staff_device"),
    )

    staff_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("staff.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # ios | android | desktop
    platform: Mapped[str] = mapped_column(String(10), nullable=False)
    # 推播供應商:目前只有 fcm(APNs 經 FCM 轉送)
    provider: Mapped[str] = mapped_column(String(10), default="fcm", nullable=False)
    # FCM 註冊權杖(桌面無權杖時由端點合成 ``desktop:{device_id}``,僅作唯一識別)
    token: Mapped[str] = mapped_column(String(4096), nullable=False)
    # App 安裝時產生的穩定 UUID(存在原生儲存)
    device_id: Mapped[str] = mapped_column(String(128), nullable=False)
    app_version: Mapped[str] = mapped_column(String(32), default="", nullable=False)
    os_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # 裝置語系(BCP 47,例 zh-TW / zh-CN / en-US),決定推播標題語言
    locale: Mapped[str | None] = mapped_column(String(16), nullable=True)
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
