"""團隊協作(W6 自建):旁支會話、@提及協作者。

- SideConversation / SideMessage:在主會話旁另開對內(團隊)或對第三方的討論串,
  不干擾與訪客的主對話。
- SessionParticipant:會話的協作者 / 關注者(除主處理坐席外),供 @提及與通知。

皆為新表,create_all 建立;查詢 tenant_id 隔離(TenantScopedMixin)。
"""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin


class SideConversation(Base, TenantScopedMixin):
    __tablename__ = "side_conversation"

    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("session.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # 主題 / 標題
    topic: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # 類型:internal(對內團隊)| external(對第三方,如供應商)
    kind: Mapped[str] = mapped_column(String(20), default="internal", nullable=False)
    # 狀態:open | closed
    status: Mapped[str] = mapped_column(String(20), default="open", nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("staff.id", ondelete="SET NULL"), nullable=True
    )


class SideMessage(Base, TenantScopedMixin):
    __tablename__ = "side_message"

    side_conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("side_conversation.id", ondelete="CASCADE"),
        index=True, nullable=False,
    )
    sender_staff_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("staff.id", ondelete="SET NULL"), nullable=True
    )
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")


class SessionParticipant(Base, TenantScopedMixin):
    __tablename__ = "session_participant"

    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("session.id", ondelete="CASCADE"), index=True, nullable=False
    )
    staff_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("staff.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # 角色:collaborator(協作者,可回覆)| watcher(關注者,只收通知)
    role: Mapped[str] = mapped_column(String(20), default="collaborator", nullable=False)
