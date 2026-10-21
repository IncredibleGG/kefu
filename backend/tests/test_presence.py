"""坐席連線登記(services/presence.py)測試:以內建假 Redis(hash 指令)驗證。

涵蓋:首條/最後一條連線判定、刷新與 TTL、殘留項目剔除、前景判定視窗、
Redis 不可用時 fail-open,以及 device_id / platform 清理。不依賴外部 Redis。
"""
from __future__ import annotations

import json
import time

import pytest

from app.services import presence, realtime


class FakeHashRedis:
    """最小假 Redis:只實作 presence 用到的 hash / expire 指令。"""

    def __init__(self) -> None:
        self.hashes: dict[str, dict[str, str]] = {}
        self.ttl: dict[str, int] = {}

    async def hset(self, key: str, field: str, value: str) -> int:
        self.hashes.setdefault(key, {})[field] = value
        return 1

    async def hgetall(self, key: str) -> dict[str, str]:
        return dict(self.hashes.get(key, {}))

    async def hdel(self, key: str, *fields: str) -> int:
        h = self.hashes.get(key, {})
        n = 0
        for f in fields:
            if h.pop(f, None) is not None:
                n += 1
        if key in self.hashes and not self.hashes[key]:
            del self.hashes[key]
        return n

    async def expire(self, key: str, seconds: int) -> bool:
        self.ttl[key] = seconds
        return True


class BrokenRedis:
    """模擬 Redis 不可用:任何指令都拋 ConnectionError。"""

    def __getattr__(self, name):
        async def _fail(*a, **kw):
            raise ConnectionError("redis down")

        return _fail


@pytest.fixture
def fake():
    f = FakeHashRedis()
    realtime.set_client(f)
    yield f
    realtime.set_client(None)


def _conn(staff="s1", **kw) -> presence.Connection:
    return presence.Connection(staff_id=staff, **kw)


@pytest.mark.asyncio
async def test_register_first_and_second_connection(fake):
    a = _conn(device_id="dev-a", platform="ios")
    b = _conn(device_id="dev-b", platform="desktop")
    assert await presence.register(a) == 0  # 第一條連線
    assert await presence.register(b) == 1  # 已有一條
    key = presence.presence_key("s1")
    assert key == "kefu:ws:s1"
    assert set(fake.hashes[key]) == {a.conn_id, b.conn_id}
    assert fake.ttl[key] == presence.TTL_SECONDS
    entry = json.loads(fake.hashes[key][a.conn_id])
    assert entry["device_id"] == "dev-a"
    assert entry["platform"] == "ios"
    assert entry["fg"] == 1
    assert isinstance(entry["ts"], float)
    assert await presence.connection_count("s1") == 2


@pytest.mark.asyncio
async def test_unregister_reports_remaining(fake):
    a, b = _conn(), _conn()
    await presence.register(a)
    await presence.register(b)
    assert await presence.unregister(a) == 1
    assert await presence.unregister(b) == 0  # 最後一條
    assert presence.presence_key("s1") not in fake.hashes
    assert await presence.connection_count("s1") == 0


@pytest.mark.asyncio
async def test_connections_are_per_staff(fake):
    await presence.register(_conn("s1"))
    await presence.register(_conn("s2"))
    assert await presence.connection_count("s1") == 1
    assert await presence.connection_count("s2") == 1
    assert await presence.connection_count("s3") == 0


@pytest.mark.asyncio
async def test_stale_entries_are_pruned(fake):
    """程序崩潰留下、超過 TTL 未刷新的項目不計入,且讀取時被清除。"""
    key = presence.presence_key("s1")
    old = time.time() - presence.TTL_SECONDS - 5
    fake.hashes[key] = {
        "dead": json.dumps({"device_id": "", "platform": "web", "fg": 1, "ts": old, "seen": old}),
        "garbage": "not-json",
    }
    a = _conn()
    assert await presence.register(a) == 0  # 殘留不算 → 仍是第一條
    assert set(fake.hashes[key]) == {a.conn_id}


@pytest.mark.asyncio
async def test_touch_refreshes_ts_and_seen(fake):
    a = _conn()
    await presence.register(a)
    key = presence.presence_key("s1")
    a.seen = time.time() - 100
    fake.ttl.clear()
    # 伺服器端刷新:ts 更新、seen 不動
    assert await presence.touch(a, client_seen=False) is True
    e = json.loads(fake.hashes[key][a.conn_id])
    assert time.time() - e["seen"] >= 99
    assert time.time() - e["ts"] < 5
    assert fake.ttl[key] == presence.TTL_SECONDS
    # 客戶端 ping:seen 也更新
    assert await presence.touch(a) is True
    e = json.loads(fake.hashes[key][a.conn_id])
    assert time.time() - e["seen"] < 5


@pytest.mark.asyncio
async def test_touch_recreates_missing_entry(fake):
    """hash 過期消失後,下一次刷新以整筆覆寫重建。"""
    a = _conn(device_id="d1")
    await presence.register(a)
    fake.hashes.clear()
    await presence.touch(a)
    assert json.loads(fake.hashes[presence.presence_key("s1")][a.conn_id])["device_id"] == "d1"


@pytest.mark.asyncio
async def test_is_foreground(fake):
    a = _conn(platform="ios")
    await presence.register(a)
    assert await presence.is_foreground("s1") is True
    await presence.set_foreground(a, False)
    assert await presence.is_foreground("s1") is False
    await presence.set_foreground(a, True)
    assert await presence.is_foreground("s1") is True
    # 客戶端 seen 超過視窗(例如舊版客戶端不送 ping)→ 不算前景
    a.seen = time.time() - 61
    await presence.touch(a, client_seen=False)
    assert await presence.is_foreground("s1") is False
    assert await presence.is_foreground("s1", within=120) is True
    # 無連線 → False
    assert await presence.is_foreground("nobody") is False


@pytest.mark.asyncio
async def test_is_foreground_any_device(fake):
    phone = _conn(platform="android")
    desk = _conn(platform="desktop")
    await presence.register(phone)
    await presence.register(desk)
    await presence.set_foreground(phone, False)
    assert await presence.is_foreground("s1") is True  # 桌面仍在前景
    await presence.set_foreground(desk, False)
    assert await presence.is_foreground("s1") is False


@pytest.mark.asyncio
async def test_fail_open_when_redis_down():
    realtime.set_client(BrokenRedis())
    try:
        a = _conn()
        assert await presence.register(a) is None
        assert await presence.touch(a) is False
        assert await presence.set_foreground(a, False) is False
        assert a.foreground is False  # 本地狀態仍更新
        assert await presence.unregister(a) is None
        assert await presence.connections("s1") is None
        assert await presence.connection_count("s1") == 0
        assert await presence.is_foreground("s1") is False
    finally:
        realtime.set_client(None)


def test_clean_device_id_and_platform():
    assert presence.clean_device_id(None) == ""
    assert presence.clean_device_id("  abc-123_x.y:z  ") == "abc-123_x.y:z"
    assert presence.clean_device_id("a b<script>") == "abscript"
    assert len(presence.clean_device_id("x" * 500)) == 128
    assert presence.clean_platform(None) == "web"
    assert presence.clean_platform("") == "web"
    assert presence.clean_platform(" iOS ") == "ios"
    assert presence.clean_platform("<>") == "web"
    assert len(presence.clean_platform("a" * 100)) == 32
