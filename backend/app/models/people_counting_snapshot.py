import uuid
from sqlalchemy import Column, String, Integer, DateTime, func
from app.models.base import Base


class PeopleCountingSnapshot(Base):
    __tablename__ = "people_counting_snapshots"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    camera_id = Column(String, nullable=False)
    camera_name = Column(String(255), nullable=True)
    timestamp = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    total_in = Column(Integer, nullable=False, default=0)
    total_out = Column(Integer, nullable=False, default=0)
    current_occupancy = Column(Integer, nullable=False, default=0)
    foot_traffic_left = Column(Integer, nullable=False, default=0)
    foot_traffic_right = Column(Integer, nullable=False, default=0)
    foot_traffic_total = Column(Integer, nullable=False, default=0)

    def __repr__(self) -> str:
        return f"<PeopleCountingSnapshot(id={self.id!r}, camera={self.camera_id!r}, occupancy={self.current_occupancy})>"
