"""Email 渠道測試(不連真信箱:解析用真位元組,收發用 mock / monkeypatch)。

涵蓋:
- parser:純文字/編碼標頭/去引言/multipart 純文字優先/僅 HTML 去標籤。
- mask_config:巢狀 imap.pass / smtp.pass 遮罩且不改到原 config。
- smtp_client._build_message:標頭與內文構造(不連網)。
- poll_email:抓信 → 解析 → 入站 → 標記已讀(imap/ingest 全 monkeypatch)。
- send_to_visitor(email 分支):以 SMTP 寄出、主旨取「Re: 原主旨」。
- API:PUT email/config(存+遮罩+密碼合併)、型別錯誤、POST email/test。
"""
from __future__ import annotations

import uuid
from email.message import EmailMessage
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from app.api.v1 import channel as channel_api
from app.core import crypto
from app.core.db import get_db
from app.services import channel_out
from app.services import email as email_service
from app.services.email import parser, smtp_client
from app.services.email import poller as email_poller


# --------------------------------------------------------------------------- #
# parser
# --------------------------------------------------------------------------- #
def _raw(from_hdr: str, subject: str, body: str, *, html: bool = False) -> bytes:
    """建構真實的 RFC822 位元組:非 ASCII 標頭自動 MIME encoded-word 編碼(如真實 MUA)。"""
    msg = EmailMessage()
    msg["From"] = from_hdr
    msg["To"] = "support@shop.example"
    msg["Subject"] = subject
    msg["Message-ID"] = "<abc123@shop.example>"
    msg.set_content(body, subtype="html" if html else "plain")
    return msg.as_bytes()


def test_parse_plain_text():
    parsed = parser.parse_email(_raw("小明 <ming@shop.example>", "訂單問題", "你好,我要退貨"))
    assert parsed.from_email == "ming@shop.example"
    assert parsed.from_name == "小明"
    assert parsed.subject == "訂單問題"
    assert parsed.body == "你好,我要退貨"
    assert parsed.message_id == "<abc123@shop.example>"


def test_parse_encoded_subject_and_name():
    # MIME encoded-word:主旨與顯示名皆為 base64/utf-8
    raw = (
        "From: =?utf-8?B?5bCP5piO?= <ming@shop.example>\r\n"
        "Subject: =?utf-8?B?6KiC5Zau5ZWP6aGM?=\r\n"
        "Content-Type: text/plain; charset=utf-8\r\n"
        "\r\n"
        "內文"
    ).encode()
    parsed = parser.parse_email(raw)
    assert parsed.from_name == "小明"
    assert parsed.subject == "訂單問題"
    assert parsed.from_email == "ming@shop.example"


def test_parse_strips_quotes():
    body = "這是我的新問題\n> 這是被引用的舊內容\nOn Mon, 1 Jan 2026, kefu wrote:\n> 更多引言"
    parsed = parser.parse_email(_raw("a@b.com", "Re: 詢問", body))
    assert "新問題" in parsed.body
    assert "被引用" not in parsed.body
    assert "wrote:" not in parsed.body


def test_parse_multipart_prefers_plain():
    msg = EmailMessage()
    msg["From"] = "Jane <jane@shop.example>"
    msg["Subject"] = "多部件"
    msg.set_content("純文字版本")
    msg.add_alternative("<p>HTML 版本</p>", subtype="html")
    parsed = parser.parse_email(msg.as_bytes())
    assert parsed.body == "純文字版本"
    assert parsed.from_email == "jane@shop.example"


def test_parse_html_only_stripped():
    raw = _raw(
        "a@b.com",
        "HTML 信",
        "<html><body><p>第一行</p><br>第二行<script>x()</script></body></html>",
        html=True,
    )
    parsed = parser.parse_email(raw)
    assert "第一行" in parsed.body
    assert "第二行" in parsed.body
    assert "<p>" not in parsed.body
    assert "x()" not in parsed.body  # script 內容被去除


def test_parse_missing_sender_is_empty():
    raw = "Subject: 無寄件人\r\nContent-Type: text/plain\r\n\r\nhi".encode()
    parsed = parser.parse_email(raw)
    assert parsed.from_email == ""


