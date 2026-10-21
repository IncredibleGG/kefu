"""Anthropic Messages API provider(BYO-Key 多供應商的一員)。

對接 ``POST {base_url}/messages``(預設 ``https://api.anthropic.com/v1``),
用 ``x-api-key`` + ``anthropic-version`` 認證。通用 ``ChatMessage``(role
system/user/assistant/tool)轉成 Anthropic 格式:system 併入獨立的 ``system``
欄位,其餘進 ``messages`` 陣列(僅 user/assistant 兩種角色)。

回應型別對齊 ``openai_provider``:``chat`` 回完整字串、``stream`` 逐段 yield
字串增量。金鑰 / 模型 / base_url 皆由呼叫端注入,不自行讀 settings(逾時除外,
沿用既有設定以對齊行為)。Anthropic 無 embedding API,``embed`` 明確拋錯。
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx

from app.core.config import settings
from app.services.llm.base import ChatMessage, LLMProvider

# Anthropic Messages API 版本標頭(必填)。
_ANTHROPIC_VERSION = "2023-06-01"
# Messages API 必填 max_tokens;呼叫端未指定時的預設上限。
_DEFAULT_MAX_TOKENS = 4096


class AnthropicProvider(LLMProvider):
    def __init__(self, api_key: str | None, base_url: str | None = None) -> None:
        # 金鑰 / base_url 由呼叫端注入;base_url 可覆寫以支援自架 / 代理。
        self.api_key = api_key
        self.base_url = (base_url or "https://api.anthropic.com/v1").rstrip("/")

    def _headers(self) -> dict:
        return {
            "x-api-key": self.api_key or "",
            "anthropic-version": _ANTHROPIC_VERSION,
            "Content-Type": "application/json",
        }

    @staticmethod
    def _convert(messages: list[ChatMessage]) -> tuple[str | None, list[dict]]:
        """把通用訊息拆成 (system 文字, Anthropic messages 陣列)。

        - role == system → 併入 system 欄位(多段以換行連接)。
        - role == assistant → assistant;其餘(user/tool/未知)→ user。
        - content 用純字串(Anthropic 接受字串或 block 陣列,字串最簡)。
        """
        system_parts: list[str] = []
        converted: list[dict] = []
        for m in messages:
            if m.role == "system":
                system_parts.append(m.content)
                continue
            role = "assistant" if m.role == "assistant" else "user"
            converted.append({"role": role, "content": m.content})
        system = "\n".join(system_parts) if system_parts else None
        return system, converted

    def _build_payload(self, messages: list[ChatMessage], *, model: str, **kw) -> dict:
        system, converted = self._convert(messages)
        payload: dict = {
            "model": model,
            "messages": converted,
            # max_tokens 為 Anthropic 必填;允許呼叫端以 kw 覆寫。
            "max_tokens": kw.pop("max_tokens", _DEFAULT_MAX_TOKENS),
            **kw,
        }
        if system:
            payload["system"] = system
        return payload

    @staticmethod
    def _extract_text(data: dict) -> str:
        """把回應 content(block 陣列)中的 text block 串接成完整字串。"""
        parts = [
            block.get("text", "")
            for block in data.get("content", [])
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        return "".join(parts)

    async def chat(self, messages: list[ChatMessage], *, model: str, **kw) -> str:
        payload = self._build_payload(messages, model=model, **kw)
        async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as c:
            r = await c.post(f"{self.base_url}/messages", json=payload, headers=self._headers())
            r.raise_for_status()
            return self._extract_text(r.json())

    async def stream(self, messages: list[ChatMessage], *, model: str, **kw) -> AsyncIterator[str]:
        payload = self._build_payload(messages, model=model, **kw)
        payload["stream"] = True
        async with httpx.AsyncClient(timeout=None) as c:
            async with c.stream(
                "POST", f"{self.base_url}/messages", json=payload, headers=self._headers()
            ) as r:
                r.raise_for_status()
                async for line in r.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    try:
                        evt = json.loads(data)
                    except Exception:
                        continue
                    # 只取文字增量事件:content_block_delta + text_delta。
                    if evt.get("type") == "content_block_delta":
                        delta = evt.get("delta") or {}
                        if delta.get("type") == "text_delta":
                            text = delta.get("text")
                            if text:
                                yield text

    async def embed(self, texts: list[str], *, model: str) -> list[list[float]]:
        raise NotImplementedError(
            "Anthropic has no embedding API; use app.services.embedding (local)."
        )
