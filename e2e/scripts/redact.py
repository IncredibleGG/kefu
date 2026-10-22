#!/usr/bin/env python3
"""把 E2E 產物目錄裡的帳密遮掉(上傳 artifact 前執行;本程式失敗時 workflow 不上傳)。

用法:python3 e2e/scripts/redact.py <目錄>
讀環境變數 E2E_EMAIL、E2E_PASSWORD。repo 是公開的,artifact 任何登入 GitHub 的人都能下載。

- 驅動程式 / 裝置的原始記錄(msedgedriver、XCTest、模擬器)會逐字或拆段記下輸入內容
  (例如 iOS 先打第一個字再打其餘),遮蔽無法保證完整 → 直接刪除。
- 其餘非圖片檔一律以位元組處理,不因編碼問題略過:遮蔽帳密每一段長度 ≥ 一半(至少 4)的子字串,
  涵蓋 UTF-8、UTF-16LE、JSON 跳脫、URL 編碼,所以輸入到一半或拆段記錄的片段也會被遮。
- 登入後的 session token(JWT)也一併遮蔽:debug 版 Capacitor 會把外掛呼叫的資料(含存 token)印進 logcat。
- 讀寫失敗的檔案刪除;刪不掉就以非 0 結束。遮完再掃一次,仍找得到完整帳密的檔案也刪除。
- 截圖(png / jpg)不處理:密碼框本來就是遮罩;失敗截圖可能看得到輸入中的 email。
"""
import fnmatch
import html
import json
import os
import re
import sys
import urllib.parse

IMAGE_EXT = {".png", ".jpg", ".jpeg"}
DROP = ["msedgedriver*.log", "xctest_runner*.log", "device-xctest.log", "device-simulator.log"]
MASK = "***"
# JWT(eyJ 開頭、三段 base64url)的 UTF-8 與 UTF-16LE(每個字元後接 \x00)位元組樣式
_SEG8 = rb"[A-Za-z0-9_\-]{8,}"
_SEG16 = rb"(?:[A-Za-z0-9_\-]\x00){8,}"
JWT_PATTERNS = [
    (re.compile(rb"eyJ" + _SEG8 + rb"\." + _SEG8 + rb"\." + _SEG8), MASK.encode("utf-8")),
    (
        re.compile(rb"e\x00y\x00J\x00" + _SEG16 + rb"\.\x00" + _SEG16 + rb"\.\x00" + _SEG16),
        MASK.encode("utf-16-le"),
    ),
]


def pieces(secret: str) -> set[str]:
    """secret 本身與所有長度 ≥ max(4, 一半) 的子字串(前綴、後綴、中段)。"""
    m = min(len(secret), max(4, (len(secret) + 1) // 2))
    return {secret[i:j] for i in range(len(secret)) for j in range(i + m, len(secret) + 1)}


def encoded(text: str) -> set[tuple[bytes, bytes]]:
    forms = {
        text,
        json.dumps(text)[1:-1],
        json.dumps(text, ensure_ascii=False)[1:-1],
        urllib.parse.quote(text, safe=""),
        urllib.parse.quote_plus(text),
        # 失敗時的頁面原始碼(failure-*.html):受控 input 的 value 屬性是 HTML 跳脫過的
        html.escape(text, quote=True),
        html.escape(text, quote=False),
    }
    out = set()
    for f in forms:
        if f:
            out.add((f.encode("utf-8"), MASK.encode("utf-8")))
            out.add((f.encode("utf-16-le"), MASK.encode("utf-16-le")))
    return out


def remove(path: str) -> bool:
    try:
        os.remove(path)
        return True
    except OSError as e:
        print(f"redact: 無法刪除 {path}:{e}", file=sys.stderr)
        return False


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    secrets = [s for s in (os.environ.get(k, "") for k in ("E2E_PASSWORD", "E2E_EMAIL")) if len(s) >= 3]
    needles = sorted({pair for s in secrets for p in pieces(s) for pair in encoded(p)}, key=lambda p: -len(p[0]))
    whole = [n for s in secrets for n, _ in encoded(s)]
    ok = True
    dropped = changed = 0
    for dirpath, _, files in os.walk(root):
        for name in files:
            path = os.path.join(dirpath, name)
            if any(fnmatch.fnmatch(name, pat) for pat in DROP):
                if remove(path):
                    dropped += 1
                else:
                    ok = False
                continue
            if os.path.splitext(name)[1].lower() in IMAGE_EXT:
                continue
            try:
                with open(path, "rb") as f:
                    raw = f.read()
                new = raw
                for pattern, mask in JWT_PATTERNS:
                    new = pattern.sub(mask, new)
                for needle, mask in needles:
                    new = new.replace(needle, mask)
                if new != raw:
                    with open(path, "wb") as f:
                        f.write(new)
                    changed += 1
                if any(n in new for n in whole) or any(p.search(new) for p, _ in JWT_PATTERNS):
                    raise ValueError("遮蔽後仍含完整帳密或 token")
            except (OSError, ValueError) as e:
                print(f"redact: {path} 無法安全處理({e}),刪除", file=sys.stderr)
                ok = remove(path) and ok
    if not secrets:
        print("redact: 沒有 E2E_EMAIL / E2E_PASSWORD,只遮蔽 token")
    print(f"redact: 遮蔽 {changed} 個檔案,刪除 {dropped} 個原始記錄")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