# --------------------------------------------------------------------------- #
# mask_config 巢狀密碼
# --------------------------------------------------------------------------- #
def test_mask_config_nested_email_pass():
    cfg = {
        "public_key": "pk",
        "imap": {"host": "imap.x", "user": "u", "pass": "supersecretimap"},
        "smtp": {"host": "smtp.x", "user": "u", "pass": "supersecretsmtp", "from": "a@x"},
    }
    masked = channel_out.mask_config(cfg)
    assert masked["public_key"] == "pk"
    assert masked["imap"]["pass"] != "supersecretimap"
    assert "…" in masked["imap"]["pass"]
    assert masked["smtp"]["pass"] != "supersecretsmtp"
    assert masked["smtp"]["from"] == "a@x"  # 非密碼欄位保留
    # 不可改到原 config
    assert cfg["imap"]["pass"] == "supersecretimap"
    assert cfg["smtp"]["pass"] == "supersecretsmtp"


# --------------------------------------------------------------------------- #
# smtp_client._build_message(不連網)
# --------------------------------------------------------------------------- #
def test_build_message_headers():
    cfg = {"from": "support@shop.example", "user": "support@shop.example"}
    msg = smtp_client._build_message(cfg, "visitor@x.com", "Re: 訂單", "感謝來信", None)
    assert msg["To"] == "visitor@x.com"
    assert msg["Subject"] == "Re: 訂單"
    assert msg["From"] == "support@shop.example"
    assert msg["Message-ID"]
    assert "感謝來信" in msg.get_content()


def test_build_message_requires_sender():
    with pytest.raises(email_service.EmailError):
        smtp_client._build_message({}, "v@x.com", "s", "b", None)


# --------------------------------------------------------------------------- #
# poll_email:抓信 → 解析 → 入站 → 標記已讀
# --------------------------------------------------------------------------- #
class _FakeScalars:
    def __init__(self, items):
        self._items = items

    def all(self):
        return self._items


class _FakeResult:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return _FakeScalars(self._items)


class _FakeDb:
    def __init__(self, channels):
        self._channels = channels

    async def execute(self, stmt):
        return _FakeResult(self._channels)

    async def commit(self):
        pass


def _email_channel(**imap):
    cfg = {"imap": {"host": "imap.x", "user": "u", "pass": "p", "folder": "INBOX", **imap}}
    return SimpleNamespace(
        id=uuid.uuid4(), tenant_id=uuid.uuid4(),
        type=channel_out.CHANNEL_EMAIL, config=cfg, is_active=True, deleted_at=None,
    )


@pytest.mark.asyncio
async def test_poll_email_ingests_and_marks_seen(monkeypatch):
    ch = _email_channel()
    raws = [
        email_service.RawEmail(uid="11", raw=_raw("小華 <hua@x.com>", "退款", "請退款")),
        email_service.RawEmail(uid="12", raw=_raw("no-name@x.com", "詢問", "在嗎")),
    ]

    async def fake_fetch(cfg, limit=50):
        assert cfg["host"] == "imap.x"
        return raws

    marked = {}

    async def fake_mark(cfg, uids):
        marked["uids"] = list(uids)

    ingested = []

    async def fake_ingest(db, tenant_id, channel_id, inbound):
        ingested.append(inbound)
        return uuid.uuid4()

    monkeypatch.setattr(email_poller.imap_client, "fetch_unseen", fake_fetch)
    monkeypatch.setattr(email_poller.imap_client, "mark_seen", fake_mark)
    monkeypatch.setattr(email_poller.channel_out, "ingest_inbound", fake_ingest)

    summary = await email_poller.poll_email(_FakeDb([ch]))
    assert summary == {"channels": 1, "fetched": 2, "ingested": 2, "errors": 0}
    assert set(marked["uids"]) == {"11", "12"}
    # external_id = 寄件人 email;內容 = 主旨 + 內文
    first = ingested[0]
    assert first.external_id == "hua@x.com"
    assert first.display_name == "小華"
    assert "退款" in first.text and "請退款" in first.text
    assert first.meta["provider"] == "email"
    assert first.meta["subject"] == "退款"


