"""郵件解析(乾淨室,僅用 Python 標準庫 email)。

把 IMAP 抓下來的原始 RFC822 位元組解析為渠道無關的 ``ParsedEmail``:
- 寄件人 email 與顯示名(headers 可能為 MIME encoded-word,一律解碼)。
- 主旨(同樣解碼)。
- 內文:純文字優先;只有 HTML 時退而求其次去標籤;並「最佳努力」去除回覆引言。

解析採防禦式:任何單一欄位失敗都退化為安全值,不整封拋錯(由呼叫端決定)。
"""
from __future__ import annotations

import html as _html
import re
from dataclasses import dataclass
from email import message_from_bytes
from email.header import decode_header, make_header
from email.message import Message
from email.utils import parseaddr


@dataclass
class ParsedEmail:
    """解析後的入站郵件(渠道無關)。"""

    from_email: str  # 寄件人信箱(當入站 external_id 用)
    from_name: str | None  # 寄件人顯示名(當 visitor.display_name 用)
    subject: str
    body: str  # 純文字內文(已最佳努力去引言)
    message_id: str | None


# 常見「引言分隔」標記:命中即視為其後皆為被引用的歷史,截斷之(最佳努力)。
_QUOTE_MARKERS = (
    re.compile(r"^\s*On .+ wrote:\s*$", re.IGNORECASE),
    re.compile(r"^\s*-{2,}\s*Original Message\s*-{2,}", re.IGNORECASE),
    re.compile(r"^\s*發件人[:：]"),
    re.compile(r"^\s*寄件者[:：]"),
    re.compile(r"^\s*在.+(寫道|撰寫)[:：]?\s*$"),
    re.compile(r"^_{5,}\s*$"),
)


def _decode_header(value: str | None) -> str:
    """解碼 MIME encoded-word 標頭(=?utf-8?...?=),失敗則原樣回傳。"""
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value))).strip()
    except Exception:
        return value.strip()


def _strip_html(raw: str) -> str:
    """把 HTML 內文最佳努力轉為純文字(去 script/style、換行保留、去標籤、解實體)。"""
    raw = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<br\s*/?>", "\n", raw)
    raw = re.sub(r"(?i)</(p|div|li|tr|h[1-6])>", "\n", raw)
    raw = re.sub(r"(?s)<[^>]+>", " ", raw)
    raw = _html.unescape(raw)
    lines = [ln.strip() for ln in raw.splitlines()]
    return "\n".join(ln for ln in lines if ln)


def _decode_payload(part: Message) -> str:
    """把單一 part 的 payload 解碼成字串,charset 未知或非法時退回 utf-8。"""
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except (LookupError, TypeError):
        return payload.decode("utf-8", errors="replace")


def _extract_body(msg: Message) -> str:
    """抽出內文:純文字優先;僅 HTML 時去標籤。"""
    plain: str | None = None
    html: str | None = None

    if msg.is_multipart():
        for part in msg.walk():
            if part.is_multipart():
                continue
            disposition = str(part.get("Content-Disposition") or "").lower()
            if "attachment" in disposition:
                continue
            ctype = part.get_content_type()
            if ctype == "text/plain" and plain is None:
                plain = _decode_payload(part)
            elif ctype == "text/html" and html is None:
                html = _decode_payload(part)
    else:
        text = _decode_payload(msg)
        if msg.get_content_type() == "text/html":
            html = text
        else:
            plain = text

    if plain is not None and plain.strip():
        return plain
    if html is not None and html.strip():
        return _strip_html(html)
    return plain or ""


def strip_quotes(text: str) -> str:
    """最佳努力去除回覆引言:丟棄 `>` 開頭行,遇引言標記即截斷其後內容。

    若因此把內文清空(整封都是引言/標記),則保留原文避免丟失。
    """
    kept: list[str] = []
    for line in text.splitlines():
        if line.lstrip().startswith(">"):
            continue
        if any(pat.match(line) for pat in _QUOTE_MARKERS):
            break
        kept.append(line)
    result = "\n".join(kept).strip()
    return result or text.strip()


def parse_email(raw: bytes) -> ParsedEmail:
    """把原始 RFC822 位元組解析為 ``ParsedEmail``。"""
    msg = message_from_bytes(raw)

    from_name, from_email = parseaddr(msg.get("From", ""))
    from_name = _decode_header(from_name) or None
    from_email = (from_email or "").strip().lower()

    subject = _decode_header(msg.get("Subject"))
    body = strip_quotes(_extract_body(msg))
    message_id = (msg.get("Message-ID") or "").strip() or None

    return ParsedEmail(
        from_email=from_email,
        from_name=from_name,
        subject=subject,
        body=body,
        message_id=message_id,
    )
