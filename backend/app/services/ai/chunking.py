"""文本切塊:上傳文檔入庫前,把長文切成可嵌入的片段。

策略:優先在段落 / 句子邊界切,並保留重疊(overlap)以免語意在邊界斷裂。
純函式、無 I/O,便於單元測試。
"""
from __future__ import annotations


def chunk_text(text: str, *, size: int = 800, overlap: int = 100) -> list[str]:
    """把 text 切成長度約 size(字元)、相鄰重疊 overlap 的片段。

    - 先正規化空白;空字串回空清單。
    - 儘量不從單字/句子中間硬切:在視窗內找最後一個換行或句號當切點。
    """
    if size <= 0:
        raise ValueError("size 必須為正整數")
    if overlap < 0 or overlap >= size:
        raise ValueError("overlap 必須為 0 <= overlap < size")

    normalized = text.strip()
    if not normalized:
        return []
    if len(normalized) <= size:
        return [normalized]

    chunks: list[str] = []
    start = 0
    n = len(normalized)
    # 可作為「柔性切點」的標點(中英文)
    breakpoints = "\n。!?！?；;"
    while start < n:
        end = min(start + size, n)
        if end < n:
            # 在 [start, end) 尾段找最後一個切點,避免切斷句子
            window = normalized[start:end]
            cut = max((window.rfind(b) for b in breakpoints), default=-1)
            if cut != -1 and cut >= size // 2:
                end = start + cut + 1
        chunk = normalized[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= n:
            break
        # 下一段起點回退 overlap,製造重疊
        start = max(end - overlap, start + 1)
    return chunks
