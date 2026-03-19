"""add detection roi to stream configs

Revision ID: aa12b3c4d5e6
Revises: 9d3c6a1b5f2e
Create Date: 2026-03-13 12:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "aa12b3c4d5e6"
down_revision: Union[str, Sequence[str], None] = "9d3c6a1b5f2e"
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
    conn = op.get_bind()
    if not _column_exists(conn, "stream_configs", "detection_roi"):
        op.add_column(
            "stream_configs",
            sa.Column("detection_roi", sa.JSON(), nullable=True),
        )


def downgrade() -> None:
    conn = op.get_bind()
    if _column_exists(conn, "stream_configs", "detection_roi"):
        op.drop_column("stream_configs", "detection_roi")
