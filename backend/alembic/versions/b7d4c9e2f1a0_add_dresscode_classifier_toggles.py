"""add dresscode classifier toggles

Revision ID: b7d4c9e2f1a0
Revises: 8c4d2e1f9a6b
Create Date: 2026-03-22 11:40:00.000000

"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "b7d4c9e2f1a0"
down_revision = "8c4d2e1f9a6b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "dresscode_policies",
        sa.Column("enable_pants_detection", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )
    op.add_column(
        "dresscode_policies",
        sa.Column("enable_slipper_detection", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )

    op.alter_column("dresscode_policies", "enable_pants_detection", server_default=None)
    op.alter_column("dresscode_policies", "enable_slipper_detection", server_default=None)


def downgrade() -> None:
    op.drop_column("dresscode_policies", "enable_slipper_detection")
    op.drop_column("dresscode_policies", "enable_pants_detection")
