"""M4 訪客服務 seam:訊息進站時的 get_or_create_visitor。

其他模組(M3 對話進站)呼叫 `get_or_create_visitor` 取得/建立訪客身份。
語意:同一租戶 + 渠道 + external_id 視為同一訪客;不存在則建立,並「順帶」建立
一筆 Contact 與之關聯(每個渠道身份至少掛一個持久客戶主檔,方便後續 CRM / 合併)。

交易邊界:本函式只 `flush`(取得主鍵)不 `commit`,交由呼叫端(request 事務)決定
提交時機。並發競態下若唯一鍵衝突,回滾這筆插入並改以查詢取回既有訪客。
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.visitor import Contact, Visitor


async def get_or_create_visitor(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    channel_id: uuid.UUID,
    external_id: str,
    display_name: str | None = None,
    avatar_url: str | None = None,
) -> Visitor:
    """取得或建立訪客(以 tenant_id + channel_id + external_id 去重)。

    - 已存在:回傳既有訪客;若帶入了新的 display_name / avatar_url 則順手刷新。
    - 不存在:建立 Contact(name 取 display_name)再建立 Visitor 並關聯之。
    """

    async def _find() -> Visitor | None:
        stmt = select(Visitor).where(
            Visitor.tenant_id == tenant_id,
            Visitor.channel_id == channel_id,
            Visitor.external_id == external_id,
            Visitor.deleted_at.is_(None),
        )
        return (await db.execute(stmt)).scalar_one_or_none()

    visitor = await _find()
    if visitor is not None:
        # 資料刷新:僅在有新值時覆蓋,避免把既有資料抹成空
        if display_name and visitor.display_name != display_name:
            visitor.display_name = display_name
        if avatar_url and visitor.avatar_url != avatar_url:
            visitor.avatar_url = avatar_url
        await db.flush()
        return visitor

    # 建新:先建 Contact 主檔,再建 Visitor 關聯
    contact = Contact(tenant_id=tenant_id, name=display_name)
    db.add(contact)
    await db.flush()

    visitor = Visitor(
        tenant_id=tenant_id,
        channel_id=channel_id,
        external_id=external_id,
        display_name=display_name,
        avatar_url=avatar_url,
        contact_id=contact.id,
    )
    db.add(visitor)
    try:
        await db.flush()
    except IntegrityError:
        # 並發下另一請求先建了同一訪客:回滾本次插入,改取回既有的
        await db.rollback()
        existing = await _find()
        if existing is None:
            raise
        return existing
    return visitor
