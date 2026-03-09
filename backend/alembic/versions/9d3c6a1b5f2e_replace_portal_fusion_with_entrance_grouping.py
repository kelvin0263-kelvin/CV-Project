"""replace portal fusion with entrance grouping

Revision ID: 9d3c6a1b5f2e
Revises: e1f4c0b9d2a7
Create Date: 2026-03-10 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "9d3c6a1b5f2e"
down_revision = "e1f4c0b9d2a7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "people_counting_configs",
        sa.Column("entrance_id", sa.String(length=100), nullable=True),
    )

    op.add_column(
        "building_counting_configs",
        sa.Column(
            "manual_offset",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )

    op.drop_column("people_counting_configs", "portal_id")
    op.drop_column("people_counting_configs", "sensor_role")
    op.drop_column("building_counting_configs", "baseline_occupancy")
    op.drop_column("building_counting_configs", "match_window_ms")

    op.alter_column(
        "building_counting_configs",
        "manual_offset",
        server_default=None,
    )


def downgrade() -> None:
    op.add_column(
        "people_counting_configs",
        sa.Column("portal_id", sa.String(length=100), nullable=True),
    )
    op.add_column(
        "people_counting_configs",
        sa.Column("sensor_role", sa.String(length=20), nullable=True),
    )
    op.add_column(
        "building_counting_configs",
        sa.Column(
            "baseline_occupancy",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "building_counting_configs",
        sa.Column(
            "match_window_ms",
            sa.Integer(),
            nullable=False,
            server_default="2000",
        ),
    )

    op.drop_column("building_counting_configs", "manual_offset")
    op.drop_column("people_counting_configs", "entrance_id")

    op.alter_column(
        "building_counting_configs",
        "baseline_occupancy",
        server_default=None,
    )
    op.alter_column(
        "building_counting_configs",
        "match_window_ms",
        server_default=None,
    )
