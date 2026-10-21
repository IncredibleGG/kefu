"""坐席附件上傳 API(乾淨室,無新依賴,復用既有 storage / conversation / channel_out)。

掛載前綴(整合者於 main.py 註冊):`/api/v1/attachments`
端點:
- POST `/api/v1/attachments/sessions/{session_id}/upload`(需 Bearer JWT,CurrentStaff)
  接 multipart `file` → 用 ``storage.save_upload`` 存檔(副檔名白名單 / 10MB 上限)
  → 以 ``conversation.add_message`` 建立一則坐席(sender_type=human)附件訊息
  (content=本站取檔 URL、content_type=image|file、meta 帶 url/filename/size/media_type)
  → 經 ``channel_out.send_to_visitor`` 出站送達訪客
  (web=no-op,靠 add_message 發的 ``message.new`` 推 widget;
   telegram=sendPhoto/sendMessage,whatsapp / facebook 真正送出附件 URL)。

安全:一律 tenant 隔離(session 必須屬於 ``staff.tenant_id`` 且未刪);
副檔名白名單 / 單檔大小上限由 storage 負責(型別/大小不符回 storage 定義的錯誤碼)。
取檔沿用既有 ``/api/v1/channel/files/{id}``(``storage.resolve_file``),本檔不另設取檔端點。
"""
from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy import select

from app.core.deps import CurrentStaff, DbSession
from app.core.response import err, ok
from app.models.conversation import Message, Session
from app.services import channel_out, realtime, storage
from app.services.conversation import add_message

router = APIRouter()
logger = logging.getLogger("kefu.attachments.api")


def _message_out(m: Message) -> dict:
    """與 conversation API 一致的訊息輸出形狀(供前端 mapMessage 直接映射)。"""
    return {
        "id": str(m.id),
        "session_id": str(m.session_id),
        "sender_type": m.sender_type,
        "sender_id": str(m.sender_id) if m.sender_id else None,
        "content_type": m.content_type,
        "content": m.content,
        "meta": m.meta,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


@router.post("/sessions/{session_id}/upload")
async def upload_attachment(
    session_id: uuid.UUID,
    staff: CurrentStaff,
    db: DbSession,
    file: UploadFile = File(...),
):
    """坐席上傳附件到某會話,建立一則帶附件的坐席訊息並送達訪客。

    附帶行為(與坐席文字回覆 ``conversation.send_message`` 一致):
    - 回覆即認領(auto-claim):若會話仍由 AI 接待或屬於他人,送附件即接手
      (handler_type=human、handler_staff_id=本人、status=open),並發 handoff 事件。
    """
    # --- tenant 隔離:會話須屬於本租戶且未刪 ---
    session = (
        await db.execute(
            select(Session).where(
                Session.id == session_id,
                Session.tenant_id == staff.tenant_id,
                Session.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if session is None:
        return JSONResponse(status_code=404, content=err("SESSION_NOT_FOUND", "會話不存在"))

    # --- 存檔(副檔名白名單 / 大小上限由 storage 負責;錯誤碼原樣回前端)---
    try:
        saved = await storage.save_upload(file)
    except storage.StorageError as exc:
        return JSONResponse(status_code=exc.status, content=err(exc.code, exc.message))

    url = f"/api/v1/channel/files/{saved.id}"
    content_type = "image" if saved.media_type.startswith("image/") else "file"
    meta = {
        "url": url,
        "filename": saved.filename,
        "media_type": saved.media_type,
        "size": saved.size,
        "attachment": True,
    }

    # --- 回覆即認領(與文字回覆一致)---
    claimed = session.handler_type != "human" or session.handler_staff_id != staff.staff_id
    if claimed:
        session.handler_type = "human"
        session.handler_staff_id = staff.staff_id
        session.status = "open"
        await db.flush()

    # --- 落庫 + 對會話頻道發 message.new(坐席台與 web widget 由此即時收到)---
    try:
        message = await add_message(
            db,
            staff.tenant_id,
            session_id,
            sender_type="human",
            content=url,
            sender_id=staff.staff_id,
            content_type=content_type,
            meta=meta,
        )
    except ValueError:
        return JSONResponse(status_code=404, content=err("SESSION_NOT_FOUND", "會話不存在"))

    # --- 認領事件:讓其他坐席與列表即時更新擁有者 / 狀態 ---
    if claimed:
        event = realtime.make_event(
            "handoff",
            {
                "session_id": str(session_id),
                "action": "takeover",
                "handler_type": "human",
                "handler_staff_id": str(staff.staff_id),
                "status": session.status,
            },
        )
        await realtime.publish(staff.tenant_id, session_id, event)
        await realtime.publish_agents(staff.tenant_id, event)

    # --- 出站送達訪客(既有出站 seam)---
    # web=no-op(widget 靠上面 add_message 的 message.new);telegram/whatsapp/facebook
    # 真正送出附件 URL。send_to_visitor 內部各 adapter 皆自行 try/except 降級,不會拋。
    await channel_out.send_to_visitor(
        db, staff.tenant_id, session_id, url, content_type=content_type
    )

    await db.commit()
    return ok(_message_out(message))
