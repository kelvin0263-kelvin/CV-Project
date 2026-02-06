import uuid
from sqlalchemy import Column, String, Integer, Boolean, Text
from app.models.base import Base


class Camera(Base):
    __tablename__ = "cameras"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String(255), nullable=False)
    location = Column(String(255), nullable=False, default="")
    type = Column(String(50), nullable=False, default="File")
    status = Column(String(50), nullable=False, default="Offline")
    mode = Column(String(100), nullable=False, default="People Counting")
    ws_url = Column(String(500), nullable=False, default="")
    resolution = Column(String(20), nullable=False, default="640x360")
    fps = Column(Integer, nullable=False, default=30)
    enabled = Column(Boolean, nullable=False, default=True)
    image = Column(Text, nullable=False, default="")

    def __repr__(self) -> str:
        return f"<Camera(id={self.id!r}, name={self.name!r})>"
