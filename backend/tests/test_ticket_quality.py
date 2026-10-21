"""M9 ticket + M10 quality 的整合測試(自包含)。

設計取捨:
- 本專案資料表用到 PostgreSQL 專屬型別(UUID/JSONB)與 pgvector,故測試需要
  一個可連的 Postgres。連不上就整檔 skip(遠端測試伺服器上會有)。
- 為免依賴 pgvector 擴充,建表時**排除**帶 Vector 欄位的 document/qa_pair
  兩張表(沒有其他表參照它們,外鍵不受影響),其餘照 metadata 建。
- 不改 main.py:在測試內把本模組 router 掛到既有 app,並以
  dependency_overrides 換掉 get_db 指向測試引擎;JWT 用真的簽發流程產生,
  一併驗證租戶隔離(tenant_id 一律來自 token,不信任外部)。

測試 DB 連線可用環境變數 KEFU_TEST_DATABASE_URL 覆寫。
"""
from __future__ import annotations

import getpass
import os
import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # noqa: F401  # 註冊所有 mapper
from app.core.db import Base, get_db
from app.core.security import create_access_token
from app.main import app
from app.models.conversation import Channel, Message, Session
from app.models.iam import Staff
from app.models.tenancy import Tenant
from app.models.visitor import Contact, Visitor

# 本模組 router 掛載(整合者在 main.py 尚未註冊,測試內自行掛上)
from app.api.v1 import quality as quality_api
from app.api.v1 import ticket as ticket_api

TEST_DB_URL = os.environ.get("KEFU_TEST_DATABASE_URL") or (
    f"postgresql+asyncpg://{getpass.getuser()}@localhost/postgres"
)

# 只建這些測試需要的表:排除帶 pgvector Vector 欄位的 document/qa_pair
_EXCLUDE = {"document", "qa_pair"}

_routes_registered = False


def _register_routes_once() -> None:
    global _routes_registered
    if not _routes_registered:
        app.include_router(ticket_api.router, prefix="/api/v1/ticket", tags=["ticket"])
        app.include_router(quality_api.router, prefix="/api/v1/quality", tags=["quality"])
        _routes_registered = True


@pytest_asyncio.fixture
async def ctx():
    """建表 + 覆寫 get_db + 播種資料 + 提供已授權的 AsyncClient。"""
    engine = create_async_engine(TEST_DB_URL)
    try:
        tables = [t for t in Base.metadata.sorted_tables if t.name not in _EXCLUDE]
        async with engine.begin() as conn:
            await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=tables))
    except Exception as exc:  # 連不上/建表失敗 → 環境不具備,跳過整組測試
        await engine.dispose()
        pytest.skip(f"需要可用的 Postgres 測試庫:{type(exc).__name__}: {exc}")

    maker = async_sessionmaker(engine, expire_on_commit=False)

    async def _override_get_db():
        async with maker() as s:
            yield s

    app.dependency_overrides[get_db] = _override_get_db
    _register_routes_once()

    # --- 播種:租戶 A(主要)、坐席、聯絡人、渠道、訪客、會話、訊息 ---
    ids: dict[str, uuid.UUID] = {}
    async with maker() as s:
        tenant = Tenant(name="Acme", slug=f"acme-{uuid.uuid4().hex[:8]}", is_active=True)
        s.add(tenant)
        await s.flush()

        staff = Staff(
            tenant_id=tenant.id,
            email=f"agent-{uuid.uuid4().hex[:6]}@acme.test",
            password_hash="x",
            display_name="Agent A",
        )
        contact = Contact(tenant_id=tenant.id, name="客戶甲")
        channel = Channel(tenant_id=tenant.id, type="web", name="Web Widget")
        s.add_all([staff, contact, channel])
        await s.flush()

        visitor = Visitor(
            tenant_id=tenant.id,
            channel_id=channel.id,
            external_id="v-1",
            contact_id=contact.id,
        )
        s.add(visitor)
        await s.flush()

        session = Session(
            tenant_id=tenant.id,
            channel_id=channel.id,
            visitor_id=visitor.id,
            status="open",
            handler_type="human",
            handler_staff_id=staff.id,
        )
        s.add(session)
        await s.flush()

        message = Message(
            tenant_id=tenant.id,
            session_id=session.id,
            sender_type="visitor",
            content="你好,我想退款",
        )
        s.add(message)
        await s.flush()

        ids = {
            "tenant_id": tenant.id,
            "staff_id": staff.id,
            "contact_id": contact.id,
            "channel_id": channel.id,
            "visitor_id": visitor.id,
            "session_id": session.id,
            "message_id": message.id,
        }
        await s.commit()

    token = create_access_token(
        {"sub": str(ids["staff_id"]), "tenant_id": str(ids["tenant_id"]), "roles": ["admin"]}
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"Authorization": f"Bearer {token}"},
    ) as client:
        yield {"client": client, "ids": ids, "maker": maker, "token": token}

    app.dependency_overrides.clear()
    await engine.dispose()


