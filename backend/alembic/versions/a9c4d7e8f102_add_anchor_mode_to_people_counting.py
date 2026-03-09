"""add anchor mode to people counting config

Revision ID: a9c4d7e8f102
Revises: f6b2d91c4a7e
Create Date: 2026-03-03 23:55:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "a9c4d7e8f102"
down_revision: Union[str, Sequence[str], None] = "f6b2d91c4a7e"
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

    if not _column_exists(conn, "people_counting_configs", "anchor_mode"):
        op.add_column(
            "people_counting_configs",
            sa.Column(
                "anchor_mode",
                sa.String(length=32),
                nullable=True,
                server_default="bottom_center",
            ),
        )

    op.execute(
        sa.text(
            "UPDATE people_counting_configs "
            "SET anchor_mode = 'bottom_center' "
            "WHERE anchor_mode IS NULL"
        )
    )
    op.alter_column("people_counting_configs", "anchor_mode", nullable=False)


def downgrade() -> None:
    op.drop_column("people_counting_configs", "anchor_mode")