@pytest.mark.asyncio
async def test_poll_email_degrade_not_marked_seen(monkeypatch):
    """入站降級(session_id=None)時不標記已讀,下輪可重試。"""
    ch = _email_channel()

    async def fake_fetch(cfg, limit=50):
        return [email_service.RawEmail(uid="9", raw=_raw("a@x.com", "s", "b"))]

    marked = {"called": False}

    async def fake_mark(cfg, uids):
        marked["called"] = True

    async def fake_ingest(db, tenant_id, channel_id, inbound):
        return None  # 核心 seam 未就緒

    monkeypatch.setattr(email_poller.imap_client, "fetch_unseen", fake_fetch)
    monkeypatch.setattr(email_poller.imap_client, "mark_seen", fake_mark)
    monkeypatch.setattr(email_poller.channel_out, "ingest_inbound", fake_ingest)

    summary = await email_poller.poll_email(_FakeDb([ch]))
    assert summary["errors"] == 1 and summary["ingested"] == 0
    assert marked["called"] is False  # 沒有要標記已讀的 UID


@pytest.mark.asyncio
async def test_poll_email_fetch_failure_isolated(monkeypatch):
    ch = _email_channel()

    async def boom(cfg, limit=50):
        raise email_service.EmailError("connect refused")

    monkeypatch.setattr(email_poller.imap_client, "fetch_unseen", boom)
    summary = await email_poller.poll_email(_FakeDb([ch]))
    assert summary["channels"] == 1 and summary["errors"] == 1 and summary["fetched"] == 0


# --------------------------------------------------------------------------- #
# send_to_visitor:email 分支
# --------------------------------------------------------------------------- #
def _fake_ctx_loader(ctype, cfg, external_id):
    async def loader(db, tenant_id, session_id):
        return channel_out._DeliveryContext(
            channel_type=ctype, channel_config=cfg, external_id=external_id
        )

    return loader


@pytest.mark.asyncio
async def test_send_to_visitor_email_sends_smtp(monkeypatch):
    tid, sid = uuid.uuid4(), uuid.uuid4()
    smtp_cfg = {"host": "smtp.x", "user": "support@x", "from": "support@x"}
    monkeypatch.setattr(
        channel_out, "_load_delivery_context",
        _fake_ctx_loader(channel_out.CHANNEL_EMAIL, {"smtp": smtp_cfg}, external_id="v@x.com"),
    )

    async def fake_subject(db, tenant_id, session_id, cfg):
        return "Re: 原主旨"

    monkeypatch.setattr(channel_out, "_resolve_reply_subject", fake_subject)

    sent = {}

    async def fake_send(cfg, to_addr, subject, body, **kw):
        sent.update(cfg=cfg, to=to_addr, subject=subject, body=body)

    monkeypatch.setattr(email_service, "send_email", fake_send)

    await channel_out.send_to_visitor(None, tid, sid, "這是回覆")
    assert sent["to"] == "v@x.com"
    assert sent["subject"] == "Re: 原主旨"
    assert sent["body"] == "這是回覆"


@pytest.mark.asyncio
async def test_send_to_visitor_email_missing_config_noop(monkeypatch):
    tid, sid = uuid.uuid4(), uuid.uuid4()
    monkeypatch.setattr(
        channel_out, "_load_delivery_context",
        _fake_ctx_loader(channel_out.CHANNEL_EMAIL, {}, external_id="v@x.com"),
    )
    called = {"sent": False}

    async def fake_send(*a, **k):
        called["sent"] = True

    monkeypatch.setattr(email_service, "send_email", fake_send)
    # 缺 smtp.host → 不寄、不拋
    await channel_out.send_to_visitor(None, tid, sid, "x")
    assert called["sent"] is False


