"""RAG 檢索 seam(M6/M7 核心對外契約)。

    async def retrieve(db, tenant_id, query, top_k=5) -> list[dict]

用 app.services.embedding.embed_texts 產生查詢向量,對 Document / QAPair 的
pgvector 欄位做 cosine 相似度檢索(`<=>`),回 [{content, source_ref, score}]。
score 為 cosine 相似度(1 - 距離),越高越相關。所有查詢以 tenant_id 過濾。
"""
from __future__ import annotations

import logging
import os
import uuid

from sqlalchemy import select

from app.models.knowledge import Document, KnowledgeCollection, QAPair
from app.services.embedding import embed_texts

logger = logging.getLogger("kefu.rag")

# 命中記錄:查詢字串截斷長度(避免存入過長 blob),與每次檢索最多記錄的命中片段數。
_HIT_QUERY_MAX = 500
_HIT_TOP_N = 5


def _hit_min_score() -> float:
    """「算得上命中」的最低 cosine 相似度門檻(score 為 1−距離,越高越相關)。

    先前以 ``score > 0`` 判命中,幾乎任何檢索都會回傳低相似度片段 → hit_rate 恆 ≈ 1.0,
    失去分析意義。改以門檻過濾:相似度低於門檻視為「未達相關」,計入未命中分母。
    可用環境變數 ``KEFU_RAG_HIT_MIN_SCORE`` 覆寫(不同嵌入模型的相似度分佈不同,便於調校)。
    預設 0.3:低相似度雜訊不算命中,又不過度嚴苛。
    """
    try:
        v = float(os.getenv("KEFU_RAG_HIT_MIN_SCORE", "0.3"))
    except (TypeError, ValueError):
        return 0.3
    # NaN 防呆:min/max 對 NaN 會傳回 NaN,而 `score >= NaN` 恆為 False?否——`>=`
    # 對 NaN 恆 False 會讓一切變未命中;但更糟的是若寫成 `NaN` 落到 0.0 側則一切命中。
    # 直接以預設值取代,避免任何 NaN 語意分歧。
    if v != v:  # NaN
        return 0.3
    # 夾到 [0,1]:score 已 clamp 在此區間,門檻超出範圍無意義。
    return min(1.0, max(0.0, v))


async def retrieve(
    db,
    tenant_id,
    query: str,
    top_k: int = 5,
    collection_ids: list | None = None,
    session_id=None,
) -> list[dict]:
    """對租戶知識庫做語意檢索,回相關片段(含來源與分數)。

    - Document 與 QAPair 兩表分別檢索後合併,依相似度取前 top_k。
    - collection_ids 非空時,只在指定知識庫內檢索;否則檢索全租戶。
    - 忽略未嵌入(embedding is null)與已軟刪除的列(含所屬集合已軟刪者:
      集合被軟刪後,其 document/QA 一律不得再被 AI 檢索引用)。
    - session_id 為選填的會話關聯,僅用於命中記錄(KBHit);不影響檢索結果。

    另:實際跑過向量檢索後(非空查詢/可嵌入),把命中的 top 片段(或零命中標記)
    寫入 KBHit 供「知識庫使用分析」。此寫入為旁路遙測,走獨立 session + try/except,
    任何失敗都不影響本函式的回傳(零回歸)。見 _record_hits。
    """
    query = (query or "").strip()
    if not query or top_k <= 0:
        return []

    vectors = await embed_texts([query])
    if not vectors:
        return []
    qvec = vectors[0]

    results: list[dict] = []

    # --- Document 檢索 ---
    # join KnowledgeCollection 並濾其 deleted_at:所屬集合被軟刪的文件片段
    # 不得再被檢索/引用(單一查詢內完成,不額外多打一次 DB)。
    doc_dist = Document.embedding.cosine_distance(qvec).label("dist")
    doc_stmt = (
        select(Document, doc_dist)
        .join(KnowledgeCollection, KnowledgeCollection.id == Document.collection_id)
        .where(
            Document.tenant_id == tenant_id,
            Document.deleted_at.is_(None),
            Document.embedding.is_not(None),
            KnowledgeCollection.deleted_at.is_(None),
        )
    )
    if collection_ids:
        doc_stmt = doc_stmt.where(Document.collection_id.in_(collection_ids))
    doc_stmt = doc_stmt.order_by(doc_dist).limit(top_k)
    for doc, dist in (await db.execute(doc_stmt)).all():
        results.append(
            {
                "content": doc.content,
                "source_ref": {
                    "type": "document",
                    "document_id": str(doc.id),
                    "collection_id": str(doc.collection_id),
                    "title": doc.title,
                    **(doc.source_ref or {}),
                },
                "score": _to_score(dist),
            }
        )

    # --- QAPair 檢索(嵌入的是問題,回覆用答案) ---
    # 同 Document:所屬集合軟刪的 QA 不得再被檢索/引用。
    qa_dist = QAPair.embedding.cosine_distance(qvec).label("dist")
    qa_stmt = (
        select(QAPair, qa_dist)
        .join(KnowledgeCollection, KnowledgeCollection.id == QAPair.collection_id)
        .where(
            QAPair.tenant_id == tenant_id,
            QAPair.deleted_at.is_(None),
            QAPair.embedding.is_not(None),
            KnowledgeCollection.deleted_at.is_(None),
        )
    )
    if collection_ids:
        qa_stmt = qa_stmt.where(QAPair.collection_id.in_(collection_ids))
    qa_stmt = qa_stmt.order_by(qa_dist).limit(top_k)
    for qa, dist in (await db.execute(qa_stmt)).all():
        results.append(
            {
                "content": qa.answer,
                "source_ref": {
                    "type": "qa",
                    "qa_pair_id": str(qa.id),
                    "collection_id": str(qa.collection_id),
                    "question": qa.question,
                },
                "score": _to_score(dist),
            }
        )

    # 合併後依相似度由高到低取前 top_k
    results.sort(key=lambda r: r["score"], reverse=True)
    final = results[:top_k]

    # 命中記錄(旁路;失敗不影響檢索結果)。只在實際跑過向量檢索的路徑記錄:
    # 空查詢 / 無法嵌入的早退不計為「檢索事件」。
    try:
        await _record_hits(tenant_id, query, final, session_id)
    except Exception:  # noqa: BLE001  雙重保險:_record_hits 內部已吞例外
        logger.debug("KBHit 記錄失敗(已忽略)", exc_info=True)

    return final


