"""remove manual offset from building counting

Revision ID: c1d2e3f4a5b7
Revises: f3c4d5e6f7a8
Create Date: 2026-04-22 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "c1d2e3f4a5b7"
down_revision: Union[str, Sequence[str], None] = "f3c4d5e6f7a8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    if _has_column("building_counting_snapshots", "occupancy"):
        op.execute(
            sa.text(
                """
                UPDATE building_counting_snapshots
                SET occupancy = raw_occupancy
                WHERE occupancy IS DISTINCT FROM raw_occupancy
                """
            )
        )

    if _has_column("building_counting_configs", "manual_offset"):
        op.drop_column("building_counting_configs", "manual_offset")
    if _has_column("building_counting_snapshots", "manual_offset"):
        op.drop_column("building_counting_snapshots", "manual_offset")


def downgrade() -> None:
    if not _has_column("building_counting_configs", "manual_offset"):
        op.add_column(
            "building_counting_configs",
            sa.Column("manual_offset", sa.Integer(), nullable=False, server_default="0"),
        )
        op.alter_column("building_counting_configs", "manual_offset", server_default=None)

    if not _has_column("building_counting_snapshots", "manual_offset"):
        op.add_column(
            "building_counting_snapshots",
            sa.Column("manual_offset", sa.Integer(), nullable=False, server_default="0"),
        )
        op.alter_column("building_counting_snapshots", "manual_offset", server_default=None)