@pytest.mark.asyncio
async def test_send_to_visitor_email_send_error_swallowed(monkeypatch):
    tid, sid = uuid.uuid4(), uuid.uuid4()
    monkeypatch.setattr(
        channel_out, "_load_delivery_context",
        _fake_ctx_loader(
            channel_out.CHANNEL_EMAIL, {"smtp": {"host": "smtp.x"}}, external_id="v@x.com"
        ),
    )

    async def fake_subject(db, tenant_id, session_id, cfg):
        return "客服回覆"

    monkeypatch.setattr(channel_out, "_resolve_reply_subject", fake_subject)

    async def boom(*a, **k):
        raise email_service.EmailError("smtp down")

    monkeypatch.setattr(email_service, "send_email", boom)
    # SMTP 失敗只記 log,不應拋
    await channel_out.send_to_visitor(None, tid, sid, "x")


# --------------------------------------------------------------------------- #
# _resolve_reply_subject
# --------------------------------------------------------------------------- #
class _SubjResult:
    def __init__(self, row):
        self._row = row

    def scalar_one_or_none(self):
        return self._row


class _SubjDb:
    def __init__(self, row):
        self._row = row

    async def execute(self, stmt):
        return _SubjResult(self._row)


@pytest.mark.asyncio
async def test_resolve_reply_subject_from_meta():
    row = SimpleNamespace(meta={"subject": "訂單 #123"})
    subj = await channel_out._resolve_reply_subject(_SubjDb(row), uuid.uuid4(), uuid.uuid4(), {})
    assert subj == "Re: 訂單 #123"


@pytest.mark.asyncio
async def test_resolve_reply_subject_no_double_re():
    row = SimpleNamespace(meta={"subject": "Re: 訂單 #123"})
    subj = await channel_out._resolve_reply_subject(_SubjDb(row), uuid.uuid4(), uuid.uuid4(), {})
    assert subj == "Re: 訂單 #123"


@pytest.mark.asyncio
async def test_resolve_reply_subject_default_when_missing():
    subj = await channel_out._resolve_reply_subject(
        _SubjDb(None), uuid.uuid4(), uuid.uuid4(), {"reply_subject": "我方回覆"}
    )
    assert subj == "我方回覆"


# --------------------------------------------------------------------------- #
# test_connection(__init__)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_test_connection_reports_both(monkeypatch):
    async def ok_imap(cfg):
        return None

    async def bad_smtp(cfg):
        raise email_service.EmailError("auth failed")

    monkeypatch.setattr(email_service, "check_imap", ok_imap)
    monkeypatch.setattr(email_service, "check_smtp", bad_smtp)
    result = await email_service.test_connection({"imap": {}, "smtp": {}})
    assert result["imap"] == {"ok": True}
    assert result["smtp"]["ok"] is False and "auth failed" in result["smtp"]["error"]


# --------------------------------------------------------------------------- #
# API:PUT email/config + POST email/test
# --------------------------------------------------------------------------- #
def _build_app():
    app = FastAPI()
    app.include_router(channel_api.router, prefix="/api/v1/channel")

    async def _fake_db():
        yield object()

    app.dependency_overrides[get_db] = _fake_db
    return app


def _override_staff(app):
    from app.core.deps import Principal, get_current_principal

    principal = Principal(staff_id=uuid.uuid4(), tenant_id=uuid.uuid4(), roles=["admin"])

    async def _fake_principal():
        return principal

    app.dependency_overrides[get_current_principal] = _fake_principal
    return principal


class _CommitDb:
    """夠用的假 DB:支援 commit/refresh(端點不真的查 DB)。"""

    async def commit(self):
        pass

    async def refresh(self, obj):
        pass


async def _commit_db_dep():
    yield _CommitDb()


