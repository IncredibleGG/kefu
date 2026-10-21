"""巨集(Macro)服務層:動作序列驗證與正規化。

Macro.actions 為 JSONB 陣列,每個元素形如:
  {"type": "reply",      "content": "您好,感謝來訊…"}
  {"type": "add_note",   "content": "已提醒客戶補件"}
  {"type": "set_status", "value": "resolved"}
  {"type": "add_tags",   "tags": ["<tag_id_or_name>", ...]}
  {"type": "assign",     "staff_id": "<uuid>"}   # 省略 staff_id = 指派給自己(前端解讀)

實際「套用」由前端 MessageComposer 呼叫既有 API 完成(插入回覆、改狀態、加標籤、
指派、加備註);此處僅負責在 CRUD 時把關結構與型別,避免存進髒資料。
"""
from __future__ import annotations

from typing import Any

from app.models.productivity import MACRO_ACTION_TYPES


class MacroValidationError(ValueError):
    """動作結構不合法;由 API 層轉為 err() 回覆。"""


def validate_macro_actions(actions: Any) -> list[dict]:
    """驗證並回傳正規化後的動作清單。不合法時丟 MacroValidationError。

    - None → 視為空清單(允許先建骨架、稍後補動作)。
    - 逐一檢查 type 是否為 MACRO_ACTION_TYPES,並按型別要求必填欄位。
    - 僅保留該型別認得的欄位,丟棄多餘鍵(防止塞入無關資料)。
    """
    if actions is None:
        return []
    if not isinstance(actions, list):
        raise MacroValidationError("actions 需為陣列")

    cleaned: list[dict] = []
    for idx, raw in enumerate(actions):
        pos = idx + 1
        if not isinstance(raw, dict):
            raise MacroValidationError(f"第 {pos} 個動作需為物件")
        atype = raw.get("type")
        if atype not in MACRO_ACTION_TYPES:
            raise MacroValidationError(
                f"第 {pos} 個動作型別不合法: {atype!r}(可用:{', '.join(MACRO_ACTION_TYPES)})"
            )

        item: dict = {"type": atype}
        if atype in ("reply", "add_note"):
            content = raw.get("content")
            if not isinstance(content, str) or not content.strip():
                raise MacroValidationError(f"第 {pos} 個動作({atype})需要非空 content")
            item["content"] = content
        elif atype == "set_status":
            value = raw.get("value")
            if not isinstance(value, str) or not value.strip():
                raise MacroValidationError(f"第 {pos} 個動作(set_status)需要 value")
            item["value"] = value.strip()
        elif atype == "add_tags":
            tags = raw.get("tags")
            if (
                not isinstance(tags, list)
                or not tags
                or not all(isinstance(x, str) and x.strip() for x in tags)
            ):
                raise MacroValidationError(f"第 {pos} 個動作(add_tags)需要非空 tags 字串陣列")
            item["tags"] = [x.strip() for x in tags]
        elif atype == "assign":
            staff_id = raw.get("staff_id")
            if staff_id is not None and not isinstance(staff_id, str):
                raise MacroValidationError(f"第 {pos} 個動作(assign)staff_id 需為字串")
            if staff_id:
                item["staff_id"] = staff_id
        cleaned.append(item)
    return cleaned
