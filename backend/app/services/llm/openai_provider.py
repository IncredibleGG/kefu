"""OpenAI-compatible chat provider (works against any OpenAI-compatible endpoint/proxy).

Embeddings are NOT provided here — the proxy has no embedding model; use
app.services.embedding instead. `embed` raises to make that explicit.
"""
from __future__ import annotations

from collections.abc import AsyncIterator

import httpx

from app.core.config import settings
from app.services.llm.base import ChatMessage, LLMProvider


class OpenAIProvider(LLMProvider):
    def __init__(self, api_key: str | None, base_url: str | None = None) -> None:
        self.api_key = api_key or settings.openai_api_key
        self.base_url = (base_url or settings.openai_base_url).rstrip("/")

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    async def chat(self, messages: list[ChatMessage], *, model: str, **kw) -> str:
        payload = {"model": model, "messages": [m.__dict__ for m in messages], **kw}
        async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as c:
            r = await c.post(f"{self.base_url}/chat/completions", json=payload, headers=self._headers())
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"]

    async def stream(self, messages: list[ChatMessage], *, model: str, **kw) -> AsyncIterator[str]:
        payload = {"model": model, "messages": [m.__dict__ for m in messages], "stream": True, **kw}
        async with httpx.AsyncClient(timeout=None) as c:
            async with c.stream(
                "POST", f"{self.base_url}/chat/completions", json=payload, headers=self._headers()
            ) as r:
                r.raise_for_status()
                async for line in r.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    import json

                    try:
                        delta = json.loads(data)["choices"][0]["delta"].get("content")
                        if delta:
                            yield delta
                    except Exception:
                        continue

    async def embed(self, texts: list[str], *, model: str) -> list[list[float]]:
        raise NotImplementedError(
            "This endpoint has no embedding model; use app.services.embedding (local)."
        )
