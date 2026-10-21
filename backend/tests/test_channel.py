"""M5 channel 測試(不需真的 Postgres / Telegram)。

- Telegram Bot API client:以 httpx.MockTransport 攔截,驗請求構造與錯誤處理。
- webhook 歸一化與 secret 驗證、群組過濾。
- send_to_visitor adapter 選擇(web=no-op 不重發 / telegram=sendMessage / email=stub)。
- ingest_inbound 標準入站流程與 seam 降級。
- API:Telegram webhook secret 驗證、web widget 送訊(以 ASGITransport + 依賴覆寫)。
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from app.api.v1 import channel as channel_api
from app.core.db import get_db
from app.services import channel_out
from app.services.telegram import (
    NormalizedInbound,
    TelegramClient,
    TelegramError,
    parse_update,
    should_ignore_update,
    verify_secret,
)


# --------------------------------------------------------------------------- #
# 遮罩
# --------------------------------------------------------------------------- #
def test_mask_secret():
    assert channel_out.mask_secret(None) is None
    assert channel_out.mask_secret("short") == "****"
    masked = channel_out.mask_secret("123456:ABCDEF-ghijklmnop")
    assert masked.startswith("1234") and masked.endswith("mnop") and "…" in masked


def test_mask_config_hides_sensitive():
    cfg = {"bot_token": "123456:ABCDEF-ghijklmnop", "public_key": "pk", "webhook_secret": "supersecretvalue"}
    masked = channel_out.mask_config(cfg)
    assert masked["public_key"] == "pk"  # 非敏感保留
    assert "…" in masked["bot_token"]
    assert masked["webhook_secret"] != "supersecretvalue"


# --------------------------------------------------------------------------- #
# Telegram client(MockTransport)
# --------------------------------------------------------------------------- #
def _mock_transport(handler):
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_client_get_me_ok():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/bot123:abc/getMe"
        return httpx.Response(200, json={"ok": True, "result": {"id": 1, "username": "kefubot"}})

    client = TelegramClient("123:abc", transport=_mock_transport(handler))
    me = await client.get_me()
    assert me["username"] == "kefubot"


@pytest.mark.asyncio
async def test_client_send_message_builds_payload():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 42}})

    client = TelegramClient("123:abc", transport=_mock_transport(handler))
    res = await client.send_message(987654, "哈囉")
    assert res["message_id"] == 42
    assert seen["path"].endswith("/sendMessage")
    assert seen["body"] == {"chat_id": 987654, "text": "哈囉"}  # None 參數被濾掉


@pytest.mark.asyncio
async def test_client_set_webhook_includes_secret():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True, "result": True})

    client = TelegramClient("123:abc", transport=_mock_transport(handler))
    ok = await client.set_webhook("https://x/y", secret_token="s3cret", allowed_updates=["message"])
    assert ok is True
    assert seen["body"]["secret_token"] == "s3cret"
    assert seen["body"]["url"] == "https://x/y"


@pytest.mark.asyncio
async def test_client_raises_on_api_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": False, "error_code": 401, "description": "Unauthorized"})

    client = TelegramClient("123:abc", transport=_mock_transport(handler))
    with pytest.raises(TelegramError) as ei:
        await client.get_me()
    assert ei.value.error_code == 401


def test_client_rejects_bad_token():
    with pytest.raises(ValueError):
        TelegramClient("no-colon-token")


def test_file_download_url():
    client = TelegramClient("123:abc")
    assert client.file_download_url("photos/f.jpg") == "https://api.telegram.org/file/bot123:abc/photos/f.jpg"


# --------------------------------------------------------------------------- #
# webhook 歸一化 / secret / 過濾
# --------------------------------------------------------------------------- #
def test_verify_secret():
    assert verify_secret("abc", "abc") is True
    assert verify_secret("abc", "xyz") is False
    assert verify_secret(None, "abc") is False  # 未設 secret → 拒絕
    assert verify_secret("abc", None) is False


def test_parse_private_text():
    update = {
        "update_id": 10,
        "message": {
            "message_id": 5,
            "from": {"id": 777, "first_name": "小明", "username": "ming"},
            "chat": {"id": 777, "type": "private"},
            "text": "你好",
        },
    }
    inbound = parse_update(update)
    assert inbound.external_id == "777"
    assert inbound.text == "你好"
    assert inbound.display_name == "小明"
    assert inbound.content_type == "text"
    assert inbound.meta["update_id"] == 10


def test_parse_photo():
    update = {
        "message": {
            "message_id": 6,
            "from": {"id": 1, "first_name": "A"},
            "chat": {"id": 1, "type": "private"},
            "photo": [
                {"file_id": "small", "file_size": 100},
                {"file_id": "big", "file_size": 900},
            ],
            "caption": "看圖",
        }
    }
    inbound = parse_update(update)
    assert inbound.content_type == "image"
    assert inbound.meta["file_id"] == "big"
    assert inbound.text == "看圖"


def test_ignore_bot_and_group():
    bot_msg = {"message": {"from": {"id": 1, "is_bot": True}, "chat": {"id": 1, "type": "private"}, "text": "x"}}
    assert should_ignore_update(bot_msg) is True

    group_msg = {"message": {"from": {"id": 2}, "chat": {"id": -100, "type": "supergroup"}, "text": "x"}}
    assert should_ignore_update(group_msg, allow_groups=False) is True
    assert should_ignore_update(group_msg, allow_groups=True) is False

    non_message = {"callback_query": {"id": "cb"}}
    assert should_ignore_update(non_message) is True


# --------------------------------------------------------------------------- #
# send_to_visitor adapter 選擇
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_send_to_visitor_web_does_not_republish(monkeypatch):
    """web 走 _send_web,且不再自行 publish。

    web widget 已由 add_message 落庫時對會話頻道發佈的 ``message.new``(帶 message_id)
    收到訊息;所有 send_to_visitor 呼叫端(坐席送訊 / 附件 / dispatch AI 回覆 / 自動回覆)
    都先 add_message 再出站。此處若再 publish(無 message_id,widget 無法去重)會造成重複氣泡。
    """
    tid, sid = uuid.uuid4(), uuid.uuid4()
    monkeypatch.setattr(
        channel_out, "_load_delivery_context",
        _fake_ctx_loader(channel_out.CHANNEL_WEB, {}, external_id="v1"),
    )
    published = []

    async def fake_publish(tenant_id, session_id, event):
        published.append((tenant_id, session_id, event))

    async def fake_publish_agents(tenant_id, event):
        published.append((tenant_id, None, event))

    from app.services import realtime

    # 不論經 seam 解析或直接 import realtime,都攔得到
    monkeypatch.setattr(realtime, "publish", fake_publish)
    monkeypatch.setattr(realtime, "publish_agents", fake_publish_agents)
    monkeypatch.setattr(
        channel_out, "_resolve_seam",
        lambda m, a: fake_publish if (m, a) == ("app.services.realtime", "publish") else None,
    )
    web_calls = []
    orig_send_web = channel_out._send_web

    async def spy_send_web(*args, **kw):
        web_calls.append(args)
        return await orig_send_web(*args, **kw)

    monkeypatch.setattr(channel_out, "_send_web", spy_send_web)

    await channel_out.send_to_visitor(None, tid, sid, "回覆內容")
    assert web_calls == [(tid, sid, "回覆內容", "text")]  # adapter 選擇正確
    assert published == []  # 不重發 → widget 不會收到重複訊息


@pytest.mark.asyncio
async def test_send_to_visitor_telegram_calls_sendmessage(monkeypatch):
    tid, sid = uuid.uuid4(), uuid.uuid4()
    monkeypatch.setattr(
        channel_out, "_load_delivery_context",
        _fake_ctx_loader(channel_out.CHANNEL_TELEGRAM, {"bot_token": "123:abc"}, external_id="55"),
    )
    calls = []

    class FakeClient:
        def __init__(self, token, **kw):
            calls.append(("init", token))

        async def send_message(self, chat_id, text, **kw):
            calls.append(("send", chat_id, text))

        async def send_photo(self, chat_id, photo, **kw):
            calls.append(("photo", chat_id, photo))

    monkeypatch.setattr(channel_out, "TelegramClient", FakeClient)
    await channel_out.send_to_visitor(None, tid, sid, "嗨")
    assert ("send", "55", "嗨") in calls


@pytest.mark.asyncio
async def test_send_to_visitor_missing_session(monkeypatch):
    async def none_loader(db, tenant_id, session_id):
        return None

    monkeypatch.setattr(channel_out, "_load_delivery_context", none_loader)
    # 不應拋出
    await channel_out.send_to_visitor(None, uuid.uuid4(), uuid.uuid4(), "x")


def _fake_ctx_loader(ctype, cfg, external_id):
    async def loader(db, tenant_id, session_id):
        return channel_out._DeliveryContext(
            channel_type=ctype, channel_config=cfg, external_id=external_id
        )

    return loader


# --------------------------------------------------------------------------- #
# ingest_inbound 標準流程與降級
# --------------------------------------------------------------------------- #
class _FakeDb:
    def __init__(self):
        self.committed = 0
        self.rolled_back = 0

    async def commit(self):
        self.committed += 1

    async def rollback(self):
        self.rolled_back += 1


def _seam_registry(recorder, *, with_dispatch=True, dispatch_raises=False):
    vid, sid, mid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

    async def get_or_create_visitor(db, tenant_id, channel_id, external_id, **kw):
        recorder.append(("visitor", external_id, kw.get("display_name")))
        return SimpleNamespace(id=vid)

    async def get_or_open_session(db, tenant_id, channel_id, visitor_id):
        recorder.append(("session", visitor_id))
        return SimpleNamespace(id=sid)

    async def add_message(db, tenant_id, session_id, sender_type, content, **kw):
        recorder.append(("message", sender_type, content, kw.get("content_type")))
        return SimpleNamespace(id=mid)

    async def handle_inbound(db, tenant_id, session_id, message_id):
        if dispatch_raises:
            raise RuntimeError("dispatch boom")
        recorder.append(("dispatch", session_id, message_id))

    reg = {
        ("app.services.visitor", "get_or_create_visitor"): get_or_create_visitor,
        ("app.services.conversation", "get_or_open_session"): get_or_open_session,
        ("app.services.conversation", "add_message"): add_message,
        ("app.services.dispatch", "handle_inbound"): handle_inbound if with_dispatch else None,
    }
    return reg, sid


@pytest.mark.asyncio
async def test_ingest_inbound_happy_path(monkeypatch):
    rec = []
    reg, sid = _seam_registry(rec)
    monkeypatch.setattr(channel_out, "_resolve_seam", lambda m, a: reg.get((m, a)))
    db = _FakeDb()
    inbound = NormalizedInbound(external_id="777", text="你好", display_name="小明")
    result = await channel_out.ingest_inbound(db, uuid.uuid4(), uuid.uuid4(), inbound)
    assert result == sid
    kinds = [r[0] for r in rec]
    assert kinds == ["visitor", "session", "message", "dispatch"]  # 順序正確
    assert ("message", "visitor", "你好", "text") in rec
    # 兩段提交:訪客訊息落地後先 commit(dispatch 失敗也不遺失),
    # dispatch 寫入 AI 回覆(僅 flush)後再 commit(否則請求結束時被回滾)。
    assert db.committed == 2
    assert db.rolled_back == 0


@pytest.mark.asyncio
async def test_ingest_inbound_dispatch_failure_degrades(monkeypatch):
    rec = []
    reg, sid = _seam_registry(rec, dispatch_raises=True)
    monkeypatch.setattr(channel_out, "_resolve_seam", lambda m, a: reg.get((m, a)))
    db = _FakeDb()
    inbound = NormalizedInbound(external_id="1", text="hi")
    # dispatch 拋錯不應讓整體失敗;訊息已落地,回傳 session_id
    result = await channel_out.ingest_inbound(db, uuid.uuid4(), uuid.uuid4(), inbound)
    assert result == sid
    kinds = [r[0] for r in rec]
    assert kinds == ["visitor", "session", "message"]  # dispatch 拋錯前未記錄
    assert db.committed == 1  # 訪客訊息已先提交落地
    assert db.rolled_back == 1  # 只回滾 dispatch 的半成品寫入


@pytest.mark.asyncio
async def test_ingest_inbound_core_seam_missing(monkeypatch):
    monkeypatch.setattr(channel_out, "_resolve_seam", lambda m, a: None)
    inbound = NormalizedInbound(external_id="1", text="hi")
    result = await channel_out.ingest_inbound(_FakeDb(), uuid.uuid4(), uuid.uuid4(), inbound)
    assert result is None  # 核心 seam 未就緒 → 降級


# --------------------------------------------------------------------------- #
# API:webhook secret 驗證 + web 送訊(ASGITransport + 依賴覆寫)
# --------------------------------------------------------------------------- #
def _build_app():
    app = FastAPI()
    app.include_router(channel_api.router, prefix="/api/v1/channel")

    async def _fake_db():
        yield object()  # 端點會被 monkeypatch,不會真用到

    app.dependency_overrides[get_db] = _fake_db
    return app


def _fake_channel(ctype="telegram", **cfg):
    return SimpleNamespace(
        id=uuid.uuid4(), tenant_id=uuid.uuid4(), type=ctype, config=cfg, is_active=True
    )


@pytest.mark.asyncio
async def test_webhook_rejects_bad_secret(monkeypatch):
    ch = _fake_channel(webhook_secret="realsecret", allow_groups=False)

    async def fake_lookup(db, key):
        return ch

    monkeypatch.setattr(channel_api, "_channel_by_public_key", fake_lookup)
    app = _build_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.post(
            "/api/v1/channel/telegram/webhook/pk",
            json={"message": {"chat": {"id": 1, "type": "private"}, "from": {"id": 1}, "text": "hi"}},
            headers={"X-Telegram-Bot-Api-Secret-Token": "WRONG"},
        )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "CHANNEL_TG_BAD_SECRET"


@pytest.mark.asyncio
async def test_webhook_good_secret_ingests(monkeypatch):
    ch = _fake_channel(webhook_secret="realsecret", allow_groups=False)
    sid = uuid.uuid4()

    async def fake_lookup(db, key):
        return ch

    seen = {}

    async def fake_ingest(db, tenant_id, channel_id, inbound):
        seen["inbound"] = inbound
        seen["tenant_id"] = tenant_id
        return sid

    monkeypatch.setattr(channel_api, "_channel_by_public_key", fake_lookup)
    monkeypatch.setattr(channel_out, "ingest_inbound", fake_ingest)
    app = _build_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.post(
            "/api/v1/channel/telegram/webhook/pk",
            json={"update_id": 1, "message": {"message_id": 3, "chat": {"id": 777, "type": "private"}, "from": {"id": 777, "first_name": "A"}, "text": "你好"}},
            headers={"X-Telegram-Bot-Api-Secret-Token": "realsecret"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["data"]["session_id"] == str(sid)
    assert seen["inbound"].external_id == "777"
    assert seen["tenant_id"] == ch.tenant_id  # tenant 由渠道推導


@pytest.mark.asyncio
async def test_webhook_group_filtered(monkeypatch):
    ch = _fake_channel(webhook_secret="realsecret", allow_groups=False)

    async def fake_lookup(db, key):
        return ch

    called = {"ingest": False}

    async def fake_ingest(*a, **k):
        called["ingest"] = True
        return uuid.uuid4()

    monkeypatch.setattr(channel_api, "_channel_by_public_key", fake_lookup)
    monkeypatch.setattr(channel_out, "ingest_inbound", fake_ingest)
    app = _build_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.post(
            "/api/v1/channel/telegram/webhook/pk",
            json={"message": {"chat": {"id": -100, "type": "supergroup"}, "from": {"id": 5}, "text": "x"}},
            headers={"X-Telegram-Bot-Api-Secret-Token": "realsecret"},
        )
    assert resp.status_code == 200
    assert resp.json()["data"]["ignored"] is True
    assert called["ingest"] is False  # 群組被過濾,未進入 pipeline


@pytest.mark.asyncio
async def test_web_message_ingests(monkeypatch):
    ch = _fake_channel(ctype="web")
    sid = uuid.uuid4()

    async def fake_lookup(db, key):
        return ch

    async def fake_ingest(db, tenant_id, channel_id, inbound):
        return sid

    monkeypatch.setattr(channel_api, "_channel_by_public_key", fake_lookup)
    monkeypatch.setattr(channel_out, "ingest_inbound", fake_ingest)
    app = _build_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.post(
            "/api/v1/channel/web/pk/message",
            json={"visitor_external_id": "web-1", "text": "在嗎"},
        )
    assert resp.status_code == 200
    assert resp.json()["data"]["session_id"] == str(sid)


@pytest.mark.asyncio
async def test_web_message_empty_rejected(monkeypatch):
    ch = _fake_channel(ctype="web")

    async def fake_lookup(db, key):
        return ch

    monkeypatch.setattr(channel_api, "_channel_by_public_key", fake_lookup)
    app = _build_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.post(
            "/api/v1/channel/web/pk/message",
            json={"visitor_external_id": "web-1", "text": "   "},
        )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "CHANNEL_EMPTY_MESSAGE"


@pytest.mark.asyncio
async def test_webhook_channel_not_found(monkeypatch):
    async def fake_lookup(db, key):
        return None

    monkeypatch.setattr(channel_api, "_channel_by_public_key", fake_lookup)
    app = _build_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.post(
            "/api/v1/channel/telegram/webhook/unknown",
            json={"message": {}},
            headers={"X-Telegram-Bot-Api-Secret-Token": "x"},
        )
    assert resp.status_code == 404
