"""坐席生產力(W5 自建):巨集(Macro)與自訂欄位定義(FieldDefinition)。

- Macro:坐席一鍵複合動作(同時插入回覆、改狀態、加標籤等),提升處理效率。
- FieldDefinition:租戶自訂工單 / 聯絡人的欄位 schema(具型別與選項),
  實際值存於各實體的 attributes(JSONB)。

皆為新表,create_all 於啟動時自動建立;查詢一律 tenant_id 隔離(TenantScopedMixin)。
"""
from __future__ import annotations

from sqlalchemy import Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin

# 巨集可含的動作型別(存於 Macro.actions 陣列,由前端/服務解讀)
MACRO_ACTION_TYPES = ("reply", "set_status", "add_tags", "assign", "add_note")
# 自訂欄位可掛的實體
FIELD_ENTITIES = ("ticket", "contact")
# 自訂欄位型別
FIELD_TYPES = ("text", "textarea", "number", "date", "select", "checkbox", "url")


class Macro(Base, TenantScopedMixin):
    """坐席巨集:一組可一鍵套用的複合動作。"""

    __tablename__ = "macro"

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # 動作清單:[{type: reply, content: "..."}, {type: set_status, value: "resolved"},
    #           {type: add_tags, tags: ["vip"]}, ...]
    actions: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)


class FieldDefinition(Base, TenantScopedMixin):
    """租戶自訂欄位定義(工單 / 聯絡人),值存於實體的 attributes JSONB。"""

    __tablename__ = "field_definition"

    # 掛在哪個實體:ticket | contact
    entity: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    # 欄位鍵(attributes 內的 key;租戶內同 entity 唯一,由服務層保證)
    key: Mapped[str] = mapped_column(String(80), nullable=False)
    label: Mapped[str] = mapped_column(String(160), nullable=False)
    # 型別:text|textarea|number|date|select|checkbox|url
    field_type: Mapped[str] = mapped_column(String(20), default="text", nullable=False)
    # select 型的選項清單;其餘型別為 None
    options: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    required: Mapped[bool] = mapped_column(default=False, nullable=False)
    # 顯示排序(小在前)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
