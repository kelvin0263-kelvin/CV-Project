"""rename entrance_id to building_id on people counting configs

Revision ID: b4c5d6e7f8a9
Revises: a1b2c3d4e5f6
Create Date: 2026-03-27 18:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b4c5d6e7f8a9"
down_revision: Union[str, Sequence[str], None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    has_entrance_id = _has_column("people_counting_configs", "entrance_id")
    has_building_id = _has_column("people_counting_configs", "building_id")
    if not has_entrance_id or has_building_id:
        return

    with op.batch_alter_table("people_counting_configs") as batch_op:
        batch_op.alter_column(
            "entrance_id",
            new_column_name="building_id",
            existing_type=sa.String(length=100),
            existing_nullable=True,
        )


def downgrade() -> None:
    has_entrance_id = _has_column("people_counting_configs", "entrance_id")
    has_building_id = _has_column("people_counting_configs", "building_id")
    if has_entrance_id or not has_building_id:
        return

    with op.batch_alter_table("people_counting_configs") as batch_op:
        batch_op.alter_column(
            "building_id",
            new_column_name="entrance_id",
            existing_type=sa.String(length=100),
            existing_nullable=True,
        )
