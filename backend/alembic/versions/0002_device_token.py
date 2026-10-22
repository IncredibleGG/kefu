"""device_token:原生 App 裝置推播權杖表(docs/NATIVE-CLIENTS.md §4.1 / §4.3)。

對應模型 ``app.models.device.DeviceToken``。

**為何寫成冪等(IF NOT EXISTS)**:基線 ``0001_baseline`` 以 ``Base.metadata.create_all``
建出「當下」全部模型;``app.models`` 匯入 DeviceToken 後,全新 DB 跑 ``upgrade head``
時基線就已建出本表。既有 DB(已 ``stamp 0001_baseline``)則需由本遷移補建。
兩種情境都要能跑,故建表 / 建索引一律 ``IF NOT EXISTS``(PostgreSQL 語法,線上 /
離線 ``--sql`` 皆可用)。

本檔以獨立的 ``MetaData`` 明列欄位(不引用 ORM 模型),日後模型演進不會回頭改寫
這版遷移的 DDL;``tenant`` / ``staff`` 只放 id 欄作為外鍵解析用佔位,不會被建立。

Revision ID: 0002_device_token
Revises: 0001_baseline
Create Date: 2026-10-22
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateIndex, CreateTable

# revision identifiers, used by Alembic.
revision: str = "0002_device_token"
down_revision: Union[str, None] = "0001_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _device_token_table() -> sa.Table:
    md = sa.MetaData()
    # 外鍵解析用佔位(不建立)
    sa.Table("tenant", md, sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True))
    sa.Table("staff", md, sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True))
    return sa.Table(
        "device_token",
        md,
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "tenant_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tenant.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "staff_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("staff.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("platform", sa.String(10), nullable=False),
        sa.Column("provider", sa.String(10), nullable=False),
        sa.Column("token", sa.String(4096), nullable=False),
        sa.Column("device_id", sa.String(128), nullable=False),
        sa.Column("app_version", sa.String(32), nullable=False),
        sa.Column("os_version", sa.String(32), nullable=True),
        sa.Column("locale", sa.String(16), nullable=True),
        sa.Column(
            "last_seen_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("token", name="uq_device_token_token"),
        sa.UniqueConstraint("staff_id", "device_id", name="uq_device_token_staff_device"),
        # 索引名沿用 SQLAlchemy index=True 的預設命名(ix_<table>_<column>),與基線一致
        sa.Index("ix_device_token_tenant_id", "tenant_id"),
        sa.Index("ix_device_token_staff_id", "staff_id"),
        sa.Index("ix_device_token_deleted_at", "deleted_at"),
    )


def upgrade() -> None:
    table = _device_token_table()
    op.execute(CreateTable(table, if_not_exists=True))
    for index in sorted(table.indexes, key=lambda i: i.name or ""):
        op.execute(CreateIndex(index, if_not_exists=True))


def downgrade() -> None:
    # 索引隨表一併刪除
    op.execute("DROP TABLE IF EXISTS device_token")
