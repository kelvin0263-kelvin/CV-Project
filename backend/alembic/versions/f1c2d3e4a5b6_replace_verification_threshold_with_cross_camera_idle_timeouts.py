"""replace verification threshold with cross-camera idle timeouts

Revision ID: f1c2d3e4a5b6
Revises: b4c5d6e7f8a9
Create Date: 2026-04-06 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f1c2d3e4a5b6"
down_revision: Union[str, Sequence[str], None] = "b4c5d6e7f8a9"
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

    if not _column_exists(conn, "people_counting_configs", "primary_in_event_idle_timeout_sec"):
        op.add_column(
            "people_counting_configs",
            sa.Column(
                "primary_in_event_idle_timeout_sec",
                sa.Float(),
                nullable=False,
                server_default="7.0",
            ),
        )
        op.alter_column(
            "people_counting_configs",
            "primary_in_event_idle_timeout_sec",
            server_default=None,
        )

    if not _column_exists(conn, "people_counting_configs", "primary_out_event_idle_timeout_sec"):
        op.add_column(
            "people_counting_configs",
            sa.Column(
                "primary_out_event_idle_timeout_sec",
                sa.Float(),
                nullable=False,
                server_default="7.0",
            ),
        )
        op.alter_column(
            "people_counting_configs",
            "primary_out_event_idle_timeout_sec",
            server_default=None,
        )

    if _column_exists(conn, "people_counting_configs", "verification_inward_threshold"):
        op.drop_column("people_counting_configs", "verification_inward_threshold")


def downgrade() -> None:
    conn = op.get_bind()

    if not _column_exists(conn, "people_counting_configs", "verification_inward_threshold"):
        op.add_column(
            "people_counting_configs",
            sa.Column(
                "verification_inward_threshold",
                sa.Float(),
                nullable=False,
                server_default="0.02",
            ),
        )
        op.alter_column(
            "people_counting_configs",
            "verification_inward_threshold",
            server_default=None,
        )

    if _column_exists(conn, "people_counting_configs", "primary_out_event_idle_timeout_sec"):
        op.drop_column("people_counting_configs", "primary_out_event_idle_timeout_sec")

    if _column_exists(conn, "people_counting_configs", "primary_in_event_idle_timeout_sec"):
        op.drop_column("people_counting_configs", "primary_in_event_idle_timeout_sec")
