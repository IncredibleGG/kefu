"""行動推播(services/push.py)與各掛勾點測試(docs/NATIVE-CLIENTS.md §4.3)。

涵蓋:
- 設定:未設定時完全不動作(不建任務、不打網路);JSON 內容 / 檔案路徑 / project id 覆寫。
- FCM HTTP v1:服務帳號 RS256 JWT 換 access token(快取)、訊息 body(android 頻道
  kefu_messages、tag / apns collapse-id / thread-id、data 全為字串)、UNREGISTERED /
  INVALID_ARGUMENT 撤銷權杖、429 / 5xx 重試 2 次、401 重換 token、絕不拋錯。
- 判斷:只推負責真人坐席、AI 接待不推、坐席 / 租戶停用不推、前景連線不推、
  15 秒合併、指派 / 轉接給自己不推、桌面裝置不推、在地化與 KEFU_PUSH_PREVIEW。
- 掛勾:routing._do_assign、channel_out.ingest_inbound、/transfer、/handoff、/ws/widget
  皆在 commit 之後才呼叫 push。
- dispatch._persist_message 降級路徑仍補發 message.new / session.activity。

HTTP 用 httpx.MockTransport,Redis 用假物件(realtime.set_client),DB 用 SQLite。
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from urllib.parse import parse_qs

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.pool import NullPool, StaticPool


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(type_, compiler, **kw):  # noqa: ANN001, ANN201
    return "TEXT"


@compiles(PGUUID, "sqlite")
def _compile_uuid_sqlite(type_, compiler, **kw):  # noqa: ANN001, ANN201
    return "CHAR(32)"


import app.models  # noqa: E402,F401
from app.api.v1 import conversation as conv_api  # noqa: E402
from app.core.db import Base  # noqa: E402
from app.core.deps import Principal  # noqa: E402
from app.models.conversation import Channel, Message, Session  # noqa: E402
from app.models.device import DeviceToken  # noqa: E402
from app.models.iam import SkillGroup, Staff  # noqa: E402
from app.models.tenancy import Tenant  # noqa: E402
from app.models.visitor import Visitor  # noqa: E402
from app.services import channel_out, dispatch, presence, push, realtime  # noqa: E402
from app.services import conversation as conv_svc  # noqa: E402
from app.services import routing as routing_svc  # noqa: E402
from app.services.telegram import NormalizedInbound  # noqa: E402

_TABLES = [
    t.__table__
    for t in (Tenant, Staff, SkillGroup, Channel, Visitor, Session, Message, DeviceToken)
]


# =========================================================================== #
# 假 Redis / 假 FCM
# =========================================================================== #
class FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.ttl: dict[str, int] = {}
        self.hashes: dict[str, dict[str, str]] = {}
        self.published: list[tuple[str, dict]] = []

    async def set(self, key, value, nx=False, ex=None):  # noqa: ANN001
        if nx and key in self.store:
            return None
        self.store[key] = value
        if ex is not None:
            self.ttl[key] = ex
        return True

    async def hset(self, key, field, value):  # noqa: ANN001
        self.hashes.setdefault(key, {})[field] = value
        return 1

    async def hgetall(self, key):  # noqa: ANN001
        return dict(self.hashes.get(key, {}))

    async def hdel(self, key, *fields):  # noqa: ANN001
        h = self.hashes.get(key, {})
        for f in fields:
            h.pop(f, None)
        return 1

    async def expire(self, key, seconds):  # noqa: ANN001
        return True

    async def publish(self, channel, data):  # noqa: ANN001
        self.published.append((channel, json.loads(data)))
        return 0

    def pubsub(self):
        return _NeverPubSub()

    def events(self, type_: str) -> list[tuple[str, dict]]:
        return [(c, e) for c, e in self.published if e.get("type") == type_]


class _NeverPubSub:
    async def subscribe(self, *chs):  # noqa: ANN002
        pass

    async def unsubscribe(self, *chs):  # noqa: ANN002
        pass

    async def aclose(self):
        pass

    async def listen(self):
        await asyncio.Event().wait()
        yield {}  # pragma: no cover


class BrokenRedis:
    def __getattr__(self, name):  # noqa: ANN001
        async def _fail(*a, **kw):  # noqa: ANN002, ANN003
            raise ConnectionError("redis down")

        return _fail


class FCMStub:
    """MockTransport handler:token 端點固定成功;send 依 send_responses 佇列回應(預設 200)。"""

    def __init__(self) -> None:
        self.token_requests: list[httpx.Request] = []
        self.send_requests: list[httpx.Request] = []
        self.send_responses: list = []
        self.token_status = 200

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "oauth2.googleapis.com":
            self.token_requests.append(request)
            if self.token_status != 200:
                return httpx.Response(self.token_status, json={"error": "invalid_grant"})
            n = len(self.token_requests)
            return httpx.Response(200, json={"access_token": f"at-{n}", "expires_in": 3600})
        self.send_requests.append(request)
        if self.send_responses:
            item = self.send_responses.pop(0)
            if isinstance(item, Exception):
                raise item
            status, body = item
            return httpx.Response(status, json=body)
        return httpx.Response(200, json={"name": "projects/kefu-test/messages/1"})

    def sent_bodies(self) -> list[dict]:
        return [json.loads(r.content) for r in self.send_requests]


def _fcm_error(status: int, code: str, *, detail: str | None = None) -> tuple[int, dict]:
    err: dict = {"code": status, "message": "x", "status": code}
    if detail:
        err["details"] = [
            {"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": detail}
        ]
    return status, {"error": err}


# =========================================================================== #
# fixtures
# =========================================================================== #
@pytest.fixture(scope="module")
def rsa_keys():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    public_pem = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    return private_pem, public_pem


def _service_account(private_pem: str) -> dict:
    return {
        "type": "service_account",
        "project_id": "kefu-test",
        "private_key_id": "kid-1",
        "private_key": private_pem,
        "client_email": "push@kefu-test.iam.gserviceaccount.com",
        "token_uri": "https://evil.example.com/token",  # 不得被採用
    }


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    """每個測試:清環境變數 / 快取 / 注入點,避免互相汙染。"""
    for name in (push.ENV_SERVICE_ACCOUNT, push.ENV_PROJECT_ID, push.ENV_PREVIEW):
        monkeypatch.delenv(name, raising=False)
    push._sa_cache.clear()
    push._reset_token_cache()
    monkeypatch.setattr(push, "RETRY_BACKOFF", (0.0, 0.0))
    fake = FakeRedis()
    realtime.set_client(fake)
    yield fake
    realtime.set_client(None)
    push.set_transport(None)
    push.set_session_factory(None)
    push._sa_cache.clear()
    push._reset_token_cache()


@pytest.fixture
def fake_redis(_isolate):
    return _isolate


@pytest.fixture
def fcm(monkeypatch, rsa_keys):
    """已設定的 FCM(JSON 內容)+ MockTransport。"""
    monkeypatch.setenv(push.ENV_SERVICE_ACCOUNT, json.dumps(_service_account(rsa_keys[0])))
    stub = FCMStub()
    push.set_transport(httpx.MockTransport(stub))
    return stub


@pytest_asyncio.fixture
async def factory():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=_TABLES))
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    push.set_session_factory(maker)
    yield maker
    await engine.dispose()


async def _seed(
    maker,
    *,
    handler_type: str = "human",
    with_handler: bool = True,
    staff_active: bool = True,
    tenant_active: bool = True,
    devices: tuple[tuple[str, str | None], ...] = (("android", "zh-TW"), ("ios", "zh-TW"), ("desktop", None)),
    visitor_name: str | None = "小明",
    content: str = "你好,請問訂單 4111 1111 1111 1111 到了嗎?",
    content_type: str = "text",
    token_prefix: str = "tok",
):
    async with maker() as db:
        tid = uuid.uuid4()
        db.add(Tenant(id=tid, name="Acme", slug=f"acme-{tid.hex[:8]}", is_active=tenant_active))
        staff = Staff(
            tenant_id=tid, email=f"{uuid.uuid4().hex[:6]}@x.com", password_hash="x",
            display_name="Agent", status="online", is_active=staff_active,
        )
        other = Staff(
            tenant_id=tid, email=f"{uuid.uuid4().hex[:6]}@x.com", password_hash="x",
            display_name="Other", status="online", is_active=True,
        )
        ch = Channel(tenant_id=tid, type="web", name="web")
        db.add_all([staff, other, ch])
        await db.flush()
        vis = Visitor(tenant_id=tid, channel_id=ch.id, external_id="v1", display_name=visitor_name)
        db.add(vis)
        await db.flush()
        sess = Session(
            tenant_id=tid, channel_id=ch.id, visitor_id=vis.id, status="open",
            handler_type=handler_type, handler_staff_id=staff.id if with_handler else None,
        )
        db.add(sess)
        await db.flush()
        msg = Message(
            tenant_id=tid, session_id=sess.id, sender_type="visitor", sender_id=vis.id,
            content_type=content_type, content=conv_svc.mask_card_numbers(content),
        )
        db.add(msg)
        for i, (platform, locale) in enumerate(devices):
            db.add(
                DeviceToken(
                    tenant_id=tid, staff_id=staff.id, platform=platform, token=f"{token_prefix}-{i}-{platform}",
                    device_id=f"dev-{i}", app_version="0.1.0", locale=locale,
                )
            )
        await db.commit()
        return SimpleNamespace(
            tid=tid, staff=staff.id, other=other.id, session=sess.id, message=msg.id, visitor=vis.id
        )


async def _devices(maker, staff_id) -> dict[str, DeviceToken]:
    async with maker() as db:
        rows = (await db.execute(select(DeviceToken).where(DeviceToken.staff_id == staff_id))).scalars()
        return {r.token: r for r in rows}


# =========================================================================== #
# 設定
# =========================================================================== #
@pytest.mark.asyncio
async def test_not_configured_is_complete_noop(factory, monkeypatch):
    calls = []
    push.set_transport(httpx.MockTransport(lambda r: calls.append(r) or httpx.Response(200)))
    s = await _seed(factory)
    assert push.is_configured() is False
    assert push.on_visitor_message(s.tid, s.session, s.message) is None
    assert push.on_assigned(s.tid, s.session, s.staff, "auto") is None
    assert push.on_transfer(s.tid, s.session, s.staff, s.other) is None
    assert not push._tasks
    assert calls == []


def test_is_configured_variants(monkeypatch, tmp_path, rsa_keys):
    sa = _service_account(rsa_keys[0])
    monkeypatch.setenv(push.ENV_SERVICE_ACCOUNT, json.dumps(sa))
    assert push.is_configured() is True

    # 檔案路徑
    path = tmp_path / "sa.json"
    path.write_text(json.dumps(sa), encoding="utf-8")
    monkeypatch.setenv(push.ENV_SERVICE_ACCOUNT, str(path))
    assert push.is_configured() is True

    # 檔案不存在 / 非 JSON / 缺欄位
    monkeypatch.setenv(push.ENV_SERVICE_ACCOUNT, str(tmp_path / "missing.json"))
    assert push.is_configured() is False
    monkeypatch.setenv(push.ENV_SERVICE_ACCOUNT, "{not json")
    assert push.is_configured() is False
    monkeypatch.setenv(push.ENV_SERVICE_ACCOUNT, json.dumps({"project_id": "kefu-test"}))
    assert push.is_configured() is False

    # 沒有 project_id → 需 KEFU_FCM_PROJECT_ID;不合法的 project id 拒絕
    no_pid = {k: v for k, v in sa.items() if k != "project_id"}
    monkeypatch.setenv(push.ENV_SERVICE_ACCOUNT, json.dumps(no_pid))
    assert push.is_configured() is False
    monkeypatch.setenv(push.ENV_PROJECT_ID, "other-project")
    assert push.is_configured() is True
    monkeypatch.setenv(push.ENV_PROJECT_ID, "../evil")
    assert push.is_configured() is False


def test_preview_flag(monkeypatch):
    assert push.preview_enabled() is True
    for v in ("false", "0", "off", "No"):
        monkeypatch.setenv(push.ENV_PREVIEW, v)
        assert push.preview_enabled() is False
    monkeypatch.setenv(push.ENV_PREVIEW, "true")
    assert push.preview_enabled() is True


def test_resolve_lang():
    assert push.resolve_lang(None) == "zh-Hant"
    assert push.resolve_lang("") == "zh-Hant"
    assert push.resolve_lang("zh-TW") == "zh-Hant"
    assert push.resolve_lang("zh_HK") == "zh-Hant"
    assert push.resolve_lang("zh-Hant-TW") == "zh-Hant"
    assert push.resolve_lang("zh-CN") == "zh-CN"
    assert push.resolve_lang("zh-Hans") == "zh-CN"
    assert push.resolve_lang("en-US") == "en"
    assert push.resolve_lang("ja-JP") == "ja"
    assert push.resolve_lang("fr-FR") == "en"  # 不支援 → en


def test_build_texts():
    assert push.build_texts("message", "zh-Hant", preview=False, visitor_name="小明", body_text="hi") == (
        "新訊息",
        "訪客傳來一則新訊息",
    )
    assert push.build_texts("message", "en", preview=True, visitor_name="Amy", body_text="hello") == (
        "Amy",
        "hello",
    )
    # 沒有文字預覽(圖片等)→ 附件字樣
    assert push.build_texts("message", "zh-CN", preview=True, visitor_name=None, body_text="") == (
        "新消息",
        "[附件]",
    )
    title, body = push.build_texts("transfer", "zh-Hant", preview=True, visitor_name="小明", body_text="VIP")
    assert title == "有會話轉接給你" and body == "小明：VIP"
    title, body = push.build_texts("assigned", "en", preview=False, visitor_name="Amy", body_text=None)
    assert title == "Conversation assigned to you" and "Amy" not in body


# =========================================================================== #
# 送出流程
# =========================================================================== #
@pytest.mark.asyncio
async def test_visitor_message_push_payload(factory, fcm, rsa_keys):
    s = await _seed(factory)
    task = push.on_visitor_message(s.tid, s.session, s.message)
    assert task is not None
    await task

    # access token:RS256 JWT,固定打 oauth2.googleapis.com(不採用 JSON 內的 token_uri)
    assert len(fcm.token_requests) == 1
    form = parse_qs(fcm.token_requests[0].content.decode())
    assert form["grant_type"] == ["urn:ietf:params:oauth:grant-type:jwt-bearer"]
    from jose import jwt

    claims = jwt.decode(
        form["assertion"][0], rsa_keys[1], algorithms=["RS256"], audience=push.OAUTH_TOKEN_URL
    )
    assert claims["iss"] == "push@kefu-test.iam.gserviceaccount.com"
    assert claims["scope"] == push.FCM_SCOPE
    assert claims["exp"] - claims["iat"] == 3600
    assert jwt.get_unverified_header(form["assertion"][0])["kid"] == "kid-1"

    # 只推 android + ios(桌面只登記不推)
    assert len(fcm.send_requests) == 2
    for req in fcm.send_requests:
        assert str(req.url) == "https://fcm.googleapis.com/v1/projects/kefu-test/messages:send"
        assert req.headers["Authorization"] == "Bearer at-1"
    bodies = fcm.sent_bodies()
    assert sorted(b["message"]["token"] for b in bodies) == ["tok-0-android", "tok-1-ios"]
    m = bodies[0]["message"]
    sid = str(s.session)
    assert m["data"] == {"type": "message", "session_id": sid, "tenant_id": str(s.tid)}
    assert all(isinstance(v, str) for v in m["data"].values())
    assert m["android"] == {
        "priority": "HIGH",
        "notification": {"channel_id": "kefu_messages", "tag": sid},
    }
    assert m["apns"]["headers"] == {"apns-priority": "10", "apns-collapse-id": sid}
    assert m["apns"]["payload"]["aps"] == {"sound": "default", "thread-id": sid}
    # 預覽:標題為訪客名、內容為遮罩後的訊息
    assert m["notification"]["title"] == "小明"
    assert "4111 1111 1111 1111" not in m["notification"]["body"]
    assert "1111" in m["notification"]["body"]
    assert m["notification"]["body"].startswith("你好")

    # 第二則推播(另一會話)沿用快取的 access token
    s2 = await _seed(factory, token_prefix="second")
    await push.on_visitor_message(s2.tid, s2.session, s2.message)
    assert len(fcm.token_requests) == 1


@pytest.mark.asyncio
async def test_preview_off_and_locales(factory, fcm, monkeypatch):
    monkeypatch.setenv(push.ENV_PREVIEW, "false")
    s = await _seed(factory, devices=(("android", "en-US"), ("ios", "fr-FR"), ("android", "zh-CN"), ("android", None)))
    await push.on_visitor_message(s.tid, s.session, s.message)
    by_token = {b["message"]["token"]: b["message"]["notification"] for b in fcm.sent_bodies()}
    assert by_token["tok-0-android"] == {"title": "New message", "body": "A visitor sent a new message"}
    assert by_token["tok-1-ios"]["title"] == "New message"  # 不支援語系 → en
    assert by_token["tok-2-android"] == {"title": "新消息", "body": "访客发来一条新消息"}
    assert by_token["tok-3-android"] == {"title": "新訊息", "body": "訪客傳來一則新訊息"}
    for n in by_token.values():
        assert "小明" not in n["title"] + n["body"]


@pytest.mark.asyncio
async def test_ai_handled_or_unassigned_session_not_pushed(factory, fcm):
    s = await _seed(factory, handler_type="ai", with_handler=False)
    r = await push._run("message", s.tid, s.session, message_id=s.message)
    assert r["reason"] == "not_human"
    s2 = await _seed(factory, handler_type="human", with_handler=False, token_prefix="second")
    r = await push._run("message", s2.tid, s2.session, message_id=s2.message)
    assert r["reason"] == "not_human"
    assert fcm.send_requests == []


@pytest.mark.asyncio
async def test_non_visitor_message_not_pushed(factory, fcm):
    s = await _seed(factory)
    async with factory() as db:
        m = Message(tenant_id=s.tid, session_id=s.session, sender_type="human", content="hi")
        db.add(m)
        await db.commit()
        mid = m.id
    r = await push._run("message", s.tid, s.session, message_id=mid)
    assert r["reason"] == "message"
    # 他租戶的 tenant_id 對不上會話 → 不推
    r = await push._run("message", uuid.uuid4(), s.session, message_id=s.message)
    assert r["reason"] == "session"
    assert fcm.send_requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize("kw", [{"staff_active": False}, {"tenant_active": False}])
async def test_inactive_staff_or_tenant_not_pushed(factory, fcm, kw):
    s = await _seed(factory, **kw)
    r = await push._run("message", s.tid, s.session, message_id=s.message)
    assert r["reason"] == "staff_inactive"
    assert fcm.send_requests == []


@pytest.mark.asyncio
async def test_soft_deleted_staff_not_pushed(factory, fcm):
    s = await _seed(factory)
    async with factory() as db:
        (await db.get(Staff, s.staff)).deleted_at = datetime.now(UTC)
        await db.commit()
    r = await push._run("message", s.tid, s.session, message_id=s.message)
    assert r["reason"] == "staff_inactive"


@pytest.mark.asyncio
async def test_foreground_connection_suppresses_push(factory, fcm, fake_redis):
    s = await _seed(factory)
    conn = presence.Connection(staff_id=str(s.staff), device_id="desk", platform="desktop")
    await presence.register(conn)
    r = await push._run("message", s.tid, s.session, message_id=s.message)
    assert r["reason"] == "foreground"
    assert fcm.send_requests == []

    # 轉到背景 → 推
    await presence.set_foreground(conn, False)
    r = await push._run("message", s.tid, s.session, message_id=s.message)
    assert r["status"] == "sent" and r["sent"] == 2


@pytest.mark.asyncio
async def test_dedupe_within_window(factory, fcm, fake_redis):
    s = await _seed(factory)
    r1 = await push._run("message", s.tid, s.session, message_id=s.message)
    r2 = await push._run("message", s.tid, s.session, message_id=s.message)
    assert r1["status"] == "sent"
    assert r2["reason"] == "dedupe"
    key = push.dedupe_key(s.staff, s.session, "message")
    assert fake_redis.ttl[key] == 15
    assert len(fcm.send_requests) == 2  # 兩台行動裝置、只推一輪

    # 視窗過期(鍵消失)→ 再推
    fake_redis.store.pop(key)
    r3 = await push._run("message", s.tid, s.session, message_id=s.message)
    assert r3["status"] == "sent"


@pytest.mark.asyncio
async def test_assigned_claims_message_slot(factory, fcm, fake_redis):
    """AI 轉人:指派推播送出後,同一會話緊接著的訊息推播被合併。"""
    s = await _seed(factory)
    r = await push._run("assigned", s.tid, s.session, target=s.staff)
    assert r["status"] == "sent"
    assert fcm.sent_bodies()[0]["message"]["data"]["type"] == "assigned"
    assert fcm.sent_bodies()[0]["message"]["notification"]["title"] == "有會話指派給你"
    r = await push._run("message", s.tid, s.session, message_id=s.message)
    assert r["reason"] == "dedupe"


@pytest.mark.asyncio
async def test_redis_down_fails_open(factory, fcm):
    s = await _seed(factory)
    realtime.set_client(BrokenRedis())
    r = await push._run("message", s.tid, s.session, message_id=s.message)
    assert r["status"] == "sent" and r["sent"] == 2


@pytest.mark.asyncio
async def test_assigned_and_transfer_rules(factory, fcm):
    s = await _seed(factory)
    # 操作者就是被指派者 / 轉給自己 → 不建任務
    assert push.on_assigned(s.tid, s.session, s.staff, str(s.staff)) is None
    assert push.on_transfer(s.tid, s.session, s.staff, s.staff) is None
    # 會話已不歸目標坐席 → 不推
    r = await push._run("assigned", s.tid, s.session, target=s.other)
    assert r["reason"] == "not_handler"
    # 轉接給我:帶附言(預覽開啟時)
    task = push.on_transfer(s.tid, s.session, s.staff, s.other, "VIP 客戶")
    await task
    m = fcm.sent_bodies()[0]["message"]
    assert m["data"]["type"] == "transfer"
    assert m["notification"] == {"title": "有會話轉接給你", "body": "小明：VIP 客戶"}


@pytest.mark.asyncio
async def test_no_mobile_devices(factory, fcm):
    s = await _seed(factory, devices=(("desktop", None),))
    r = await push._run("message", s.tid, s.session, message_id=s.message)
    assert r["reason"] == "no_devices"
    assert fcm.token_requests == [] and fcm.send_requests == []


@pytest.mark.asyncio
async def test_revoked_devices_skipped(factory, fcm):
    s = await _seed(factory)
    async with factory() as db:
        for d in (await db.execute(select(DeviceToken))).scalars():
            if d.platform == "ios":
                d.revoked_at = datetime.now(UTC)
        await db.commit()
    await push._run("message", s.tid, s.session, message_id=s.message)
    assert [b["message"]["token"] for b in fcm.sent_bodies()] == ["tok-0-android"]


# =========================================================================== #
# FCM 錯誤處理
# =========================================================================== #
@pytest.mark.asyncio
async def test_unregistered_and_invalid_argument_revoke(factory, fcm):
    s = await _seed(factory)
    fcm.send_responses = [
        _fcm_error(404, "NOT_FOUND", detail="UNREGISTERED"),
        _fcm_error(400, "INVALID_ARGUMENT", detail="INVALID_ARGUMENT"),
    ]
    r = await push._run("message", s.tid, s.session, message_id=s.message)
    assert r == {"status": "sent", "sent": 0, "revoked": 2, "failed": 0}
    devs = await _devices(factory, s.staff)
    assert devs["tok-0-android"].revoked_at is not None
    assert devs["tok-1-ios"].revoked_at is not None
    assert devs["tok-2-desktop"].revoked_at is None
    assert len(fcm.send_requests) == 2  # 不重試


@pytest.mark.asyncio
async def test_plain_404_does_not_revoke(factory, fcm):
    """404 但沒有 UNREGISTERED 錯誤碼(例 project id 設錯)→ 不可誤撤權杖。"""
    s = await _seed(factory, devices=(("android", None),))
    fcm.send_responses = [_fcm_error(404, "NOT_FOUND")]
    r = await push._run("message", s.tid, s.session, message_id=s.message)
    assert r["failed"] == 1 and r["revoked"] == 0
    assert (await _devices(factory, s.staff))["tok-0-android"].revoked_at is None


@pytest.mark.asyncio
async def test_retry_on_429_and_5xx(factory, fcm):
    s = await _seed(factory, devices=(("android", None),))
    fcm.send_responses = [_fcm_error(503, "UNAVAILABLE"), _fcm_error(429, "RESOURCE_EXHAUSTED")]
    r = await push._run("message", s.tid, s.session, message_id=s.message)
    assert r["sent"] == 1
    assert len(fcm.send_requests) == 3


@pytest.mark.asyncio
async def test_retry_gives_up_after_two_retries(factory, fcm):
    s = await _seed(factory, devices=(("android", None),))
    fcm.send_responses = [_fcm_error(500, "INTERNAL")] * 5
    r = await push._run("message", s.tid, s.session, message_id=s.message)
    assert r["failed"] == 1
    assert len(fcm.send_requests) == 3  # 1 次 + 重試 2 次
    assert (await _devices(factory, s.staff))["tok-0-android"].revoked_at is None


@pytest.mark.asyncio
async def test_other_4xx_not_retried(factory, fcm):
    s = await _seed(factory, devices=(("android", None),))
    fcm.send_responses = [_fcm_error(403, "PERMISSION_DENIED", detail="SENDER_ID_MISMATCH")]
    r = await push._run("message", s.tid, s.session, message_id=s.message)
    assert r["failed"] == 1 and len(fcm.send_requests) == 1


@pytest.mark.asyncio
async def test_401_refreshes_access_token_once(factory, fcm):
    s = await _seed(factory, devices=(("android", None),))
    fcm.send_responses = [_fcm_error(401, "UNAUTHENTICATED")]
    r = await push._run("message", s.tid, s.session, message_id=s.message)
    assert r["sent"] == 1
    assert len(fcm.token_requests) == 2
    assert fcm.send_requests[-1].headers["Authorization"] == "Bearer at-2"


@pytest.mark.asyncio
async def test_transport_errors_never_raise(factory, fcm):
    s = await _seed(factory, devices=(("android", None),))
    fcm.send_responses = [httpx.ConnectError("boom")] * 3
    r = await push._run("message", s.tid, s.session, message_id=s.message)
    assert r["failed"] == 1 and len(fcm.send_requests) == 3


@pytest.mark.asyncio
async def test_token_exchange_failure_never_raises(factory, fcm):
    s = await _seed(factory, devices=(("android", None),))
    fcm.token_status = 400
    task = push.on_visitor_message(s.tid, s.session, s.message)
    await task  # 不拋錯
    assert fcm.send_requests == []


@pytest.mark.asyncio
async def test_background_task_exceptions_are_swallowed(factory, fcm, monkeypatch):
    s = await _seed(factory)

    async def _boom(*a, **kw):  # noqa: ANN002, ANN003
        raise RuntimeError("db exploded")

    monkeypatch.setattr(push, "_run", _boom)
    task = push.on_visitor_message(s.tid, s.session, s.message)
    assert task in push._tasks  # 保留強參照
    await task
    assert task.exception() is None
    await asyncio.sleep(0)
    assert task not in push._tasks


def test_on_hooks_without_running_loop_are_noop(monkeypatch, rsa_keys):
    monkeypatch.setenv(push.ENV_SERVICE_ACCOUNT, json.dumps(_service_account(rsa_keys[0])))
    assert push.on_visitor_message(uuid.uuid4(), uuid.uuid4(), uuid.uuid4()) is None
    assert push.on_assigned("not-a-uuid", uuid.uuid4(), uuid.uuid4()) is None


# =========================================================================== #
# 掛勾點(全部在 commit 之後)
# =========================================================================== #
def _track_commits(db, order: list[str]) -> None:
    real_commit = db.commit

    async def _commit():
        order.append("commit")
        await real_commit()

    db.commit = _commit  # type: ignore[method-assign]


@pytest.mark.asyncio
async def test_routing_assign_hook_after_commit(factory, monkeypatch):
    s = await _seed(factory, with_handler=False, handler_type="ai")
    order: list[str] = []
    calls: list[tuple] = []

    def _rec(*args):  # noqa: ANN002
        order.append("push")
        calls.append(args)

    monkeypatch.setattr(push, "on_assigned", _rec)
    async with factory() as db:
        _track_commits(db, order)
        got = await routing_svc.manual_assign(db, s.tid, s.session, s.staff, actor_staff_id=s.other)
    assert got == s.staff
    assert order == ["commit", "push"]
    tid, sid, staff_id, actor = calls[0]
    assert (tid, sid, staff_id, actor) == (s.tid, s.session, s.staff, str(s.other))


@pytest.mark.asyncio
async def test_routing_hook_failure_does_not_break_assignment(factory, monkeypatch):
    s = await _seed(factory, with_handler=False, handler_type="ai")

    def _boom(*a):  # noqa: ANN002
        raise RuntimeError("push broken")

    monkeypatch.setattr(push, "on_assigned", _boom)
    async with factory() as db:
        assert await routing_svc.manual_assign(db, s.tid, s.session, s.staff) == s.staff


@pytest.mark.asyncio
async def test_ingest_inbound_hook_after_both_commits(monkeypatch):
    order: list[str] = []
    calls: list[tuple] = []
    sid, mid = uuid.uuid4(), uuid.uuid4()

    class _Db:
        async def commit(self):
            order.append("commit")

        async def rollback(self):
            order.append("rollback")

    async def get_or_create_visitor(db, tenant_id, channel_id, external_id, **kw):  # noqa: ANN001, ANN003
        return SimpleNamespace(id=uuid.uuid4())

    async def get_or_open_session(db, tenant_id, channel_id, visitor_id):  # noqa: ANN001
        return SimpleNamespace(id=sid)

    async def add_message(db, tenant_id, session_id, sender_type, content, **kw):  # noqa: ANN001, ANN003
        return SimpleNamespace(id=mid)

    async def handle_inbound(db, tenant_id, session_id, message_id):  # noqa: ANN001
        order.append("dispatch")

    reg = {
        ("app.services.visitor", "get_or_create_visitor"): get_or_create_visitor,
        ("app.services.conversation", "get_or_open_session"): get_or_open_session,
        ("app.services.conversation", "add_message"): add_message,
        ("app.services.dispatch", "handle_inbound"): handle_inbound,
    }
    monkeypatch.setattr(channel_out, "_resolve_seam", lambda m, a: reg.get((m, a)))
    monkeypatch.setattr(channel_out, "_translate_inbound", lambda *a: asyncio.sleep(0))

    def _rec(*args):  # noqa: ANN002
        order.append("push")
        calls.append(args)

    monkeypatch.setattr(push, "on_visitor_message", _rec)
    tid = uuid.uuid4()
    result = await channel_out.ingest_inbound(_Db(), tid, uuid.uuid4(), NormalizedInbound(external_id="1", text="hi"))
    assert result == sid
    assert order == ["commit", "dispatch", "commit", "push"]
    assert calls == [(tid, sid, mid)]


@pytest.mark.asyncio
async def test_transfer_and_handoff_hooks_after_commit(factory, monkeypatch, fake_redis):
    s = await _seed(factory)
    order: list[str] = []
    calls: list[tuple] = []

    def _rec(*args):  # noqa: ANN002
        order.append("push")
        calls.append(args)

    monkeypatch.setattr(push, "on_transfer", _rec)
    me = Principal(staff_id=s.staff, tenant_id=s.tid, roles=["admin"])

    # /transfer 給另一位坐席(帶附言)
    async with factory() as db:
        _track_commits(db, order)
        r = await conv_api.transfer(
            s.session, conv_api.TransferIn(target_staff_id=s.other, note="VIP"), me, db
        )
    assert r["ok"] is True
    assert order == ["commit", "push"]
    assert calls[-1] == (s.tid, s.session, s.other, s.staff, "VIP")

    # /transfer 只轉技能組(無坐席)→ 不推
    order.clear()
    async with factory() as db:
        _track_commits(db, order)
        await conv_api.transfer(s.session, conv_api.TransferIn(), me, db)
    assert order == ["commit"]

    # /handoff takeover → 不推;transfer 給另一位 → commit 後推
    order.clear()
    async with factory() as db:
        _track_commits(db, order)
        await conv_api.handoff(s.session, conv_api.HandoffIn(action="takeover"), me, db)
    assert order == ["commit"]
    async with factory() as db:
        _track_commits(db, order)
        await conv_api.handoff(
            s.session, conv_api.HandoffIn(action="transfer", handler_staff_id=s.other), me, db
        )
    assert order == ["commit", "commit", "push"]
    assert calls[-1] == (s.tid, s.session, s.other, s.staff, None)


def test_ws_widget_hook_after_commit(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    url = f"sqlite+aiosqlite:///{tmp_path / 'widget.db'}"
    engine = create_async_engine(url, poolclass=NullPool)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _create():
        async with engine.begin() as conn:
            await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=_TABLES))
        return await _seed(maker, devices=())

    s = asyncio.run(_create())
    monkeypatch.setattr(conv_api, "SessionLocal", maker)
    fake = FakeRedis()
    realtime.set_client(fake)
    calls: list[tuple] = []
    monkeypatch.setattr(push, "on_visitor_message", lambda *a: calls.append(a))

    app = FastAPI()
    app.include_router(conv_api.ws_router)
    with TestClient(app) as client:
        with client.websocket_connect(
            f"/ws/widget?tenant_id={s.tid}&session_id={s.session}&visitor_external_id=v1"
        ) as ws:
            ws.send_json({"type": "message", "payload": {"content": "在嗎"}})
            deadline = time.time() + 5
            while not calls and time.time() < deadline:
                time.sleep(0.02)

    assert len(calls) == 1
    tid, sid, mid = calls[0]
    assert (tid, sid) == (s.tid, s.session)

    async def _check():
        async with maker() as db:
            msg = await db.get(Message, mid)
            return msg.content if msg else None

    assert asyncio.run(_check()) == "在嗎"  # push 被呼叫時訊息已 commit
    asyncio.run(engine.dispose())


# =========================================================================== #
# dispatch 降級寫入仍補發即時事件
# =========================================================================== #
@pytest.mark.asyncio
async def test_dispatch_fallback_publishes_events(factory, fake_redis, monkeypatch):
    s = await _seed(factory, devices=())

    async def _broken_add_message(*a, **kw):  # noqa: ANN002, ANN003
        raise RuntimeError("add_message broken")

    monkeypatch.setattr(conv_svc, "add_message", _broken_add_message)
    async with factory() as db:
        msg = await dispatch._persist_message(
            db, s.tid, s.session, sender_type="ai", content="您的卡 4111 1111 1111 1111 已收到",
            meta={"confidence": 0.9},
        )
        await db.commit()
        mid = msg.id

    news = fake_redis.events("message.new")
    assert len(news) == 1
    channel, evt = news[0]
    assert channel == realtime.session_channel(s.tid, s.session)
    p = evt["payload"]
    assert p["message_id"] == str(mid)
    assert p["sender_type"] == "ai"
    assert p["content_type"] == "text"
    assert "4111 1111 1111 1111" not in p["content"]
    assert p["meta"] == {"confidence": 0.9}

    acts = fake_redis.events("session.activity")
    assert len(acts) == 1
    channel, evt = acts[0]
    assert channel == realtime.agents_channel(s.tid)
    a = evt["payload"]
    assert a["message_id"] == str(mid)
    assert a["handler_type"] == "human"
    assert a["handler_staff_id"] == str(s.staff)
    assert a["visitor_id"] == str(s.visitor)
    assert a["last_message_at"]
    assert "4111 1111 1111 1111" not in a["preview"]

    async with factory() as db:
        stored = await db.get(Message, mid)
        assert "4111 1111 1111 1111" not in stored.content
        assert (await db.get(Session, s.session)).last_message_at is not None


@pytest.mark.asyncio
async def test_dispatch_fallback_survives_redis_down(factory, monkeypatch):
    s = await _seed(factory, devices=())
    realtime.set_client(BrokenRedis())

    async def _broken_add_message(*a, **kw):  # noqa: ANN002, ANN003
        raise RuntimeError("add_message broken")

    monkeypatch.setattr(conv_svc, "add_message", _broken_add_message)
    async with factory() as db:
        msg = await dispatch._persist_message(db, s.tid, s.session, sender_type="ai", content="hi")
        await db.commit()
        assert msg.id is not None
