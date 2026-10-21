"""M4 API:訪客 / 聯絡人(CRM)/ 標籤 / AI 畫像。

所有端點:①以 JWT 解析出的 principal.tenant_id 過濾(絕不信任前端傳入的 tenant_id)。
②成功回傳統一信封 ok(...);錯誤循 auth 模組慣例以 HTTPException 拋出。
"""
from __future__ import annotations

import csv
import io
import uuid
from datetime import UTC

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import ok
from app.models.conversation import Channel, Session
from app.models.tag import TAG_TARGET_TYPES, Tag, TagRelation
from app.models.visitor import Contact, Visitor

router = APIRouter()


# ---------------------------------------------------------------------------
# 序列化輔助(統一輸出格式,UUID/時間轉字串)
# ---------------------------------------------------------------------------
def _visitor_out(v: Visitor) -> dict:
    return {
        "id": str(v.id),
        "channel_id": str(v.channel_id),
        "external_id": v.external_id,
        "display_name": v.display_name,
        "avatar_url": v.avatar_url,
        "contact_id": str(v.contact_id) if v.contact_id else None,
        "is_blocked": v.is_blocked,
        "ai_profile": v.ai_profile,
        "created_at": v.created_at.isoformat() if v.created_at else None,
    }


def _contact_out(c: Contact) -> dict:
    return {
        "id": str(c.id),
        "name": c.name,
        "email": c.email,
        "phone": c.phone,
        "attributes": c.attributes,
        "note": c.note,
        "is_blocked": c.is_blocked,
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }


def _tag_out(t: Tag) -> dict:
    return {
        "id": str(t.id),
        "name": t.name,
        "color": t.color,
        "category": t.category,
    }


