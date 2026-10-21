"""M5 channel — WhatsApp(Meta Cloud API)+ Facebook Messenger 測試。

不需真的 Postgres / Meta:
- WhatsApp / Facebook 出站 client:以 httpx.MockTransport 攔截,驗 URL / payload / header 與錯誤處理。
- webhook:X-Hub-Signature-256 驗簽、GET hub.challenge 驗證握手。
- payload 歸一化:WhatsApp messages / Facebook messaging 事件 → NormalizedInbound。
- send_to_visitor adapter 選擇(whatsapp / facebook)。
- mask_config 遮罩 Meta 機密欄位。
- API:GET 握手回 challenge、POST 驗簽 + 入站、設定端點存並遮罩(ASGITransport + 依賴覆寫)。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from app.api.v1 import channel as channel_api
from app.core import crypto
from app.core.db import get_db
from app.core.deps import Principal, get_current_principal
from app.services import channel_out
from app.services.meta import (
    FacebookClient,
    MetaError,
    WhatsAppClient,
    parse_facebook,
    parse_whatsapp,
    verify_challenge,
    verify_signature,
)


# --------------------------------------------------------------------------- #
# 出站 client(MockTransport)
# --------------------------------------------------------------------------- #
def _mock_transport(handler):
    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_whatsapp_client_builds_request():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200, json={"messaging_product": "whatsapp", "messages": [{"id": "wamid.X"}]}
        )

    client = WhatsAppClient("PNID1", "TKN-secret", transport=_mock_transport(handler))
    res = await client.send_text("886900111222", "哈囉")
    assert res["messages"][0]["id"] == "wamid.X"
    assert seen["path"].endswith("/v20.0/PNID1/messages")
    assert seen["auth"] == "Bearer TKN-secret"  # token 走 header,不放 URL
    assert seen["body"]["messaging_product"] == "whatsapp"
    assert seen["body"]["to"] == "886900111222"
    assert seen["body"]["text"]["body"] == "哈囉"


@pytest.mark.asyncio
async def test_facebook_client_builds_request():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"recipient_id": "PSID9", "message_id": "mid.1"})

    client = FacebookClient("PAGE-TKN", transport=_mock_transport(handler))
    res = await client.send_text("PSID9", "嗨")
    assert res["message_id"] == "mid.1"
    assert seen["path"].endswith("/v20.0/me/messages")
    assert seen["auth"] == "Bearer PAGE-TKN"
    assert seen["body"]["recipient"]["id"] == "PSID9"
    assert seen["body"]["message"]["text"] == "嗨"
    assert seen["body"]["messaging_type"] == "RESPONSE"


@pytest.mark.asyncio
async def test_graph_error_raises_metaerror():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400, json={"error": {"message": "Invalid OAuth token", "code": 190}}
        )

    client = WhatsAppClient("PNID1", "bad", transport=_mock_transport(handler))
    with pytest.raises(MetaError) as ei:
        await client.send_text("1", "x")
    assert ei.value.code == 190


def test_clients_reject_missing_credentials():
    with pytest.raises(ValueError):
        WhatsAppClient("", "tkn")
    with pytest.raises(ValueError):
        WhatsAppClient("pnid", "")
    with pytest.raises(ValueError):
        FacebookClient("")


# --------------------------------------------------------------------------- #
# 簽章 / 驗證握手
# --------------------------------------------------------------------------- #
def _sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_verify_signature():
    body = b'{"a":1}'
    good = _sign("appsecret", body)
    assert verify_signature("appsecret", body, good) is True
    assert verify_signature("appsecret", body, "sha256=deadbeef") is False
    assert verify_signature("wrongsecret", body, good) is False
    assert verify_signature(None, body, good) is False  # 未設 app_secret → 拒絕
    assert verify_signature("appsecret", body, None) is False
    assert verify_signature("appsecret", body, "md5=xxx") is False  # 前綴不符


def test_verify_challenge():
    assert (
        verify_challenge(mode="subscribe", token="vt", challenge="CH", expected_token="vt")
        == "CH"
    )
    assert (
        verify_challenge(mode="subscribe", token="bad", challenge="CH", expected_token="vt")
        is None
    )
    assert (
        verify_challenge(mode="unsubscribe", token="vt", challenge="CH", expected_token="vt")
        is None
    )
    assert (
        verify_challenge(mode="subscribe", token="vt", challenge="CH", expected_token=None)
        is None
    )


# --------------------------------------------------------------------------- #
# WhatsApp payload 解析
# --------------------------------------------------------------------------- #
def _wa_payload(messages, contacts=None):
    return {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "WABA",
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {"phone_number_id": "PNID1"},
                            "contacts": contacts or [],
                            "messages": messages,
                        },
                    }
                ],
            }
        ],
    }


def test_parse_whatsapp_text():
    payload = _wa_payload(
        messages=[
            {"from": "886900", "id": "wamid.1", "type": "text", "text": {"body": "你好"}}
        ],
        contacts=[{"wa_id": "886900", "profile": {"name": "小明"}}],
    )
    inbounds = parse_whatsapp(payload)
    assert len(inbounds) == 1
    ib = inbounds[0]
    assert ib.external_id == "886900"
    assert ib.text == "你好"
    assert ib.content_type == "text"
    assert ib.display_name == "小明"
    assert ib.meta["provider"] == "whatsapp"
    assert ib.meta["phone_number_id"] == "PNID1"
    assert ib.meta["message_id"] == "wamid.1"


def test_parse_whatsapp_image_and_multiple():
    payload = _wa_payload(
        messages=[
            {"from": "1", "id": "m1", "type": "text", "text": {"body": "一"}},
            {
                "from": "2",
                "id": "m2",
                "type": "image",
                "image": {"id": "media99", "caption": "看圖"},
            },
            {"from": "3", "id": "m3", "type": "location"},
        ]
    )
    inbounds = parse_whatsapp(payload)
    assert len(inbounds) == 3
    assert inbounds[1].content_type == "image"
    assert inbounds[1].meta["media_id"] == "media99"
    assert inbounds[1].text == "看圖"
    assert inbounds[2].text == "[媒體]"  # 非文字/媒體型別 → 佔位


def test_parse_whatsapp_statuses_only_empty():
    # 僅狀態回報(無 messages)→ 不產生 inbound
    payload = {
        "entry": [{"changes": [{"value": {"statuses": [{"id": "x", "status": "read"}]}}]}]
    }
    assert parse_whatsapp(payload) == []


# --------------------------------------------------------------------------- #
# Facebook payload 解析
# --------------------------------------------------------------------------- #
def test_parse_facebook_text():
    payload = {
        "object": "page",
        "entry": [
            {
                "id": "PAGE1",
                "messaging": [
                    {
                        "sender": {"id": "PSID7"},
                        "recipient": {"id": "PAGE1"},
                        "timestamp": 123,
                        "message": {"mid": "mid.7", "text": "在嗎"},
                    }
                ],
            }
        ],
    }
    inbounds = parse_facebook(payload)
    assert len(inbounds) == 1
    ib = inbounds[0]
    assert ib.external_id == "PSID7"
    assert ib.text == "在嗎"
    assert ib.meta["provider"] == "facebook"
    assert ib.meta["mid"] == "mid.7"
    assert ib.meta["page_id"] == "PAGE1"


def test_parse_facebook_skips_echo_and_delivery():
    payload = {
        "entry": [
            {
                "id": "PAGE1",
                "messaging": [
                    {"sender": {"id": "PAGE1"}, "message": {"is_echo": True, "text": "回聲"}},
                    {"sender": {"id": "PSID7"}, "delivery": {"mids": ["mid.1"]}},
                    {
                        "sender": {"id": "PSID7"},
                        "message": {
                            "attachments": [
                                {"type": "image", "payload": {"url": "https://x/i.jpg"}}
                            ]
                        },
                    },
                ],
            }
        ]
    }
    inbounds = parse_facebook(payload)
    # echo 與 delivery 都被略過,只剩附件訊息
    assert len(inbounds) == 1
    assert inbounds[0].content_type == "image"
    assert inbounds[0].text == "[媒體]"
    assert inbounds[0].meta["attachment_url"] == "https://x/i.jpg"


# --------------------------------------------------------------------------- #
# send_to_visitor adapter 選擇
# --------------------------------------------------------------------------- #
def _fake_ctx_loader(ctype, cfg, external_id):
    async def loader(db, tenant_id, session_id):
        return channel_out._DeliveryContext(
            channel_type=ctype, channel_config=cfg, external_id=external_id
        )

    return loader


@pytest.mark.asyncio
async def test_send_to_visitor_whatsapp(monkeypatch):
    tid, sid = uuid.uuid4(), uuid.uuid4()
    monkeypatch.setattr(
        channel_out,
        "_load_delivery_context",
        _fake_ctx_loader(
            channel_out.CHANNEL_WHATSAPP,
            {"phone_number_id": "PNID1", "access_token": "tkn"},
            external_id="886900",
        ),
    )
    calls = []

    class FakeWA:
        def __init__(self, pnid, token, **kw):
            calls.append(("init", pnid, token))

        async def send_text(self, to, text, **kw):
            calls.append(("send", to, text))

    monkeypatch.setattr(channel_out, "WhatsAppClient", FakeWA)
    await channel_out.send_to_visitor(None, tid, sid, "回覆")
    assert ("send", "886900", "回覆") in calls


@pytest.mark.asyncio
async def test_send_to_visitor_facebook(monkeypatch):
    tid, sid = uuid.uuid4(), uuid.uuid4()
    monkeypatch.setattr(
        channel_out,
        "_load_delivery_context",
        _fake_ctx_loader(
            channel_out.CHANNEL_FACEBOOK,
            {"page_access_token": "ptkn"},
            external_id="PSID7",
        ),
    )
    calls = []

    class FakeFB:
        def __init__(self, token, **kw):
            calls.append(("init", token))

        async def send_text(self, rid, text, **kw):
            calls.append(("send", rid, text))

    monkeypatch.setattr(channel_out, "FacebookClient", FakeFB)
    await channel_out.send_to_visitor(None, tid, sid, "嗨")
    assert ("send", "PSID7", "嗨") in calls


@pytest.mark.asyncio
async def test_send_to_visitor_whatsapp_missing_cfg_no_raise(monkeypatch):
    # 缺 access_token / wa_id → 靜默略過,不拋
    monkeypatch.setattr(
        channel_out,
        "_load_delivery_context",
        _fake_ctx_loader(channel_out.CHANNEL_WHATSAPP, {"phone_number_id": "PNID1"}, None),
    )
    await channel_out.send_to_visitor(None, uuid.uuid4(), uuid.uuid4(), "x")


# --------------------------------------------------------------------------- #
# 遮罩
# --------------------------------------------------------------------------- #
def test_mask_config_hides_meta_secrets():
    cfg = {
        "phone_number_id": "PNID1",
        "page_id": "PAGE1",
        "access_token": "EAAG-supersecret-token",
        "page_access_token": "EAAP-anothertoken",
        "app_secret": "appsecretvalue-1234",
        "verify_token": "myverifytoken",
    }
    masked = channel_out.mask_config(cfg)
    assert masked["phone_number_id"] == "PNID1"  # 識別碼保留
    assert masked["page_id"] == "PAGE1"
    for k in ("access_token", "page_access_token", "app_secret", "verify_token"):
        assert "…" in masked[k] and masked[k] != cfg[k]


# --------------------------------------------------------------------------- #
# API(ASGITransport + 依賴覆寫)
# --------------------------------------------------------------------------- #
class _FakeApiDb:
    async def commit(self):
        pass

    async def refresh(self, obj):
        pass


def _build_app(principal: Principal | None = None):
    app = FastAPI()
    app.include_router(channel_api.router, prefix="/api/v1/channel")

    async def _fake_db():
        yield _FakeApiDb()

    app.dependency_overrides[get_db] = _fake_db
    if principal is not None:
        app.dependency_overrides[get_current_principal] = lambda: principal
    return app


def _fake_channel(ctype, **cfg):
    return SimpleNamespace(
        id=uuid.uuid4(),
        tenant_id=uuid.uuid4(),
        type=ctype,
        name="ch",
        config=dict(cfg),
        is_active=True,
        created_at=None,
    )


@pytest.mark.asyncio
async def test_whatsapp_webhook_verify_echoes_challenge(monkeypatch):
    ch = _fake_channel(channel_out.CHANNEL_WHATSAPP, verify_token="vt", app_secret="s")

    async def fake_lookup(db, key):
        return ch

    monkeypatch.setattr(channel_api, "_channel_by_public_key", fake_lookup)
    app = _build_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.get(
            "/api/v1/channel/whatsapp/webhook/pk",
            params={"hub.mode": "subscribe", "hub.verify_token": "vt", "hub.challenge": "12345"},
        )
    assert resp.status_code == 200
    assert resp.text == "12345"  # 原樣回 challenge,非 JSON 信封


@pytest.mark.asyncio
async def test_facebook_webhook_verify_bad_token(monkeypatch):
    ch = _fake_channel(channel_out.CHANNEL_FACEBOOK, verify_token="vt")

    async def fake_lookup(db, key):
        return ch

    monkeypatch.setattr(channel_api, "_channel_by_public_key", fake_lookup)
    app = _build_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.get(
            "/api/v1/channel/facebook/webhook/pk",
            params={"hub.mode": "subscribe", "hub.verify_token": "WRONG", "hub.challenge": "9"},
        )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "CHANNEL_META_BAD_VERIFY"


@pytest.mark.asyncio
async def test_whatsapp_webhook_bad_signature(monkeypatch):
    ch = _fake_channel(channel_out.CHANNEL_WHATSAPP, app_secret="appsecret")

    async def fake_lookup(db, key):
        return ch

    monkeypatch.setattr(channel_api, "_channel_by_public_key", fake_lookup)
    app = _build_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.post(
            "/api/v1/channel/whatsapp/webhook/pk",
            content=b'{"entry":[]}',
            headers={"X-Hub-Signature-256": "sha256=bad", "Content-Type": "application/json"},
        )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "CHANNEL_META_BAD_SIGNATURE"


@pytest.mark.asyncio
async def test_whatsapp_webhook_good_signature_ingests(monkeypatch):
    ch = _fake_channel(channel_out.CHANNEL_WHATSAPP, app_secret="appsecret")
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

    payload = _wa_payload(
        messages=[{"from": "886900", "id": "w1", "type": "text", "text": {"body": "你好"}}],
        contacts=[{"wa_id": "886900", "profile": {"name": "小明"}}],
    )
    raw = json.dumps(payload).encode()
    app = _build_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.post(
            "/api/v1/channel/whatsapp/webhook/pk",
            content=raw,
            headers={
                "X-Hub-Signature-256": _sign("appsecret", raw),
                "Content-Type": "application/json",
            },
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["data"]["count"] == 1
    assert body["data"]["session_ids"] == [str(sid)]
    assert seen["inbound"].external_id == "886900"
    assert seen["tenant_id"] == ch.tenant_id  # tenant 由渠道推導


@pytest.mark.asyncio
async def test_facebook_webhook_good_signature_ingests(monkeypatch):
    ch = _fake_channel(channel_out.CHANNEL_FACEBOOK, app_secret="fbsecret")
    sid = uuid.uuid4()

    async def fake_lookup(db, key):
        return ch

    async def fake_ingest(db, tenant_id, channel_id, inbound):
        return sid

    monkeypatch.setattr(channel_api, "_channel_by_public_key", fake_lookup)
    monkeypatch.setattr(channel_out, "ingest_inbound", fake_ingest)

    payload = {
        "object": "page",
        "entry": [
            {
                "id": "PAGE1",
                "messaging": [
                    {"sender": {"id": "PSID7"}, "message": {"mid": "m1", "text": "hi"}}
                ],
            }
        ],
    }
    raw = json.dumps(payload).encode()
    app = _build_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.post(
            "/api/v1/channel/facebook/webhook/pk",
            content=raw,
            headers={
                "X-Hub-Signature-256": _sign("fbsecret", raw),
                "Content-Type": "application/json",
            },
        )
    assert resp.status_code == 200
    assert resp.json()["data"]["session_ids"] == [str(sid)]


@pytest.mark.asyncio
async def test_webhook_channel_type_mismatch_404(monkeypatch):
    # public_key 命中的是 telegram 渠道,但打 whatsapp webhook → 404
    ch = _fake_channel(channel_out.CHANNEL_TELEGRAM)

    async def fake_lookup(db, key):
        return ch

    monkeypatch.setattr(channel_api, "_channel_by_public_key", fake_lookup)
    app = _build_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.post(
            "/api/v1/channel/whatsapp/webhook/pk",
            content=b"{}",
            headers={"X-Hub-Signature-256": "sha256=x"},
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_set_whatsapp_config_stores_and_masks(monkeypatch):
    ch = _fake_channel(channel_out.CHANNEL_WHATSAPP)
    principal = Principal(staff_id=uuid.uuid4(), tenant_id=ch.tenant_id, roles=["admin"])

    async def fake_owned(db, tenant_id, channel_id):
        return ch

    monkeypatch.setattr(channel_api, "_get_owned_channel", fake_owned)
    app = _build_app(principal=principal)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.put(
            f"/api/v1/channel/{ch.id}/whatsapp/config",
            json={
                "phone_number_id": "PNID1",
                "access_token": "EAAG-longsecrettoken",
                "verify_token": "verifytok",
                "app_secret": "appsecretvalue",
            },
            headers={"Authorization": "Bearer x"},
        )
    assert resp.status_code == 200
    data = resp.json()["data"]
    # 已寫入底層 config:機敏欄位靜態加密(enc:: 前綴),解密後為原值
    assert ch.config["phone_number_id"] == "PNID1"
    assert crypto.is_encrypted(ch.config["access_token"])
    assert crypto.decrypt(ch.config["access_token"]) == "EAAG-longsecrettoken"
    # 回應遮罩機密欄位(不外露 enc:: 也不外露明文)
    assert data["config"]["phone_number_id"] == "PNID1"
    assert "…" in data["config"]["access_token"]
    assert "enc::" not in data["config"]["access_token"]
    assert "…" in data["config"]["app_secret"]


@pytest.mark.asyncio
async def test_set_facebook_config_wrong_type(monkeypatch):
    ch = _fake_channel(channel_out.CHANNEL_WHATSAPP)  # 型別不符
    principal = Principal(staff_id=uuid.uuid4(), tenant_id=ch.tenant_id, roles=["admin"])

    async def fake_owned(db, tenant_id, channel_id):
        return ch

    monkeypatch.setattr(channel_api, "_get_owned_channel", fake_owned)
    app = _build_app(principal=principal)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.put(
            f"/api/v1/channel/{ch.id}/facebook/config",
            json={"page_id": "PAGE1", "page_access_token": "tkn"},
            headers={"Authorization": "Bearer x"},
        )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "CHANNEL_WRONG_TYPE"


@pytest.mark.asyncio
async def test_set_whatsapp_config_masked_resubmit_keeps_secret(monkeypatch):
    # 前端把遮罩值(含 …)原樣送回 → 不覆寫既有 access_token
    ch = _fake_channel(
        channel_out.CHANNEL_WHATSAPP, phone_number_id="PNID1", access_token="realtoken1234"
    )
    principal = Principal(staff_id=uuid.uuid4(), tenant_id=ch.tenant_id, roles=["admin"])

    async def fake_owned(db, tenant_id, channel_id):
        return ch

    monkeypatch.setattr(channel_api, "_get_owned_channel", fake_owned)
    app = _build_app(principal=principal)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.put(
            f"/api/v1/channel/{ch.id}/whatsapp/config",
            json={"phone_number_id": "PNID1", "access_token": "real…1234"},
            headers={"Authorization": "Bearer x"},
        )
    assert resp.status_code == 200
    # 沿用既有值(未被遮罩值覆寫);底層可能為明文或已加密,解密後應仍為原值
    assert crypto.decrypt(ch.config["access_token"]) == "realtoken1234"
