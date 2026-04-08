"""merge building snapshot and capacity heads

Revision ID: f2b3c4d5e6f7
Revises: d7e8f9a0b1c2, f1a2b3c4d5e6
Create Date: 2026-04-08 04:20:00.000000

"""

from typing import Sequence, Union


revision: str = "f2b3c4d5e6f7"
down_revision: Union[str, Sequence[str], None] = ("d7e8f9a0b1c2", "f1a2b3c4d5e6")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
