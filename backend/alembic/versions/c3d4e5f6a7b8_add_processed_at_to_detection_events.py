"""add processed_at to detection events

Revision ID: c3d4e5f6a7b8
Revises: aba3812a47a2
Create Date: 2026-04-07 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "c3d4e5f6a7b8"
down_revision: Union[str, Sequence[str], None] = "aba3812a47a2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "detection_events",
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.alter_column(
        "detection_events",
        "timestamp",
        existing_type=sa.DateTime(timezone=True),
        server_default=None,
        nullable=True,
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE detection_events
        SET timestamp = COALESCE(timestamp, processed_at, NOW())
        WHERE timestamp IS NULL
        """
    )
    op.alter_column(
        "detection_events",
        "timestamp",
        existing_type=sa.DateTime(timezone=True),
        server_default=sa.text("now()"),
        nullable=False,
    )
    op.drop_column("detection_events", "processed_at")
