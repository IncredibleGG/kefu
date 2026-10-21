"""工單內部備註 / 評論串:TicketNote。

對標 LiveChat HelpDesk 的「internal note」——坐席在工單上留給團隊看的內部
評論(訪客不可見)。一張工單可有多筆備註,依 created_at 形成時間線。

- 只掛在工單詳情內部,永不外送訪客(與訊息 Message 完全分離)。
- staff_id 可為 None(作者離職軟刪後仍保留備註內容,不隨之消失)。
- 所有查詢一律以 tenant_id 隔離(見 TenantScopedMixin);ticket_id 亦已建索引,
  依工單撈備註為熱路徑。
- created_at / updated_at / deleted_at 由 TenantScopedMixin(TimestampMixin)提供,
  故此處不再重複宣告 created_at。

注意:本模型須由整合方在 app/models/__init__.py 補一行匯入(見交付報告),
Alembic autogenerate 與 create_all 才看得到 ticket_note 表。
"""
from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin


class TicketNote(Base, TenantScopedMixin):
    """一則工單內部備註(僅團隊可見的評論)。"""

    __tablename__ = "ticket_note"

    # 所屬工單;工單軟刪不連動刪除備註(以 CASCADE 僅在租戶硬刪時清理)
    ticket_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("ticket.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    # 撰寫備註的坐席;作者被軟刪 / 移除時置 None(不刪備註)
    staff_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("staff.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # 備註正文(純文字;富文本由前端負責轉義呈現)
    body: Mapped[str] = mapped_column(Text, nullable=False)
