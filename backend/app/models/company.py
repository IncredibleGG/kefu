"""近程 CRM:公司(Company)一等實體。

在此之前 B2B 只能靠 ``Contact.attributes["company"]`` 這個自由字串來表示所屬公司,
無法把「同一家公司底下的多個聯絡人」聚合起來、也無法在公司層維護產業/規模/備註等
結構化資料。本模型把公司升為一等 CRM 實體:

- ``Company`` 為公司主檔(租戶隔離、軟刪,沿用 ``TenantScopedMixin``)。
- 聯絡人歸屬公司以 ``Contact.company_id``(FK → ``company.id``,ON DELETE SET NULL)表示,
  見 ``app/models/visitor.py``。

``domain`` 為選填的 email 網域(如 ``example.com``),可作為未來「依寄件網域自動歸屬
聯絡人到公司」的依據,故建索引方便查詢;此處不強制唯一,交由業務層決定去重策略。
"""
from __future__ import annotations

from sqlalchemy import String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TenantScopedMixin


class Company(Base, TenantScopedMixin):
    """公司主檔(B2B CRM 一等實體);租戶隔離、軟刪。"""

    __tablename__ = "company"

    # 公司名稱(必填);同一租戶內不強制唯一,允許同名不同分部,由前端提示重複即可。
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # email 網域(選填),供未來依寄件網域自動歸屬聯絡人;建索引方便查詢,不強制唯一。
    domain: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    industry: Mapped[str | None] = mapped_column(String(100), nullable=True)  # 產業別
    size: Mapped[str | None] = mapped_column(String(50), nullable=True)  # 規模(如 1-50 / 51-200)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)  # 客服備註(自由文字)
    attributes: Mapped[dict | None] = mapped_column(JSONB, nullable=True)  # 自訂 CRM 欄位
