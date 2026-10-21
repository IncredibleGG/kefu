"""Alembic 環境設定(乾淨室)。

本專案的 SQLAlchemy engine 為 async(URL 形如 ``postgresql+asyncpg://``)。
Alembic 本身是同步 API,因此這裡採「async engine + ``connection.run_sync(...)``」
的方式在 async 連線上跑同步的遷移流程——如此就**不必額外安裝 sync driver**
(專案目前只裝了 asyncpg,沒有 psycopg)。

設計要點:
- ``target_metadata = app.core.db.Base.metadata`` —— autogenerate 的比對基準。
- 匯入 ``app.models`` 讓所有 ORM 表都註冊進 ``Base.metadata``(否則 autogenerate
  只看得到被 import 過的表)。
- 資料庫 URL 一律取自 ``app.core.config.settings.database_url``,並覆寫
  ``alembic.ini`` 裡的 sqlalchemy.url 佔位值(單一事實來源;容器內由
  KEFU_DATABASE_URL 環境變數提供)。
- 匯入 ``pgvector.sqlalchemy`` 讓 autogenerate 認得 ``Vector`` 型別
  (pgvector extension 本身在基線遷移內以 ``CREATE EXTENSION`` 建立)。
"""
from __future__ import annotations

import asyncio
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

from alembic import context

# 匯入 pgvector 的 SQLAlchemy 型別,讓 autogenerate 能辨識 Vector 欄位。
import pgvector.sqlalchemy  # noqa: F401

from app.core.config import settings
from app.core.db import Base
import app.models  # noqa: F401  匯入以註冊所有 ORM 模型到 Base.metadata

# Alembic Config 物件(讀取 alembic.ini)。
config = context.config

# 設定 Python logging(依 alembic.ini 的 [loggers] 等區段)。
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# 用應用設定覆寫 ini 的佔位 URL,確保遷移與 App 連的是同一個 DB。
config.set_main_option("sqlalchemy.url", settings.database_url)

# autogenerate 的比對來源:所有 ORM 表都掛在這個 metadata 上。
target_metadata = Base.metadata


def _offline_url(async_url: str) -> str:
    """離線(``--sql``)模式僅需 URL 判斷方言、不會真的連線,
    因此把 async driver 去掉即可(``postgresql+asyncpg`` -> ``postgresql``)。"""
    return async_url.replace("+asyncpg", "")


def run_migrations_offline() -> None:
    """離線模式:只產生 SQL 腳本,不連線資料庫(``alembic upgrade head --sql``)。"""
    context.configure(
        url=_offline_url(settings.database_url),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    """實際的同步遷移流程,由 run_sync 在 async 連線上呼叫。"""
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,  # 型別變更也納入 autogenerate 偵測
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    """線上模式:用 async engine 連線,透過 run_sync 執行同步遷移。"""
    connectable = create_async_engine(settings.database_url, poolclass=pool.NullPool)
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