async def _seed_other_tenant(maker) -> tuple[uuid.UUID, str]:
    """再播一個租戶 B + 坐席,回傳 (tenant_id, token),用於驗證租戶隔離。"""
    async with maker() as s:
        t = Tenant(name="Other", slug=f"other-{uuid.uuid4().hex[:8]}", is_active=True)
        s.add(t)
        await s.flush()
        st = Staff(
            tenant_id=t.id,
            email=f"b-{uuid.uuid4().hex[:6]}@other.test",
            password_hash="x",
            display_name="Agent B",
        )
        s.add(st)
        await s.commit()
        token = create_access_token(
            {"sub": str(st.id), "tenant_id": str(t.id), "roles": ["admin"]}
        )
        return t.id, token


# ============================ M9 ticket ============================
@pytest.mark.asyncio
async def test_ticket_crud_and_status_flow(ctx):
    client = ctx["client"]

    # 建立
    r = await client.post(
        "/api/v1/ticket",
        json={"title": "退款申請", "description": "訂單#123", "priority": "high"},
    )
    assert r.status_code == 200, r.text
    env = r.json()
    assert env["ok"] is True
    tid = env["data"]["id"]
    assert env["data"]["status"] == "open"
    assert env["data"]["priority"] == "high"

    # 讀取
    r = await client.get(f"/api/v1/ticket/{tid}")
    assert r.json()["data"]["title"] == "退款申請"

    # 更新
    r = await client.patch(f"/api/v1/ticket/{tid}", json={"tags": ["refund", "vip"]})
    assert r.json()["data"]["tags"] == ["refund", "vip"]

    # 改狀態 -> resolved,應寫入 resolved_at
    r = await client.post(f"/api/v1/ticket/{tid}/status", json={"status": "resolved"})
    data = r.json()["data"]
    assert data["status"] == "resolved"
    assert data["resolved_at"] is not None

    # 非法狀態 -> 422
    r = await client.post(f"/api/v1/ticket/{tid}/status", json={"status": "bogus"})
    assert r.status_code == 422

    # 軟刪後查不到
    r = await client.delete(f"/api/v1/ticket/{tid}")
    assert r.json()["data"]["deleted"] is True
    r = await client.get(f"/api/v1/ticket/{tid}")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_ticket_assign(ctx):
    client, ids = ctx["client"], ctx["ids"]
    r = await client.post("/api/v1/ticket", json={"title": "指派測試"})
    tid = r.json()["data"]["id"]
    r = await client.post(
        f"/api/v1/ticket/{tid}/assign", json={"assignee_staff_id": str(ids["staff_id"])}
    )
    assert r.json()["data"]["assignee_staff_id"] == str(ids["staff_id"])
    # 取消指派
    r = await client.post(f"/api/v1/ticket/{tid}/assign", json={"assignee_staff_id": None})
    assert r.json()["data"]["assignee_staff_id"] is None


@pytest.mark.asyncio
async def test_ticket_list_filter_pagination_and_isolation(ctx):
    client, ids, maker = ctx["client"], ctx["ids"], ctx["maker"]

    # 建三張:兩張 open、一張改 pending
    for i in range(3):
        await client.post("/api/v1/ticket", json={"title": f"T{i}"})
    r = await client.get("/api/v1/ticket", params={"status": "open", "page": 1, "size": 2})
    body = r.json()["data"]
    assert body["total"] == 3
    assert len(body["items"]) == 2  # 分頁生效
    assert body["page"] == 1 and body["size"] == 2

    # 租戶隔離:租戶 B 建的工單不應出現在 A 的列表
    _tb, token_b = await _seed_other_tenant(maker)
    await client.post(
        "/api/v1/ticket",
        json={"title": "B 的工單"},
        headers={"Authorization": f"Bearer {token_b}"},
    )
    r = await client.get("/api/v1/ticket")  # 以 A 身分
    titles = [it["title"] for it in r.json()["data"]["items"]]
    assert "B 的工單" not in titles
    assert r.json()["data"]["total"] == 3


