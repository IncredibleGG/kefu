"""外部渠道入站媒體的共用下載/存檔工具(乾淨室、無新增第三方相依)。

背景:web widget 訪客上傳走 `storage.save_upload`;但 Telegram / WhatsApp /
Facebook 的入站媒體只拿得到「media id / 遠端 URL」,需由後端主動下載後才有本站
可存取的檔案。本模組提供該能力:

    download_and_store(url, *, headers=None, filename_hint=None) -> stored_url | None

- 用 httpx 串流下載外部媒體(邊讀邊累計大小,超限即中止,不整包載入惡意大檔)。
- 存進 `storage.upload_dir()`(**復用**既有上傳目錄),檔名 `<uuid_hex><ext>` 並寫一份
  `<檔名>.json` 側車 meta——**刻意沿用 `storage.py` 的命名與側車格式**,如此既有的
  `storage.resolve_file` 與 `/api/v1/channel/files/{id}` 取檔端點可原封不動服務這些檔。
- 基本安全:副檔名/型別白名單(圖片、文件、常見音訊/視訊)、單檔大小上限
  (`KEFU_MEDIA_MAX_BYTES`,預設 25MB);**SSRF 防護**:對真實外連(未注入 transport)
  於下載前及每次轉址後驗證目標主機解析出的 IP 均為公網,阻擋 loopback / 私網 /
  link-local(含雲端 metadata 169.254.169.254)等內網目標,並拒絕非 http/https;
  轉址改為關閉自動跟進、手動逐跳驗證。
- **失敗一律回 None、不拋例外**:呼叫端據此降級回佔位行為,絕不讓入站訊息路徑崩潰。

不修改 `storage.py`:只讀取它的 `upload_dir()` 與大小常數,其餘自理(依任務約束,
storage.py 若屬他人則以本模組自行處理擴充需求)。
"""
from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import uuid
from pathlib import Path
from urllib.parse import urljoin

import httpx

from app.services import storage
from app.services.ingest.net_guard import BlockedURLError, assert_url_public_async

logger = logging.getLogger("kefu.media_store")

# 手動逐跳跟進轉址的最大次數(關閉 httpx 自動轉址,改為每跳先驗證主機非私網,
# 避免媒體 URL 以 3xx 轉址到內網 / 雲端 metadata 繞過 SSRF 防護)。
_MAX_REDIRECTS = 5

# 對外可取檔的 URL 前綴(對應 channel.py 的 GET /api/v1/channel/files/{file_id},
# 由 storage.resolve_file 服務)。與該端點保持一致,勿隨意更動。
_PUBLIC_URL_PREFIX = "/api/v1/channel/files"

# 讀取分塊大小。
_CHUNK = 64 * 1024

# 單檔大小上限(可由環境變數覆寫);外部渠道媒體多半大於 web 上傳,預設放寬到 25MB。
_DEFAULT_MAX_BYTES = 25 * 1024 * 1024


def _max_bytes() -> int:
    raw = os.environ.get("KEFU_MEDIA_MAX_BYTES")
    if raw and raw.isdigit():
        return int(raw)
    return _DEFAULT_MAX_BYTES


# 入站媒體允許的副檔名(小寫、不含點)。較 storage 的上傳白名單多納入音訊/視訊,
# 以涵蓋 Telegram voice、WhatsApp audio/video 等入站型別。刻意不收 .svg(XSS 風險)。
_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "bmp"}
_DOC_EXTS = {
    "pdf", "txt", "csv", "md", "rtf",
    "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "zip", "rar", "7z",
}
_AUDIO_EXTS = {"ogg", "oga", "mp3", "m4a", "aac", "amr", "wav"}
_VIDEO_EXTS = {"mp4", "3gp", "mov", "webm", "mkv", "avi"}
_ALLOWED_EXTS = _IMAGE_EXTS | _DOC_EXTS | _AUDIO_EXTS | _VIDEO_EXTS

# content-type → 副檔名(優先於 mimetypes.guess_extension,避免拿到 .jpe 之類冷門值)。
_CT_TO_EXT = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
    "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp",
    "audio/ogg": "ogg", "audio/oga": "oga", "audio/mpeg": "mp3",
    "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr",
    "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
    "video/mp4": "mp4", "video/3gpp": "3gp", "video/quicktime": "mov",
    "video/webm": "webm", "video/x-matroska": "mkv",
    "application/pdf": "pdf",
}

# 副檔名安全清洗:僅保留英數、轉小寫、最長 8(對齊 storage.resolve_file 的 file_id 規則)。
_EXT_SANITIZE = re.compile(r"[^a-z0-9]")


def _norm_ct(content_type: str | None) -> str | None:
    """正規化 content-type:去參數(charset 等)、去空白、轉小寫。"""
    if not content_type or "/" not in content_type:
        return None
    return content_type.split(";", 1)[0].strip().lower() or None


def _sanitize_ext(ext: str | None) -> str | None:
    """把候選副檔名清洗成 [a-z0-9]{1,8};清洗後為空回 None。"""
    if not ext:
        return None
    cleaned = _EXT_SANITIZE.sub("", ext.lower())[:8]
    return cleaned or None


def _ext_from_name(filename_hint: str | None) -> str | None:
    if not filename_hint:
        return None
    return _sanitize_ext(Path(filename_hint).suffix.lstrip("."))


def _ext_from_ct(content_type: str | None) -> str | None:
    ct = _norm_ct(content_type)
    if not ct:
        return None
    if ct in _CT_TO_EXT:
        return _CT_TO_EXT[ct]
    guessed = mimetypes.guess_extension(ct)
    return _sanitize_ext(guessed.lstrip(".")) if guessed else None


