"""add separate dresscode thresholds

Revision ID: d4e6f8a1b2c3
Revises: a1b2c3d4e5f6
Create Date: 2026-04-02 01:40:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "d4e6f8a1b2c3"
down_revision: Union[str, Sequence[str], None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "dresscode_policies",
        sa.Column("pants_confidence_threshold", sa.Float(), nullable=True),
    )
    op.add_column(
        "dresscode_policies",
        sa.Column("slipper_confidence_threshold", sa.Float(), nullable=True),
    )

    op.execute(
        sa.text(
            "UPDATE dresscode_policies "
            "SET pants_confidence_threshold = COALESCE(pants_confidence_threshold, confidence_threshold, 0.8), "
            "slipper_confidence_threshold = COALESCE(slipper_confidence_threshold, confidence_threshold, 0.8)"
        )
    )

    op.alter_column(
        "dresscode_policies",
        "pants_confidence_threshold",
        existing_type=sa.Float(),
        nullable=False,
        server_default="0.8",
    )
    op.alter_column(
        "dresscode_policies",
        "slipper_confidence_threshold",
        existing_type=sa.Float(),
        nullable=False,
        server_default="0.8",
    )
    op.alter_column("dresscode_policies", "pants_confidence_threshold", server_default=None)
    op.alter_column("dresscode_policies", "slipper_confidence_threshold", server_default=None)


def downgrade() -> None:
    op.drop_column("dresscode_policies", "slipper_confidence_threshold")
    op.drop_column("dresscode_policies", "pants_confidence_threshold")
