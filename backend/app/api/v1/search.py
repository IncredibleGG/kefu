"""P0 全域搜尋 API。

掛載前綴(整合者於 main.py 註冊):`/api/v1/search`
    app.include_router(search.router, prefix="/api/v1/search", tags=["search"])

端點:
- GET `/api/v1/search?q=&type=all|sessions|messages|contacts&page=&size=`
  需 Bearer JWT;一律以 principal.tenant_id 過濾(租戶隔離)。回統一結果:
  `{sessions:[], messages:[{session_id, snippet, ...}], contacts:[], query, type, page, size}`
"""
from __future__ import annotations

from fastapi import APIRouter, Query

from app.core.deps import CurrentStaff, DbSession
from app.core.response import ok
from app.services import search as search_service

router = APIRouter()


@router.get("")
async def global_search(
    staff: CurrentStaff,
    db: DbSession,
    q: str = Query("", description="搜尋關鍵字"),
    type: str = Query("all", description="all | sessions | messages | contacts"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=50),
):
    """全域搜尋 訊息 / 會話 / 聯絡人。空白 q 回空結果。"""
    data = await search_service.global_search(
        db, staff.tenant_id, q, type=type, page=page, size=size
    )
    return ok(data)
