"""本機檔案儲存服務 —— 供 web widget 訪客上傳附件/圖片用。

設計要點:
- 乾淨室、無外部依賴(只用標準庫 + FastAPI UploadFile 的鴨子型別)。
- 儲存目錄由環境變數 `KEFU_UPLOAD_DIR` 指定,預設 `/data/uploads`;啟動即確保存在。
- 檔名以 `<uuid_hex><副檔名>` 命名(內容定址、不可枚舉),另存一份 `<檔名>.json`
  側車 meta 記錄原始檔名與 media type,供下載時還原 Content-Disposition。
- 基本安全:副檔名白名單(常見圖片與文件)、單檔大小上限 10MB、
  取檔時的 file_id 嚴格格式驗證以防路徑穿越。

此模組刻意不耦合租戶邏輯:channelKey 有效性由 channel.py 的路由驗證。
"""
from __future__ import annotations

import mimetypes
import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

# --------------------------------------------------------------------------- #
# 設定與白名單
# --------------------------------------------------------------------------- #
# 單檔大小上限:10 MB
MAX_UPLOAD_BYTES = 10 * 1024 * 1024

# 允許的副檔名(小寫,含點)。圖片 + 常見文件/壓縮檔。
# 刻意不收 .svg(可挾帶腳本,於 <img> 或直接開啟時有 XSS 風險)。
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
_FILE_EXTS = {
    ".pdf", ".txt", ".csv", ".md", ".rtf",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".zip", ".rar", ".7z",
}
ALLOWED_EXTS = _IMAGE_EXTS | _FILE_EXTS

# 取檔用的 file_id 安全格式:純英數 uuid + 一個副檔名(擋掉 `/`、`..` 等)。
_FILE_ID_RE = re.compile(r"^[A-Za-z0-9]{1,64}\.[A-Za-z0-9]{1,8}$")

# 讀取時的分塊大小(邊讀邊累加以便在超限時提早中止,不整包載入超大惡意檔)。
_CHUNK = 64 * 1024


def upload_dir() -> Path:
    """回傳(並確保存在)上傳根目錄。目錄可由 KEFU_UPLOAD_DIR 覆寫。"""
    d = Path(os.environ.get("KEFU_UPLOAD_DIR", "/data/uploads"))
    d.mkdir(parents=True, exist_ok=True)
    return d


# --------------------------------------------------------------------------- #
# 型別
# --------------------------------------------------------------------------- #
class _UploadLike(Protocol):
    """FastAPI UploadFile 的最小介面(便於測試替身)。"""

    filename: str | None
    content_type: str | None

    async def read(self, size: int = -1) -> bytes: ...  # noqa: E704


@dataclass
class SavedFile:
    """存檔結果。id 即對外可取檔的識別碼(等同儲存檔名)。"""

    id: str          # 例:`a1b2c3....png`
    filename: str    # 原始檔名(供下載命名)
    media_type: str  # 例:`image/png`
    size: int        # 位元組


@dataclass
class ResolvedFile:
    """取檔結果(供串流回應)。"""

    path: Path
    media_type: str
    filename: str
    is_image: bool


class StorageError(Exception):
    """存檔失敗(型別/大小不符等),攜帶對外的錯誤碼、訊息與 HTTP 狀態。"""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #
def _ext_of(filename: str | None) -> str:
    """取小寫副檔名(含點);無副檔名回空字串。"""
    if not filename:
        return ""
    return Path(filename).suffix.lower()


def _guess_media_type(ext: str, declared: str | None) -> str:
    """推測 media type:優先用副檔名對照表,退回上傳宣告值,再退回二進位流。"""
    guessed, _ = mimetypes.guess_type("x" + ext)
    if guessed:
        return guessed
    if declared and "/" in declared:
        return declared
    return "application/octet-stream"


# --------------------------------------------------------------------------- #
# 存檔 / 取檔
# --------------------------------------------------------------------------- #
async def save_upload(upload: _UploadLike) -> SavedFile:
    """驗證並儲存一個上傳檔;成功回傳 SavedFile,失敗擲 StorageError。

    驗證:副檔名白名單、大小 <= 10MB。寫入 `<uuid><ext>` 與側車 `.json` meta。
    """
    original = (upload.filename or "").strip() or "file"
    ext = _ext_of(original)
    if ext not in ALLOWED_EXTS:
        raise StorageError(
            "UPLOAD_TYPE_NOT_ALLOWED",
            f"不支援的檔案型別:{ext or '(無副檔名)'}",
        )

    media_type = _guess_media_type(ext, upload.content_type)
    file_id = f"{uuid.uuid4().hex}{ext}"
    dest = upload_dir() / file_id

    # 邊讀邊寫並累計大小,一超限即刪除半成品並回錯。
    size = 0
    try:
        with dest.open("wb") as fh:
            while True:
                chunk = await upload.read(_CHUNK)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    fh.close()
                    dest.unlink(missing_ok=True)
                    raise StorageError(
                        "UPLOAD_TOO_LARGE",
                        f"檔案超過大小上限({MAX_UPLOAD_BYTES // (1024 * 1024)}MB)",
                        status=413,
                    )
                fh.write(chunk)
    except StorageError:
        raise
    except Exception as exc:  # 磁碟寫入失敗等
        dest.unlink(missing_ok=True)
        raise StorageError("UPLOAD_WRITE_FAILED", f"存檔失敗:{exc}", status=500) from exc

    if size == 0:
        dest.unlink(missing_ok=True)
        raise StorageError("UPLOAD_EMPTY", "空檔案")

    # 側車 meta:記原始檔名與 media type,供取檔時還原下載命名。
    meta_path = dest.with_name(dest.name + ".json")
    try:
        import json

        meta_path.write_text(
            json.dumps({"filename": original, "media_type": media_type}, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:
        pass  # meta 失敗不致命:取檔時可退回副檔名推測

    return SavedFile(id=file_id, filename=original, media_type=media_type, size=size)


def resolve_file(file_id: str) -> ResolvedFile | None:
    """依 file_id 定位磁碟檔案;不存在或 id 格式非法則回 None。

    嚴格驗證 file_id 格式以防路徑穿越;再讀側車 meta 還原原始檔名/型別。
    """
    if not _FILE_ID_RE.match(file_id or ""):
        return None
    base = upload_dir()
    path = (base / file_id).resolve()
    # 再保險:確保解析後仍落在上傳目錄內。
    try:
        path.relative_to(base.resolve())
    except ValueError:
        return None
    if not path.is_file():
        return None

    ext = path.suffix.lower()
    media_type = _guess_media_type(ext, None)
    filename = file_id
    meta_path = path.with_name(path.name + ".json")
    if meta_path.is_file():
        try:
            import json

            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            filename = str(meta.get("filename") or filename)
            media_type = str(meta.get("media_type") or media_type)
        except Exception:
            pass

    return ResolvedFile(
        path=path,
        media_type=media_type,
        filename=filename,
        is_image=media_type.startswith("image/"),
    )
