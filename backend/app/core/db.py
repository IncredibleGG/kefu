"""Async SQLAlchemy engine, session factory, and declarative base.

All business tables inherit from `Base` via the mixins in app.models.base,
which provide id / tenant_id / timestamps / soft-delete uniformly.
"""
from __future__ import annotations

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

# asyncpg 連線一律把 session 時區釘為 UTC:讓 date_trunc('day'|'hour', timestamptz) 以
# UTC 日界分桶,與各報表 UTC 視窗邊界(period_start/end、since)一致,避免非 UTC 部署下
# 近午夜事件落錯日、首尾桶變半日(sqlite 測試環境不套用此參數)。
_connect_args: dict = {}
if settings.database_url.startswith(("postgresql", "postgres")):
    _connect_args["server_settings"] = {"timezone": "UTC"}

engine = create_async_engine(
    settings.database_url,
    echo=settings.sql_echo,
    pool_pre_ping=True,
    connect_args=_connect_args,
)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency yielding an async DB session."""
    async with SessionLocal() as session:
        yield session


async def init_db() -> None:
    """Dev bootstrap: ensure pgvector extension + create tables from metadata.

    Production uses Alembic migrations; this keeps first-run/testing frictionless.
    """
    from sqlalchemy import text

    import app.models  # noqa: F401  (register all mappers)

    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(Base.metadata.create_all)

    await _bootstrap_platform_admin()


async def _bootstrap_platform_admin() -> None:
    """平台超管 bootstrap:若設有環境變數 ``KEFU_PLATFORM_ADMIN_EMAIL`` 且對應的
    Staff 已存在,則將其 ``is_platform_admin`` 設為 True(冪等),讓平台超管可經
    環境變數開通,不必手改 DB。

    - 讀取方式:``os.environ.get``(config.py 不動,故不經 settings)。
    - email 僅租戶內唯一,可能跨租戶多筆,一律標記(env 由營運方刻意設定)。
    - 全程 try/except:任何失敗(無此欄位/連不上 DB/表未建)都不擋服務啟動。
    """
    import os

    email = (os.environ.get("KEFU_PLATFORM_ADMIN_EMAIL") or "").strip()
    if not email:
        return
    try:
        from sqlalchemy import update

        from app.models.iam import Staff

        async with SessionLocal() as session:
            await session.execute(
                update(Staff)
                .where(Staff.email == email, Staff.is_platform_admin.is_(False))
                .values(is_platform_admin=True)
            )
            await session.commit()
    except Exception:
        # bootstrap 為便利機制,失敗不得影響啟動流程。
        pass
