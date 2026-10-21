"""Unified API response envelope: { ok, data, error, request_id }.

request_id 來源:由 `app.main` 的 RequestIDMiddleware 於每個請求生成,寫入一個
contextvar(見下)。ok()/err() 在呼叫端未顯式傳入 request_id 時,自動從該
contextvar 讀取並填入信封,讓所有端點與例外處理器產生的信封都帶上同一個
關聯 ID(同時也會在回應標頭 X-Request-Id 回傳)。無請求上下文時(如單元測試
直接呼叫 ok/err)則為 None,行為與過去一致。
"""
from __future__ import annotations

import contextvars
from typing import Any

# 每請求的關聯 ID。middleware 於請求進入時 set、離開時 reset;
# ok()/err() 在未顯式帶 request_id 時讀取它,故不需改動既有各端點呼叫。
_request_id_ctx: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "kefu_request_id", default=None
)


def set_request_id(request_id: str | None):
    """設定當前請求的 request_id,回傳 token 供稍後 reset。"""
    return _request_id_ctx.set(request_id)


def reset_request_id(token) -> None:
    """還原 request_id contextvar(請求結束時呼叫,避免跨請求殘留)。"""
    _request_id_ctx.reset(token)


def current_request_id() -> str | None:
    """取得當前請求的 request_id(無上下文時為 None)。"""
    return _request_id_ctx.get()


def ok(data: Any = None, request_id: str | None = None) -> dict[str, Any]:
    if request_id is None:
        request_id = _request_id_ctx.get()
    return {"ok": True, "data": data, "error": None, "request_id": request_id}


def err(code: str, message: str, request_id: str | None = None) -> dict[str, Any]:
    if request_id is None:
        request_id = _request_id_ctx.get()
    return {"ok": False, "data": None, "error": {"code": code, "message": message}, "request_id": request_id}
