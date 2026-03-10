"""add fall_detection_configs table

Revision ID: e4a2c3d4e5f6
Revises: e4a2c8d0a113
Create Date: 2026-02-25

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e4a2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = 'e4a2c8d0a113'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    existing = conn.execute(
        sa.text(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name = 'fall_detection_configs'"
        )
    )
    if existing.fetchone() is not None:
        return

    op.create_table(
        "fall_detection_configs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "camera_id",
            sa.String(),
            sa.ForeignKey("cameras.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("detection_sensitivity", sa.Integer(), nullable=False, server_default="75"),
        sa.Column("inactivity_timer_seconds", sa.Integer(), nullable=False, server_default="1"),
    )


def downgrade() -> None:
    op.drop_table("fall_detection_configs")
