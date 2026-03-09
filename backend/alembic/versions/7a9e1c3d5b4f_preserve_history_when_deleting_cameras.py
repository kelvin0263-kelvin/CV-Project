"""preserve history when deleting cameras

Revision ID: 7a9e1c3d5b4f
Revises: 6f2c8b1d4e9a
Create Date: 2026-03-10 00:30:00.000000

"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "7a9e1c3d5b4f"
down_revision = "6f2c8b1d4e9a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "detection_events",
        sa.Column("camera_name", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "people_counting_snapshots",
        sa.Column("camera_name", sa.String(length=255), nullable=True),
    )

    op.execute(
        """
        UPDATE detection_events AS detection
        SET camera_name = cameras.name
        FROM cameras
        WHERE detection.camera_id = cameras.id
          AND detection.camera_name IS NULL
        """
    )
    op.execute(
        """
        UPDATE people_counting_snapshots AS snapshots
        SET camera_name = cameras.name
        FROM cameras
        WHERE snapshots.camera_id = cameras.id
          AND snapshots.camera_name IS NULL
        """
    )

    op.drop_constraint("detection_events_camera_id_fkey", "detection_events", type_="foreignkey")
    op.drop_constraint("people_counting_snapshots_camera_id_fkey", "people_counting_snapshots", type_="foreignkey")


def downgrade() -> None:
    op.execute(
        """
        DELETE FROM detection_events
        WHERE camera_id IS NOT NULL
          AND camera_id NOT IN (SELECT id FROM cameras)
        """
    )
    op.execute(
        """
        DELETE FROM people_counting_snapshots
        WHERE camera_id NOT IN (SELECT id FROM cameras)
        """
    )

    op.create_foreign_key(
        "detection_events_camera_id_fkey",
        "detection_events",
        "cameras",
        ["camera_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "people_counting_snapshots_camera_id_fkey",
        "people_counting_snapshots",
        "cameras",
        ["camera_id"],
        ["id"],
        ondelete="CASCADE",
    )

    op.drop_column("people_counting_snapshots", "camera_name")
    op.drop_column("detection_events", "camera_name")
