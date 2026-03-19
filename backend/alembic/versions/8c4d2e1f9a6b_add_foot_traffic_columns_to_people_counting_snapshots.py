"""add foot traffic columns to people counting snapshots

Revision ID: 8c4d2e1f9a6b
Revises: 7a9e1c3d5b4f
Create Date: 2026-03-19 21:30:00.000000

"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "8c4d2e1f9a6b"
down_revision = "7a9e1c3d5b4f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "people_counting_snapshots",
        sa.Column("foot_traffic_left", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "people_counting_snapshots",
        sa.Column("foot_traffic_right", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "people_counting_snapshots",
        sa.Column("foot_traffic_total", sa.Integer(), nullable=False, server_default="0"),
    )

    op.alter_column("people_counting_snapshots", "foot_traffic_left", server_default=None)
    op.alter_column("people_counting_snapshots", "foot_traffic_right", server_default=None)
    op.alter_column("people_counting_snapshots", "foot_traffic_total", server_default=None)


def downgrade() -> None:
    op.drop_column("people_counting_snapshots", "foot_traffic_total")
    op.drop_column("people_counting_snapshots", "foot_traffic_right")
    op.drop_column("people_counting_snapshots", "foot_traffic_left")
