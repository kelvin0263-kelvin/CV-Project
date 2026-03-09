"""add building counting config and portal sensor fields

Revision ID: f6b2d91c4a7e
Revises: e4c9f1a2b6d3
Create Date: 2026-03-03 18:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "f6b2d91c4a7e"
down_revision: Union[str, Sequence[str], None] = "e4c9f1a2b6d3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _column_exists(conn, table_name: str, column_name: str) -> bool:
    return bool(
        conn.execute(
            sa.text(
                "SELECT EXISTS ("
                "  SELECT 1 FROM information_schema.columns "
                "  WHERE table_name = :table_name AND column_name = :column_name"
                ")"
            ),
            {"table_name": table_name, "column_name": column_name},
        ).scalar()
    )


def upgrade() -> None:
    """Add building-level counting config plus per-camera portal fields."""
    conn = op.get_bind()

    if not _column_exists(conn, "people_counting_configs", "participate_in_building_count"):
        op.add_column(
            "people_counting_configs",
            sa.Column(
                "participate_in_building_count",
                sa.Boolean(),
                nullable=True,
                server_default=sa.text("false"),
            ),
        )
    if not _column_exists(conn, "people_counting_configs", "portal_id"):
        op.add_column(
            "people_counting_configs",
            sa.Column("portal_id", sa.String(length=100), nullable=True),
        )
    if not _column_exists(conn, "people_counting_configs", "sensor_role"):
        op.add_column(
            "people_counting_configs",
            sa.Column("sensor_role", sa.String(length=20), nullable=True),
        )

    op.execute(
        sa.text(
            "UPDATE people_counting_configs "
            "SET participate_in_building_count = false "
            "WHERE participate_in_building_count IS NULL"
        )
    )
    op.alter_column("people_counting_configs", "participate_in_building_count", nullable=False)

    table_exists = bool(
        conn.execute(
            sa.text(
                "SELECT EXISTS ("
                "  SELECT 1 FROM information_schema.tables "
                "  WHERE table_name = 'building_counting_configs'"
                ")"
            )
        ).scalar()
    )
    if not table_exists:
        op.create_table(
            "building_counting_configs",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("baseline_occupancy", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("match_window_ms", sa.Integer(), nullable=False, server_default="2000"),
        )

    conn.execute(
        sa.text(
            "INSERT INTO building_counting_configs (id, enabled, baseline_occupancy, match_window_ms) "
            "SELECT :id, true, 0, 2000 "
            "WHERE NOT EXISTS (SELECT 1 FROM building_counting_configs)"
        ),
        {"id": "default-building-counting-config"},
    )


def downgrade() -> None:
    """Remove building-level counting config and portal sensor fields."""
    op.drop_table("building_counting_configs")
    op.drop_column("people_counting_configs", "sensor_role")
    op.drop_column("people_counting_configs", "portal_id")
    op.drop_column("people_counting_configs", "participate_in_building_count")
