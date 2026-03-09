import uuid

from sqlalchemy import Column, String, Integer, DateTime, Boolean, JSON, func

from app.models.base import Base


class BuildingCountingSnapshot(Base):
    __tablename__ = "building_counting_snapshots"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    timestamp = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    raw_in = Column(Integer, nullable=False, default=0)
    raw_out = Column(Integer, nullable=False, default=0)
    raw_occupancy = Column(Integer, nullable=False, default=0)
    max_capacity = Column(Integer, nullable=True)
    capacity_exceeded = Column(Boolean, nullable=False, default=False)
    manual_offset = Column(Integer, nullable=False, default=0)
    occupancy = Column(Integer, nullable=False, default=0)
    active_camera_count = Column(Integer, nullable=False, default=0)
    entrance_summaries = Column(JSON, nullable=False, default=dict)

    def __repr__(self) -> str:
        return (
            f"<BuildingCountingSnapshot(id={self.id!r}, occupancy={self.occupancy!r}, "
            f"raw_occupancy={self.raw_occupancy!r}, capacity_exceeded={self.capacity_exceeded!r})>"
        )
