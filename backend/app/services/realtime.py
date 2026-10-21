"""即時推送:以 Redis pub/sub 承載會話事件,供 WebSocket 端訂閱轉發。

頻道命名:
- 會話頻道 ``rt:{tenant}:session:{session}``:單一會話內的訊息與事件,
  訪客端(/ws/widget)與正在檢視該會話的坐席端訂閱。
- 租戶坐席頻道 ``rt:{tenant}:agents``:會話生命週期事件(新會話/接管/轉接/結束),
  供坐席工作台(/ws/agent)即時更新列表。

封包統一為 ``{type, payload, ts}``(見 ``make_event``);publish 直接投遞事件字典,
WebSocket 端把解碼後的事件原封轉發給連線。
"""
from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import redis.asyncio as aioredis

from app.core.config import settings

# 模組層級的 Redis 連線;lazy 建立,測試可用 set_client() 注入假物件
_client: aioredis.Redis | None = None


def get_client() -> aioredis.Redis:
    """取得(必要時建立)共用的 async Redis 連線。"""
    global _client
    if _client is None:
        _client = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _client


def set_client(client: Any) -> None:
    """測試掛鉤:注入自訂 / 假的 Redis 連線,以免依賴外部服務。"""
    global _client
    _client = client


# --- 頻道命名 ---------------------------------------------------------------

def session_channel(tenant_id: uuid.UUID | str, session_id: uuid.UUID | str) -> str:
    """單一會話頻道名。"""
    return f"rt:{tenant_id}:session:{session_id}"


def agents_channel(tenant_id: uuid.UUID | str) -> str:
    """租戶層級坐席工作台頻道名。"""
    return f"rt:{tenant_id}:agents"


# --- 事件封包 ---------------------------------------------------------------

def make_event(type_: str, payload: dict | None = None) -> dict[str, Any]:
    """建立統一封包 ``{type, payload, ts}``;ts 為 UTC ISO8601 字串。"""
    return {
        "type": type_,
        "payload": payload or {},
        "ts": datetime.now(timezone.utc).isoformat(),
    }


# --- 發佈 -------------------------------------------------------------------

async def publish(
    tenant_id: uuid.UUID | str, session_id: uuid.UUID | str, event: dict
) -> None:
    """把事件發佈到指定會話頻道(簽名見 DEV-PLAN 3.5)。"""
    await get_client().publish(
        session_channel(tenant_id, session_id), json.dumps(event, default=str)
    )


async def publish_agents(tenant_id: uuid.UUID | str, event: dict) -> None:
    """把事件發佈到租戶坐席工作台頻道(會話列表層級更新)。"""
    await get_client().publish(agents_channel(tenant_id), json.dumps(event, default=str))


# --- 訂閱(供 WebSocket 端使用)---------------------------------------------

@asynccontextmanager
async def subscribe(channels: list[str]) -> AsyncIterator[AsyncIterator[dict]]:
    """訂閱一批頻道,yield 一個非同步事件迭代器;離開時自動退訂並關閉。

    用法::

        async with subscribe([session_channel(t, s)]) as events:
            async for event in events:
                await ws.send_json(event)
    """
    client = get_client()
    pubsub = client.pubsub()
    await pubsub.subscribe(*channels)
    try:
        yield _iter_events(pubsub)
    finally:
        try:
            await pubsub.unsubscribe(*channels)
            await pubsub.aclose()
        except Exception:  # noqa: BLE001 - 關閉期例外不應向外拋
            pass


async def _iter_events(pubsub: Any) -> AsyncIterator[dict]:
    """把 pubsub 訊息解碼成事件字典逐一 yield(只取 message 類型)。"""
    async for msg in pubsub.listen():
        if msg.get("type") != "message":
            continue
        data = msg.get("data")
        if data is None:
            continue
        if isinstance(data, bytes):
            data = data.decode()
        try:
            yield json.loads(data)
        except (ValueError, TypeError):
            continue
