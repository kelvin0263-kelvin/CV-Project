import uuid
from sqlalchemy import Column, String, Integer, DateTime, JSON, ForeignKey, func
from app.models.base import Base


class PeopleCountingSnapshot(Base):
    __tablename__ = "people_counting_snapshots"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    camera_id = Column(String, ForeignKey("cameras.id", ondelete="CASCADE"), nullable=False)
    timestamp = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    total_in = Column(Integer, nullable=False, default=0)
    total_out = Column(Integer, nullable=False, default=0)
    zone_counts = Column(JSON, nullable=True, default=dict)
    current_occupancy = Column(Integer, nullable=False, default=0)

    def __repr__(self) -> str:
        return f"<PeopleCountingSnapshot(id={self.id!r}, camera={self.camera_id!r}, occupancy={self.current_occupancy})>"
