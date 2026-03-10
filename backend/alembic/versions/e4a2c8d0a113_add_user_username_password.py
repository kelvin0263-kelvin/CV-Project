"""add username and password_hash to users for auth

Revision ID: e4a2c8d0a113
Revises: 7a9e1c3d5b4f
Create Date: 2026-02-11

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e4a2c8d0a113"
down_revision: Union[str, Sequence[str], None] = "7a9e1c3d5b4f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("username", sa.String(80), nullable=True))
    op.add_column("users", sa.Column("password_hash", sa.String(255), nullable=True))
    op.alter_column(
        "users",
        "email",
        existing_type=sa.String(320),
        nullable=True,
    )
    op.create_index(op.f("ix_users_username"), "users", ["username"], unique=True)


def downgrade() -> None:
    op.drop_index(op.f("ix_users_username"), table_name="users")
    op.alter_column(
        "users",
        "email",
        existing_type=sa.String(320),
        nullable=False,
    )
    op.drop_column("users", "password_hash")
    op.drop_column("users", "username")
