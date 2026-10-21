"""近程 CRM:公司(Company)一等實體 API。

打開 B2B:公司主檔 CRUD + 聯絡人歸屬公司。所有端點:
① 以 JWT 解析出的 ``staff.tenant_id`` 過濾(絕不信任前端傳入的 tenant_id);
② 成功回統一信封 ``ok(...)``;錯誤循全域信封慣例,以
   ``raise HTTPException(status, {"code","message"})`` 拋出(交由 app.main 的
   例外處理器包成 ``{ok:false,error:{code,message}}``)。

權限(對齊既有 CRM/聯絡人模組 app/api/v1/visitor.py):
- 讀:``conversation.view``;
- 寫:``conversation.assign``(agent/supervisor 角色皆具備此碼;admin 於 require() 短路放行)。

路由前綴 ``/api/v1/company`` 由 app.main 掛載,故此處路徑相對於該前綴:
- ``GET  ""``                              公司清單(?q 搜尋名稱/網域、分頁)
- ``POST ""``                              建立公司
- ``GET  /{company_id}``                   公司詳情
- ``PATCH /{company_id}``                  更新公司
- ``DELETE /{company_id}``                 軟刪公司(其聯絡人 company_id 置空)
- ``GET  /{company_id}/contacts``          該公司的聯絡人
- ``POST /{company_id}/contacts/{cid}``    把聯絡人歸屬到公司
- ``DELETE /{company_id}/contacts/{cid}``  移除聯絡人的公司歸屬
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import ok
from app.models.company import Company
from app.models.visitor import Contact

router = APIRouter()

# 權限碼:對齊 app/api/v1/visitor.py 的 CRM 端點(讀 view、寫 assign)。
_PERM_READ = "conversation.view"
_PERM_WRITE = "conversation.assign"


# ---------------------------------------------------------------------------
# 序列化輔助(統一輸出:UUID/時間轉字串)
# ---------------------------------------------------------------------------
def _company_out(c: Company) -> dict:
    return {
        "id": str(c.id),
        "name": c.name,
        "domain": c.domain,
        "industry": c.industry,
        "size": c.size,
        "notes": c.notes,
        "attributes": c.attributes,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }


def _contact_brief(c: Contact) -> dict:
    """公司底下聯絡人的精簡輸出(公司頁列示用)。"""
    return {
        "id": str(c.id),
        "name": c.name,
        "email": c.email,
        "phone": c.phone,
        "company_id": str(c.company_id) if c.company_id else None,
        "is_blocked": c.is_blocked,
    }


# ---------------------------------------------------------------------------
# 請求模型
# ---------------------------------------------------------------------------
class CompanyIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    domain: str | None = None
    industry: str | None = None
    size: str | None = None
    notes: str | None = None
    attributes: dict | None = None


class CompanyPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    domain: str | None = None
    industry: str | None = None
    size: str | None = None
    notes: str | None = None
    attributes: dict | None = None


# ---------------------------------------------------------------------------
# 取物件(租戶隔離 + 未刪)
# ---------------------------------------------------------------------------
async def _get_company_or_404(db, tenant_id: uuid.UUID, company_id: uuid.UUID) -> Company:
    c = (
        await db.execute(
            select(Company).where(
                Company.tenant_id == tenant_id,
                Company.id == company_id,
                Company.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if c is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "company not found"},
        )
    return c


async def _get_contact_or_404(db, tenant_id: uuid.UUID, contact_id: uuid.UUID) -> Contact:
    c = (
        await db.execute(
            select(Contact).where(
                Contact.tenant_id == tenant_id,
                Contact.id == contact_id,
                Contact.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if c is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": "contact not found"},
        )
    return c


# ===========================================================================
# 公司 Company CRUD
# ===========================================================================
@router.get("")
async def list_companies(
    staff: CurrentStaff,
    db: DbSession,
    q: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """公司清單(q 模糊搜尋名稱/網域;分頁)。回 {items,total,limit,offset}。"""
    staff.require(_PERM_READ)
    base = select(Company).where(
        Company.tenant_id == staff.tenant_id, Company.deleted_at.is_(None)
    )
    if q:
        like = f"%{q}%"
        base = base.where(Company.name.ilike(like) | Company.domain.ilike(like))
    total = int(
        (
            await db.execute(select(func.count()).select_from(base.order_by(None).subquery()))
        ).scalar_one()
    )
    rows = (
        await db.execute(
            base.order_by(Company.created_at.desc()).limit(limit).offset(offset)
        )
    ).scalars().all()
    return ok(
        {
            "items": [_company_out(c) for c in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    )


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_company(body: CompanyIn, staff: CurrentStaff, db: DbSession):
    """建立公司主檔。"""
    staff.require(_PERM_WRITE)
    c = Company(
        tenant_id=staff.tenant_id,
        name=body.name,
        domain=body.domain,
        industry=body.industry,
        size=body.size,
        notes=body.notes,
        attributes=body.attributes,
    )
    db.add(c)
    await db.commit()
    # commit 後以 awaited refresh 重新載入(含 server_default 的 created_at/updated_at),
    # 避免序列化時觸發過期屬性的隱式惰性載入(async 下會 MissingGreenlet)。
    await db.refresh(c)
    return ok(_company_out(c))


@router.get("/{company_id}")
async def get_company(company_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """公司詳情(含底下聯絡人數)。"""
    staff.require(_PERM_READ)
    c = await _get_company_or_404(db, staff.tenant_id, company_id)
    contact_count = int(
        (
            await db.execute(
                select(func.count())
                .select_from(Contact)
                .where(
                    Contact.tenant_id == staff.tenant_id,
                    Contact.company_id == c.id,
                    Contact.deleted_at.is_(None),
                )
            )
        ).scalar_one()
    )
    data = _company_out(c)
    data["contact_count"] = contact_count
    return ok(data)


@router.patch("/{company_id}")
async def update_company(
    company_id: uuid.UUID, body: CompanyPatch, staff: CurrentStaff, db: DbSession
):
    """更新公司(僅更新有帶入的欄位)。"""
    staff.require(_PERM_WRITE)
    c = await _get_company_or_404(db, staff.tenant_id, company_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(c, field, value)
    await db.commit()
    # UPDATE 後 onupdate 的 updated_at 會被標記過期;以 awaited refresh 重新載入,
    # 避免序列化 _company_out 時對過期屬性做隱式惰性載入(async 下會 MissingGreenlet)。
    await db.refresh(c)
    return ok(_company_out(c))


@router.delete("/{company_id}")
async def delete_company(company_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """軟刪公司(設 deleted_at);其底下聯絡人的 company_id 置空,不連帶刪聯絡人。"""
    staff.require(_PERM_WRITE)
    c = await _get_company_or_404(db, staff.tenant_id, company_id)
    contacts = (
        await db.execute(
            select(Contact).where(
                Contact.tenant_id == staff.tenant_id, Contact.company_id == c.id
            )
        )
    ).scalars().all()
    for ct in contacts:
        ct.company_id = None
    c.deleted_at = datetime.now(UTC)
    await db.commit()
    return ok({"id": str(c.id), "deleted": True})


# ===========================================================================
# 公司 ↔ 聯絡人 歸屬
# ===========================================================================
@router.get("/{company_id}/contacts")
async def list_company_contacts(
    company_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
    q: str | None = None,
    limit: int = Query(100, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """列出歸屬於該公司的聯絡人(q 模糊搜尋姓名/信箱/電話;分頁)。"""
    staff.require(_PERM_READ)
    await _get_company_or_404(db, staff.tenant_id, company_id)
    stmt = select(Contact).where(
        Contact.tenant_id == staff.tenant_id,
        Contact.company_id == company_id,
        Contact.deleted_at.is_(None),
    )
    if q:
        like = f"%{q}%"
        stmt = stmt.where(
            Contact.name.ilike(like) | Contact.email.ilike(like) | Contact.phone.ilike(like)
        )
    rows = (
        await db.execute(
            stmt.order_by(Contact.created_at.desc()).limit(limit).offset(offset)
        )
    ).scalars().all()
    return ok([_contact_brief(c) for c in rows])


@router.post("/{company_id}/contacts/{contact_id}")
async def assign_contact(
    company_id: uuid.UUID, contact_id: uuid.UUID, staff: CurrentStaff, db: DbSession
):
    """把聯絡人歸屬到公司(設 Contact.company_id);已屬其他公司則改歸屬本公司。"""
    staff.require(_PERM_WRITE)
    company = await _get_company_or_404(db, staff.tenant_id, company_id)
    contact = await _get_contact_or_404(db, staff.tenant_id, contact_id)
    contact.company_id = company.id
    await db.commit()
    await db.refresh(contact)  # 重新載入,避免序列化時對過期屬性做惰性載入(async 安全)
    return ok(_contact_brief(contact))


@router.delete("/{company_id}/contacts/{contact_id}")
async def unassign_contact(
    company_id: uuid.UUID, contact_id: uuid.UUID, staff: CurrentStaff, db: DbSession
):
    """移除聯絡人的公司歸屬(company_id 置空)。僅在該聯絡人確實屬於此公司時才置空。"""
    staff.require(_PERM_WRITE)
    await _get_company_or_404(db, staff.tenant_id, company_id)
    contact = await _get_contact_or_404(db, staff.tenant_id, contact_id)
    removed = False
    if contact.company_id == company_id:
        contact.company_id = None
        removed = True
        await db.commit()
    return ok({"contact_id": str(contact_id), "company_id": str(company_id), "removed": removed})
