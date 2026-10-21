"""Email 渠道共用例外(避免 imap/smtp/parser 互相 import 造成循環)。"""
from __future__ import annotations


class EmailError(RuntimeError):
    """IMAP / SMTP 連線、登入、收發或解析失敗時拋出。

    收信輪詢與出站發信都以此為統一失敗訊號:上層一律 try/except 降級,不讓
    單封信或單一渠道的問題拖垮整個管線。
    """