def _to_score(distance) -> float:
    """cosine 距離(0~2)轉相似度(1 - 距離),clamp 到 [0,1] 便於比較。"""
    try:
        sim = 1.0 - float(distance)
    except (TypeError, ValueError):
        return 0.0
    return round(max(0.0, min(1.0, sim)), 4)


def _as_uuid(v):
    """把來源 ref 內的 id 字串安全轉 UUID;非法/None 一律回 None(不拋)。"""
    if v is None:
        return None
    if isinstance(v, uuid.UUID):
        return v
    try:
        return uuid.UUID(str(v))
    except (ValueError, TypeError, AttributeError):
        return None


async def _record_hits(tenant_id, query: str, results: list[dict], session_id=None) -> None:
    """把一次檢索的命中片段寫入 KBHit(知識庫使用分析用)。

    零回歸保證:
    - 全程 try/except,任何失敗(模型不可用/表未建/DB 故障/型別)都完全吞掉。
    - 使用「獨立 session」(app.core.db.SessionLocal),不碰呼叫端傳入的 db /
      其交易,故即使寫入失敗也不會污染檢索主流程的 session。
    - 批次 add_all + 單次 commit,無 N+1。

    記錄規則:
    - 有命中(score ≥ 相關門檻,見 _hit_min_score):取前 _HIT_TOP_N 片段各一列
      (document 或 qa,連同 collection)。
    - 零命中 / 全部低於門檻:記一列標記(FK 皆 null、score null),作為命中率分母的
      「未命中事件」。
    - 同批列共用同一 occurred_at,作為「一次檢索事件」的分組鍵。
    """
    try:
        from datetime import UTC, datetime

        from app.core.db import SessionLocal
        from app.models.kb_analytics import KBHit

        q = (query or "").strip()[:_HIT_QUERY_MAX]
        if not q:
            return
        sid = _as_uuid(session_id)
        occurred_at = datetime.now(UTC)

        min_score = _hit_min_score()
        top = [r for r in results if float(r.get("score") or 0.0) >= min_score][:_HIT_TOP_N]
        rows: list = []
        if top:
            for r in top:
                ref = r.get("source_ref") or {}
                rows.append(
                    KBHit(
                        tenant_id=tenant_id,
                        collection_id=_as_uuid(ref.get("collection_id")),
                        document_id=_as_uuid(ref.get("document_id")),
                        qa_id=_as_uuid(ref.get("qa_pair_id")),
                        query=q,
                        score=float(r.get("score") or 0.0),
                        session_id=sid,
                        occurred_at=occurred_at,
                    )
                )
        else:
            # 未命中事件:query 有值但無任何片段,記一列(FK/score 皆 null)。
            rows.append(
                KBHit(
                    tenant_id=tenant_id,
                    query=q,
                    score=None,
                    session_id=sid,
                    occurred_at=occurred_at,
                )
            )

        async with SessionLocal() as s:
            s.add_all(rows)
            await s.commit()
    except Exception:  # noqa: BLE001
        # 命中記錄純為遙測,任何錯誤都不得影響檢索;僅在 debug 記錄。
        logger.debug("KBHit 寫入失敗(已忽略)", exc_info=True)
