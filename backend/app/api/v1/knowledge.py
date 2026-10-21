"""M7 knowledge API:知識庫 collection / 文檔 / QA CRUD、上傳切塊入庫、
網站爬取 stub、檢索測試端點。

router 前綴由整合者掛載為 /api/v1/knowledge。所有查詢以 staff.tenant_id 過濾,
回覆一律用 app.core.response 信封。文檔/QA 入庫時以 embed_texts 產生向量。
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated
from urllib.parse import quote, urlparse

from fastapi import APIRouter, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.deps import CurrentStaff, DbSession, Principal
from app.core.response import ok
from app.models.kb_analytics import KBHit
from app.models.knowledge import Document, KnowledgeCollection, QAPair
from app.models.tenancy import Tenant
from app.services import rag
from app.services.ai.chunking import chunk_text
from app.services.embedding import embed_texts
from app.services.ingest import (
    CRAWL_TASK_KIND,
    DocumentParseError,
    build_crawl_task_ref,
    is_crawl_task_ref,
    parse_document,
)

router = APIRouter()

logger = logging.getLogger("kefu.knowledge")

# 集合列表的「命中率」預設回溯視窗(天);列表端點本身不帶 days,故用此常數。
_HIT_RATE_WINDOW_DAYS = 30
# 分析端點各「top N」清單長度上限。
_ANALYTICS_TOP_N = 10


# ----------------------------- schemas -----------------------------
class CollectionIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    source_type: str = Field(default="document")  # document|website|qa


class CollectionPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    source_type: str | None = None


class DocumentIn(BaseModel):
    content: str = Field(min_length=1)
    title: str | None = Field(default=None, max_length=500)
    source_ref: dict | None = None


class QAPairIn(BaseModel):
    question: str = Field(min_length=1)
    answer: str = Field(min_length=1)


class QAPairPatch(BaseModel):
    question: str | None = None
    answer: str | None = None


class CrawlIn(BaseModel):
    url: str
    max_pages: int = Field(default=20, ge=1, le=500)


class RetrieveIn(BaseModel):
    query: str = Field(min_length=1)
    top_k: int = Field(default=5, ge=1, le=50)
    collection_ids: list[uuid.UUID] | None = None


# ----------------------------- helpers -----------------------------
def _now() -> datetime:
    return datetime.now(UTC)


def _collection_dict(c: KnowledgeCollection, doc_count: int = 0, hit_rate: float | None = None) -> dict:
    return {
        "id": str(c.id),
        "name": c.name,
        "source_type": c.source_type,
        "is_published": c.is_published,
        "public_slug": c.public_slug,
        "created_at": c.created_at.isoformat(),
        # 該集合下未刪除的文件數(由呼叫端批量算好傳入,避免 N+1),見 _doc_counts。
        "doc_count": doc_count,
        # 命中率:近 _HIT_RATE_WINDOW_DAYS 天內,「命中此集合的檢索事件數 / 全租戶總檢索事件數」。
        # 由 KBHit 命中追蹤資料計算(見 _hit_rates);無資料 / 尚未有命中記錄時為 None,
        # 前端顯示「—」。此值取代了先前恆 None 的佔位。
        "hit_rate": hit_rate,
    }


async def _doc_counts(db, tenant_id, collection_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """一次算出多個集合各自的「知識條目數」(未刪除、租戶隔離),避免逐集合查詢的 N+1。

    條目數 = 可檢索 Document 切塊數 + QAPair 數,理由:
    - 純 QA 型集合(source_type='qa')沒有 Document,舊版只查 Document 恆為 0,
      會誤導管理員以為集合是空的;故 QAPair 也計入。
    - 網站爬取「任務標記」列(Document.source_ref.kind == crawl_task)是佇列狀態
      載體、非可檢索內容(見 ingest.is_crawl_task_ref;/documents 列表亦濾除之),
      故不計入 Document,與文件列表口徑一致。以 is_distinct_from 過濾:
      source_ref 為 NULL 或無 kind 者(一般文件)其 ->>'kind' 為 NULL,
      NULL IS DISTINCT FROM 'crawl_task' 為真而被保留;唯 kind='crawl_task' 被排除。

    回 {collection_id: count};清單中無任何條目的集合不會出現在結果(呼叫端以 0 補)。
    """
    if not collection_ids:
        return {}
    counts: dict[uuid.UUID, int] = {}

    doc_rows = (
        await db.execute(
            select(Document.collection_id, func.count(Document.id))
            .where(
                Document.tenant_id == tenant_id,
                Document.collection_id.in_(collection_ids),
                Document.deleted_at.is_(None),
                Document.source_ref["kind"].astext.is_distinct_from(CRAWL_TASK_KIND),
            )
            .group_by(Document.collection_id)
        )
    ).all()
    for cid, n in doc_rows:
        counts[cid] = counts.get(cid, 0) + n

    qa_rows = (
        await db.execute(
            select(QAPair.collection_id, func.count(QAPair.id))
            .where(
                QAPair.tenant_id == tenant_id,
                QAPair.collection_id.in_(collection_ids),
                QAPair.deleted_at.is_(None),
            )
            .group_by(QAPair.collection_id)
        )
    ).all()
    for cid, n in qa_rows:
        counts[cid] = counts.get(cid, 0) + n

    return counts


async def _hit_rates(
    db, tenant_id, collection_ids: list[uuid.UUID], days: int = _HIT_RATE_WINDOW_DAYS
) -> dict[uuid.UUID, float]:
    """一次算出多個集合各自的「近 days 天命中率」(租戶隔離),避免 N+1。

    命中率定義:``命中此集合的檢索事件數 / 全租戶總檢索事件數``。
    - 一次 rag.retrieve = 一次「檢索事件」,同批 KBHit 列共用同一 occurred_at,
      故事件數以 ``COUNT(DISTINCT occurred_at)`` 計。
    - 分母為全租戶總檢索事件數(含未命中),使各集合命中率可加總比較其「解答佔比」。

    零回歸:整個計算包在 try/except。若 kb_hit 表尚未建立 / DB 出錯,回空 dict,
    呼叫端 hit_rate 退回 None(前端顯示「—」),絕不讓集合列表 / 詳情端點崩潰。
    只回有命中的集合;無命中者不在結果內(呼叫端以 None 補)。
    """
    if not collection_ids:
        return {}
    try:
        cutoff = datetime.now(UTC) - timedelta(days=days)
        base = [
            KBHit.tenant_id == tenant_id,
            KBHit.deleted_at.is_(None),
            KBHit.occurred_at >= cutoff,
        ]
        # 分母:全租戶總檢索事件數(distinct occurred_at)。
        total = (
            await db.execute(
                select(func.count(func.distinct(KBHit.occurred_at))).where(*base)
            )
        ).scalar_one()
        if not total:
            return {}
        # 分子:各集合命中的檢索事件數(distinct occurred_at),一次 group by 取回。
        rows = (
            await db.execute(
                select(KBHit.collection_id, func.count(func.distinct(KBHit.occurred_at)))
                .where(*base, KBHit.collection_id.in_(collection_ids))
                .group_by(KBHit.collection_id)
            )
        ).all()
        return {cid: round(n / total, 4) for cid, n in rows if cid is not None}
    except Exception:  # noqa: BLE001
        logger.debug("集合命中率計算失敗(退回 None)", exc_info=True)
        return {}


def _require_analytics(staff: Principal) -> None:
    """分析端點權限:admin,或持有 ``knowledge.view`` / ``report.view`` 任一即可檢視。"""
    roles = staff.roles
    if "admin" in roles or "knowledge.view" in roles or "report.view" in roles:
        return
    raise HTTPException(
        status.HTTP_403_FORBIDDEN, detail="missing permission: knowledge.view or report.view"
    )


def _zero_trend(cutoff: datetime, now: datetime, by_day: dict | None = None) -> list[dict]:
    """產生 [cutoff .. now] 每日 total/hits 序列(UTC 日界),缺日以 0 補齊,便於前端趨勢圖。"""
    by_day = by_day or {}
    out: list[dict] = []
    d = cutoff.date()
    end = now.date()
    while d <= end:
        key = d.isoformat()
        v = by_day.get(key) or {}
        out.append({"date": key, "total": int(v.get("total", 0)), "hits": int(v.get("hits", 0))})
        d += timedelta(days=1)
    return out


def _slugify(name: str) -> str:
    """把集合名轉成 URL 友善片段;非 ASCII(如中文)會被過濾,故一律附短碼保證非空且唯一。"""
    base = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    base = base[:100] or "collection"
    return f"{base}-{uuid.uuid4().hex[:8]}"


def _document_dict(d: Document) -> dict:
    return {
        "id": str(d.id),
        "collection_id": str(d.collection_id),
        "title": d.title,
        "content": d.content,
        "source_ref": d.source_ref,
        "chunk_index": d.chunk_index,
        "embedded": d.embedding is not None,
    }


def _qa_dict(q: QAPair) -> dict:
    return {
        "id": str(q.id),
        "collection_id": str(q.collection_id),
        "question": q.question,
        "answer": q.answer,
        "embedded": q.embedding is not None,
    }


async def _get_collection(db, tenant_id, collection_id) -> KnowledgeCollection:
    c = (
        await db.execute(
            select(KnowledgeCollection).where(
                KnowledgeCollection.id == collection_id,
                KnowledgeCollection.tenant_id == tenant_id,
                KnowledgeCollection.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if c is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="collection not found")
    return c


# ----------------------------- collections -----------------------------
@router.post("/collections")
async def create_collection(body: CollectionIn, staff: CurrentStaff, db: DbSession):
    staff.require("knowledge.manage")
    c = KnowledgeCollection(tenant_id=staff.tenant_id, name=body.name, source_type=body.source_type)
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return ok(_collection_dict(c))


@router.get("/collections")
async def list_collections(staff: CurrentStaff, db: DbSession):
    rows = (
        await db.execute(
            select(KnowledgeCollection)
            .where(
                KnowledgeCollection.tenant_id == staff.tenant_id,
                KnowledgeCollection.deleted_at.is_(None),
            )
            .order_by(KnowledgeCollection.created_at.desc())
        )
    ).scalars().all()
    ids = [c.id for c in rows]
    counts = await _doc_counts(db, staff.tenant_id, ids)
    rates = await _hit_rates(db, staff.tenant_id, ids)
    return ok([_collection_dict(c, counts.get(c.id, 0), rates.get(c.id)) for c in rows])


@router.get("/collections/{collection_id}")
async def get_collection(collection_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    c = await _get_collection(db, staff.tenant_id, collection_id)
    counts = await _doc_counts(db, staff.tenant_id, [c.id])
    rates = await _hit_rates(db, staff.tenant_id, [c.id])
    return ok(_collection_dict(c, counts.get(c.id, 0), rates.get(c.id)))


@router.patch("/collections/{collection_id}")
async def update_collection(
    collection_id: uuid.UUID, body: CollectionPatch, staff: CurrentStaff, db: DbSession
):
    c = await _get_collection(db, staff.tenant_id, collection_id)
    if body.name is not None:
        c.name = body.name
    if body.source_type is not None:
        c.source_type = body.source_type
    await db.commit()
    await db.refresh(c)
    counts = await _doc_counts(db, staff.tenant_id, [c.id])
    return ok(_collection_dict(c, counts.get(c.id, 0)))


@router.delete("/collections/{collection_id}")
async def delete_collection(collection_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    c = await _get_collection(db, staff.tenant_id, collection_id)
    c.deleted_at = _now()
    await db.commit()
    return ok({"id": str(collection_id), "deleted": True})


# ----------------------------- publish (public Help Center) -----------------------------
async def _tenant_slug(db, tenant_id) -> str | None:
    return (
        await db.execute(select(Tenant.slug).where(Tenant.id == tenant_id))
    ).scalar_one_or_none()


def _publish_payload(c: KnowledgeCollection, tenant_slug: str | None) -> dict:
    """發布狀態回應:回可直接給終端使用者的「公開閱讀頁」網址。

    公開閱讀頁是前端 SPA 路由 `/help/{tenant_slug}?c={public_slug}`
    (見 frontend/src/routes/router.tsx 的 `/help/:slug` 與 PublicHelpCenter.tsx;
    查詢參數 `c` 對應集合的 public_slug)。管理員複製 public_url 給使用者會看到
    可讀 HTML 頁,而非 /api/v1/helpcenter/... 的裸 JSON。

    只回同源相對路徑,不硬編網域(dev 由 Vite、prod 由 nginx 於同源服務前端);
    public_base 保留為 helpcenter JSON API 基底,供程式組公開 API 請求之用,非給人點的連結。
    """
    api_base = f"/api/v1/helpcenter/{tenant_slug}" if tenant_slug else None
    public_url: str | None = None
    if tenant_slug:
        public_url = f"/help/{quote(tenant_slug, safe='')}"
        if c.public_slug:
            public_url += f"?c={quote(c.public_slug, safe='')}"
    return {
        "id": str(c.id),
        "is_published": c.is_published,
        "public_slug": c.public_slug,
        "tenant_slug": tenant_slug,
        # 給管理員複製、分享給終端使用者的公開閱讀頁(可讀頁,非 JSON API)
        "public_url": public_url,
        # helpcenter JSON API 基底(供程式組公開 API 請求;非人類閱讀連結)
        "public_base": api_base,
    }


@router.post("/collections/{collection_id}/publish")
async def publish_collection(collection_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """把知識庫集合發布到對外公開的 Help Center;產生(或沿用)公開網址片段。

    權限:admin 或 ``knowledge.manage``。發布後該集合的文章 / QA 才會對外可見。
    """
    staff.require("knowledge.manage")
    c = await _get_collection(db, staff.tenant_id, collection_id)
    c.is_published = True
    if not c.public_slug:
        c.public_slug = _slugify(c.name)
    await db.commit()
    await db.refresh(c)
    tenant_slug = await _tenant_slug(db, staff.tenant_id)
    return ok(_publish_payload(c, tenant_slug))


@router.post("/collections/{collection_id}/unpublish")
async def unpublish_collection(collection_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """從公開 Help Center 下架該集合(保留 public_slug,便於重新發布維持連結)。"""
    staff.require("knowledge.manage")
    c = await _get_collection(db, staff.tenant_id, collection_id)
    c.is_published = False
    await db.commit()
    await db.refresh(c)
    tenant_slug = await _tenant_slug(db, staff.tenant_id)
    return ok(_publish_payload(c, tenant_slug))


# ----------------------------- documents -----------------------------
async def _index_document(db, tenant_id, collection_id, content: str, title: str | None, source_ref: dict | None):
    """把一段文本切塊 + 嵌入 + 入庫,回新增的 Document 列。"""
    chunks = chunk_text(content)
    if not chunks:
        return []
    vectors = await embed_texts(chunks)
    docs = []
    for i, (chunk, vec) in enumerate(zip(chunks, vectors)):
        d = Document(
            tenant_id=tenant_id,
            collection_id=collection_id,
            title=title,
            content=chunk,
            source_ref=source_ref,
            chunk_index=i,
            embedding=vec,
        )
        db.add(d)
        docs.append(d)
    await db.flush()
    return docs


@router.post("/collections/{collection_id}/documents")
async def create_document(
    collection_id: uuid.UUID, body: DocumentIn, staff: CurrentStaff, db: DbSession
):
    """由原始文本建立文檔(自動切塊 + 嵌入入庫)。"""
    staff.require("knowledge.manage")
    await _get_collection(db, staff.tenant_id, collection_id)
    docs = await _index_document(
        db, staff.tenant_id, collection_id, body.content, body.title, body.source_ref
    )
    await db.commit()
    return ok({"collection_id": str(collection_id), "chunks": len(docs), "documents": [_document_dict(d) for d in docs]})


@router.post("/collections/{collection_id}/documents/upload")
async def upload_document(
    collection_id: uuid.UUID, staff: CurrentStaff, db: DbSession, file: UploadFile
):
    """上傳文件(.txt/.md/.pdf/.docx),解析為純文字後切塊 + 嵌入入庫。

    - .pdf 用 pypdf、.docx 用 python-docx 抽文字;.txt/.md 等走 UTF-8 解碼,
      解析後接回與純文字建檔相同的「切塊→嵌入→入庫」管線(見 _index_document)。
    - 無法解析(格式不支援 / 加密 PDF / 內容為空 / 掃描圖片無文字)一律回 415
      並附清楚訊息,不讓例外冒成 500。
    嵌入為同步進行(檔案通常不大);未來可改 FastAPI BackgroundTasks + 獨立 session。
    """
    staff.require("knowledge.manage")
    await _get_collection(db, staff.tenant_id, collection_id)
    raw = await file.read()
    try:
        text = parse_document(file.filename, raw)
    except DocumentParseError as e:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail=str(e))
    source_ref = {"file": file.filename}
    docs = await _index_document(db, staff.tenant_id, collection_id, text, file.filename, source_ref)
    await db.commit()
    return ok({"collection_id": str(collection_id), "filename": file.filename, "chunks": len(docs)})


@router.get("/collections/{collection_id}/documents")
async def list_documents(collection_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    await _get_collection(db, staff.tenant_id, collection_id)
    rows = (
        await db.execute(
            select(Document)
            .where(
                Document.tenant_id == staff.tenant_id,
                Document.collection_id == collection_id,
                Document.deleted_at.is_(None),
            )
            .order_by(Document.chunk_index.asc())
        )
    ).scalars().all()
    # 濾掉網站爬取「任務標記」列(source_ref.kind == crawl_task):那是佇列狀態載體,
    # 非可檢索內容(embedding 恆為 None),不應出現在文件列表。見 GET .../crawl。
    return ok([_document_dict(d) for d in rows if not is_crawl_task_ref(d.source_ref)])


@router.delete("/documents/{document_id}")
async def delete_document(document_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    d = (
        await db.execute(
            select(Document).where(
                Document.id == document_id,
                Document.tenant_id == staff.tenant_id,
                Document.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if d is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="document not found")
    d.deleted_at = _now()
    await db.commit()
    return ok({"id": str(document_id), "deleted": True})


# ----------------------------- QA pairs -----------------------------
@router.post("/collections/{collection_id}/qa")
async def create_qa(collection_id: uuid.UUID, body: QAPairIn, staff: CurrentStaff, db: DbSession):
    staff.require("knowledge.manage")
    await _get_collection(db, staff.tenant_id, collection_id)
    vec = (await embed_texts([body.question]))[0]  # 嵌入問題以利語意檢索
    q = QAPair(
        tenant_id=staff.tenant_id,
        collection_id=collection_id,
        question=body.question,
        answer=body.answer,
        embedding=vec,
    )
    db.add(q)
    await db.commit()
    await db.refresh(q)
    return ok(_qa_dict(q))


@router.get("/collections/{collection_id}/qa")
async def list_qa(collection_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    await _get_collection(db, staff.tenant_id, collection_id)
    rows = (
        await db.execute(
            select(QAPair)
            .where(
                QAPair.tenant_id == staff.tenant_id,
                QAPair.collection_id == collection_id,
                QAPair.deleted_at.is_(None),
            )
            .order_by(QAPair.created_at.desc())
        )
    ).scalars().all()
    return ok([_qa_dict(q) for q in rows])


@router.patch("/qa/{qa_id}")
async def update_qa(qa_id: uuid.UUID, body: QAPairPatch, staff: CurrentStaff, db: DbSession):
    q = (
        await db.execute(
            select(QAPair).where(
                QAPair.id == qa_id,
                QAPair.tenant_id == staff.tenant_id,
                QAPair.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if q is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="qa pair not found")
    if body.question is not None:
        q.question = body.question
        q.embedding = (await embed_texts([body.question]))[0]  # 問題變更需重嵌入
    if body.answer is not None:
        q.answer = body.answer
    await db.commit()
    await db.refresh(q)
    return ok(_qa_dict(q))


@router.delete("/qa/{qa_id}")
async def delete_qa(qa_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    q = (
        await db.execute(
            select(QAPair).where(
                QAPair.id == qa_id,
                QAPair.tenant_id == staff.tenant_id,
                QAPair.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if q is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="qa pair not found")
    q.deleted_at = _now()
    await db.commit()
    return ok({"id": str(qa_id), "deleted": True})


# ----------------------------- website crawl -----------------------------
def _crawl_task_dict(d: Document) -> dict:
    """把一列爬取任務標記(Document.source_ref)攤成前端可讀的狀態物件。"""
    ref = d.source_ref or {}
    return {
        "task_id": str(d.id),
        "url": ref.get("url"),
        "status": ref.get("status"),  # pending|running|done|failed
        "max_pages": ref.get("max_pages"),
        "max_depth": ref.get("max_depth"),
        "pages_ingested": ref.get("pages_ingested", 0),
        "chunks": ref.get("chunks", 0),
        "error": ref.get("error"),
        "created_at": ref.get("created_at"),
        "finished_at": ref.get("finished_at"),
    }


@router.post("/collections/{collection_id}/crawl")
async def crawl_website(collection_id: uuid.UUID, body: CrawlIn, staff: CurrentStaff, db: DbSession):
    """把網站爬取任務排入佇列(背景 worker 非同步處理),回任務初始狀態 pending。

    **無新 migration**:任務以一列 Document 的 source_ref(JSONB,kind=crawl_task)
    為佇列載體,狀態 pending → running → done|failed;背景 worker
    (app.workers.crawl)每輪撿 pending → 抓取(遵守 robots、限頁數/深度)→ 抽正文
    → 切塊嵌入入庫(source_ref 記頁面 URL,可追溯來源)→ 更新狀態。
    以 GET 同路徑查詢任務狀態。

    權限:admin 或 ``knowledge.manage``(對齊 publish/unpublish;避免最低權限 staff
    觸發爬取)。
    """
    staff.require("knowledge.manage")
    await _get_collection(db, staff.tenant_id, collection_id)
    url = (body.url or "").strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="請提供有效的 http/https 網址",
        )
    ref = build_crawl_task_ref(url, body.max_pages)
    task = Document(
        tenant_id=staff.tenant_id,
        collection_id=collection_id,
        title=f"網站爬取任務:{url}",
        content=url,  # content 不可為空;放 URL 當佔位(此列 embedding=None,不入檢索)
        source_ref=ref,
        chunk_index=0,
        embedding=None,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return ok(_crawl_task_dict(task))


@router.get("/collections/{collection_id}/crawl")
async def list_crawl_tasks(collection_id: uuid.UUID, staff: CurrentStaff, db: DbSession):
    """列出該集合的網站爬取任務與狀態(供前端顯示/輪詢進度)。"""
    await _get_collection(db, staff.tenant_id, collection_id)
    rows = (
        await db.execute(
            select(Document)
            .where(
                Document.tenant_id == staff.tenant_id,
                Document.collection_id == collection_id,
                Document.deleted_at.is_(None),
            )
            .order_by(Document.created_at.desc())
        )
    ).scalars().all()
    tasks = [_crawl_task_dict(d) for d in rows if is_crawl_task_ref(d.source_ref)]
    return ok(tasks)


# ----------------------------- usage analytics -----------------------------
@router.get("/analytics")
async def knowledge_analytics(
    staff: CurrentStaff,
    db: DbSession,
    days: Annotated[int, Query(ge=1, le=365, description="回溯天數(如 7 / 30)")] = 30,
):
    """知識庫使用分析(對標 LiveChat KnowledgeBase 使用分析)。

    以 KBHit 命中追蹤資料聚合;全程租戶隔離、SQL 聚合、常數次查詢、無 N+1:
    - ``total_retrievals``:檢索事件數(一次 rag.retrieve = 一次事件,以
      ``COUNT(DISTINCT occurred_at)`` 計)。
    - ``hit_retrievals`` / ``miss_retrievals`` / ``hit_rate``:有命中 / 未命中事件數,
      命中率 = 有命中 / 總(總為 0 時 ``hit_rate`` 為 None)。
    - ``top_queries``:熱門搜尋詞(依觸發的檢索事件數;含未命中查詢)。
    - ``top_documents`` / ``top_collections``:最常命中的文件 / 集合
      (依「命中該來源的檢索事件數」;附標題 / 名稱,以 2 次常數查詢補齊,無 N+1)。
    - ``trend``:逐日 total / hits(零填滿整段區間,UTC 日界)。

    權限:``knowledge.view`` 或 ``report.view``(admin 放行)。
    零回歸:kb_hit 表未建 / DB 出錯時,回「空但結構完整」的資料(前端顯示空狀態而非報錯)。
    """
    _require_analytics(staff)
    tid = staff.tenant_id
    now = datetime.now(UTC)
    cutoff = now - timedelta(days=days)

    def _empty() -> dict:
        return {
            "days": days,
            "total_retrievals": 0,
            "hit_retrievals": 0,
            "miss_retrievals": 0,
            "hit_rate": None,
            "top_queries": [],
            "top_documents": [],
            "top_collections": [],
            "trend": _zero_trend(cutoff, now),
        }

    try:
        base = [KBHit.tenant_id == tid, KBHit.deleted_at.is_(None), KBHit.occurred_at >= cutoff]

        # --- 逐日趨勢 + 總量(單趟聚合;總量由逐日加總得出,事件不跨日) ---
        day_col = func.date_trunc("day", func.timezone("UTC", KBHit.occurred_at)).label("day")
        trend_rows = (
            await db.execute(
                select(
                    day_col,
                    func.count(func.distinct(KBHit.occurred_at)).label("total"),
                    func.count(func.distinct(KBHit.occurred_at))
                    .filter(KBHit.score.is_not(None))
                    .label("hits"),
                )
                .where(*base)
                .group_by(day_col)
                .order_by(day_col)
            )
        ).all()
        by_day: dict[str, dict] = {}
        total_retrievals = 0
        hit_retrievals = 0
        for day, total, hits in trend_rows:
            key = day.date().isoformat() if hasattr(day, "date") else str(day)[:10]
            by_day[key] = {"total": int(total or 0), "hits": int(hits or 0)}
            total_retrievals += int(total or 0)
            hit_retrievals += int(hits or 0)
        trend = _zero_trend(cutoff, now, by_day)

        # --- 熱門搜尋詞(依檢索事件數) ---
        tq_rows = (
            await db.execute(
                select(KBHit.query, func.count(func.distinct(KBHit.occurred_at)).label("cnt"))
                .where(*base)
                .group_by(KBHit.query)
                .order_by(func.count(func.distinct(KBHit.occurred_at)).desc())
                .limit(_ANALYTICS_TOP_N)
            )
        ).all()
        top_queries = [{"query": q, "count": int(n)} for q, n in tq_rows if q]

        # --- 最常命中文件(依命中該文件的檢索事件數) ---
        td_rows = (
            await db.execute(
                select(KBHit.document_id, func.count(func.distinct(KBHit.occurred_at)).label("cnt"))
                .where(*base, KBHit.document_id.is_not(None))
                .group_by(KBHit.document_id)
                .order_by(func.count(func.distinct(KBHit.occurred_at)).desc())
                .limit(_ANALYTICS_TOP_N)
            )
        ).all()
        doc_meta: dict = {}
        doc_ids = [d for d, _ in td_rows]
        if doc_ids:
            for did, title, cid in (
                await db.execute(
                    select(Document.id, Document.title, Document.collection_id).where(
                        Document.id.in_(doc_ids), Document.tenant_id == tid
                    )
                )
            ).all():
                doc_meta[did] = (title, cid)
        top_documents = []
        for did, n in td_rows:
            title, cid = doc_meta.get(did, (None, None))
            top_documents.append(
                {
                    "document_id": str(did),
                    "title": title,
                    "collection_id": str(cid) if cid else None,
                    "count": int(n),
                }
            )

        # --- 最常命中集合 ---
        tc_rows = (
            await db.execute(
                select(KBHit.collection_id, func.count(func.distinct(KBHit.occurred_at)).label("cnt"))
                .where(*base, KBHit.collection_id.is_not(None))
                .group_by(KBHit.collection_id)
                .order_by(func.count(func.distinct(KBHit.occurred_at)).desc())
                .limit(_ANALYTICS_TOP_N)
            )
        ).all()
        coll_names: dict = {}
        coll_ids = [c for c, _ in tc_rows]
        if coll_ids:
            for cid, name in (
                await db.execute(
                    select(KnowledgeCollection.id, KnowledgeCollection.name).where(
                        KnowledgeCollection.id.in_(coll_ids), KnowledgeCollection.tenant_id == tid
                    )
                )
            ).all():
                coll_names[cid] = name
        top_collections = [
            {"collection_id": str(cid), "name": coll_names.get(cid), "count": int(n)}
            for cid, n in tc_rows
        ]

        hit_rate = round(hit_retrievals / total_retrievals, 4) if total_retrievals else None
        return ok(
            {
                "days": days,
                "total_retrievals": total_retrievals,
                "hit_retrievals": hit_retrievals,
                "miss_retrievals": total_retrievals - hit_retrievals,
                "hit_rate": hit_rate,
                "top_queries": top_queries,
                "top_documents": top_documents,
                "top_collections": top_collections,
                "trend": trend,
            }
        )
    except Exception:  # noqa: BLE001
        # 分析為附加報表能力;聚合失敗(表未建 / DB 故障)回空結構,不讓端點 500。
        logger.warning("知識庫使用分析聚合失敗,回空結構", exc_info=True)
        return ok(_empty())


# ----------------------------- retrieval test -----------------------------
@router.post("/retrieve")
async def retrieve_test(body: RetrieveIn, staff: CurrentStaff, db: DbSession):
    """檢索測試端點:直接呼叫 rag.retrieve,供調試知識庫召回品質。"""
    collection_ids = [cid for cid in (body.collection_ids or [])] or None
    hits = await rag.retrieve(
        db, staff.tenant_id, body.query, top_k=body.top_k, collection_ids=collection_ids
    )
    return ok({"query": body.query, "hits": hits})
