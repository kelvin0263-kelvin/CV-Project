"""allow sub-second inactivity timer for fall detection

Revision ID: c8b1d2e3f4a5
Revises: f5b6c7d8e9a0
Create Date: 2026-03-10

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c8b1d2e3f4a5"
down_revision: Union[str, Sequence[str], None] = "f5b6c7d8e9a0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    table_exists = conn.execute(
        sa.text(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name = 'fall_detection_configs'"
        )
    )
    if table_exists.fetchone() is None:
        return

    column_info = conn.execute(
        sa.text(
            "SELECT data_type FROM information_schema.columns "
            "WHERE table_schema = 'public' "
            "AND table_name = 'fall_detection_configs' "
            "AND column_name = 'inactivity_timer_seconds'"
        )
    ).scalar_one_or_none()
    if column_info is None or column_info in {"double precision", "real", "numeric"}:
        return

    op.alter_column(
        "fall_detection_configs",
        "inactivity_timer_seconds",
        existing_type=sa.Integer(),
        type_=sa.Float(),
        existing_nullable=False,
        server_default="1.0",
        postgresql_using="inactivity_timer_seconds::double precision",
    )


def downgrade() -> None:
    conn = op.get_bind()
    table_exists = conn.execute(
        sa.text(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name = 'fall_detection_configs'"
        )
    )
    if table_exists.fetchone() is None:
        return

    column_info = conn.execute(
        sa.text(
            "SELECT data_type FROM information_schema.columns "
            "WHERE table_schema = 'public' "
            "AND table_name = 'fall_detection_configs' "
            "AND column_name = 'inactivity_timer_seconds'"
        )
    ).scalar_one_or_none()
    if column_info is None or column_info == "integer":
        return

    op.alter_column(
        "fall_detection_configs",
        "inactivity_timer_seconds",
        existing_type=sa.Float(),
        type_=sa.Integer(),
        existing_nullable=False,
        server_default="1",
        postgresql_using="ROUND(inactivity_timer_seconds)::integer",
    )
