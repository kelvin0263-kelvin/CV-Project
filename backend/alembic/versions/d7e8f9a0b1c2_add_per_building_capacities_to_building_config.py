"""add per-building capacities to building config

Revision ID: d7e8f9a0b1c2
Revises: c3d4e5f6a7b8
Create Date: 2026-04-08 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d7e8f9a0b1c2"
down_revision: Union[str, Sequence[str], None] = "c3d4e5f6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "building_counting_configs",
        sa.Column(
            "capacity_by_building_id",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'{}'::json"),
        ),
    )
    op.alter_column(
        "building_counting_configs",
        "capacity_by_building_id",
        server_default=None,
    )


def downgrade() -> None:
    op.drop_column("building_counting_configs", "capacity_by_building_id")