@pytest.mark.asyncio
async def test_ticket_from_session_autolinks_contact(ctx):
    client, ids = ctx["client"], ctx["ids"]
    r = await client.post(
        f"/api/v1/ticket/from-session/{ids['session_id']}",
        json={"description": "由會話建立"},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["session_id"] == str(ids["session_id"])
    # 自動帶入該會話訪客的聯絡人與當前處理者
    assert data["contact_id"] == str(ids["contact_id"])
    assert data["assignee_staff_id"] == str(ids["staff_id"])

    # 不存在的會話 -> 404
    r = await client.post(f"/api/v1/ticket/from-session/{uuid.uuid4()}", json={})
    assert r.status_code == 404


# ============================ M10 quality ============================
@pytest.mark.asyncio
async def test_service_summary_create_and_list(ctx):
    client, ids = ctx["client"], ctx["ids"]
    r = await client.post(
        "/api/v1/quality/service-summary",
        json={"session_id": str(ids["session_id"]), "category": "退款", "note": "已協助處理"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["category"] == "退款"

    r = await client.get(
        "/api/v1/quality/service-summary", params={"session_id": str(ids["session_id"])}
    )
    body = r.json()["data"]
    assert body["total"] == 1
    assert body["items"][0]["staff_id"] == str(ids["staff_id"])


@pytest.mark.asyncio
async def test_csat_public_submit_and_staff_list(ctx):
    client, ids = ctx["client"], ctx["ids"]

    # 訪客提交(不帶 Authorization):tenant 由 session 反查
    r = await client.post(
        "/api/v1/quality/csat",
        json={"session_id": str(ids["session_id"]), "rating": 5, "comment": "很滿意"},
        headers={"Authorization": ""},
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["level"] == "good"  # 5 星自動映射

    # 低分映射 bad
    r = await client.post(
        "/api/v1/quality/csat",
        json={"session_id": str(ids["session_id"]), "rating": 1},
        headers={"Authorization": ""},
    )
    assert r.json()["data"]["level"] == "bad"

    # 不存在會話 -> 404
    r = await client.post(
        "/api/v1/quality/csat",
        json={"session_id": str(uuid.uuid4()), "rating": 3},
        headers={"Authorization": ""},
    )
    assert r.status_code == 404

    # 坐席查詢(需授權)
    r = await client.get("/api/v1/quality/csat", params={"session_id": str(ids["session_id"])})
    assert r.json()["data"]["total"] == 2


@pytest.mark.asyncio
async def test_quality_record_and_sampling_filter(ctx):
    client, ids = ctx["client"], ctx["ids"]
    # session 目標、抽檢樣本
    r = await client.post(
        "/api/v1/quality/quality-record",
        json={
            "target_type": "session",
            "session_id": str(ids["session_id"]),
            "score": 90,
            "label": "優秀案例",
            "is_sampled": True,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["reviewer_staff_id"] == str(ids["staff_id"])

    # 非抽檢一筆
    await client.post(
        "/api/v1/quality/quality-record",
        json={"target_type": "session", "session_id": str(ids["session_id"]), "label": "一般"},
    )

    # 抽檢列表過濾
    r = await client.get("/api/v1/quality/quality-record", params={"is_sampled": "true"})
    body = r.json()["data"]
    assert body["total"] == 1
    assert body["items"][0]["label"] == "優秀案例"

    # message 目標但缺 message_id -> 422
    r = await client.post(
        "/api/v1/quality/quality-record", json={"target_type": "message"}
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_message_flag_writes_record_and_meta(ctx):
    client, ids, maker = ctx["client"], ctx["ids"], ctx["maker"]
    r = await client.post(
        f"/api/v1/quality/message/{ids['message_id']}/flag",
        json={"label": "違規用語", "note": "用詞不當", "score": 40},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["target_type"] == "message"
    assert data["message_id"] == str(ids["message_id"])
    record_id = data["id"]

    # Message.meta.quality 應被蓋上旗標
    async with maker() as s:
        msg = (
            await s.execute(select(Message).where(Message.id == ids["message_id"]))
        ).scalar_one()
        assert msg.meta is not None
        q = msg.meta["quality"]
        assert q["flagged"] is True
        assert q["label"] == "違規用語"
        assert q["record_id"] == record_id

    # 不存在訊息 -> 404
    r = await client.post(
        f"/api/v1/quality/message/{uuid.uuid4()}/flag", json={"label": "x"}
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_agent_monitor_lists_active_sessions(ctx):
    client, ids = ctx["client"], ctx["ids"]
    r = await client.get(f"/api/v1/quality/agent-monitor/{ids['staff_id']}")
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["count"] == 1
    sess = data["active_sessions"][0]
    assert sess["session_id"] == str(ids["session_id"])
    assert sess["last_message"]["content"] == "你好,我想退款"
