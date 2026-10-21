"""Google Gemini(generativelanguage)provider(BYO-Key 多供應商的一員)。

對接 ``POST {base_url}/models/{model}:generateContent``(預設 base_url
``https://generativelanguage.googleapis.com/v1beta``)。金鑰以 ``x-goog-api-key``
標頭傳遞(Gemini 官方支援,等同 ``?key=`` 查詢字串,但不把金鑰寫進 URL / 日誌,
較安全)。

通用 ``ChatMessage`` 轉成 Gemini 格式:system → ``systemInstruction``;user →
role ``user``、assistant → role ``model``,內容包成 ``parts:[{text}]``。常見生成
參數(temperature / top_p / top_k / max_tokens / stop)收攏進 ``generationConfig``。

回應型別對齊 ``openai_provider``:``chat`` 回完整字串、``stream`` 逐段 yield 字串
增量。金鑰 / 模型 / base_url 皆由呼叫端注入,不自行讀 settings(逾時除外,沿用既有
設定以對齊行為)。Gemini 的 embedding 走不同端點,此處 ``embed`` 明確拋錯。
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx

from app.core.config import settings
from app.services.llm.base import ChatMessage, LLMProvider

# 通用生成參數 → Gemini generationConfig 的鍵名對映。
_GEN_CONFIG_MAP = {
    "temperature": "temperature",
    "top_p": "topP",
    "topP": "topP",
    "top_k": "topK",
    "topK": "topK",
    "max_tokens": "maxOutputTokens",
    "max_output_tokens": "maxOutputTokens",
    "maxOutputTokens": "maxOutputTokens",
    "stop": "stopSequences",
    "stop_sequences": "stopSequences",
    "stopSequences": "stopSequences",
}


class GeminiProvider(LLMProvider):
    def __init__(self, api_key: str | None, base_url: str | None = None) -> None:
        # 金鑰 / base_url 由呼叫端注入;base_url 可覆寫以支援自架 / 代理。
        self.api_key = api_key
        self.base_url = (
            base_url or "https://generativelanguage.googleapis.com/v1beta"
        ).rstrip("/")

    def _headers(self) -> dict:
        # 用標頭傳金鑰(避免寫進 URL 查詢字串);等同官方 ?key= 認證。
        return {"x-goog-api-key": self.api_key or "", "Content-Type": "application/json"}

    @staticmethod
    def _convert(messages: list[ChatMessage]) -> tuple[dict | None, list[dict]]:
        """把通用訊息拆成 (systemInstruction, contents 陣列)。

        - role == system → systemInstruction.parts(多段以換行連接)。
        - role == assistant → role ``model``;其餘(user/tool/未知)→ ``user``。
        """
        system_parts: list[str] = []
        contents: list[dict] = []
        for m in messages:
            if m.role == "system":
                system_parts.append(m.content)
                continue
            role = "model" if m.role == "assistant" else "user"
            contents.append({"role": role, "parts": [{"text": m.content}]})
        system_instruction = (
            {"parts": [{"text": "\n".join(system_parts)}]} if system_parts else None
        )
        return system_instruction, contents

    def _build_payload(self, messages: list[ChatMessage], **kw) -> dict:
        system_instruction, contents = self._convert(messages)
        payload: dict = {"contents": contents}
        if system_instruction:
            payload["systemInstruction"] = system_instruction
        # 允許呼叫端直接給 generationConfig;再把已知的通用參數併入。
        gen_config: dict = dict(
            kw.pop("generationConfig", None) or kw.pop("generation_config", None) or {}
        )
        for key, value in list(kw.items()):
            mapped = _GEN_CONFIG_MAP.get(key)
            if mapped is not None:
                gen_config[mapped] = value
        if gen_config:
            payload["generationConfig"] = gen_config
        return payload

    @staticmethod
    def _extract_text(data: dict) -> str:
        """串接第一個 candidate 內 content.parts 的所有 text。"""
        candidates = data.get("candidates") or []
        if not candidates:
            return ""
        parts = (candidates[0].get("content") or {}).get("parts") or []
        return "".join(
            p.get("text", "") for p in parts if isinstance(p, dict) and p.get("text")
        )

    async def chat(self, messages: list[ChatMessage], *, model: str, **kw) -> str:
        payload = self._build_payload(messages, **kw)
        url = f"{self.base_url}/models/{model}:generateContent"
        async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as c:
            r = await c.post(url, json=payload, headers=self._headers())
            r.raise_for_status()
            return self._extract_text(r.json())

    async def stream(self, messages: list[ChatMessage], *, model: str, **kw) -> AsyncIterator[str]:
        payload = self._build_payload(messages, **kw)
        # SSE 串流端點;alt=sse 讓回應以 `data: {json}` 逐行輸出。
        url = f"{self.base_url}/models/{model}:streamGenerateContent?alt=sse"
        async with httpx.AsyncClient(timeout=None) as c:
            async with c.stream("POST", url, json=payload, headers=self._headers()) as r:
                r.raise_for_status()
                async for line in r.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    try:
                        text = self._extract_text(json.loads(data))
                    except Exception:
                        continue
                    if text:
                        yield text

    async def embed(self, texts: list[str], *, model: str) -> list[list[float]]:
        raise NotImplementedError(
            "Gemini embeddings use a separate endpoint; use app.services.embedding (local)."
        )
