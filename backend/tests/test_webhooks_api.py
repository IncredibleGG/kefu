"""對外 Webhook + 開放 API 測試。

覆蓋(不依賴外部 Postgres / Redis / 真實 HTTP):
  1. 純邏輯:HMAC 簽章、body 組裝、API key 產生 / 雜湊 / 定速比對 / 遮罩。
  2. 派送:_deliver_one 重試退避(mock _send / _sleep)、deliver_event 只送給
     「本租戶、訂閱該事件、啟用中」的 endpoint 且簽章正確。
  3. 埋點:add_message 會觸發 message.created webhook 外送(mock realtime / _send)。
  4. ext 認證:get_api_key_context 以雜湊比對定位租戶、更新 last_used_at;
     缺金鑰 / 無效金鑰一律 401。

型別 shim 讓 pg 專屬型別(UUID / JSONB)於記憶體 SQLite 可用(不影響正式 pg)。
"""
from __future__ import annotations

import json
import uuid

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.pool import StaticPool

# --- 測試專用型別 shim:讓 pg 專屬型別在 SQLite 上可用(不影響正式 pg 行為) ---


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(type_, compiler, **kw):  # noqa: ANN001, ANN201
    return "TEXT"


@compiles(PGUUID, "sqlite")
def _compile_uuid_sqlite(type_, compiler, **kw):  # noqa: ANN001, ANN201
    return "CHAR(32)"


from app.core import apikey_auth  # noqa: E402
from app.core.db import Base  # noqa: E402
from app.models.automation import AutomationRule  # noqa: E402
from app.models.conversation import Channel, Message, Session  # noqa: E402
from app.models.tenancy import Tenant  # noqa: E402
from app.models.visitor import Contact, Visitor  # noqa: E402
from app.models.webhook import ApiKey, WebhookEndpoint  # noqa: E402
from app.services import conversation as conv_svc  # noqa: E402
from app.services import webhooks as svc  # noqa: E402

_TABLES = [
    t.__table__
    for t in (
        Tenant,
        Channel,
        Contact,
        Visitor,
        Session,
        Message,
        AutomationRule,
        WebhookEndpoint,
        ApiKey,
    )
]


# ===========================================================================
# 純邏輯:簽章 / body / api key(無 DB)
# ===========================================================================
def test_sign_matches_hmac_sha256():
    import hashlib
    import hmac

    body = '{"event":"x","data":{},"ts":"t"}'
    expected = hmac.new(b"s3cr3t", body.encode(), hashlib.sha256).hexdigest()
    assert svc.sign("s3cr3t", body) == expected
    # 不同 secret → 不同簽章
    assert svc.sign("other", body) != expected


def test_build_body_shape():
    body = svc.build_body("conversation.created", {"session_id": "abc"}, ts="2026-01-01T00:00:00Z")
    parsed = json.loads(body)
    assert parsed["event"] == "conversation.created"
    assert parsed["data"] == {"session_id": "abc"}
    assert parsed["ts"] == "2026-01-01T00:00:00Z"


def test_api_key_generate_and_hash():
    raw, prefix, key_hash = apikey_auth.generate_api_key()
    assert raw.startswith("kefu_")
    assert raw.startswith(prefix)  # prefix 為明文頭段
    assert key_hash == apikey_auth.hash_api_key(raw)
    # 雜湊為 sha256 hexdigest(64 hex 字元)
    assert len(key_hash) == 64
    # 定速比對:正確金鑰過、錯誤金鑰不過
    assert apikey_auth.verify_api_key(raw, key_hash) is True
    assert apikey_auth.verify_api_key("kefu_wrong", key_hash) is False


def test_api_key_hash_is_deterministic_and_unique():
    r1, _, h1 = apikey_auth.generate_api_key()
    r2, _, h2 = apikey_auth.generate_api_key()
    assert r1 != r2 and h1 != h2  # 每把不同
    assert apikey_auth.hash_api_key(r1) == h1  # 同輸入穩定


def test_mask_key_reveals_only_prefix():
    masked = apikey_auth.mask_key("kefu_ab12cd")
    assert masked.startswith("kefu_ab12cd")
    assert "…" in masked


