"""Embedding service — local by default (fastembed), pluggable per tenant.

The dev LLM endpoint has no embedding model, so RAG embeds locally with a small
multilingual model. Dimension must match settings.embedding_dim and the pgvector
column (app.models.knowledge.EMBED_DIM).
"""
from __future__ import annotations

from functools import lru_cache

from app.core.config import settings


@lru_cache
def _local_model():
    # Imported lazily so the dependency is only needed when local embedding is used.
    from fastembed import TextEmbedding

    return TextEmbedding(model_name=settings.embedding_model)


async def _embed_openai(texts: list[str]) -> list[list[float]]:
    """用 OpenAI 相容 embeddings API 產生向量。

    金鑰與端點沿用 settings(與 app.services.llm.openai_provider 同一組):
    - ``settings.openai_api_key``  → ``Authorization: Bearer`` 標頭
    - ``settings.openai_base_url`` → POST ``{base_url}/embeddings``
    - ``settings.embedding_model`` → 要求的 embedding 模型名

    回傳前會校驗每條向量維度需與 ``settings.embedding_dim``(即 pgvector 欄位維度,
    見 app.models.knowledge.EMBED_DIM)一致;對不上會明確報錯,避免寫入/檢索出錯。
    """
    import httpx

    if not settings.openai_api_key:
        raise RuntimeError(
            "embedding_provider=openai 需設定 KEFU_OPENAI_API_KEY(見中央金鑰表)"
        )

    base_url = settings.openai_base_url.rstrip("/")
    headers = {
        "Authorization": f"Bearer {settings.openai_api_key}",
        "Content-Type": "application/json",
    }
    payload = {"model": settings.embedding_model, "input": texts}
    async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as client:
        resp = await client.post(f"{base_url}/embeddings", json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    # OpenAI embeddings 回傳的 data 陣列不保證與輸入同序,需依 index 還原
    items = sorted(data["data"], key=lambda item: item["index"])
    vectors = [item["embedding"] for item in items]

    # 維度校驗:與 settings.embedding_dim / pgvector 欄位必須一致,否則入庫或檢索必錯
    for vec in vectors:
        if len(vec) != settings.embedding_dim:
            raise ValueError(
                f"openai embedding 維度不符:得到 {len(vec)},預期 {settings.embedding_dim} "
                f"(model={settings.embedding_model});請調整 KEFU_EMBEDDING_DIM 或改用相符的模型"
            )
    return vectors


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """Return embeddings for a batch of texts using the configured provider."""
    if settings.embedding_provider == "local":
        model = _local_model()
        return [vec.tolist() for vec in model.embed(texts)]
    if settings.embedding_provider == "openai":
        return await _embed_openai(texts)
    raise NotImplementedError(f"embedding_provider not implemented: {settings.embedding_provider}")
