"""裝置推播權杖登記 API 測試(docs/NATIVE-CLIENTS.md §4.1:/api/v1/devices)。

涵蓋:upsert(同裝置重登記沿用同列、清除 revoked_at)、權杖在坐席間 / 本人裝置間搬家、
每人最多 10 台(撤銷最久未見)、只能撤銷 / 列出自己的裝置、桌面無權杖合成識別值、
輸入驗證,以及 push_enabled 反映 push.is_configured()。

跑在記憶體 SQLite(StaticPool)+ 型別 shim;不依賴外部 Postgres / Redis。
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.pool import StaticPool


@compiles(JSONB, "sqlite")
def _compile_jsonb_sqlite(type_, compiler, **kw):  # noqa: ANN001, ANN201
    return "TEXT"


@compiles(PGUUID, "sqlite")
def _compile_uuid_sqlite(type_, compiler, **kw):  # noqa: ANN001, ANN201
    return "CHAR(32)"


from app.api.v1 import devices as devices_api  # noqa: E402
from app.core.db import Base, get_db  # noqa: E402
from app.core.security import create_access_token  # noqa: E402
import app.models  # noqa: E402,F401
from app.models.device import DeviceToken  # noqa: E402
from app.models.iam import Staff  # noqa: E402
from app.models.tenancy import Tenant  # noqa: E402
from app.services import push  # noqa: E402

_TABLES = [Tenant.__table__, Staff.__table__, DeviceToken.__table__]


@pytest.fixture(autouse=True)
def _no_push_env(monkeypatch):
    monkeypatch.delenv(push.ENV_SERVICE_ACCOUNT, raising=False)
    monkeypatch.delenv(push.ENV_PROJECT_ID, raising=False)


@pytest_asyncio.fixture
async def env():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=_TABLES))
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(devices_api.router, prefix="/api/v1/devices")

    async def _override_get_db():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_db] = _override_get_db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client, factory
    await engine.dispose()


async def _tenant(factory, slug: str) -> uuid.UUID:
    async with factory() as db:
        t = Tenant(name=slug, slug=slug, is_active=True)
        db.add(t)
        await db.commit()
        return t.id


async def _staff(factory, tenant_id: uuid.UUID, email: str) -> uuid.UUID:
    async with factory() as db:
        s = Staff(
            tenant_id=tenant_id,
            email=email,
            password_hash="x",
            display_name=email,
            status="offline",
            is_active=True,
        )
        db.add(s)
        await db.commit()
        return s.id


def _auth(staff_id: uuid.UUID, tenant_id: uuid.UUID) -> dict[str, str]:
    token = create_access_token({"sub": str(staff_id), "tenant_id": str(tenant_id), "roles": []})
    return {"Authorization": f"Bearer {token}"}


async def _rows(factory) -> list[DeviceToken]:
    async with factory() as db:
        return list((await db.execute(select(DeviceToken))).scalars().all())


def _body(**kw) -> dict:
    data = {
        "token": "fcm-token-1",
        "platform": "android",
        "device_id": "dev-1",
        "app_version": "0.1.0",
        "os_version": "14",
        "locale": "zh-TW",
    }
    data.update(kw)
    return data


@pytest_asyncio.fixture
async def people(env):
    client, factory = env
    tid = await _tenant(factory, "acme")
    a = await _staff(factory, tid, "a@x.com")
    b = await _staff(factory, tid, "b@x.com")
    other_tid = await _tenant(factory, "other")
    c = await _staff(factory, other_tid, "c@x.com")
    return client, factory, {"tid": tid, "a": a, "b": b, "other_tid": other_tid, "c": c}


@pytest.mark.asyncio
async def test_requires_auth(env):
    client, _ = env
    r = await client.post("/api/v1/devices", json=_body())
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_register_and_upsert_same_device(people):
    client, factory, p = people
    h = _auth(p["a"], p["tid"])
    r = await client.post("/api/v1/devices", json=_body(), headers=h)
    body = r.json()
    assert body["ok"] is True
    first_id = body["data"]["id"]
    assert body["data"]["push_enabled"] is False  # 未設定 FCM

    # 同裝置重登記(權杖輪替 + 語系變更):沿用同一列
    r = await client.post(
        "/api/v1/devices", json=_body(token="fcm-token-2", locale="en-US"), headers=h
    )
    assert r.json()["data"]["id"] == first_id
    rows = await _rows(factory)
    assert len(rows) == 1
    assert rows[0].token == "fcm-token-2"
    assert rows[0].locale == "en-US"
    assert rows[0].tenant_id == p["tid"]
    assert rows[0].staff_id == p["a"]
    assert rows[0].provider == "fcm"


@pytest.mark.asyncio
async def test_reregister_clears_revoked(people):
    client, factory, p = people
    h = _auth(p["a"], p["tid"])
    await client.post("/api/v1/devices", json=_body(), headers=h)
    r = await client.delete("/api/v1/devices/dev-1", headers=h)
    assert r.json()["data"] == {"device_id": "dev-1", "revoked": True}
    assert (await _rows(factory))[0].revoked_at is not None

    await client.post("/api/v1/devices", json=_body(), headers=h)
    rows = await _rows(factory)
    assert len(rows) == 1 and rows[0].revoked_at is None


@pytest.mark.asyncio
async def test_token_moves_between_staff(people):
    """共用手機換人登入:同一權杖登記到 B 時,A 的舊列被刪除(不再推給 A)。"""
    client, factory, p = people
    await client.post("/api/v1/devices", json=_body(), headers=_auth(p["a"], p["tid"]))
    # 跨租戶也一樣搬家(token 全域唯一)
    r = await client.post(
        "/api/v1/devices", json=_body(device_id="dev-shared"), headers=_auth(p["c"], p["other_tid"])
    )
    assert r.json()["ok"] is True
    rows = await _rows(factory)
    assert len(rows) == 1
    assert rows[0].staff_id == p["c"]
    assert rows[0].tenant_id == p["other_tid"]
    assert rows[0].device_id == "dev-shared"


@pytest.mark.asyncio
async def test_token_moves_between_own_devices(people):
    client, factory, p = people
    h = _auth(p["a"], p["tid"])
    await client.post("/api/v1/devices", json=_body(device_id="old"), headers=h)
    await client.post("/api/v1/devices", json=_body(device_id="new"), headers=h)
    rows = await _rows(factory)
    assert [r.device_id for r in rows] == ["new"]


@pytest.mark.asyncio
async def test_max_ten_devices_revokes_oldest(people):
    client, factory, p = people
    h = _auth(p["a"], p["tid"])
    for i in range(10):
        r = await client.post(
            "/api/v1/devices", json=_body(token=f"t{i}", device_id=f"d{i}"), headers=h
        )
        assert r.json()["ok"] is True
    # 讓 d0 成為最久未見
    async with factory() as db:
        base = datetime.now(UTC) - timedelta(days=30)
        for row in (await db.execute(select(DeviceToken))).scalars().all():
            idx = int(row.device_id[1:])
            row.last_seen_at = base + timedelta(hours=idx)
        await db.commit()

    await client.post("/api/v1/devices", json=_body(token="t10", device_id="d10"), headers=h)
    rows = {r.device_id: r for r in await _rows(factory)}
    assert len(rows) == 11
    active = sorted(d for d, r in rows.items() if r.revoked_at is None)
    assert len(active) == 10
    assert rows["d0"].revoked_at is not None
    assert rows["d10"].revoked_at is None

    r = await client.get("/api/v1/devices", headers=h)
    assert len(r.json()["data"]["items"]) == 10


@pytest.mark.asyncio
async def test_delete_only_own_device(people):
    client, factory, p = people
    await client.post("/api/v1/devices", json=_body(), headers=_auth(p["a"], p["tid"]))
    # B 嘗試撤銷 A 的 device_id:冪等 revoked=false,A 的列不受影響
    r = await client.delete("/api/v1/devices/dev-1", headers=_auth(p["b"], p["tid"]))
    assert r.json()["data"] == {"device_id": "dev-1", "revoked": False}
    assert (await _rows(factory))[0].revoked_at is None
    # 不存在的裝置:同樣冪等
    r = await client.delete("/api/v1/devices/nope", headers=_auth(p["a"], p["tid"]))
    assert r.json()["ok"] is True and r.json()["data"]["revoked"] is False


@pytest.mark.asyncio
async def test_list_only_own_and_hides_token(people):
    client, factory, p = people
    ha, hb = _auth(p["a"], p["tid"]), _auth(p["b"], p["tid"])
    await client.post("/api/v1/devices", json=_body(token="ta", device_id="da"), headers=ha)
    await client.post("/api/v1/devices", json=_body(token="tb", device_id="db"), headers=hb)
    await client.post(
        "/api/v1/devices", json=_body(token="ta2", device_id="da2", platform="ios"), headers=ha
    )
    await client.delete("/api/v1/devices/da2", headers=ha)

    r = await client.get("/api/v1/devices", headers=ha)
    data = r.json()["data"]
    assert [d["device_id"] for d in data["items"]] == ["da"]
    assert "token" not in data["items"][0]
    assert data["push_enabled"] is False

    r = await client.get("/api/v1/devices", params={"include_revoked": "true"}, headers=ha)
    ids = sorted(d["device_id"] for d in r.json()["data"]["items"])
    assert ids == ["da", "da2"]


@pytest.mark.asyncio
async def test_desktop_without_token_is_synthesized(people):
    client, factory, p = people
    h = _auth(p["a"], p["tid"])
    r = await client.post(
        "/api/v1/devices", json=_body(token="", platform="desktop", device_id="mac-1"), headers=h
    )
    assert r.json()["ok"] is True
    rows = await _rows(factory)
    assert rows[0].token == "desktop:mac-1"
    assert rows[0].platform == "desktop"


@pytest.mark.asyncio
async def test_mobile_requires_token(people):
    client, _, p = people
    r = await client.post("/api/v1/devices", json=_body(token=" "), headers=_auth(p["a"], p["tid"]))
    assert r.json()["ok"] is False
    assert r.json()["error"]["code"] == "bad_request"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "patch",
    [
        {"platform": "web"},
        {"device_id": ""},
        {"device_id": "bad id!"},
        {"device_id": "x" * 129},
        {"token": "x" * 3000},
        {"locale": "x" * 17},
    ],
)
async def test_validation(people, patch):
    client, _, p = people
    r = await client.post("/api/v1/devices", json=_body(**patch), headers=_auth(p["a"], p["tid"]))
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_push_enabled_reflects_configuration(people, monkeypatch):
    client, _, p = people
    monkeypatch.setattr(push, "is_configured", lambda: True)
    r = await client.post("/api/v1/devices", json=_body(), headers=_auth(p["a"], p["tid"]))
    assert r.json()["data"]["push_enabled"] is True