async def _tag_ids_for(db, tenant_id: uuid.UUID, target_type: str, target_id: uuid.UUID) -> list[str]:
    rows = (
        await db.execute(
            select(TagRelation.tag_id).where(
                TagRelation.tenant_id == tenant_id,
                TagRelation.target_type == target_type,
                TagRelation.target_id == target_id,
                TagRelation.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    return [str(r) for r in rows]


async def _target_ids_by_tag(db, tenant_id: uuid.UUID, tag_id: uuid.UUID, target_type: str):
    """回傳某標籤下、指定目標類型的 target_id 集合(供依標籤過濾)。"""
    return (
        select(TagRelation.target_id).where(
            TagRelation.tenant_id == tenant_id,
            TagRelation.tag_id == tag_id,
            TagRelation.target_type == target_type,
            TagRelation.deleted_at.is_(None),
        )
    )


# ===========================================================================
# 訪客 Visitor
# ===========================================================================
@router.get("/visitors")
async def list_visitors(
    staff: CurrentStaff,
    db: DbSession,
    channel_id: uuid.UUID | None = None,
    contact_id: uuid.UUID | None = None,
    is_blocked: bool | None = None,
    tag_id: uuid.UUID | None = None,
    q: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """訪客清單(可依渠道 / 聯絡人 / 封鎖狀態 / 標籤過濾,q 模糊搜尋名稱與外部 ID)。"""
    staff.require("conversation.view")
    stmt = select(Visitor).where(
        Visitor.tenant_id == staff.tenant_id, Visitor.deleted_at.is_(None)
    )
    if channel_id is not None:
        stmt = stmt.where(Visitor.channel_id == channel_id)
    if contact_id is not None:
        stmt = stmt.where(Visitor.contact_id == contact_id)
    if is_blocked is not None:
        stmt = stmt.where(Visitor.is_blocked.is_(is_blocked))
    if tag_id is not None:
        stmt = stmt.where(
            Visitor.id.in_(await _target_ids_by_tag(db, staff.tenant_id, tag_id, "visitor"))
        )
    if q:
        like = f"%{q}%"
        stmt = stmt.where(Visitor.display_name.ilike(like) | Visitor.external_id.ilike(like))
    stmt = stmt.order_by(Visitor.created_at.desc()).limit(limit).offset(offset)
    rows = (await db.execute(stmt)).scalars().all()
    return ok([_visitor_out(v) for v in rows])


@router.get("/visitors/{visitor_id}")
async def get_visitor(visitor_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """訪客檔案:含關聯 Contact、標籤。"""
    staff.require("conversation.view")
    v = await _get_visitor_or_404(db, staff.tenant_id, visitor_id)
    contact = None
    if v.contact_id:
        contact = (
            await db.execute(
                select(Contact).where(
                    Contact.tenant_id == staff.tenant_id,
                    Contact.id == v.contact_id,
                    Contact.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
    data = _visitor_out(v)
    data["contact"] = _contact_out(contact) if contact else None
    data["tags"] = await _tag_ids_for(db, staff.tenant_id, "visitor", v.id)
    return ok(data)


@router.get("/visitors/{visitor_id}/timeline")
async def visitor_timeline(
    visitor_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
    limit: int = Query(20, ge=1, le=100),
):
    """訪客軌跡:來源渠道 + 近期會話清單。"""
    staff.require("conversation.view")
    v = await _get_visitor_or_404(db, staff.tenant_id, visitor_id)
    channel = (
        await db.execute(
            select(Channel).where(
                Channel.tenant_id == staff.tenant_id, Channel.id == v.channel_id
            )
        )
    ).scalar_one_or_none()
    sessions = (
        await db.execute(
            select(Session)
            .where(
                Session.tenant_id == staff.tenant_id,
                Session.visitor_id == v.id,
                Session.deleted_at.is_(None),
            )
            .order_by(Session.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return ok(
        {
            "visitor_id": str(v.id),
            "source": {
                "channel_id": str(v.channel_id),
                "channel_type": channel.type if channel else None,
                "channel_name": channel.name if channel else None,
            },
            "sessions": [
                {
                    "id": str(s.id),
                    "status": s.status,
                    "handler_type": s.handler_type,
                    "created_at": s.created_at.isoformat() if s.created_at else None,
                    "closed_at": s.closed_at.isoformat() if s.closed_at else None,
                }
                for s in sessions
            ],
        }
    )


@router.post("/visitors/{visitor_id}/block")
async def block_visitor(visitor_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """封鎖此渠道訪客身份(黑名單)。"""
    staff.require("conversation.assign")
    v = await _get_visitor_or_404(db, staff.tenant_id, visitor_id)
    v.is_blocked = True
    await db.commit()
    return ok(_visitor_out(v))


@router.post("/visitors/{visitor_id}/unblock")
async def unblock_visitor(visitor_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """解除此渠道訪客身份封鎖。"""
    staff.require("conversation.assign")
    v = await _get_visitor_or_404(db, staff.tenant_id, visitor_id)
    v.is_blocked = False
    await db.commit()
    return ok(_visitor_out(v))


class AIProfileIn(BaseModel):
    # 供 AI 模組寫入意圖/情緒/自動標籤等;鍵值不限,淺層合併進 ai_profile
    profile: dict = Field(default_factory=dict)
    replace: bool = False  # True 則整體覆蓋,預設為淺層合併


@router.post("/visitors/{visitor_id}/ai-profile")
async def set_ai_profile(
    visitor_id: uuid.UUID, body: AIProfileIn, staff: CurrentStaff, db: DbSession
):
    """AI 畫像寫入端點(供 AI 模組寫意圖/情緒/自動標籤)。"""
    staff.require("conversation.assign")
    v = await _get_visitor_or_404(db, staff.tenant_id, visitor_id)
    if body.replace:
        v.ai_profile = dict(body.profile)
    else:
        # 重新賦值新 dict,確保 ORM 偵測到 JSONB 變更
        v.ai_profile = {**(v.ai_profile or {}), **body.profile}
    await db.commit()
    return ok(_visitor_out(v))


async def _get_visitor_or_404(db, tenant_id: uuid.UUID, visitor_id: uuid.UUID) -> Visitor:
    v = (
        await db.execute(
            select(Visitor).where(
                Visitor.tenant_id == tenant_id,
                Visitor.id == visitor_id,
                Visitor.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if v is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="visitor not found")
    return v


# ===========================================================================
# 聯絡人 Contact(CRM)
# ===========================================================================
class ContactIn(BaseModel):
    name: str | None = None
    email: str | None = None
    phone: str | None = None
    attributes: dict | None = None
    note: str | None = None


class ContactPatch(BaseModel):
    name: str | None = None
    email: str | None = None
    phone: str | None = None
    attributes: dict | None = None
    note: str | None = None
    is_blocked: bool | None = None


@router.post("/contacts", status_code=status.HTTP_201_CREATED)
async def create_contact(body: ContactIn, staff: CurrentStaff, db: DbSession):
    """建立聯絡人主檔。"""
    staff.require("conversation.assign")
    c = Contact(
        tenant_id=staff.tenant_id,
        name=body.name,
        email=body.email,
        phone=body.phone,
        attributes=body.attributes,
        note=body.note,
    )
    db.add(c)
    await db.commit()
    return ok(_contact_out(c))


# ---------------------------------------------------------------------------
# 聯絡人批量匯入(CSV multipart 或 JSON 陣列)
# ---------------------------------------------------------------------------
_IMPORT_MAX_ROWS = 5000  # 單次匯入資料列上限(不含表頭)

# 標準欄位別名(以「去空白後的小寫」比對;CJK 大小寫不變,直接命中)。
# company 無獨立資料庫欄位,統一併入 attributes["company"](前端由 attributes 讀取)。
_IMPORT_FIELD_ALIASES = {
    "name": "name", "姓名": "name", "名稱": "name", "名字": "name", "full name": "name", "fullname": "name",
    "email": "email", "e-mail": "email", "mail": "email", "信箱": "email", "電子郵件": "email", "郵箱": "email", "電郵": "email",
    "phone": "phone", "tel": "phone", "telephone": "phone", "mobile": "phone", "cellphone": "phone",
    "電話": "phone", "手機": "phone", "手機號碼": "phone", "電話號碼": "phone", "聯絡電話": "phone",
    "company": "company", "公司": "company", "公司名稱": "company", "organization": "company", "org": "company", "公司名": "company",
    "note": "note", "notes": "note", "備註": "note", "remark": "note", "remarks": "note", "備注": "note",
}


def _decode_csv_bytes(content: bytes) -> str:
    """容錯解碼 CSV bytes:優先 UTF-8(去 BOM),再退 Big5 / GB18030,最後以 replace 保底。"""
    for enc in ("utf-8-sig", "big5", "gb18030"):
        try:
            return content.decode(enc)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace")


def _rows_from_csv(text: str) -> list[dict]:
    """CSV 文字 → [{_line, _data}]。首列為表頭(line 1),資料自 line 2 起。"""
    reader = csv.DictReader(io.StringIO(text))
    return [{"_line": i, "_data": rec} for i, rec in enumerate(reader, start=2)]


async def _parse_import_payload(request: Request) -> list[dict]:
    """依 Content-Type 取出待匯入列:multipart 檔案 / 原始 CSV / JSON 陣列。"""
    ctype = request.headers.get("content-type", "").lower()
    if "multipart/form-data" in ctype:
        form = await request.form()
        upload = form.get("file")
        if upload is None or not hasattr(upload, "read"):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="missing 'file' in form-data")
        content = await upload.read()
        return _rows_from_csv(_decode_csv_bytes(content))
    if "csv" in ctype or "text/plain" in ctype:
        return _rows_from_csv(_decode_csv_bytes(await request.body()))
    # 其餘視為 JSON:接受頂層陣列,或 {rows:[...]} / {contacts:[...]}
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="invalid body; expected CSV multipart or JSON array",
        )
    if isinstance(payload, dict):
        payload = payload.get("rows") or payload.get("contacts") or []
    if not isinstance(payload, list):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="JSON body must be an array of objects"
        )
    return [
        {"_line": i, "_data": rec if isinstance(rec, dict) else {}}
        for i, rec in enumerate(payload, start=1)
    ]


def _normalize_contact_row(raw: dict) -> dict | None:
    """單列原始 dict → 標準欄位 {name,email,phone,note,attributes}。
    整列空白回傳 None(交由呼叫端計入 skipped)。company 併入 attributes。"""
    fields: dict = {"name": None, "email": None, "phone": None, "note": None, "attributes": {}}
    for key, val in (raw or {}).items():
        if key is None:  # csv 表頭外的多餘欄位(DictReader restkey)
            continue
        k = str(key).strip()
        if not k:
            continue
        # 值正規化:None→空字串;非字串轉字串;統一去頭尾空白
        if val is None:
            sval = ""
        elif isinstance(val, str):
            sval = val.strip()
        elif isinstance(val, (list, tuple)):
            sval = " ".join(str(x) for x in val).strip()
        else:
            sval = str(val).strip()
        mapped = _IMPORT_FIELD_ALIASES.get(k.lower())
        if mapped in ("name", "email", "phone", "note"):
            if sval:
                fields[mapped] = sval
        elif mapped == "company":
            if sval:
                fields["attributes"]["company"] = sval
        else:
            # 未知欄位 → 自訂屬性(保留原始鍵名);略過空值避免雜訊
            if sval:
                fields["attributes"][k] = sval
    if not (fields["name"] or fields["email"] or fields["phone"] or fields["note"] or fields["attributes"]):
        return None
    return fields


async def _find_dup_contact(
    db, tenant_id: uuid.UUID, email: str | None, phone: str | None
) -> Contact | None:
    """同租戶、未刪聯絡人中,以 email(不分大小寫)或 phone 命中既有者。"""
    if not email and not phone:
        return None
    conds = []
    if email:
        conds.append(func.lower(Contact.email) == email.lower())
    if phone:
        conds.append(Contact.phone == phone)
    stmt = (
        select(Contact)
        .where(
            Contact.tenant_id == tenant_id,
            Contact.deleted_at.is_(None),
            or_(*conds),
        )
        .limit(1)
    )
    return (await db.execute(stmt)).scalars().first()


def _apply_import_fields(c: Contact, fields: dict) -> None:
    """把標準欄位套到 Contact;只覆蓋有帶入的欄位(避免以空值清掉既有資料)。
    attributes 以「既有 ∪ 新值(新值優先)」淺層合併,重新賦值以觸發 JSONB 變更偵測。"""
    if fields["name"]:
        c.name = fields["name"]
    if fields["email"]:
        c.email = fields["email"]
    if fields["phone"]:
        c.phone = fields["phone"]
    if fields["note"]:
        c.note = fields["note"]
    incoming = fields["attributes"]
    if incoming:
        c.attributes = {**(c.attributes or {}), **incoming}


@router.post("/contacts/import")
async def import_contacts(
    request: Request,
    staff: CurrentStaff,
    db: DbSession,
    on_duplicate: str = Query("update", pattern="^(update|skip)$"),
):
    """批量匯入聯絡人(CurrentStaff,tenant 隔離)。

    - 接受 multipart CSV(欄位名 ``file``)、原始 CSV,或 JSON 陣列。
    - 欄位對映:name / email / phone / company(→ attributes)/ note,其餘欄位進 attributes。
    - 去重:同租戶內以 email(不分大小寫)或 phone 命中既有聯絡人;
      ``on_duplicate=update`` 更新既有(只覆蓋有帶入的欄位、attributes 合併)、
      ``on_duplicate=skip`` 略過。批次內先建立者經 flush 亦可被後續列去重命中。
    - 逐列容錯:壞列略過並收集錯誤;整列空白計入 skipped。
    - 上限 ``_IMPORT_MAX_ROWS`` 列。
    回傳 ``{created, updated, skipped, errors:[{row, reason}]}``。
    """
    staff.require("conversation.assign")
    rows = await _parse_import_payload(request)
    if len(rows) > _IMPORT_MAX_ROWS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"too many rows (max {_IMPORT_MAX_ROWS})",
        )

    created = updated = skipped = 0
    errors: list[dict] = []

    for row in rows:
        line = row["_line"]
        try:
            fields = _normalize_contact_row(row["_data"])
            if fields is None:  # 整列空白
                skipped += 1
                continue
            if not (fields["email"] or fields["phone"] or fields["name"]):
                errors.append({"row": line, "reason": "缺少可辨識欄位(name/email/phone)"})
                continue
            existing = await _find_dup_contact(db, staff.tenant_id, fields["email"], fields["phone"])
            if existing is not None:
                if on_duplicate == "skip":
                    skipped += 1
                    continue
                _apply_import_fields(existing, fields)
                updated += 1
            else:
                c = Contact(tenant_id=staff.tenant_id)
                _apply_import_fields(c, fields)
                db.add(c)
                created += 1
            # 逐列 flush:讓批次內新建/更新者可被後續列的去重查詢命中
            await db.flush()
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001 逐列容錯,壞列不影響其他列
            errors.append({"row": line, "reason": str(e) or e.__class__.__name__})

    await db.commit()
    return ok({"created": created, "updated": updated, "skipped": skipped, "errors": errors})


@router.get("/contacts")
async def list_contacts(
    staff: CurrentStaff,
    db: DbSession,
    is_blocked: bool | None = None,
    tag_id: uuid.UUID | None = None,
    q: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """聯絡人清單(可依封鎖狀態 / 標籤過濾,q 模糊搜尋姓名/信箱/電話)。"""
    staff.require("conversation.view")
    stmt = select(Contact).where(
        Contact.tenant_id == staff.tenant_id, Contact.deleted_at.is_(None)
    )
    if is_blocked is not None:
        stmt = stmt.where(Contact.is_blocked.is_(is_blocked))
    if tag_id is not None:
        stmt = stmt.where(
            Contact.id.in_(await _target_ids_by_tag(db, staff.tenant_id, tag_id, "contact"))
        )
    if q:
        like = f"%{q}%"
        stmt = stmt.where(
            Contact.name.ilike(like) | Contact.email.ilike(like) | Contact.phone.ilike(like)
        )
    stmt = stmt.order_by(Contact.created_at.desc()).limit(limit).offset(offset)
    rows = (await db.execute(stmt)).scalars().all()
    return ok([_contact_out(c) for c in rows])


@router.get("/contacts/{contact_id}")
async def get_contact(contact_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """聯絡人檔案:含關聯的訪客身份、標籤。"""
    staff.require("conversation.view")
    c = await _get_contact_or_404(db, staff.tenant_id, contact_id)
    visitors = (
        await db.execute(
            select(Visitor).where(
                Visitor.tenant_id == staff.tenant_id,
                Visitor.contact_id == c.id,
                Visitor.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    data = _contact_out(c)
    data["visitors"] = [_visitor_out(v) for v in visitors]
    data["tags"] = await _tag_ids_for(db, staff.tenant_id, "contact", c.id)
    return ok(data)


@router.patch("/contacts/{contact_id}")
async def update_contact(
    contact_id: uuid.UUID, body: ContactPatch, staff: CurrentStaff, db: DbSession
):
    """更新聯絡人 CRM 欄位(僅更新有帶入的欄位)。"""
    staff.require("conversation.assign")
    c = await _get_contact_or_404(db, staff.tenant_id, contact_id)
    patch = body.model_dump(exclude_unset=True)
    for field, value in patch.items():
        setattr(c, field, value)
    await db.commit()
    return ok(_contact_out(c))


@router.delete("/contacts/{contact_id}")
async def delete_contact(contact_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """軟刪除聯絡人(設 deleted_at);其下訪客的 contact_id 置空。"""
    from datetime import datetime

    staff.require("conversation.assign")
    c = await _get_contact_or_404(db, staff.tenant_id, contact_id)
    visitors = (
        await db.execute(
            select(Visitor).where(
                Visitor.tenant_id == staff.tenant_id, Visitor.contact_id == c.id
            )
        )
    ).scalars().all()
    for v in visitors:
        v.contact_id = None
    c.deleted_at = datetime.now(UTC)
    await db.commit()
    return ok({"id": str(c.id), "deleted": True})


@router.post("/contacts/{contact_id}/block")
async def block_contact(contact_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """封鎖聯絡人(跨渠道黑名單)。"""
    staff.require("conversation.assign")
    c = await _get_contact_or_404(db, staff.tenant_id, contact_id)
    c.is_blocked = True
    await db.commit()
    return ok(_contact_out(c))


@router.post("/contacts/{contact_id}/unblock")
async def unblock_contact(contact_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """解除聯絡人封鎖。"""
    staff.require("conversation.assign")
    c = await _get_contact_or_404(db, staff.tenant_id, contact_id)
    c.is_blocked = False
    await db.commit()
    return ok(_contact_out(c))


class MergeIn(BaseModel):
    primary_contact_id: uuid.UUID
    merge_contact_ids: list[uuid.UUID] = Field(min_length=1)


@router.post("/contacts/merge")
async def merge_contacts(body: MergeIn, staff: CurrentStaff, db: DbSession):
    """跨渠道身份合併:把多個 Contact 的訪客併到主 Contact,合併屬性後軟刪被併者。"""
    from datetime import datetime

    staff.require("conversation.assign")
    if body.primary_contact_id in body.merge_contact_ids:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail="primary contact cannot be in merge list"
        )
    primary = await _get_contact_or_404(db, staff.tenant_id, body.primary_contact_id)

    moved_visitors = 0
    for cid in body.merge_contact_ids:
        c = await _get_contact_or_404(db, staff.tenant_id, cid)
        # 把該 Contact 下所有訪客改掛到主 Contact
        visitors = (
            await db.execute(
                select(Visitor).where(
                    Visitor.tenant_id == staff.tenant_id, Visitor.contact_id == c.id
                )
            )
        ).scalars().all()
        for v in visitors:
            v.contact_id = primary.id
            moved_visitors += 1
        # 屬性合併:主檔為準,被併者補主檔缺漏的 attributes 鍵與空欄位
        if c.attributes:
            primary.attributes = {**c.attributes, **(primary.attributes or {})}
        for field in ("name", "email", "phone", "note"):
            if getattr(primary, field) is None and getattr(c, field) is not None:
                setattr(primary, field, getattr(c, field))
        # 標籤改指向主 Contact
        rels = (
            await db.execute(
                select(TagRelation).where(
                    TagRelation.tenant_id == staff.tenant_id,
                    TagRelation.target_type == "contact",
                    TagRelation.target_id == c.id,
                    TagRelation.deleted_at.is_(None),
                )
            )
        ).scalars().all()
        for rel in rels:
            rel.target_id = primary.id
        # 軟刪被併聯絡人
        c.deleted_at = datetime.now(UTC)

    await db.commit()
    return ok(
        {
            "primary_contact_id": str(primary.id),
            "merged": [str(c) for c in body.merge_contact_ids],
            "moved_visitors": moved_visitors,
        }
    )


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
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="contact not found")
    return c


# ===========================================================================
# 標籤 Tag
# ===========================================================================
class TagIn(BaseModel):
    name: str
    color: str | None = None
    category: str | None = None


class TagPatch(BaseModel):
    name: str | None = None
    color: str | None = None
    category: str | None = None


class TagApplyIn(BaseModel):
    target_type: str
    target_id: uuid.UUID


def _check_target_type(target_type: str) -> None:
    if target_type not in TAG_TARGET_TYPES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f"invalid target_type; must be one of {list(TAG_TARGET_TYPES)}",
        )


@router.post("/tags", status_code=status.HTTP_201_CREATED)
async def create_tag(body: TagIn, staff: CurrentStaff, db: DbSession):
    """建立標籤(同租戶內名稱唯一)。"""
    staff.require("conversation.assign")
    dup = (
        await db.execute(
            select(func.count())
            .select_from(Tag)
            .where(
                Tag.tenant_id == staff.tenant_id,
                Tag.name == body.name,
                Tag.deleted_at.is_(None),
            )
        )
    ).scalar_one()
    if dup:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="tag name already exists")
    t = Tag(tenant_id=staff.tenant_id, name=body.name, color=body.color, category=body.category)
    db.add(t)
    await db.commit()
    return ok(_tag_out(t))


@router.get("/tags")
async def list_tags(
    staff: CurrentStaff,
    db: DbSession,
    category: str | None = None,
    q: str | None = None,
):
    """標籤清單。"""
    staff.require("conversation.view")
    stmt = select(Tag).where(Tag.tenant_id == staff.tenant_id, Tag.deleted_at.is_(None))
    if category is not None:
        stmt = stmt.where(Tag.category == category)
    if q:
        stmt = stmt.where(Tag.name.ilike(f"%{q}%"))
    rows = (await db.execute(stmt.order_by(Tag.name))).scalars().all()
    return ok([_tag_out(t) for t in rows])


@router.patch("/tags/{tag_id}")
async def update_tag(tag_id: uuid.UUID, body: TagPatch, staff: CurrentStaff, db: DbSession):
    """更新標籤。"""
    staff.require("conversation.assign")
    t = await _get_tag_or_404(db, staff.tenant_id, tag_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(t, field, value)
    await db.commit()
    return ok(_tag_out(t))


@router.delete("/tags/{tag_id}")
async def delete_tag(tag_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """軟刪除標籤,並移除其所有關聯。"""
    from datetime import datetime

    staff.require("conversation.assign")
    t = await _get_tag_or_404(db, staff.tenant_id, tag_id)
    rels = (
        await db.execute(
            select(TagRelation).where(
                TagRelation.tenant_id == staff.tenant_id,
                TagRelation.tag_id == t.id,
                TagRelation.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    now = datetime.now(UTC)
    for rel in rels:
        rel.deleted_at = now
    t.deleted_at = now
    await db.commit()
    return ok({"id": str(t.id), "deleted": True})


@router.post("/tags/{tag_id}/apply")
async def apply_tag(tag_id: uuid.UUID, body: TagApplyIn, staff: CurrentStaff, db: DbSession):
    """把標籤套用到目標(冪等:已存在則直接回傳)。"""
    staff.require("conversation.assign")
    _check_target_type(body.target_type)
    t = await _get_tag_or_404(db, staff.tenant_id, tag_id)
    existing = (
        await db.execute(
            select(TagRelation).where(
                TagRelation.tenant_id == staff.tenant_id,
                TagRelation.tag_id == t.id,
                TagRelation.target_type == body.target_type,
                TagRelation.target_id == body.target_id,
                TagRelation.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        rel = TagRelation(
            tenant_id=staff.tenant_id,
            tag_id=t.id,
            target_type=body.target_type,
            target_id=body.target_id,
        )
        db.add(rel)
        await db.commit()
    return ok(
        {
            "tag_id": str(t.id),
            "target_type": body.target_type,
            "target_id": str(body.target_id),
        }
    )


@router.post("/tags/{tag_id}/remove")
async def remove_tag(tag_id: uuid.UUID, body: TagApplyIn, staff: CurrentStaff, db: DbSession):
    """從目標移除標籤(軟刪關聯)。"""
    from datetime import datetime

    staff.require("conversation.assign")
    _check_target_type(body.target_type)
    rel = (
        await db.execute(
            select(TagRelation).where(
                TagRelation.tenant_id == staff.tenant_id,
                TagRelation.tag_id == tag_id,
                TagRelation.target_type == body.target_type,
                TagRelation.target_id == body.target_id,
                TagRelation.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if rel is not None:
        rel.deleted_at = datetime.now(UTC)
        await db.commit()
    return ok({"removed": rel is not None})


@router.get("/tags/{tag_id}/targets")
async def list_tag_targets(
    tag_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
    target_type: str | None = None,
):
    """依標籤過濾:列出該標籤套用到的所有目標(可再限定 target_type)。"""
    staff.require("conversation.view")
    await _get_tag_or_404(db, staff.tenant_id, tag_id)
    stmt = select(TagRelation).where(
        TagRelation.tenant_id == staff.tenant_id,
        TagRelation.tag_id == tag_id,
        TagRelation.deleted_at.is_(None),
    )
    if target_type is not None:
        _check_target_type(target_type)
        stmt = stmt.where(TagRelation.target_type == target_type)
    rows = (await db.execute(stmt)).scalars().all()
    return ok(
        [{"target_type": r.target_type, "target_id": str(r.target_id)} for r in rows]
    )


@router.get("/targets/{target_type}/{target_id}/tags")
async def list_target_tags(
    target_type: str, target_id: uuid.UUID, staff: CurrentStaff, db: DbSession
):
    """列出某目標身上的所有標籤(完整標籤物件)。"""
    staff.require("conversation.view")
    _check_target_type(target_type)
    tag_ids = (
        await db.execute(
            select(TagRelation.tag_id).where(
                TagRelation.tenant_id == staff.tenant_id,
                TagRelation.target_type == target_type,
                TagRelation.target_id == target_id,
                TagRelation.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    if not tag_ids:
        return ok([])
    tags = (
        await db.execute(
            select(Tag).where(
                Tag.tenant_id == staff.tenant_id,
                Tag.id.in_(tag_ids),
                Tag.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    return ok([_tag_out(t) for t in tags])


async def _get_tag_or_404(db, tenant_id: uuid.UUID, tag_id: uuid.UUID) -> Tag:
    t = (
        await db.execute(
            select(Tag).where(
                Tag.tenant_id == tenant_id, Tag.id == tag_id, Tag.deleted_at.is_(None)
            )
        )
    ).scalar_one_or_none()
    if t is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="tag not found")
    return t
