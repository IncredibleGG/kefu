"""LLM provider abstraction — the pluggable layer that enables BYO-Key.

Product requirement (護城河柱一): never hard-bind a single vendor. Each tenant
can supply its own provider + key via Tenant.llm_config; dev default is OpenAI.
Concrete providers live alongside this file (openai.py, anthropic.py, ...).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass


@dataclass
class ChatMessage:
    role: str  # system | user | assistant | tool
    content: str


class LLMProvider(ABC):
    """Minimal contract every provider implements."""

    @abstractmethod
    async def chat(self, messages: list[ChatMessage], *, model: str, **kw) -> str:
        """Return a full completion."""

    @abstractmethod
    def stream(self, messages: list[ChatMessage], *, model: str, **kw) -> AsyncIterator[str]:
        """Yield completion deltas for streaming to the widget/agent UI."""

    @abstractmethod
    async def embed(self, texts: list[str], *, model: str) -> list[list[float]]:
        """Return embeddings for RAG indexing/retrieval."""


def get_provider(name: str, api_key: str | None, base_url: str | None = None) -> LLMProvider:
    """Factory: resolve a provider by name (openai|anthropic|gemini|...).

    Import providers lazily so missing SDKs don't break unrelated modules.
    ``base_url`` 可覆寫供應商端點(自架 / 代理用);None 時各 provider 用預設。
    現有呼叫端以位置參數 (name, api_key) 呼叫,base_url 為向後相容的可選參數。
    """
    if name == "openai":
        from app.services.llm.openai_provider import OpenAIProvider

        return OpenAIProvider(api_key=api_key)
    if name == "anthropic":
        from app.services.llm.anthropic_provider import AnthropicProvider

        return AnthropicProvider(api_key=api_key, base_url=base_url)
    if name == "gemini":
        from app.services.llm.gemini_provider import GeminiProvider

        return GeminiProvider(api_key=api_key, base_url=base_url)
    raise NotImplementedError(f"LLM provider not implemented: {name}")
