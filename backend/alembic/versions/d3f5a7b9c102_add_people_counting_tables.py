"""add people_counting_configs and people_counting_snapshots tables

Revision ID: d3f5a7b9c102
Revises: c2a1f8b3d901
Create Date: 2026-02-10 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd3f5a7b9c102'
down_revision: Union[str, Sequence[str], None] = 'c2a1f8b3d901'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create people counting tables."""

    conn = op.get_bind()

    # 1. people_counting_configs
    result = conn.execute(
        sa.text(
            "SELECT EXISTS ("
            "  SELECT 1 FROM information_schema.tables "
            "  WHERE table_name = 'people_counting_configs'"
            ")"
        )
    )
    if not result.scalar():
        op.create_table(
            "people_counting_configs",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column(
                "camera_id",
                sa.String(),
                sa.ForeignKey("cameras.id", ondelete="CASCADE"),
                unique=True,
                nullable=False,
            ),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("max_capacity", sa.Integer(), nullable=True),
            sa.Column("lines", sa.JSON(), nullable=False, server_default="[]"),
            sa.Column("zones", sa.JSON(), nullable=False, server_default="[]"),
        )

    # 2. people_counting_snapshots
    result = conn.execute(
        sa.text(
            "SELECT EXISTS ("
            "  SELECT 1 FROM information_schema.tables "
            "  WHERE table_name = 'people_counting_snapshots'"
            ")"
        )
    )
    if not result.scalar():
        op.create_table(
            "people_counting_snapshots",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column(
                "camera_id",
                sa.String(),
                sa.ForeignKey("cameras.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "timestamp",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column("total_in", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("total_out", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("zone_counts", sa.JSON(), nullable=True),
            sa.Column("current_occupancy", sa.Integer(), nullable=False, server_default="0"),
        )


def downgrade() -> None:
    """Drop people counting tables."""
    op.drop_table("people_counting_snapshots")
    op.drop_table("people_counting_configs")