# ===========================================================================
# 派送:_deliver_one 重試 / deliver_event 過濾與簽章(DB + mock IO)
# ===========================================================================
@pytest_asyncio.fixture
async def db():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=_TABLES))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


@pytest.mark.asyncio
async def test_deliver_one_retries_then_succeeds(monkeypatch):
    """前兩次失敗、第三次成功;退避睡眠被 mock 掉,總嘗試 3 次。"""
    attempts: list[int] = []
    sleeps: list[float] = []

    async def _fake_send(url, body, signature, event):
        attempts.append(1)
        if len(attempts) < 3:
            raise RuntimeError("boom")  # 連線失敗
        return 200

    async def _fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(svc, "_send", _fake_send)
    monkeypatch.setattr(svc, "_sleep", _fake_sleep)

    ok_ = await svc._deliver_one("https://x.test/hook", "sec", "message.created", {"a": 1})
    assert ok_ is True
    assert len(attempts) == 3
    assert len(sleeps) == 2  # 兩次失敗後各退避一次


@pytest.mark.asyncio
async def test_deliver_one_gives_up_after_max_attempts(monkeypatch):
    """一直非 2xx → 用盡重試後回 False,不拋。"""
    attempts: list[int] = []

    async def _fake_send(url, body, signature, event):
        attempts.append(1)
        return 500

    monkeypatch.setattr(svc, "_send", _fake_send)
    monkeypatch.setattr(svc, "_sleep", lambda *_a, **_k: _noop())
    ok_ = await svc._deliver_one("https://x.test/hook", "sec", "message.created", None)
    assert ok_ is False
    assert len(attempts) == svc._MAX_ATTEMPTS


async def _noop():
    return None


@pytest.mark.asyncio
async def test_deliver_event_filters_and_signs(monkeypatch, db):
    """只送給:本租戶、訂閱該事件、啟用中的 endpoint;送出的簽章可被重現。"""
    tid = uuid.uuid4()
    other = uuid.uuid4()
    db.add(Tenant(id=tid, name="Acme", slug=f"a-{tid.hex[:8]}"))
    db.add(Tenant(id=other, name="Other", slug=f"o-{other.hex[:8]}"))

    # 命中:同租戶、訂閱、啟用
    hit = WebhookEndpoint(
        tenant_id=tid, url="https://hit.test/h", events=["message.created"],
        secret="secretA", is_active=True,
    )
    # 未訂閱此事件
    no_sub = WebhookEndpoint(
        tenant_id=tid, url="https://nosub.test/h", events=["conversation.closed"],
        secret="s", is_active=True,
    )
    # 停用
    inactive = WebhookEndpoint(
        tenant_id=tid, url="https://inactive.test/h", events=["message.created"],
        secret="s", is_active=False,
    )
    # 別的租戶
    other_ep = WebhookEndpoint(
        tenant_id=other, url="https://other.test/h", events=["message.created"],
        secret="s", is_active=True,
    )
    db.add_all([hit, no_sub, inactive, other_ep])
    await db.commit()

    calls: list[dict] = []

    async def _fake_send(url, body, signature, event):
        calls.append({"url": url, "body": body, "signature": signature, "event": event})
        return 200

    monkeypatch.setattr(svc, "_send", _fake_send)
    monkeypatch.setattr(svc, "_sleep", lambda *_a, **_k: _noop())

    await svc.deliver_event(db, tid, "message.created", {"session_id": "s1"})

    # 只有命中的 endpoint 被送到
    assert len(calls) == 1
    c = calls[0]
    assert c["url"] == "https://hit.test/h"
    assert c["event"] == "message.created"
    # 簽章可用該 endpoint 的 secret 對送出的 body 重現
    assert c["signature"] == svc.sign("secretA", c["body"])
    # body 內含事件與資料
    parsed = json.loads(c["body"])
    assert parsed["event"] == "message.created"
    assert parsed["data"] == {"session_id": "s1"}


@pytest.mark.asyncio
async def test_deliver_event_no_endpoints_noop(monkeypatch, db):
    """無訂閱 endpoint 時不呼叫 _send、不拋。"""
    tid = uuid.uuid4()
    db.add(Tenant(id=tid, name="Acme", slug=f"a-{tid.hex[:8]}"))
    await db.commit()

    called: list[int] = []

    async def _fake_send(*_a, **_k):
        called.append(1)
        return 200

    monkeypatch.setattr(svc, "_send", _fake_send)
    await svc.deliver_event(db, tid, "message.created", {})
    assert called == []


