"""提示詞組裝:把 RAG 取回的知識拼成帶引用的 LLM 訊息。

反幻覺設計:知識以編號 [1][2]... 列出,並指示模型只依知識作答、標註引用來源,
資訊不足時明講,不得編造。
"""
from __future__ import annotations

from app.services.llm.base import ChatMessage

_DEFAULT_SYSTEM = (
    "你是專業、友善的客服助理。只依據下方提供的『知識庫片段』回答問題。"
    "回答時可用 [編號] 標註引用來源。若片段無法回答,請誠實說明資訊不足,不要編造。"
)


def _format_knowledge(knowledge: list[dict]) -> str:
    """把知識片段格式化為帶編號的引用區塊。"""
    if not knowledge:
        return "(無可用知識庫片段)"
    lines = []
    for i, item in enumerate(knowledge, start=1):
        content = (item.get("content") or "").strip()
        lines.append(f"[{i}] {content}")
    return "\n\n".join(lines)


def build_messages(
    query: str,
    knowledge: list[dict],
    *,
    system_prompt: str | None = None,
    history: list[dict] | None = None,
) -> list[ChatMessage]:
    """組裝送給 LLM 的訊息序列。

    - system_prompt:租戶自訂人格;None 用預設。
    - history:可選的近期對話 [{role, content}],role ∈ system|user|assistant。
    - 知識庫片段以獨立 system 訊息注入,末尾放使用者問題。
    """
    messages: list[ChatMessage] = [ChatMessage(role="system", content=system_prompt or _DEFAULT_SYSTEM)]
    messages.append(
        ChatMessage(
            role="system",
            content="以下是可用的知識庫片段(僅供作答依據):\n\n" + _format_knowledge(knowledge),
        )
    )
    for turn in history or []:
        role = turn.get("role", "user")
        if role not in ("system", "user", "assistant"):
            role = "user"
        messages.append(ChatMessage(role=role, content=turn.get("content", "")))
    messages.append(ChatMessage(role="user", content=query))
    return messages
