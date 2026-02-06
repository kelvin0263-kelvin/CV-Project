"""initial tables

Revision ID: b09343afe57f
Revises: 
Create Date: 2026-02-06 22:26:17.309667

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b09343afe57f'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # --- cameras ---
    op.create_table(
        "cameras",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("location", sa.String(255), nullable=False, server_default=""),
        sa.Column("type", sa.String(50), nullable=False, server_default="File"),
        sa.Column("status", sa.String(50), nullable=False, server_default="Offline"),
        sa.Column("mode", sa.String(100), nullable=False, server_default="People Counting"),
        sa.Column("ws_url", sa.String(500), nullable=False, server_default=""),
        sa.Column("resolution", sa.String(20), nullable=False, server_default="640x360"),
        sa.Column("fps", sa.Integer(), nullable=False, server_default="30"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("image", sa.Text(), nullable=False, server_default=""),
    )

    # --- stream_configs ---
    op.create_table(
        "stream_configs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "camera_id",
            sa.String(),
            sa.ForeignKey("cameras.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("source_path", sa.String(1000), nullable=False),
        sa.Column("view_index", sa.Integer(), nullable=False, server_default="-1"),
        sa.Column("is_fisheye", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )

    # --- users ---
    op.create_table(
        "users",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("email", sa.String(320), nullable=False, unique=True),
        sa.Column("role", sa.String(50), nullable=False, server_default="viewer"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    # --- detection_events ---
    op.create_table(
        "detection_events",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "camera_id",
            sa.String(),
            sa.ForeignKey("cameras.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("event_type", sa.String(100), nullable=False),
        sa.Column(
            "timestamp",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("details", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("detection_events")
    op.drop_table("users")
    op.drop_table("stream_configs")
    op.drop_table("cameras")