@pytest.mark.asyncio
async def test_put_email_config_stores_and_masks(monkeypatch):
    app = _build_app()
    _override_staff(app)
    ch = SimpleNamespace(
        id=uuid.uuid4(), tenant_id=uuid.uuid4(), type="email", name="信箱",
        config={"public_key": "pk"}, is_active=True, created_at=None, deleted_at=None,
    )

    async def fake_owned(db, tenant_id, channel_id):
        return ch

    monkeypatch.setattr(channel_api, "_get_owned_channel", fake_owned)
    # 端點內用到的 db.commit/refresh:改用 _CommitDb
    app.dependency_overrides[get_db] = _commit_db_dep

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
    data = resp.json()["data"]
    # 存進 channel.config:密碼靜態加密(enc::),解密後為原值;回應遮罩
    assert crypto.is_encrypted(ch.config["imap"]["pass"])
    assert crypto.decrypt(ch.config["imap"]["pass"]) == "imapsecretvalue"
    assert ch.config["smtp"]["from"] == "u2"  # from 預設用 user
    assert "…" in data["config"]["imap"]["pass"]
    assert "enc::" not in data["config"]["imap"]["pass"]
    assert data["config"]["smtp"]["pass"] != "smtpsecretvalue"


@pytest.mark.asyncio
async def test_put_email_config_keeps_prev_pass_when_masked(monkeypatch):
    """送回遮罩值(含 …)或留空 → 沿用既有密碼。"""
    app = _build_app()
    _override_staff(app)
    ch = SimpleNamespace(
        id=uuid.uuid4(), tenant_id=uuid.uuid4(), type="email", name="信箱",
        config={"imap": {"pass": "OLDIMAPPASS"}, "smtp": {"pass": "OLDSMTPPASS"}},
        is_active=True, created_at=None, deleted_at=None,
    )

    async def fake_owned(db, tenant_id, channel_id):
        return ch

    monkeypatch.setattr(channel_api, "_get_owned_channel", fake_owned)
    app.dependency_overrides[get_db] = _commit_db_dep

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.put(
            f"/api/v1/channel/{ch.id}/email/config",
            json={
                "imap": {"host": "imap.x", "user": "u", "pass": "OLD…PASS"},  # 遮罩樣式
                "smtp": {"host": "smtp.x", "user": "u"},  # 留空
            },
            headers={"Authorization": "Bearer x"},
        )
    assert resp.status_code == 200
    # 沿用既有值(未被遮罩/留空覆寫);底層可能為明文或已加密,解密後應仍為原值
    assert crypto.decrypt(ch.config["imap"]["pass"]) == "OLDIMAPPASS"
    assert crypto.decrypt(ch.config["smtp"]["pass"]) == "OLDSMTPPASS"


@pytest.mark.asyncio
async def test_put_email_config_wrong_type(monkeypatch):
    app = _build_app()
    _override_staff(app)
    ch = SimpleNamespace(
        id=uuid.uuid4(), tenant_id=uuid.uuid4(), type="telegram", name="tg", config={},
        is_active=True, created_at=None, deleted_at=None,
    )

    async def fake_owned(db, tenant_id, channel_id):
        return ch

    monkeypatch.setattr(channel_api, "_get_owned_channel", fake_owned)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.put(
            f"/api/v1/channel/{ch.id}/email/config",
            json={
                "imap": {"host": "i", "user": "u", "pass": "p"},
                "smtp": {"host": "s", "user": "u", "pass": "p"},
            },
            headers={"Authorization": "Bearer x"},
        )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "CHANNEL_WRONG_TYPE"


@pytest.mark.asyncio
async def test_post_email_test_endpoint(monkeypatch):
    app = _build_app()
    _override_staff(app)
    ch = SimpleNamespace(
        id=uuid.uuid4(), tenant_id=uuid.uuid4(), type="email", name="信箱",
        config={"imap": {"host": "i"}, "smtp": {"host": "s"}},
        is_active=True, created_at=None, deleted_at=None,
    )

    async def fake_owned(db, tenant_id, channel_id):
        return ch

    async def fake_test(config):
        return {"imap": {"ok": True}, "smtp": {"ok": False, "error": "boom"}}

    monkeypatch.setattr(channel_api, "_get_owned_channel", fake_owned)
    monkeypatch.setattr(channel_api.email_service, "test_connection", fake_test)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        resp = await c.post(
            f"/api/v1/channel/{ch.id}/email/test", headers={"Authorization": "Bearer x"}
        )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["ok"] is False
    assert data["imap"]["ok"] is True
    assert data["smtp"]["error"] == "boom"
