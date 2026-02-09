import uuid
from sqlalchemy import Column, String, Integer, Boolean, JSON, ForeignKey
from app.models.base import Base


class PeopleCountingConfig(Base):
    __tablename__ = "people_counting_configs"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    camera_id = Column(String, ForeignKey("cameras.id", ondelete="CASCADE"), unique=True, nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    max_capacity = Column(Integer, nullable=True)
    # JSON: [{id, name, points: [[x1,y1],[x2,y2]], direction: "left_to_right"|"right_to_left"}]
    lines = Column(JSON, nullable=False, default=list)
    # JSON: [{id, name, points: [[x1,y1],[x2,y2],[x3,y3],...]}]
    zones = Column(JSON, nullable=False, default=list)

    def __repr__(self) -> str:
        return f"<PeopleCountingConfig(id={self.id!r}, camera={self.camera_id!r})>"
