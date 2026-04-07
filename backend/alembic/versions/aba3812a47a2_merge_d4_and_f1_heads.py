"""merge d4 and f1 heads

Revision ID: aba3812a47a2
Revises: d4e6f8a1b2c3, f1c2d3e4a5b6
Create Date: 2026-04-06 01:57:44.513935

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'aba3812a47a2'
down_revision: Union[str, Sequence[str], None] = ('d4e6f8a1b2c3', 'f1c2d3e4a5b6')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
