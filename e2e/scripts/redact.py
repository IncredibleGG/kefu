#!/usr/bin/env python3
"""把 E2E 產物目錄裡的帳密遮掉(上傳 artifact 前執行;本程式失敗時 workflow 不上傳)。

用法:python3 e2e/scripts/redact.py <目錄>
讀環境變數 E2E_EMAIL、E2E_PASSWORD。repo 是公開的,artifact 任何登入 GitHub 的人都能下載。

- 驅動程式 / 裝置的原始記錄(msedgedriver、XCTest、模擬器)會逐字或拆段記下輸入內容
  (例如 iOS 先打第一個字再打其餘),遮蔽無法保證完整 → 直接刪除。
- Maestro 的 Android driver 打每個字前會在 logcat 記一行字元碼(`D Maestro : 97`)→ 這類行整行刪除。
- 其餘非圖片檔一律以位元組處理,不因編碼問題略過:遮蔽帳密每一段長度 ≥ 一半(至少 4)的子字串,
  涵蓋 UTF-8、UTF-16LE、JSON 跳脫、URL 編碼、HTML 跳脫,所以輸入到一半或拆段記錄的片段也會被遮。
- 登入後的 session token(JWT)也一併遮蔽:debug 版 Capacitor 會把外掛呼叫的資料(含存 token)印進 logcat。
- 讀寫失敗的檔案刪除;刪不掉就以非 0 結束。遮完再掃一次,仍找得到完整帳密或 token 的檔案也刪除。
- 截圖無法遮蔽,改為刪除可能拍到帳密的:Maestro 某次嘗試(attempt-N/)已開始輸入帳密
  (commands.json 有 inputText,或沒有 commands.json)時,只留 01、02(輸入前)與 04、05(登入後)
  這四張指定截圖,失敗截圖等一律刪除;~/.maestro/tests 的副本(maestro-tests/)裡的截圖也刪除。
  桌面版由 login.mjs 在失敗截圖前先清空登入框。
"""
from __future__ import annotations

import fnmatch
import html
import json
import os
import re
import sys
import urllib.parse

IMAGE_EXT = {".png", ".jpg", ".jpeg"}
DROP = ["msedgedriver*.log", "xctest_runner*.log", "device-xctest.log", "device-simulator.log"]
KEEP_SHOTS = ("01-", "02-", "04-", "05-")
ATTEMPT_DIR = re.compile(r"^attempt-\d+$")
MASK = "***"
# 「D Maestro : 112」「D/Maestro( 123): 112」這類逐字字元碼記錄(整行刪除)
MAESTRO_KEYCODE_LINE = re.compile(rb"(?m)^[^\n]*\bMaestro\b[^\n:]*:[ \t]*\d{1,5}[ \t]*\r?(?:\n|\Z)")
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


def browser_escape(text: str, attribute: bool) -> str:
    """瀏覽器序列化 DOM(getPageSource)的跳脫方式:屬性值跳脫 & nbsp ",文字節點跳脫 & nbsp < >。"""
    out = text.replace("&", "&amp;").replace("\xa0", "&nbsp;")
    if attribute:
        return out.replace('"', "&quot;")
    return out.replace("<", "&lt;").replace(">", "&gt;")


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
        browser_escape(text, attribute=True),
        browser_escape(text, attribute=False),
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


def attempt_of(root: str, path: str) -> str | None:
    """path 所屬的 Maestro 嘗試目錄(root 底下第一個 attempt-N),不在任何嘗試目錄裡時回 None。"""
    parts = os.path.relpath(path, root).split(os.sep)
    for i, part in enumerate(parts[:-1]):
        if ATTEMPT_DIR.match(part):
            return os.path.join(root, *parts[: i + 1])
    return None


def typed_attempts(root: str) -> set[str]:
    """已開始輸入帳密的嘗試目錄:有 inputText 指令,或沒有 commands.json(無法判斷時當作已輸入)。"""
    attempts, with_commands, typed = set(), set(), set()
    for dirpath, dirs, files in os.walk(root):
        if ATTEMPT_DIR.match(os.path.basename(dirpath)) and attempt_of(root, os.path.join(dirpath, "x")) == dirpath:
            attempts.add(dirpath)
        if "commands.json" in files:
            path = os.path.join(dirpath, "commands.json")
            attempt = attempt_of(root, path)
            if attempt is None:
                continue
            with_commands.add(attempt)
            try:
                with open(path, "rb") as f:
                    if b"inputTextCommand" in f.read():
                        typed.add(attempt)
            except OSError:
                typed.add(attempt)
    return typed | (attempts - with_commands)


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    secrets = [s for s in (os.environ.get(k, "") for k in ("E2E_PASSWORD", "E2E_EMAIL")) if len(s) >= 3]
    needles = sorted({pair for s in secrets for p in pieces(s) for pair in encoded(p)}, key=lambda p: -len(p[0]))
    whole = [n for s in secrets for n, _ in encoded(s)]
    typed = typed_attempts(root)
    ok = True
    dropped = changed = shots = 0
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
                in_copy = "maestro-tests" in os.path.relpath(path, root).split(os.sep)
                if in_copy or (attempt_of(root, path) in typed and not name.startswith(KEEP_SHOTS)):
                    if remove(path):
                        shots += 1
                    else:
                        ok = False
                continue
            try:
                with open(path, "rb") as f:
                    raw = f.read()
                new = MAESTRO_KEYCODE_LINE.sub(b"", raw)
                for pattern, mask in JWT_PATTERNS:
                    new = pattern.sub(mask, new)
                for needle, mask in needles:
                    new = new.replace(needle, mask)
                if new != raw:
                    with open(path, "wb") as f:
                        f.write(new)
                    changed += 1
                leaked = (
                    any(n in new for n in whole)
                    or any(p.search(new) for p, _ in JWT_PATTERNS)
                    or MAESTRO_KEYCODE_LINE.search(new)
                )
                if leaked:
                    raise ValueError("遮蔽後仍含帳密或 token")
            except (OSError, ValueError) as e:
                print(f"redact: {path} 無法安全處理({e}),刪除", file=sys.stderr)
                ok = remove(path) and ok
    if not secrets:
        print("redact: 沒有 E2E_EMAIL / E2E_PASSWORD,只遮蔽 token 與逐字記錄")
    print(f"redact: 遮蔽 {changed} 個檔案,刪除 {dropped} 個原始記錄、{shots} 張可能拍到帳密的截圖")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
