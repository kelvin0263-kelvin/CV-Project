import uuid
from sqlalchemy import Column, String, DateTime, JSON
from app.models.base import Base


class DetectionEvent(Base):
    __tablename__ = "detection_events"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    camera_id = Column(String, nullable=True)
    camera_name = Column(String(255), nullable=True)
    event_type = Column(String(100), nullable=False)
    timestamp = Column(DateTime(timezone=True), nullable=True)
    processed_at = Column(DateTime(timezone=True), nullable=True)
    details = Column(JSON, nullable=True)

    def __repr__(self) -> str:
        return f"<DetectionEvent(id={self.id!r}, type={self.event_type!r})>"
