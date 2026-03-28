"""merge current alembic heads

Revision ID: f9a1b2c3d4e5
Revises: aa12b3c4d5e6, b7d4c9e2f1a0, c8b1d2e3f4a5
Create Date: 2026-03-26 04:35:00.000000

"""
from typing import Sequence, Union


# revision identifiers, used by Alembic.
revision: str = "f9a1b2c3d4e5"
down_revision: Union[str, Sequence[str], None] = (
    "aa12b3c4d5e6",
    "b7d4c9e2f1a0",
    "c8b1d2e3f4a5",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
