"""M6/M7 單元測試:切塊、信心分數、RAG 檢索、dispatch 編排(含轉人分支)。

以 mock 隔離 DB 與 LLM/embedding,不需真實 Postgres/pgvector 即可跑。
    pytest tests/test_ai_rag.py
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import dispatch, rag
from app.services.ai.agent import EffectiveConfig, compute_confidence
from app.services.ai.chunking import chunk_text


# ----------------------------- chunk_text -----------------------------
def test_chunk_text_empty_returns_empty():
    assert chunk_text("") == []
    assert chunk_text("   \n  ") == []


def test_chunk_text_short_single_chunk():
    assert chunk_text("你好世界") == ["你好世界"]


def test_chunk_text_splits_with_overlap():
    text = "。".join(f"第{i}句內容填充填充填充" for i in range(60))
    chunks = chunk_text(text, size=120, overlap=30)
    assert len(chunks) > 1
    # 每塊不超過 size(容許柔性切點造成的少量偏差)
    assert all(len(c) <= 120 for c in chunks)
    # 覆蓋原文起訖
    assert chunks[0].startswith("第0句")


def test_chunk_text_invalid_params():
    with pytest.raises(ValueError):
        chunk_text("x", size=0)
    with pytest.raises(ValueError):
        chunk_text("x", size=100, overlap=100)


# ----------------------------- compute_confidence -----------------------------
def test_confidence_empty_is_zero():
    assert compute_confidence([]) == 0.0


def test_confidence_takes_top_score():
    assert compute_confidence([{"score": 0.3}, {"score": 0.82}, {"score": 0.5}]) == 0.82


def test_confidence_clamped():
    assert compute_confidence([{"score": 1.9}]) == 1.0
    assert compute_confidence([{"score": -0.4}]) == 0.0


# ----------------------------- rag.retrieve -----------------------------
def _result(rows):
    r = MagicMock()
    r.all.return_value = rows
    return r


@pytest.mark.asyncio
async def test_retrieve_merges_and_sorts_by_score():
    tenant_id = uuid.uuid4()
    doc = SimpleNamespace(
        id=uuid.uuid4(), content="文件片段", collection_id=uuid.uuid4(), title="標題", source_ref={"file": "a.txt"}
    )
    qa = SimpleNamespace(id=uuid.uuid4(), answer="QA 答案", collection_id=uuid.uuid4(), question="問題?")

    db = MagicMock()
    # 第一次 execute → Document(距離 0.5→分 0.5);第二次 → QAPair(距離 0.1→分 0.9)
    db.execute = AsyncMock(side_effect=[_result([(doc, 0.5)]), _result([(qa, 0.1)])])

    with patch("app.services.rag.embed_texts", new=AsyncMock(return_value=[[0.1] * 384])):
        hits = await rag.retrieve(db, tenant_id, "查詢", top_k=5)

    assert len(hits) == 2
    # QA 分數較高應排前
    assert hits[0]["content"] == "QA 答案"
    assert hits[0]["score"] == 0.9
    assert hits[0]["source_ref"]["type"] == "qa"
    assert hits[1]["source_ref"]["type"] == "document"
    assert hits[1]["source_ref"]["file"] == "a.txt"


@pytest.mark.asyncio
async def test_retrieve_empty_query_returns_empty():
    db = MagicMock()
    db.execute = AsyncMock()
    hits = await rag.retrieve(db, uuid.uuid4(), "   ", top_k=5)
    assert hits == []
    db.execute.assert_not_called()


# ----------------------------- dispatch.handle_inbound -----------------------------
def _cfg(threshold=0.55, handoff=True):
    return EffectiveConfig(
        provider="openai",
        model="gpt-5.5",
        api_key="k",
        system_prompt=None,
        confidence_threshold=threshold,
        handoff_enabled=handoff,
    )


@pytest.mark.asyncio
async def test_dispatch_ignored_when_human_owned():
    db = MagicMock()
    session = SimpleNamespace(handler_type="human")
    with patch("app.services.dispatch._load_session", new=AsyncMock(return_value=session)):
        out = await dispatch.handle_inbound(db, uuid.uuid4(), uuid.uuid4(), uuid.uuid4())
    assert out["status"] == "ignored"
    assert out["reason"] == "handled_by_human"


@pytest.mark.asyncio
async def test_dispatch_replies_on_high_confidence():
    db = MagicMock()
    db.add = MagicMock()
    db.flush = AsyncMock()
    session = SimpleNamespace(handler_type="ai", handler_staff_id=None)
    inbound = SimpleNamespace(content="請問營業時間?")

    gen = AsyncMock(return_value={"answer": "早上9點到晚上6點", "confidence": 0.88, "sources": [{"index": 1}]})
    with patch("app.services.dispatch._load_session", new=AsyncMock(return_value=session)), \
         patch("app.services.dispatch._load_message", new=AsyncMock(return_value=inbound)), \
         patch("app.services.dispatch.resolve_config", new=AsyncMock(return_value=_cfg())), \
         patch("app.services.dispatch.generate_answer", new=gen):
        out = await dispatch.handle_inbound(db, uuid.uuid4(), uuid.uuid4(), uuid.uuid4())

    assert out["status"] == "replied"
    assert out["confidence"] == 0.88
    # 高信心不轉人
    assert session.handler_type == "ai"
    # 有把 AI 訊息寫入(降級為本地 ORM insert)
    assert db.add.called


@pytest.mark.asyncio
async def test_dispatch_handoff_on_low_confidence():
    db = MagicMock()
    db.add = MagicMock()
    db.flush = AsyncMock()
    session = SimpleNamespace(handler_type="ai", handler_staff_id=uuid.uuid4())
    inbound = SimpleNamespace(content="很冷門的問題")

    gen = AsyncMock(return_value={"answer": "草稿", "confidence": 0.12, "sources": []})
    with patch("app.services.dispatch._load_session", new=AsyncMock(return_value=session)), \
         patch("app.services.dispatch._load_message", new=AsyncMock(return_value=inbound)), \
         patch("app.services.dispatch.resolve_config", new=AsyncMock(return_value=_cfg(threshold=0.55))), \
         patch("app.services.dispatch.generate_answer", new=gen):
        out = await dispatch.handle_inbound(db, uuid.uuid4(), uuid.uuid4(), uuid.uuid4())

    assert out["status"] == "handoff"
    # 低信心 → 轉人
    assert session.handler_type == "human"
    assert session.handler_staff_id is None


@pytest.mark.asyncio
async def test_dispatch_ignored_when_no_content():
    db = MagicMock()
    session = SimpleNamespace(handler_type="ai")
    with patch("app.services.dispatch._load_session", new=AsyncMock(return_value=session)), \
         patch("app.services.dispatch._load_message", new=AsyncMock(return_value=None)):
        out = await dispatch.handle_inbound(db, uuid.uuid4(), uuid.uuid4(), None)
    assert out["status"] == "ignored"
    assert out["reason"] == "no_inbound_content"
