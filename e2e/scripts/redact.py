#!/usr/bin/env python3
"""把 E2E 產物目錄裡所有文字檔中的帳密換成 ***(上傳 artifact 前執行)。

用法:python3 e2e/scripts/redact.py <目錄>
讀環境變數 E2E_EMAIL、E2E_PASSWORD;同時處理 JSON 跳脫、URL 編碼,以及輸入到一半留下的前綴。
二進位檔(png、mp4 等)略過;密碼框在截圖裡本來就是遮罩。
"""
import json
import os
import sys
import urllib.parse

TEXT_EXT = {".txt", ".log", ".json", ".xml", ".html", ".yaml", ".yml", ".csv", ".md", ""}


def variants(secret: str) -> list[str]:
    out = set()
    # 輸入到一半就失敗時,元件樹 / 記錄裡會留下「前半段」;夠長的前綴一併遮蔽
    min_prefix = max(6, (len(secret) + 1) // 2)
    for n in range(min(len(secret), min_prefix), len(secret) + 1):
        p = secret[:n]
        out |= {p, json.dumps(p)[1:-1], urllib.parse.quote(p, safe=""), urllib.parse.quote_plus(p)}
    return sorted((v for v in out if v), key=len, reverse=True)


def main() -> int:
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    secrets = [os.environ.get(k, "") for k in ("E2E_PASSWORD", "E2E_EMAIL")]
    needles = [v for s in secrets if len(s) >= 3 for v in variants(s)]
    if not needles:
        print("redact: 沒有需要遮蔽的值")
        return 0
    changed = 0
    for dirpath, _, files in os.walk(root):
        for name in files:
            path = os.path.join(dirpath, name)
            if os.path.splitext(name)[1].lower() not in TEXT_EXT:
                continue
            try:
                with open(path, "rb") as f:
                    raw = f.read()
                text = raw.decode("utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            new = text
            for n in needles:
                new = new.replace(n, "***")
            if new != text:
                with open(path, "w", encoding="utf-8", newline="") as f:
                    f.write(new)
                changed += 1
    print(f"redact: 已處理 {changed} 個檔案")
    return 0


if __name__ == "__main__":
    sys.exit(main())
