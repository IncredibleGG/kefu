"""對外公開 Help Center(自助中心)測試:發布 / 公開讀取 / 未發布不可見 / 租戶隔離。

以 in-memory SQLite 跑,無需 Postgres/pgvector:
- 為 postgres 專用型別(JSONB、pgvector.Vector)註冊 SQLite 編譯 hook,使 create_all 可行。
- 直接以 ORM 播種資料(embedding 留空),避開嵌入服務,測試純為 API 行為。

    pytest tests/test_helpcenter.py
"""
from __future__ import annotations

import uuid

import pytest
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles


# --- 讓 postgres 專用型別能在 SQLite 建表(僅供測試) ---
@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(type_, compiler, **kw):
    return "JSON"


@compiles(Vector, "sqlite")
def _compile_vector_sqlite(type_, compiler, **kw):
    return "TEXT"


# ----------------------------- 基礎設施 -----------------------------
async def _engine():
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import StaticPool

    import app.models  # noqa: F401  註冊所有 mapper
    from app.core.db import Base

    engine = create_async_engine(
        "sqlite+aiosqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine


def _token(staff_id, tenant_id, roles) -> str:
    from app.core.security import create_access_token

    return create_access_token(
        {"sub": str(staff_id), "tenant_id": str(tenant_id), "roles": roles}
    )


async def _client(engine):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from app.api.v1 import helpcenter, knowledge
    from app.core.db import get_db

    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _get_db():
        async with maker() as s:
            yield s

    app = FastAPI()
    app.include_router(knowledge.router, prefix="/api/v1/knowledge")
    app.include_router(helpcenter.router, prefix="/api/v1/helpcenter")
    app.dependency_overrides[get_db] = _get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _seed(engine):
    """建立兩個租戶與各自的集合 / 文章 / QA,直接播種(embedding 留空)。

    tenant A(slug=demo):
      - colA1:待發布,含 art1/art2(is_published=True)、hidden_doc(is_published=False)、faqA
      - colA2:永不發布,含 secret_doc
    tenant B(slug=other):
      - colB1:已發布,含 bdoc
    """
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from app.models.knowledge import Document, KnowledgeCollection, QAPair
    from app.models.tenancy import Tenant

    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    ids: dict = {}
    async with maker() as db:
        ta = Tenant(name="A 公司", slug="demo")
        tb = Tenant(name="B 公司", slug="other")
        db.add_all([ta, tb])
        await db.flush()

        col_a1 = KnowledgeCollection(tenant_id=ta.id, name="入門指南", source_type="document")
        col_a2 = KnowledgeCollection(tenant_id=ta.id, name="內部草稿", source_type="document")
        col_b1 = KnowledgeCollection(
            tenant_id=tb.id, name="B 分類", source_type="document",
            is_published=True, public_slug="b-cat-abc",
        )
        db.add_all([col_a1, col_a2, col_b1])
        await db.flush()

        art1 = Document(
            tenant_id=ta.id, collection_id=col_a1.id, title="如何開始",
            content="第一步請先註冊帳號並登入退款設定。", source_ref={"file": "start.md"},
            chunk_index=0,
        )
        art2 = Document(
            tenant_id=ta.id, collection_id=col_a1.id, title="常見設定",
            content="在後台可以調整通知與偏好。", chunk_index=0,
        )
        hidden_doc = Document(
            tenant_id=ta.id, collection_id=col_a1.id, title="暫未公開",
            content="這篇文章單獨下架。", chunk_index=0, is_published=False,
        )
        secret_doc = Document(
            tenant_id=ta.id, collection_id=col_a2.id, title="內部機密",
            content="這是未發布集合的機密內容 退款。", chunk_index=0,
        )
        bdoc = Document(
            tenant_id=tb.id, collection_id=col_b1.id, title="B 專屬",
            content="B 租戶的公開文章 退款。", chunk_index=0,
        )
        faq_a = QAPair(
            tenant_id=ta.id, collection_id=col_a1.id,
            question="如何退款?", answer="到訂單頁點退款即可。",
        )
        db.add_all([art1, art2, hidden_doc, secret_doc, bdoc, faq_a])
        await db.commit()

        ids = {
            "tenant_a": ta.id, "tenant_b": tb.id,
            "col_a1": col_a1.id, "col_a2": col_a2.id, "col_b1": col_b1.id,
            "art1": art1.id, "art2": art2.id, "hidden_doc": hidden_doc.id,
            "secret_doc": secret_doc.id, "bdoc": bdoc.id, "faq_a": faq_a.id,
        }
    return ids


# ----------------------------- 發布管理 -----------------------------
@pytest.mark.asyncio
async def test_publish_and_unpublish_flow():
    engine = await _engine()
    try:
        ids = await _seed(engine)
        admin = {"Authorization": f"Bearer {_token(uuid.uuid4(), ids['tenant_a'], ['admin'])}"}
        async with await _client(engine) as c:
            # 尚未發布 → 公開清單看不到
            r = await c.get("/api/v1/helpcenter/demo/collections")
            assert r.json()["ok"] is True
            assert r.json()["data"]["collections"] == []

            # 發布 colA1
            r = await c.post(f"/api/v1/knowledge/collections/{ids['col_a1']}/publish", headers=admin)
            body = r.json()
            assert body["ok"] is True
            assert body["data"]["is_published"] is True
            slug = body["data"]["public_slug"]
            assert slug and slug.endswith(tuple("0123456789abcdef"))  # 帶短碼
            assert body["data"]["tenant_slug"] == "demo"
            # public_url 指向給人閱讀的前端頁 /help/{tenant}?c={public_slug},非 JSON API
            assert body["data"]["public_url"] == f"/help/demo?c={slug}"

            # 公開清單現在看得到,且只此一個(colA2 未發布)
            r = await c.get("/api/v1/helpcenter/demo/collections")
            cols = r.json()["data"]["collections"]
            assert len(cols) == 1 and cols[0]["slug"] == slug and cols[0]["name"] == "入門指南"

            # 取消發布 → 又看不到
            r = await c.post(f"/api/v1/knowledge/collections/{ids['col_a1']}/unpublish", headers=admin)
            assert r.json()["data"]["is_published"] is False
            r = await c.get("/api/v1/helpcenter/demo/collections")
            assert r.json()["data"]["collections"] == []
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_publish_requires_permission():
    engine = await _engine()
    try:
        ids = await _seed(engine)
        # 無 admin、也無 knowledge.manage
        agent = {"Authorization": f"Bearer {_token(uuid.uuid4(), ids['tenant_a'], ['agent'])}"}
        manager = {"Authorization": f"Bearer {_token(uuid.uuid4(), ids['tenant_a'], ['knowledge.manage'])}"}
        async with await _client(engine) as c:
            r = await c.post(f"/api/v1/knowledge/collections/{ids['col_a1']}/publish", headers=agent)
            assert r.status_code == 403
            # 具 knowledge.manage 權限者可發布
            r = await c.post(f"/api/v1/knowledge/collections/{ids['col_a1']}/publish", headers=manager)
            assert r.status_code == 200 and r.json()["data"]["is_published"] is True
    finally:
        await engine.dispose()


# ----------------------------- 公開讀取 -----------------------------
@pytest.mark.asyncio
async def test_public_articles_and_single_and_search():
    engine = await _engine()
    try:
        ids = await _seed(engine)
        admin = {"Authorization": f"Bearer {_token(uuid.uuid4(), ids['tenant_a'], ['admin'])}"}
        async with await _client(engine) as c:
            await c.post(f"/api/v1/knowledge/collections/{ids['col_a1']}/publish", headers=admin)

            # 文章清單:art1/art2 可見,hidden_doc(單獨下架)不可見
            r = await c.get("/api/v1/helpcenter/demo/articles")
            data = r.json()["data"]
            titles = {i["title"] for i in data["items"]}
            assert titles == {"如何開始", "常見設定"}
            assert data["total"] == 2
            # 清單只給摘要不給全文欄位
            assert "content" not in data["items"][0] and "excerpt" in data["items"][0]

            # 單篇文章:回全文 + 來源
            r = await c.get(f"/api/v1/helpcenter/demo/articles/{ids['art1']}")
            art = r.json()["data"]
            assert art["title"] == "如何開始"
            assert "註冊帳號" in art["content"]
            assert art["source"] == {"file": "start.md"}
            # 不外洩機敏欄位
            assert "embedding" not in art

            # FAQ 清單
            r = await c.get("/api/v1/helpcenter/demo/faqs")
            faqs = r.json()["data"]["items"]
            assert len(faqs) == 1 and faqs[0]["question"] == "如何退款?"

            # 搜尋:'退款' 命中 art1 與 faq;未發布集合的 secret_doc 不得出現
            r = await c.get("/api/v1/helpcenter/demo/search", params={"q": "退款"})
            sd = r.json()["data"]
            art_titles = {a["title"] for a in sd["articles"]}
            assert "如何開始" in art_titles
            assert "內部機密" not in art_titles  # 未發布集合內容不可被搜到
            assert len(sd["faqs"]) == 1

            # 空白 q → 空結果
            r = await c.get("/api/v1/helpcenter/demo/search", params={"q": "  "})
            assert r.json()["data"]["articles"] == [] and r.json()["data"]["faqs"] == []
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_unpublished_not_visible():
    engine = await _engine()
    try:
        ids = await _seed(engine)
        admin = {"Authorization": f"Bearer {_token(uuid.uuid4(), ids['tenant_a'], ['admin'])}"}
        async with await _client(engine) as c:
            await c.post(f"/api/v1/knowledge/collections/{ids['col_a1']}/publish", headers=admin)

            # 未發布集合(colA2)的文章:單篇讀取 → not_found
            r = await c.get(f"/api/v1/helpcenter/demo/articles/{ids['secret_doc']}")
            assert r.json()["ok"] is False and r.json()["error"]["code"] == "not_found"

            # 已發布集合中被單獨下架的文章 → not_found
            r = await c.get(f"/api/v1/helpcenter/demo/articles/{ids['hidden_doc']}")
            assert r.json()["ok"] is False and r.json()["error"]["code"] == "not_found"

            # 指定未發布集合做 collection 篩選 → 空清單
            r = await c.get("/api/v1/helpcenter/demo/articles", params={"collection": str(ids["col_a2"])})
            assert r.json()["data"]["items"] == [] and r.json()["data"]["total"] == 0
    finally:
        await engine.dispose()


# ----------------------------- 租戶隔離 -----------------------------
@pytest.mark.asyncio
async def test_tenant_isolation():
    engine = await _engine()
    try:
        ids = await _seed(engine)
        admin = {"Authorization": f"Bearer {_token(uuid.uuid4(), ids['tenant_a'], ['admin'])}"}
        async with await _client(engine) as c:
            await c.post(f"/api/v1/knowledge/collections/{ids['col_a1']}/publish", headers=admin)

            # 用 B 的 slug 看到的是 B 的內容,絕不含 A 的文章
            r = await c.get("/api/v1/helpcenter/other/collections")
            names = {col["name"] for col in r.json()["data"]["collections"]}
            assert names == {"B 分類"}

            r = await c.get("/api/v1/helpcenter/other/articles")
            titles = {i["title"] for i in r.json()["data"]["items"]}
            assert titles == {"B 專屬"} and "如何開始" not in titles

            # A 的文章 id 不能經由 B 的 slug 取得(跨租戶存取被擋)
            r = await c.get(f"/api/v1/helpcenter/other/articles/{ids['art1']}")
            assert r.json()["ok"] is False and r.json()["error"]["code"] == "not_found"

            # 未知租戶 slug → not_found
            r = await c.get("/api/v1/helpcenter/nonexistent/collections")
            assert r.json()["ok"] is False and r.json()["error"]["code"] == "not_found"

            # B 的 slug 搜 '退款' 只回 B 自己的文章
            r = await c.get("/api/v1/helpcenter/other/search", params={"q": "退款"})
            art_titles = {a["title"] for a in r.json()["data"]["articles"]}
            assert art_titles == {"B 專屬"}
    finally:
        await engine.dispose()