# ===========================================================================
# 埋點:add_message 觸發 message.created webhook 外送
# ===========================================================================
@pytest.mark.asyncio
async def test_add_message_delivers_webhook(monkeypatch, db):
    """add_message 落訊後應派送 message.created(與 realtime / automation 並存)。"""
    tid = uuid.uuid4()
    db.add(Tenant(id=tid, name="Acme", slug=f"a-{tid.hex[:8]}"))
    ch = Channel(tenant_id=tid, type="web", name="ch")
    db.add(ch)
    await db.flush()
    vis = Visitor(tenant_id=tid, channel_id=ch.id, external_id="v1")
    db.add(vis)
    await db.flush()
    sess = Session(tenant_id=tid, channel_id=ch.id, visitor_id=vis.id, status="open", handler_type="ai")
    db.add(sess)
    await db.flush()
    db.add(
        WebhookEndpoint(
            tenant_id=tid, url="https://hook.test/h", events=["message.created"],
            secret="sec", is_active=True,
        )
    )
    await db.commit()

    # realtime 走 Redis,測試以 no-op 取代
    async def _noop_pub(*_a, **_k):
        return None

    from app.services import realtime

    monkeypatch.setattr(realtime, "publish", _noop_pub)
    monkeypatch.setattr(realtime, "publish_agents", _noop_pub)

    sent: list[dict] = []

    async def _fake_send(url, body, signature, event):
        sent.append({"url": url, "event": event, "body": body})
        return 200

    monkeypatch.setattr(svc, "_send", _fake_send)
    monkeypatch.setattr(svc, "_sleep", lambda *_a, **_k: _noop())

    await conv_svc.add_message(db, tid, sess.id, "visitor", "哈囉", sender_id=vis.id)

    assert len(sent) == 1
    assert sent[0]["event"] == "message.created"
    parsed = json.loads(sent[0]["body"])
    assert parsed["data"]["session_id"] == str(sess.id)
    assert parsed["data"]["sender_type"] == "visitor"


# ===========================================================================
# ext 認證:get_api_key_context
# ===========================================================================
@pytest.mark.asyncio
async def test_api_key_auth_resolves_tenant_and_touches_last_used(db):
    tid = uuid.uuid4()
    db.add(Tenant(id=tid, name="Acme", slug=f"a-{tid.hex[:8]}"))
    raw, prefix, key_hash = apikey_auth.generate_api_key()
    k = ApiKey(tenant_id=tid, name="ext", key_prefix=prefix, key_hash=key_hash, is_active=True)
    db.add(k)
    await db.commit()

    # Bearer 形式
    ctx = await apikey_auth.get_api_key_context(db=db, authorization=f"Bearer {raw}")
    assert ctx.tenant_id == tid
    assert ctx.api_key_id == k.id

    # X-Api-Key 形式亦可
    ctx2 = await apikey_auth.get_api_key_context(db=db, x_api_key=raw)
    assert ctx2.tenant_id == tid

    # last_used_at 已被更新
    await db.refresh(k)
    assert k.last_used_at is not None


@pytest.mark.asyncio
async def test_api_key_auth_missing_key_401(db):
    with pytest.raises(HTTPException) as ei:
        await apikey_auth.get_api_key_context(db=db)
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_api_key_auth_invalid_key_401(db):
    with pytest.raises(HTTPException) as ei:
        await apikey_auth.get_api_key_context(db=db, authorization="Bearer kefu_nope")
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_api_key_auth_revoked_key_401(db):
    """撤銷(is_active=False)的金鑰不得通過認證。"""
    tid = uuid.uuid4()
    db.add(Tenant(id=tid, name="Acme", slug=f"a-{tid.hex[:8]}"))
    raw, prefix, key_hash = apikey_auth.generate_api_key()
    db.add(ApiKey(tenant_id=tid, name="k", key_prefix=prefix, key_hash=key_hash, is_active=False))
    await db.commit()

    with pytest.raises(HTTPException) as ei:
        await apikey_auth.get_api_key_context(db=db, authorization=f"Bearer {raw}")
    assert ei.value.status_code == 401
