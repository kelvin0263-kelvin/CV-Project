"""replace zones with frame exclude areas

Revision ID: c7b6e4d1a2f0
Revises: a9c4d7e8f102
Create Date: 2026-03-09 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "c7b6e4d1a2f0"
down_revision: Union[str, Sequence[str], None] = "a9c4d7e8f102"
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

    if not _column_exists(conn, "people_counting_configs", "frame_exclude_areas"):
        op.add_column(
            "people_counting_configs",
            sa.Column(
                "frame_exclude_areas",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'[]'"),
            ),
        )

    if _column_exists(conn, "people_counting_configs", "zones"):
        op.drop_column("people_counting_configs", "zones")

    if _column_exists(conn, "people_counting_snapshots", "zone_counts"):
        op.drop_column("people_counting_snapshots", "zone_counts")


def downgrade() -> None:
    conn = op.get_bind()

    if not _column_exists(conn, "people_counting_configs", "zones"):
        op.add_column(
            "people_counting_configs",
            sa.Column(
                "zones",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'[]'"),
            ),
        )

    if not _column_exists(conn, "people_counting_snapshots", "zone_counts"):
        op.add_column(
            "people_counting_snapshots",
            sa.Column(
                "zone_counts",
                sa.JSON(),
                nullable=True,
                server_default=sa.text("'{}'"),
            ),
        )

    if _column_exists(conn, "people_counting_configs", "frame_exclude_areas"):
        op.drop_column("people_counting_configs", "frame_exclude_areas")
