"""對外公開 Help Center(自助中心)API —— 無需登入的公開讀取端點。

router 前綴由整合者掛載為 ``/api/v1/helpcenter``(**不加任何 JWT 依賴**)。
租戶以網址中的 ``tenant_slug`` 定位(對應 ``Tenant.slug``,demo 租戶 slug=demo)。

嚴格公開安全邊界:
- 只回**已發布**內容 —— 集合須 ``is_published``,文章須所屬集合已發布且自身 ``is_published``。
- 一律過濾 ``deleted_at is None``,並以 slug 解析出的 ``tenant_id`` 做租戶隔離。
- 只輸出標題 / 內容 / 來源等對外欄位,**不含** embedding、內部設定等機敏資料。
- QAPair 以「常見問題(FAQ)」形式納入,可搜尋、可列表。

回覆一律走 ``app.core.response`` 的 ok()/err() 信封;查無資料回 err("not_found", ...)。
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Query
from sqlalchemy import func, or_, select

from app.core.deps import DbSession
from app.core.response import err, ok
from app.models.knowledge import Document, KnowledgeCollection, QAPair
from app.models.tenancy import Tenant

router = APIRouter()


# ----------------------------- serializers(公開安全,絕不外洩機敏) -----------------------------
def _collection_dict(c: KnowledgeCollection) -> dict:
    return {
        "id": str(c.id),
        "slug": c.public_slug,
        "name": c.name,
        "source_type": c.source_type,
    }


def _excerpt(text: str | None, limit: int = 200) -> str:
    t = (text or "").strip()
    return t if len(t) <= limit else t[:limit].rstrip() + "…"


def _article_list_dict(d: Document) -> dict:
    return {
        "id": str(d.id),
        "collection_id": str(d.collection_id),
        "title": d.title,
        "excerpt": _excerpt(d.content),
        "chunk_index": d.chunk_index,
        "created_at": d.created_at.isoformat() if d.created_at else None,
    }


def _article_dict(d: Document) -> dict:
    return {
        "id": str(d.id),
        "collection_id": str(d.collection_id),
        "title": d.title,
        "content": d.content,
        "source": d.source_ref,  # 引用來源(url / file / page)
        "chunk_index": d.chunk_index,
        "created_at": d.created_at.isoformat() if d.created_at else None,
    }


def _faq_dict(q: QAPair) -> dict:
    return {
        "id": str(q.id),
        "collection_id": str(q.collection_id),
        "question": q.question,
        "answer": q.answer,
    }


# ----------------------------- helpers(租戶 / 已發布範圍) -----------------------------
async def _resolve_tenant(db, tenant_slug: str) -> Tenant | None:
    return (
        await db.execute(
            select(Tenant).where(Tenant.slug == tenant_slug, Tenant.is_active.is_(True))
        )
    ).scalar_one_or_none()


def _published_collection_ids(tenant_id):
    """租戶內所有『已發布且未刪除』集合 id 的子查詢,作為公開內容的第一道閘。"""
    return (
        select(KnowledgeCollection.id)
        .where(
            KnowledgeCollection.tenant_id == tenant_id,
            KnowledgeCollection.is_published.is_(True),
            KnowledgeCollection.deleted_at.is_(None),
        )
        .scalar_subquery()
    )


async def _published_collection(db, tenant_id, key: str) -> KnowledgeCollection | None:
    """依 public_slug 或集合 UUID 取一個『已發布』集合(供 collection 篩選)。"""
    key_conds = [KnowledgeCollection.public_slug == key]
    try:
        key_conds.append(KnowledgeCollection.id == uuid.UUID(str(key)))
    except (ValueError, AttributeError, TypeError):
        pass
    return (
        await db.execute(
            select(KnowledgeCollection).where(
                KnowledgeCollection.tenant_id == tenant_id,
                KnowledgeCollection.is_published.is_(True),
                KnowledgeCollection.deleted_at.is_(None),
                or_(*key_conds),
            )
        )
    ).scalar_one_or_none()


# ----------------------------- endpoints -----------------------------
@router.get("/{tenant_slug}/collections")
async def public_collections(tenant_slug: str, db: DbSession):
    """已發布的集合(分類)清單。"""
    tenant = await _resolve_tenant(db, tenant_slug)
    if tenant is None:
        return err("not_found", "help center not found")
    rows = (
        await db.execute(
            select(KnowledgeCollection)
            .where(
                KnowledgeCollection.tenant_id == tenant.id,
                KnowledgeCollection.is_published.is_(True),
                KnowledgeCollection.deleted_at.is_(None),
            )
            .order_by(KnowledgeCollection.created_at.desc())
        )
    ).scalars().all()
    return ok({"tenant_slug": tenant_slug, "collections": [_collection_dict(c) for c in rows]})


@router.get("/{tenant_slug}/articles")
async def public_articles(
    tenant_slug: str,
    db: DbSession,
    collection: str | None = Query(default=None, description="集合 public_slug 或 id,篩選單一分類"),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=50),
):
    """已發布集合下的文章(Document)清單,支援 collection 篩選與分頁。"""
    tenant = await _resolve_tenant(db, tenant_slug)
    if tenant is None:
        return err("not_found", "help center not found")

    conds = [
        Document.tenant_id == tenant.id,
        Document.is_published.is_(True),
        Document.deleted_at.is_(None),
    ]
    if collection is not None:
        col = await _published_collection(db, tenant.id, collection)
        if col is None:
            # 指定的分類不存在或未發布 → 空清單(不洩漏是否存在)
            return ok(
                {"tenant_slug": tenant_slug, "collection": collection,
                 "items": [], "total": 0, "page": page, "size": size}
            )
        conds.append(Document.collection_id == col.id)
    else:
        conds.append(Document.collection_id.in_(_published_collection_ids(tenant.id)))

    total = (
        await db.execute(select(func.count()).select_from(Document).where(*conds))
    ).scalar_one()
    rows = (
        await db.execute(
            select(Document)
            .where(*conds)
            .order_by(Document.created_at.desc(), Document.chunk_index.asc())
            .offset((page - 1) * size)
            .limit(size)
        )
    ).scalars().all()
    return ok(
        {
            "tenant_slug": tenant_slug,
            "collection": collection,
            "items": [_article_list_dict(d) for d in rows],
            "total": total,
            "page": page,
            "size": size,
        }
    )


@router.get("/{tenant_slug}/articles/{doc_id}")
async def public_article(tenant_slug: str, doc_id: uuid.UUID, db: DbSession):
    """單篇文章(標題 + 內容 + 來源);須屬於已發布集合且自身已發布。"""
    tenant = await _resolve_tenant(db, tenant_slug)
    if tenant is None:
        return err("not_found", "help center not found")
    d = (
        await db.execute(
            select(Document).where(
                Document.id == doc_id,
                Document.tenant_id == tenant.id,
                Document.is_published.is_(True),
                Document.deleted_at.is_(None),
                Document.collection_id.in_(_published_collection_ids(tenant.id)),
            )
        )
    ).scalar_one_or_none()
    if d is None:
        return err("not_found", "article not found")
    return ok(_article_dict(d))


@router.get("/{tenant_slug}/faqs")
async def public_faqs(
    tenant_slug: str,
    db: DbSession,
    collection: str | None = Query(default=None, description="集合 public_slug 或 id,篩選單一分類"),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=50),
):
    """已發布集合下的常見問題(QAPair)清單。"""
    tenant = await _resolve_tenant(db, tenant_slug)
    if tenant is None:
        return err("not_found", "help center not found")

    conds = [
        QAPair.tenant_id == tenant.id,
        QAPair.deleted_at.is_(None),
    ]
    if collection is not None:
        col = await _published_collection(db, tenant.id, collection)
        if col is None:
            return ok(
                {"tenant_slug": tenant_slug, "collection": collection,
                 "items": [], "total": 0, "page": page, "size": size}
            )
        conds.append(QAPair.collection_id == col.id)
    else:
        conds.append(QAPair.collection_id.in_(_published_collection_ids(tenant.id)))

    total = (
        await db.execute(select(func.count()).select_from(QAPair).where(*conds))
    ).scalar_one()
    rows = (
        await db.execute(
            select(QAPair)
            .where(*conds)
            .order_by(QAPair.created_at.desc())
            .offset((page - 1) * size)
            .limit(size)
        )
    ).scalars().all()
    return ok(
        {
            "tenant_slug": tenant_slug,
            "collection": collection,
            "items": [_faq_dict(q) for q in rows],
            "total": total,
            "page": page,
            "size": size,
        }
    )


@router.get("/{tenant_slug}/search")
async def public_search(
    tenant_slug: str,
    db: DbSession,
    q: str = Query("", description="關鍵字;空白回空結果"),
    limit: int = Query(default=20, ge=1, le=50),
):
    """對已發布內容做全文搜尋(ILIKE 標題 / 內容);文章與常見問題分開回傳。"""
    tenant = await _resolve_tenant(db, tenant_slug)
    if tenant is None:
        return err("not_found", "help center not found")

    query = q.strip()
    if not query:
        return ok({"tenant_slug": tenant_slug, "query": "", "articles": [], "faqs": []})

    like = f"%{query}%"
    published_ids = _published_collection_ids(tenant.id)

    articles = (
        await db.execute(
            select(Document)
            .where(
                Document.tenant_id == tenant.id,
                Document.is_published.is_(True),
                Document.deleted_at.is_(None),
                Document.collection_id.in_(published_ids),
                or_(Document.title.ilike(like), Document.content.ilike(like)),
            )
            .order_by(Document.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()

    faqs = (
        await db.execute(
            select(QAPair)
            .where(
                QAPair.tenant_id == tenant.id,
                QAPair.deleted_at.is_(None),
                QAPair.collection_id.in_(published_ids),
                or_(QAPair.question.ilike(like), QAPair.answer.ilike(like)),
            )
            .order_by(QAPair.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()

    return ok(
        {
            "tenant_slug": tenant_slug,
            "query": query,
            "articles": [_article_list_dict(d) for d in articles],
            "faqs": [_faq_dict(qp) for qp in faqs],
        }
    )
