"""add runtime_key to stream_configs

Revision ID: e4c9f1a2b6d3
Revises: d3f5a7b9c102
Create Date: 2026-03-03 16:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "e4c9f1a2b6d3"
down_revision: Union[str, Sequence[str], None] = "d3f5a7b9c102"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add a persistent runtime_key so one RTSP URL can back multiple producers."""
    conn = op.get_bind()
    has_column = conn.execute(
        sa.text(
            "SELECT EXISTS ("
            "  SELECT 1 FROM information_schema.columns "
            "  WHERE table_name = 'stream_configs' AND column_name = 'runtime_key'"
            ")"
        )
    ).scalar()

    if not has_column:
        op.add_column(
            "stream_configs",
            sa.Column("runtime_key", sa.String(length=1500), nullable=True),
        )

    op.execute(
        sa.text(
            "UPDATE stream_configs "
            "SET runtime_key = source_path "
            "WHERE runtime_key IS NULL OR runtime_key = ''"
        )
    )

    op.alter_column("stream_configs", "runtime_key", nullable=False)

    index_exists = conn.execute(
        sa.text(
            "SELECT EXISTS ("
            "  SELECT 1 FROM pg_indexes "
            "  WHERE tablename = 'stream_configs' "
            "    AND indexname = 'ix_stream_configs_runtime_key'"
            ")"
        )
    ).scalar()
    if not index_exists:
        op.create_index(
            "ix_stream_configs_runtime_key",
            "stream_configs",
            ["runtime_key"],
            unique=False,
        )


def downgrade() -> None:
    """Remove runtime_key from stream_configs."""
    op.drop_index("ix_stream_configs_runtime_key", table_name="stream_configs")
    op.drop_column("stream_configs", "runtime_key")
