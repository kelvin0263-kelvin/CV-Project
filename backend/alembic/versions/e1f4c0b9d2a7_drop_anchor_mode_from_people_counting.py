"""drop anchor mode from people counting

Revision ID: e1f4c0b9d2a7
Revises: c7b6e4d1a2f0
Create Date: 2026-03-10 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "e1f4c0b9d2a7"
down_revision: Union[str, Sequence[str], None] = "c7b6e4d1a2f0"
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

    if _column_exists(conn, "people_counting_configs", "anchor_mode"):
        op.drop_column("people_counting_configs", "anchor_mode")


def downgrade() -> None:
    conn = op.get_bind()

    if not _column_exists(conn, "people_counting_configs", "anchor_mode"):
        op.add_column(
            "people_counting_configs",
            sa.Column(
                "anchor_mode",
                sa.String(length=32),
                nullable=False,
                server_default="bottom_center",
            ),
        )
