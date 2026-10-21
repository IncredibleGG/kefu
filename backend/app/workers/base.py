"""背景 worker 的介面(協定)、全域註冊表與註冊 helper。

一個 worker = 「吃一個 AsyncSession、回傳任意摘要」的 async 可呼叫物:

    async def my_worker(db: AsyncSession) -> Any: ...

各 worker 檔 import 後用 `@register_worker(name="...")` 自我登記進 `WORKERS`;
`jobs.run_due_jobs` 會依序執行清單中的每個 worker。新增 worker 只要:
1) 在自己的檔內 `@register_worker(name="…")`,
2) 在 `jobs.py` 頂部 append 一行 `from app.workers import <檔名>`(觸發註冊)。
"""
from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("kefu.workers")

# worker 型別:吃 AsyncSession、回傳任意摘要的 async 可呼叫物。
Worker = Callable[[AsyncSession], Awaitable[Any]]

# 全域註冊表:list of async callables。各 worker 檔被 import 時自我 append。
WORKERS: list[Worker] = []


def worker_name(fn: Worker) -> str:
    """取 worker 的顯示名(供 log):優先用註冊時給的 name,否則函式名。"""
    return getattr(fn, "_worker_name", None) or getattr(fn, "__name__", repr(fn))


def register_worker(fn: Worker | None = None, *, name: str | None = None):
    """把一個 async worker 登記進 `WORKERS`。可當裝飾器或直接呼叫。

    用法:
        @register_worker                 # 用函式名當顯示名
        async def foo(db): ...

        @register_worker(name="sla_digest")  # 指定顯示名(推薦,便於 log 辨識)
        async def run(db): ...

    冪等:同一函式重複登記只算一次(模組被重載/重複 import 時不會膨脹清單)。
    """

    def _decorate(f: Worker) -> Worker:
        if name:
            f._worker_name = name  # type: ignore[attr-defined]
        if f not in WORKERS:
            WORKERS.append(f)
            logger.debug("已註冊背景 worker:%s", worker_name(f))
        return f

    # 兼具 `@register_worker` 與 `@register_worker(name=...)` 兩種寫法
    return _decorate(fn) if fn is not None else _decorate
