import uuid
from sqlalchemy import Column, String, DateTime, ForeignKey, JSON, func
from app.models.base import Base


class DetectionEvent(Base):
    __tablename__ = "detection_events"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    camera_id = Column(String, ForeignKey("cameras.id", ondelete="CASCADE"), nullable=False)
    event_type = Column(String(100), nullable=False)
    timestamp = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    details = Column(JSON, nullable=True)

    def __repr__(self) -> str:
        return f"<DetectionEvent(id={self.id!r}, type={self.event_type!r})>"
