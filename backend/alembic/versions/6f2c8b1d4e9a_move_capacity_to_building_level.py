"""move capacity to building level

Revision ID: 6f2c8b1d4e9a
Revises: 4c1a2b7d9e6f
Create Date: 2026-03-10 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "6f2c8b1d4e9a"
down_revision = "4c1a2b7d9e6f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "building_counting_configs",
        sa.Column("max_capacity", sa.Integer(), nullable=True),
    )
    op.drop_column("people_counting_configs", "max_capacity")

    op.add_column(
        "building_counting_snapshots",
        sa.Column("max_capacity", sa.Integer(), nullable=True),
    )
    op.add_column(
        "building_counting_snapshots",
        sa.Column("capacity_exceeded", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.alter_column("building_counting_snapshots", "capacity_exceeded", server_default=None)

    op.alter_column("detection_events", "camera_id", existing_type=sa.String(), nullable=True)


def downgrade() -> None:
    op.alter_column("detection_events", "camera_id", existing_type=sa.String(), nullable=False)

    op.drop_column("building_counting_snapshots", "capacity_exceeded")
    op.drop_column("building_counting_snapshots", "max_capacity")

    op.add_column(
        "people_counting_configs",
        sa.Column("max_capacity", sa.Integer(), nullable=True),
    )
    op.drop_column("building_counting_configs", "max_capacity")
