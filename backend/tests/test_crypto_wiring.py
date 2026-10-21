"""機敏欄位靜態加密(at-rest)接線測試。

驗證三件核心事:
1. **寫入時加密**:設定端點寫入後,``channel.config`` / ``Tenant.llm_config`` 內的機敏欄位
   為 ``enc::`` 密文(解密後等於原值),且「留空/遮罩沿用」邏輯不受破壞。
2. **取用時解密**:真正呼叫外部 API(telegram / whatsapp / smtp)前,機敏值已被 decrypt
   成明文才交給 client;webhook 驗證(secret / app_secret / verify_token)前亦先 decrypt。
3. **遮罩不外露**:mask_config 對外回應「既不含 ``enc::`` 也不含完整明文」,僅露解密後尾4碼。

另涵蓋一次性遷移 ``encrypt_existing_secrets`` 的正確性與冪等性。
全程不連真 DB / 外部服務:以 monkeypatch + ASGITransport + fake client 模擬。
"""
from __future__ import annotations

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
from app.services import translation
from app.services.email import smtp_client


# --------------------------------------------------------------------------- #
# 共用假件
# --------------------------------------------------------------------------- #
class _ApiDb:
    async def commit(self):
        pass

    async def refresh(self, obj):
        pass


def _build_app(principal: Principal | None = None) -> FastAPI:
    app = FastAPI()
    app.include_router(channel_api.router, prefix="/api/v1/channel")

    async def _fake_db():
        yield _ApiDb()

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


def _fake_ctx_loader(ctype, cfg, external_id):
    async def loader(db, tenant_id, session_id):
        return channel_out._DeliveryContext(
            channel_type=ctype, channel_config=cfg, external_id=external_id
        )

    return loader


# --------------------------------------------------------------------------- #
# 1) 寫入時加密:config 內為 enc::(API 端點)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_write_whatsapp_config_stores_ciphertext(monkeypatch):
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
                "verify_token": "verifytok-1234",
                "app_secret": "appsecretvalue-1234",
            },
            headers={"Authorization": "Bearer x"},
        )
    assert resp.status_code == 200
    # 底層 config:機敏欄位皆為 enc:: 密文,解密後為原值;識別碼不加密
    assert ch.config["phone_number_id"] == "PNID1"
    for key, plain in (
        ("access_token", "EAAG-longsecrettoken"),
        ("verify_token", "verifytok-1234"),
        ("app_secret", "appsecretvalue-1234"),
    ):
        assert crypto.is_encrypted(ch.config[key]), key
        assert crypto.decrypt(ch.config[key]) == plain, key


@pytest.mark.asyncio
async def test_write_email_config_stores_ciphertext(monkeypatch):
    ch = _fake_channel(channel_out.CHANNEL_EMAIL, public_key="pk")
    principal = Principal(staff_id=uuid.uuid4(), tenant_id=ch.tenant_id, roles=["admin"])

    async def fake_owned(db, tenant_id, channel_id):
        return ch

    monkeypatch.setattr(channel_api, "_get_owned_channel", fake_owned)
    app = _build_app(principal=principal)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.put(
            f"/api/v1/channel/{ch.id}/email/config",
            json={
                "imap": {"host": "imap.x", "user": "u", "pass": "imapsecretvalue"},
                "smtp": {"host": "smtp.x", "user": "u2", "pass": "smtpsecretvalue"},
            },
            headers={"Authorization": "Bearer x"},
        )
    assert resp.status_code == 200
    assert crypto.is_encrypted(ch.config["imap"]["pass"])
    assert crypto.decrypt(ch.config["imap"]["pass"]) == "imapsecretvalue"
    assert crypto.is_encrypted(ch.config["smtp"]["pass"])
    assert crypto.decrypt(ch.config["smtp"]["pass"]) == "smtpsecretvalue"


# --------------------------------------------------------------------------- #
# 2) 取用時解密:送出前 client 拿到明文
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_send_telegram_decrypts_bot_token(monkeypatch):
    enc_token = crypto.encrypt("123:abcdef")
    monkeypatch.setattr(
        channel_out,
        "_load_delivery_context",
        _fake_ctx_loader(channel_out.CHANNEL_TELEGRAM, {"bot_token": enc_token}, "55"),
    )
    seen = {}

    class FakeClient:
        def __init__(self, token, **kw):
            seen["token"] = token

        async def send_message(self, chat_id, text, **kw):
            seen["send"] = (chat_id, text)

        async def send_photo(self, chat_id, photo, **kw):
            seen["photo"] = (chat_id, photo)

    monkeypatch.setattr(channel_out, "TelegramClient", FakeClient)
    await channel_out.send_to_visitor(None, uuid.uuid4(), uuid.uuid4(), "嗨")
    # client 收到的是解密後的明文,而非 enc:: 密文
    assert seen["token"] == "123:abcdef"
    assert seen["send"] == ("55", "嗨")