def _pick_ext(
    filename_hint: str | None, content_type: str | None, content_type_hint: str | None
) -> str | None:
    """副檔名決策順序:檔名提示 → 回應 content-type → 型別提示。皆無回 None。"""
    for cand in (
        _ext_from_name(filename_hint),
        _ext_from_ct(content_type),
        _ext_from_ct(content_type_hint),
    ):
        if cand:
            return cand
    return None


def _pick_media_type(content_type: str | None, content_type_hint: str | None, ext: str) -> str:
    """media type 決策:回應 content-type → 型別提示 → 依副檔名推測 → 二進位流。"""
    for ct in (_norm_ct(content_type), _norm_ct(content_type_hint)):
        if ct:
            return ct
    guessed, _ = mimetypes.guess_type("x." + ext)
    return guessed or "application/octet-stream"


def _write_sidecar(dest: Path, filename: str, media_type: str) -> None:
    """寫 `<檔名>.json` 側車,格式對齊 storage,供 resolve_file 還原下載命名/型別。"""
    meta_path = dest.with_name(dest.name + ".json")
    try:
        meta_path.write_text(
            json.dumps({"filename": filename, "media_type": media_type}, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:  # 側車失敗不致命:取檔時可退回副檔名推測
        logger.warning("媒體側車 meta 寫入失敗(dest=%s)", dest.name, exc_info=True)


async def download_and_store(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    filename_hint: str | None = None,
    content_type_hint: str | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    timeout: float = 30.0,
) -> str | None:
    """下載外部媒體並存入本站上傳目錄,回傳本站可存取 URL;任何失敗回 None(不拋)。

    參數:
        url:外部媒體來源(Telegram file download URL / Graph 媒體 URL / FB 附件 URL)。
        headers:下載請求標頭(如 WhatsApp 需 ``Authorization: Bearer <token>``)。
        filename_hint:原始檔名提示,用於推副檔名並還原下載命名。
        content_type_hint:型別提示(如 WhatsApp 媒體 metadata 的 mime_type),
            當回應未帶可用 content-type 時作為後援。
        transport:可選,測試時注入 httpx.MockTransport(免真連外網)。
        timeout:單次請求逾時秒數。

    回傳:``/api/v1/channel/files/<uuid><ext>``(可被既有取檔端點服務),失敗回 None。
    """
    if not url:
        return None

    max_bytes = _max_bytes()
    dest: Path | None = None
    file_id: str | None = None
    size = 0
    downloaded = False
    try:
        # 關閉自動轉址:改由下方迴圈手動逐跳跟進,並在每跳前(僅真實外連,未注入
        # transport 時)驗證目標主機非私網/內網,避免以 3xx 轉址繞過 SSRF 防護。
        # transport 為受信任的測試替身接縫(僅內部呼叫端於測試注入,絕非外部可控),
        # 注入時代表不走真實網路,故略過 DNS 驗證。
        async with httpx.AsyncClient(
            transport=transport, timeout=timeout, follow_redirects=False
        ) as client:
            current = url
            for _hop in range(_MAX_REDIRECTS + 1):
                if transport is None:
                    await assert_url_public_async(current)  # SSRF 逐跳驗證(拋 BlockedURLError)
                async with client.stream("GET", current, headers=headers) as resp:
                    if resp.is_redirect:
                        loc = resp.headers.get("location")
                        if not loc:
                            logger.warning("媒體下載轉址缺 Location,略過")
                            return None
                        current = urljoin(current, loc)
                        continue

                    if resp.status_code >= 400:
                        logger.warning("媒體下載 HTTP %s,略過", resp.status_code)
                        return None

                    # 有 Content-Length 時先做早退檢查(仍會於串流時再次把關)。
                    clen = resp.headers.get("content-length")
                    if clen and clen.isdigit() and int(clen) > max_bytes:
                        logger.warning("媒體超過大小上限(content-length=%s),略過", clen)
                        return None

                    resp_ct = resp.headers.get("content-type")
                    ext = _pick_ext(filename_hint, resp_ct, content_type_hint)
                    if ext is None or ext not in _ALLOWED_EXTS:
                        logger.warning("媒體型別不在白名單(ext=%s),略過", ext)
                        return None
                    media_type = _pick_media_type(resp_ct, content_type_hint, ext)

                    file_id = f"{uuid.uuid4().hex}.{ext}"
                    dest = storage.upload_dir() / file_id  # 復用既有上傳目錄

                    with dest.open("wb") as fh:
                        async for chunk in resp.aiter_bytes(_CHUNK):
                            if not chunk:
                                continue
                            size += len(chunk)
                            if size > max_bytes:
                                logger.warning("媒體串流超過大小上限,中止並清除")
                                fh.close()
                                dest.unlink(missing_ok=True)
                                return None
                            fh.write(chunk)
                    downloaded = True
                    break
            else:
                logger.warning("媒體下載轉址次數過多,略過")
                return None

        if not downloaded or dest is None or file_id is None or size == 0:
            if dest is not None:
                dest.unlink(missing_ok=True)
            return None

        original = (filename_hint or "").strip() or file_id
        _write_sidecar(dest, original, media_type)
        return f"{_PUBLIC_URL_PREFIX}/{file_id}"

    except BlockedURLError:  # SSRF 防護拒絕(私網/內網或非法 scheme):降級回 None
        logger.warning("媒體下載目標被 SSRF 防護拒絕(私網/內網或非法 scheme),略過")
        if dest is not None:
            try:
                dest.unlink(missing_ok=True)
            except Exception:
                pass
        return None
    except Exception:  # 網路 / 磁碟 / 解析等任何失敗一律降級
        logger.warning("媒體下載失敗,降級(不拋)", exc_info=True)
        if dest is not None:
            try:
                dest.unlink(missing_ok=True)
            except Exception:
                pass
        return None
