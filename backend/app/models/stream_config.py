import uuid
from sqlalchemy import Column, String, Integer, Boolean, ForeignKey, JSON, DateTime
from sqlalchemy.orm import relationship
from app.models.base import Base


class StreamConfig(Base):
    __tablename__ = "stream_configs"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    camera_id = Column(String, ForeignKey("cameras.id", ondelete="CASCADE"), nullable=False, unique=True)
    source_path = Column(String(1000), nullable=False)
    runtime_key = Column(String(1500), nullable=False, default="")
    view_index = Column(Integer, nullable=False, default=-1)
    is_fisheye = Column(Boolean, nullable=False, default=False)
    detection_roi = Column(JSON, nullable=True)
    uploaded_video_start_time_override = Column(DateTime(timezone=True), nullable=True)

    # Relationship back to Camera
    camera = relationship("Camera", backref="stream_config", uselist=False)

    def __repr__(self) -> str:
        return (
            f"<StreamConfig(camera_id={self.camera_id!r}, source={self.source_path!r}, "
            f"runtime_key={self.runtime_key!r})>"
        )
