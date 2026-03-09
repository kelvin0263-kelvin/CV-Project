"""add building counting snapshots

Revision ID: 4c1a2b7d9e6f
Revises: 9d3c6a1b5f2e
Create Date: 2026-03-10 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "4c1a2b7d9e6f"
down_revision = "9d3c6a1b5f2e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "building_counting_snapshots",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("timestamp", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("raw_in", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("raw_out", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("raw_occupancy", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("manual_offset", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("occupancy", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("active_camera_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("entrance_summaries", sa.JSON(), nullable=False, server_default=sa.text("'{}'::json")),
        sa.PrimaryKeyConstraint("id"),
    )

    op.alter_column("building_counting_snapshots", "enabled", server_default=None)
    op.alter_column("building_counting_snapshots", "raw_in", server_default=None)
    op.alter_column("building_counting_snapshots", "raw_out", server_default=None)
    op.alter_column("building_counting_snapshots", "raw_occupancy", server_default=None)
    op.alter_column("building_counting_snapshots", "manual_offset", server_default=None)
    op.alter_column("building_counting_snapshots", "occupancy", server_default=None)
    op.alter_column("building_counting_snapshots", "active_camera_count", server_default=None)
    op.alter_column("building_counting_snapshots", "entrance_summaries", server_default=None)


def downgrade() -> None:
    op.drop_table("building_counting_snapshots")