@pytest.mark.asyncio
async def test_send_whatsapp_decrypts_access_token(monkeypatch):
    enc = crypto.encrypt("EAAG-secret")
    monkeypatch.setattr(
        channel_out,
        "_load_delivery_context",
        _fake_ctx_loader(
            channel_out.CHANNEL_WHATSAPP,
            {"phone_number_id": "PNID1", "access_token": enc},
            "wa1",
        ),
    )
    seen = {}

    class FakeWA:
        def __init__(self, phone_number_id, access_token, **kw):
            seen["init"] = (phone_number_id, access_token)

        async def send_text(self, rid, text, **kw):
            seen["send"] = (rid, text)

    monkeypatch.setattr(channel_out, "WhatsAppClient", FakeWA)
    await channel_out.send_to_visitor(None, uuid.uuid4(), uuid.uuid4(), "hi")
    assert seen["init"] == ("PNID1", "EAAG-secret")  # 明文 token
    assert seen["send"] == ("wa1", "hi")


@pytest.mark.asyncio
async def test_smtp_client_decrypts_pass(monkeypatch):
    """送信前 SMTP client 以解密後明文登入(涵蓋 poller / test / 出站共用的 _connect)。"""
    captured = {}

    class FakeSMTP:
        def __init__(self, host, port, timeout=None):
            captured["conn"] = (host, port)

        def ehlo(self):
            pass

        def starttls(self):
            captured["starttls"] = True

        def login(self, user, password):
            captured["login"] = (user, password)

        def send_message(self, msg):
            captured["sent"] = True

        def quit(self):
            pass

    monkeypatch.setattr(smtp_client.smtplib, "SMTP", FakeSMTP)
    cfg = {
        "host": "smtp.x",
        "port": 587,
        "tls": True,
        "user": "u",
        "pass": crypto.encrypt("smtpsecret"),
        "from": "u@x",
    }
    await smtp_client.send_email(cfg, "to@x", "主旨", "內文")
    assert captured["login"] == ("u", "smtpsecret")  # 解密後明文,而非 enc::


@pytest.mark.asyncio
async def test_telegram_webhook_decrypts_stored_secret(monkeypatch):
    """webhook 驗 secret 前先解密:密文存的 secret,前端送明文 header 應驗過。"""
    ch = _fake_channel(
        channel_out.CHANNEL_TELEGRAM,
        webhook_secret=crypto.encrypt("realsecret"),
        allow_groups=False,
    )

    async def fake_lookup(db, key):
        return ch

    async def fake_ingest(db, tenant_id, channel_id, inbound):
        return uuid.uuid4()

    monkeypatch.setattr(channel_api, "_channel_by_public_key", fake_lookup)
    monkeypatch.setattr(channel_out, "ingest_inbound", fake_ingest)
    app = _build_app()
    transport = httpx.ASGITransport(app=app)
    body = {
        "update_id": 1,
        "message": {
            "message_id": 3,
            "chat": {"id": 777, "type": "private"},
            "from": {"id": 777, "first_name": "A"},
            "text": "你好",
        },
    }
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        good = await c.post(
            "/api/v1/channel/telegram/webhook/pk",
            json=body,
            headers={"X-Telegram-Bot-Api-Secret-Token": "realsecret"},
        )
        bad = await c.post(
            "/api/v1/channel/telegram/webhook/pk",
            json=body,
            headers={"X-Telegram-Bot-Api-Secret-Token": "WRONG"},
        )
    assert good.status_code == 200  # 解密後與明文 header 相符
    assert bad.status_code == 403


@pytest.mark.asyncio
async def test_custom_translation_decrypts_api_key(monkeypatch):
    """custom 翻譯供應商:呼叫外部端點前 api_key 已解密置入 Authorization 標頭。"""
    seen = {}

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"text": "hola", "source_lang": "en"}

    class _FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, endpoint, json=None, headers=None):
            seen["headers"] = headers
            return _Resp()

    monkeypatch.setattr(translation.httpx, "AsyncClient", _FakeClient)
    cfg = {"endpoint": "https://x/translate", "api_key": crypto.encrypt("ck-secret")}
    out = await translation._custom_translate("hello", "es", "en", cfg)
    assert out["text"] == "hola"
    assert seen["headers"]["Authorization"] == "Bearer ck-secret"  # 明文,而非 enc::


