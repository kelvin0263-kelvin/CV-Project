"""add cross-camera fields to people counting configs

Revision ID: a1b2c3d4e5f6
Revises: f9a1b2c3d4e5
Create Date: 2026-03-26 05:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, Sequence[str], None] = "f9a1b2c3d4e5"
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

    if not _column_exists(conn, "people_counting_configs", "cross_camera_enabled"):
        op.add_column(
            "people_counting_configs",
            sa.Column(
                "cross_camera_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            ),
        )
        op.alter_column("people_counting_configs", "cross_camera_enabled", server_default=None)

    if not _column_exists(conn, "people_counting_configs", "cross_camera_pair_id"):
        op.add_column(
            "people_counting_configs",
            sa.Column("cross_camera_pair_id", sa.String(length=100), nullable=True),
        )

    if not _column_exists(conn, "people_counting_configs", "cross_camera_role"):
        op.add_column(
            "people_counting_configs",
            sa.Column(
                "cross_camera_role",
                sa.String(length=20),
                nullable=False,
                server_default="none",
            ),
        )
        op.alter_column("people_counting_configs", "cross_camera_role", server_default=None)

    if not _column_exists(conn, "people_counting_configs", "verification_camera_id"):
        op.add_column(
            "people_counting_configs",
            sa.Column("verification_camera_id", sa.String(), nullable=True),
        )

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


def downgrade() -> None:
    conn = op.get_bind()

    if _column_exists(conn, "people_counting_configs", "verification_inward_threshold"):
        op.drop_column("people_counting_configs", "verification_inward_threshold")
    if _column_exists(conn, "people_counting_configs", "verification_camera_id"):
        op.drop_column("people_counting_configs", "verification_camera_id")
    if _column_exists(conn, "people_counting_configs", "cross_camera_role"):
        op.drop_column("people_counting_configs", "cross_camera_role")
    if _column_exists(conn, "people_counting_configs", "cross_camera_pair_id"):
        op.drop_column("people_counting_configs", "cross_camera_pair_id")
    if _column_exists(conn, "people_counting_configs", "cross_camera_enabled"):
        op.drop_column("people_counting_configs", "cross_camera_enabled")
