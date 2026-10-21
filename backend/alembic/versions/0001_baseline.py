"""baseline:一次建出目前全部 ORM 表(大爆炸基線)。

策略:
- **全新 DB**:``alembic upgrade head`` → 先建 pgvector extension,再由
  ``Base.metadata.create_all`` 一次建出所有既有模型對應的表。
- **既有 DB**(先前已用 core.db.init_db / create_all 建好整個 schema):
  改跑 ``alembic stamp head`` —— 只把版本標記成已在最新版、**不重跑** upgrade,
  避免對已存在的表重複建立。

自本基線起,任何 schema 變更一律走:
``alembic revision --autogenerate -m "..."`` → ``alembic upgrade head``,
不要再手動 ALTER。詳見 backend/MIGRATIONS.md。

Revision ID: 0001_baseline
Revises:
Create Date: 2026-09-24
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import context, op

# 匯入 Base 與所有模型,讓 metadata 內含全部表定義。
# (env.py 已 import,一次;此處再 import 使本檔即便被單獨載入也自洽。)
from app.core.db import Base
import app.models  # noqa: F401  註冊所有 ORM 模型到 Base.metadata

# revision identifiers, used by Alembic.
revision: str = "0001_baseline"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """全新 DB:建擴充 + 依 metadata 一次建出所有表。"""
    bind = op.get_bind()
    # pgvector:Vector 欄位(knowledge.Document / QAPair.embedding)所需的擴充,
    # 必須先於建表存在。IF NOT EXISTS 使其可重入。
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    # 大爆炸:一次建出 metadata 內所有表(涵蓋 app.models 的全部既有模型)。
    # 離線(--sql)模式無法查詢既有物件,故關掉 checkfirst 只輸出 CREATE。
    Base.metadata.create_all(bind=bind, checkfirst=not context.is_offline_mode())


def downgrade() -> None:
    """回滾:依相依順序卸下所有表(extension 保留不刪)。"""
    bind = op.get_bind()
    Base.metadata.drop_all(bind=bind)
    # 註:不 DROP EXTENSION vector —— 其他 DB 物件可能仍依賴 vector 型別,
    # 且擴充存在本身無害,交由 DBA 視情況處理。