# --------------------------------------------------------------------------- #
# 3) 遮罩不外露:mask 先解密再遮罩,回應不含 enc:: 也不含明文
# --------------------------------------------------------------------------- #
def test_mask_config_decrypts_then_masks_no_leak():
    cfg = {
        "public_key": "pk",
        "bot_token": crypto.encrypt("123456:ABCDEF-ghijklmnop"),
        "imap": {"host": "imap.x", "user": "u", "pass": crypto.encrypt("supersecretimap")},
    }
    masked = channel_out.mask_config(cfg)
    assert masked["public_key"] == "pk"  # 非機敏保留

    bt = masked["bot_token"]
    assert "…" in bt and "enc::" not in bt
    assert bt.endswith("mnop")  # 遮罩的是「解密後」的真實尾4碼
    assert "123456:ABCDEF-ghijklmnop" not in bt  # 不外露完整明文

    ip = masked["imap"]["pass"]
    assert "…" in ip and "enc::" not in ip
    assert ip.endswith("imap")
    # 原 config 不被 mask 改動
    assert crypto.is_encrypted(cfg["bot_token"])
    assert crypto.is_encrypted(cfg["imap"]["pass"])


def test_mask_config_plaintext_still_masked_backward_compat():
    """舊明文(未加密)值:decrypt 原樣回傳後仍正確遮罩,不會外露明文。"""
    cfg = {"bot_token": "123456:ABCDEF-ghijklmnop", "webhook_secret": "supersecretvalue"}
    masked = channel_out.mask_config(cfg)
    assert masked["bot_token"].endswith("mnop") and "…" in masked["bot_token"]
    assert masked["webhook_secret"] != "supersecretvalue" and "…" in masked["webhook_secret"]


# --------------------------------------------------------------------------- #
# 4) 一次性遷移:正確 + 冪等
# --------------------------------------------------------------------------- #
class _MigrationDb:
    """回傳兩批(先 channels 後 tenants)的假 DB;記錄 commit 次數。"""

    def __init__(self, channels, tenants):
        self._batches = [channels, tenants]
        self._i = 0
        self.committed = 0

    async def execute(self, stmt):
        rows = self._batches[self._i]
        self._i += 1
        return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: rows))

    async def commit(self):
        self.committed += 1


@pytest.mark.asyncio
async def test_encrypt_existing_secrets_migrates_and_is_idempotent():
    ch_plain = SimpleNamespace(
        config={
            "bot_token": "123:plaintoken",
            "public_key": "pk",
            "imap": {"pass": "imapplain"},
            "smtp": {"pass": "smtpplain", "from": "a@x"},
        }
    )
    ch_already = SimpleNamespace(
        config={"access_token": crypto.encrypt("alreadyenc"), "public_key": "pk2"}
    )
    t_plain = SimpleNamespace(
        llm_config={
            "api_key": "sk-plain",
            "translation": {"provider": "custom", "api_key": "ck-plain"},
        }
    )
    t_none = SimpleNamespace(llm_config=None)

    db = _MigrationDb([ch_plain, ch_already], [t_plain, t_none])
    stats = await channel_out.encrypt_existing_secrets(db)

    # 只有「含未加密機敏」的筆數計入:ch_plain、t_plain
    assert stats == {"channels": 1, "tenants": 1}
    assert db.committed == 1

    # 明文欄位已就地加密,解密後仍為原值
    assert crypto.is_encrypted(ch_plain.config["bot_token"])
    assert crypto.decrypt(ch_plain.config["bot_token"]) == "123:plaintoken"
    assert crypto.decrypt(ch_plain.config["imap"]["pass"]) == "imapplain"
    assert crypto.decrypt(ch_plain.config["smtp"]["pass"]) == "smtpplain"
    assert ch_plain.config["public_key"] == "pk"  # 非機敏不動
    assert ch_plain.config["smtp"]["from"] == "a@x"
    assert crypto.decrypt(t_plain.llm_config["api_key"]) == "sk-plain"
    assert crypto.decrypt(t_plain.llm_config["translation"]["api_key"]) == "ck-plain"
    # 已加密者維持不變
    assert crypto.decrypt(ch_already.config["access_token"]) == "alreadyenc"

    # 冪等:再跑一次,全部已加密 → 無任何變更
    db2 = _MigrationDb([ch_plain, ch_already], [t_plain, t_none])
    stats2 = await channel_out.encrypt_existing_secrets(db2)
    assert stats2 == {"channels": 0, "tenants": 0}
