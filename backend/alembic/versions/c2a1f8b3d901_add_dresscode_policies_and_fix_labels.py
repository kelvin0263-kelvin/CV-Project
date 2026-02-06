"""add dresscode_policies table and fix restricted_labels

Revision ID: c2a1f8b3d901
Revises: b09343afe57f
Create Date: 2026-02-06 23:50:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c2a1f8b3d901'
down_revision: Union[str, Sequence[str], None] = 'b09343afe57f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create dresscode_policies table (if needed) and fix restricted_labels data."""

    # 1. Create the dresscode_policies table if it doesn't exist yet
    #    (it may already exist if created by Base.metadata.create_all)
    conn = op.get_bind()
    result = conn.execute(
        sa.text(
            "SELECT EXISTS ("
            "  SELECT 1 FROM information_schema.tables "
            "  WHERE table_name = 'dresscode_policies'"
            ")"
        )
    )
    table_exists = result.scalar()

    if not table_exists:
        op.create_table(
            "dresscode_policies",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("enabled_camera_ids", sa.JSON(), nullable=False, server_default="[]"),
            sa.Column("restricted_labels", sa.JSON(), nullable=False, server_default='["shorts"]'),
            sa.Column("confidence_threshold", sa.Float(), nullable=False, server_default="0.8"),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        )

    # 2. Fix any existing rows where restricted_labels still says "short_pants"
    op.execute(
        sa.text(
            "UPDATE dresscode_policies "
            "SET restricted_labels = '[\"shorts\"]'::jsonb "
            "WHERE restricted_labels::text LIKE '%short_pants%'"
        )
    )


def downgrade() -> None:
    """Drop dresscode_policies table."""
    op.drop_table("dresscode_policies")
