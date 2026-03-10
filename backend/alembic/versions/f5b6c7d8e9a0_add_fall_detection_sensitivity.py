"""add detection_sensitivity to fall_detection_configs

Revision ID: f5b6c7d8e9a0
Revises: e4a2c3d4e5f6
Create Date: 2026-03-07

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f5b6c7d8e9a0"
down_revision: Union[str, Sequence[str], None] = "e4a2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    t = conn.execute(sa.text(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'fall_detection_configs'"
    ))
    if t.fetchone() is None:
        return
    r = conn.execute(
        sa.text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = 'fall_detection_configs' AND column_name = 'detection_sensitivity'"
        )
    )
    if r.fetchone() is not None:
        return
    op.add_column(
        "fall_detection_configs",
        sa.Column("detection_sensitivity", sa.Integer(), nullable=False, server_default="75"),
    )


def downgrade() -> None:
    op.drop_column("fall_detection_configs", "detection_sensitivity")
