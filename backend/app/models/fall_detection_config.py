import uuid
from sqlalchemy import Column, String, Integer, Float, Boolean, ForeignKey
from app.models.base import Base


class FallDetectionConfig(Base):
    __tablename__ = "fall_detection_configs"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    camera_id = Column(String, ForeignKey("cameras.id", ondelete="CASCADE"), unique=True, nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    detection_sensitivity = Column(Integer, nullable=False, default=75)
    inactivity_timer_seconds = Column(Float, nullable=False, default=1.0)

    def __repr__(self) -> str:
        return f"<FallDetectionConfig(camera_id={self.camera_id!r}, inactivity={self.inactivity_timer_seconds}s)>"
