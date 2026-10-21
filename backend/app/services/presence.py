"""坐席連線登記(presence):以 Redis 記錄每條 /ws/agent 連線,判斷「在線」與「前景」。

資料結構(每位坐席一個 hash):

    kefu:ws:{staff_id}  →  { conn_id: '{"device_id","platform","fg","ts","seen"}' , ... }

- ``ts``:伺服器最後一次刷新此連線的時間(連線存活期間由 WS 端定期刷新);
  超過 ``TTL_SECONDS`` 未刷新的項目視為殘留(程序崩潰未清除),讀取時剔除。
- ``seen``:客戶端最後一次主動回報(ping / app_state)的時間;``is_foreground``
  以此判斷「近期確實在前景」,舊版不送心跳的客戶端不會被誤判為前景。
- 整個 hash 另設 ``EXPIRE TTL_SECONDS``,每次刷新延長;最後一條連線消失後自然過期。

上線狀態語義(由 /ws/agent 依本模組回傳值套用到 ``Staff.status``):
第一條連線出現才設 online(且僅在目前為 offline 時)、最後一條結束才設 offline
(且僅在目前為 online 時),手動設的 busy / away 不被覆蓋。

容錯:Redis 不可用時一律 fail-open —— 登記類函式回 ``None``(呼叫端退回舊行為:
連上即上線、斷線即離線),查詢類回保守值(``is_foreground`` → False、
``connection_count`` → 0),絕不向外拋錯。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from app.services import realtime

logger = logging.getLogger("kefu.presence")

KEY_PREFIX = "kefu:ws:"
# 連線項目存活時間(秒):WS 端每 KEEPALIVE 刷新一次,遠小於此值
TTL_SECONDS = 120
# 「前景」判定視窗(秒):fg=1 且客戶端 seen 在此視窗內
FOREGROUND_WITHIN_SECONDS = 60
# 單次 Redis 操作逾時(秒):避免 Redis 失聯時卡住 WS 握手 / 斷線清理
OP_TIMEOUT_SECONDS = 2.0

_MAX_DEVICE_ID = 128
_MAX_PLATFORM = 32


def presence_key(staff_id: uuid.UUID | str) -> str:
    """坐席連線登記 hash 的鍵名。"""
    return f"{KEY_PREFIX}{staff_id}"


def new_conn_id() -> str:
    """產生單條連線的識別碼(每次 WS 連線一個)。"""
    return uuid.uuid4().hex


def clean_device_id(value: str | None) -> str:
    """清理客戶端帶來的 device_id:去空白、限長;不合法字元一律剔除。"""
    if not value:
        return ""
    cleaned = "".join(ch for ch in value.strip() if ch.isalnum() or ch in "-_.:")
    return cleaned[:_MAX_DEVICE_ID]


def clean_platform(value: str | None) -> str:
    """清理客戶端帶來的 platform:小寫、限長、只留 [a-z0-9_-];缺省為 web。"""
    if not value:
        return "web"
    cleaned = "".join(ch for ch in value.strip().lower() if ch.isalnum() or ch in "-_")
    return cleaned[:_MAX_PLATFORM] or "web"


@dataclass
class Connection:
    """單條 /ws/agent 連線的登記資訊(由 WS 端持有,刷新時整筆覆寫)。"""

    staff_id: str
    conn_id: str = field(default_factory=new_conn_id)
    device_id: str = ""
    platform: str = "web"
    foreground: bool = True
    seen: float = field(default_factory=time.time)

    def entry(self, now: float) -> str:
        return json.dumps(
            {
                "device_id": self.device_id,
                "platform": self.platform,
                "fg": 1 if self.foreground else 0,
                "ts": now,
                "seen": self.seen,
            }
        )


# --------------------------- 內部工具 --------------------------- #

async def _safe(coro: Any, what: str) -> Any:
    """執行 Redis 操作;任何失敗(含逾時)記錄後回 None(fail-open)。"""
    try:
        return await asyncio.wait_for(coro, timeout=OP_TIMEOUT_SECONDS)
    except Exception:
        logger.warning("presence %s 失敗(Redis 不可用?)", what, exc_info=True)
        return None


def _decode(raw: Any) -> dict | None:
    if isinstance(raw, bytes):
        raw = raw.decode()
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


async def _live_entries(client: Any, key: str, now: float) -> dict[str, dict]:
    """讀出未過期的連線項目;順手剔除超過 TTL 未刷新的殘留項目。"""
    raw = await client.hgetall(key) or {}
    live: dict[str, dict] = {}
    stale: list[str] = []
    for k, v in raw.items():
        conn_id = k.decode() if isinstance(k, bytes) else str(k)
        data = _decode(v)
        try:
            ts = float(data.get("ts", 0)) if data else 0.0
        except (TypeError, ValueError):
            ts = 0.0
        if data is None or now - ts > TTL_SECONDS:
            stale.append(conn_id)
            continue
        live[conn_id] = data
    if stale:
        await client.hdel(key, *stale)
    return live


async def _write(conn: Connection) -> bool:
    client = realtime.get_client()
    key = presence_key(conn.staff_id)
    await client.hset(key, conn.conn_id, conn.entry(time.time()))
    await client.expire(key, TTL_SECONDS)
    return True


# --------------------------- 對外 API --------------------------- #

async def register(conn: Connection) -> int | None:
    """登記一條新連線。回傳「登記前」的有效連線數(0 = 第一條連線);Redis 不可用回 None。"""

    async def _do() -> int:
        client = realtime.get_client()
        key = presence_key(conn.staff_id)
        now = time.time()
        before = await _live_entries(client, key, now)
        before.pop(conn.conn_id, None)
        await client.hset(key, conn.conn_id, conn.entry(now))
        await client.expire(key, TTL_SECONDS)
        return len(before)

    return await _safe(_do(), "register")


async def touch(conn: Connection, *, client_seen: bool = True) -> bool:
    """刷新連線存活時間並延長 TTL。``client_seen`` 為真時一併更新客戶端 seen 時間
    (收到 ping / app_state);伺服器定期刷新時傳 False。成功回 True。"""
    if client_seen:
        conn.seen = time.time()
    return bool(await _safe(_write(conn), "touch"))


async def set_foreground(conn: Connection, foreground: bool) -> bool:
    """更新此連線的前景狀態(客戶端 app_state),同時視為一次客戶端活動。"""
    conn.foreground = bool(foreground)
    return await touch(conn, client_seen=True)


async def unregister(conn: Connection) -> int | None:
    """移除一條連線。回傳移除後剩餘的有效連線數(0 = 最後一條);Redis 不可用回 None。"""

    async def _do() -> int:
        client = realtime.get_client()
        key = presence_key(conn.staff_id)
        await client.hdel(key, conn.conn_id)
        return len(await _live_entries(client, key, time.time()))

    return await _safe(_do(), "unregister")


async def connections(staff_id: uuid.UUID | str) -> list[dict] | None:
    """列出坐席目前的有效連線(含 conn_id);Redis 不可用回 None。"""

    async def _do() -> list[dict]:
        live = await _live_entries(realtime.get_client(), presence_key(staff_id), time.time())
        return [{"conn_id": cid, **data} for cid, data in live.items()]

    return await _safe(_do(), "connections")


async def connection_count(staff_id: uuid.UUID | str) -> int:
    """坐席目前的有效連線數;Redis 不可用時回 0。"""
    conns = await connections(staff_id)
    return len(conns) if conns else 0


async def is_foreground(
    staff_id: uuid.UUID | str, within: float = FOREGROUND_WITHIN_SECONDS
) -> bool:
    """坐席是否有任一裝置「前景」連線(fg=1 且客戶端 seen 在 ``within`` 秒內)。

    供推播判斷「有前景連線就不推」;Redis 不可用時回 False(寧可多推,不漏通知)。
    """
    conns = await connections(staff_id)
    if not conns:
        return False
    now = time.time()
    for c in conns:
        try:
            seen = float(c.get("seen", c.get("ts", 0)))
        except (TypeError, ValueError):
            continue
        if c.get("fg") in (1, True, "1") and now - seen <= within:
            return True
    return False
