"""M3 conversation: Channel, Session, Message.

Session.handler_type + handler_id capture the CURRENT owner (ai | human) and
support smooth AI<->human handoff; handoff history is kept as system Messages.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin


class Channel(Base, TenantScopedMixin):
    """A configured inbound channel: web widget, telegram, email, whatsapp, ..."""

    __tablename__ = "channel"
    type: Mapped[str] = mapped_column(String(30), nullable=False, index=True)  # telegram|web|email...
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)  # bot_token etc. (encrypt secrets)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)


class Session(Base, TenantScopedMixin):
    """A conversation thread between a visitor and the bot/agent."""

    __tablename__ = "session"
    channel_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("channel.id", ondelete="CASCADE"), index=True, nullable=False
    )
    visitor_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("visitor.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # status: queued | open | closed
    status: Mapped[str] = mapped_column(String(20), default="open", nullable=False, index=True)
    # current owner
    handler_type: Mapped[str] = mapped_column(String(10), default="ai", nullable=False)  # ai|human
    handler_staff_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("staff.id", ondelete="SET NULL"), nullable=True
    )
    skill_group_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("skill_group.id", ondelete="SET NULL"), nullable=True
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 最後一則訊息時間;供會話列表(Tabs)依活躍度排序,由 add_message 更新
    last_message_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    # --- 雙向即時翻譯(M6 週邊)---
    # 是否對本會話啟用翻譯(坐席端逐會話開關)
    translate_enabled: Mapped[bool] = mapped_column(default=False, nullable=False)
    # 坐席慣用語言(入站翻成此語言;預設繁中)
    agent_lang: Mapped[str] = mapped_column(String(20), default="zh-Hant", nullable=False)
    # 訪客語言(首次訪客訊息偵測後寫入;出站翻成此語言)
    visitor_lang: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # 稍後處理(snooze):延後到此時間再由 wake worker 喚回佇列;None=未延後
    snoozed_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    # CSAT 自動邀評:已於結案時發出邀評的時間;None=未邀評(供 worker 去重避免重複邀評)
    csat_invited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Message(Base, TenantScopedMixin):
    """One message in a session."""

    __tablename__ = "message"
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("session.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # sender_type: visitor | ai | human | system
    sender_type: Mapped[str] = mapped_column(String(10), nullable=False)
    sender_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    content_type: Mapped[str] = mapped_column(String(20), default="text", nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # rich cards, attachments, ai sources/confidence, quality flags
    meta: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # 已讀送達回執:訊息被對向讀取的時間;None=未讀。供未讀計數與已讀標記
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
