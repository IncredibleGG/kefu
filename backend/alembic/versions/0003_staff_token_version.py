"""staff.token_version:存取權杖版本,改密 / 重設 / 2FA 變更後撤銷既發 JWT。

對應模型 ``app.models.iam.Staff.token_version``(簽發 access token 時以 ``tv`` claim 夾帶,
``core/deps.get_current_principal``、平台超管守衛與 ``/ws/agent`` 握手 / 定期複查比對)。

**為何寫成冪等(IF NOT EXISTS)**:基線 ``0001_baseline`` 以 ``Base.metadata.create_all``
建出「當下」全部模型;全新 DB 跑 ``upgrade head`` 時基線就已建出本欄。既有 DB
(已 ``stamp`` 到 ``0002_device_token``)則需由本遷移補欄。兩種情境都要能跑,故以
PostgreSQL 的 ``ADD COLUMN IF NOT EXISTS``(線上 / 離線 ``--sql`` 皆可用)。

既有列一律補 0;既發、不帶 ``tv`` claim 的 token 也視為版本 0,因此部署後舊 token
照常可用到過期,直到該坐席第一次改密 / 重設 / 2FA 變更才失效。

Revision ID: 0003_staff_token_version
Revises: 0002_device_token
Create Date: 2026-10-26
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003_staff_token_version"
down_revision: Union[str, None] = "0002_device_token"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE staff ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE staff DROP COLUMN IF EXISTS token_version")
