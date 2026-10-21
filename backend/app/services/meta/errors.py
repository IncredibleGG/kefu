"""Meta(WhatsApp Cloud API / Facebook Send API)子套件的統一例外。"""
from __future__ import annotations


class MetaError(RuntimeError):
    """Graph API 回傳 error,或 HTTP / 解析層錯誤時拋出。

    出站 adapter 會捕捉此例外並降級(只 log 不向上拋),避免拖垮 dispatch。
    """

    def __init__(
        self, message: str, *, code: int | None = None, http_status: int | None = None
    ) -> None:
        super().__init__(message)
        self.description = message
        self.code = code
        self.http_status = http_status
