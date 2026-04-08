"""add processed_at to building counting snapshots

Revision ID: f1a2b3c4d5e6
Revises: f0a1b2c3d4e6
Create Date: 2026-04-08 03:55:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f1a2b3c4d5e6"
down_revision: Union[str, Sequence[str], None] = "f0a1b2c3d4e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "building_counting_snapshots",
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.alter_column(
        "building_counting_snapshots",
        "timestamp",
        existing_type=sa.DateTime(timezone=True),
        server_default=None,
        existing_nullable=False,
        nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "building_counting_snapshots",
        "timestamp",
        existing_type=sa.DateTime(timezone=True),
        server_default=sa.text("now()"),
        existing_nullable=True,
        nullable=False,
    )
    op.drop_column("building_counting_snapshots", "processed_at")
