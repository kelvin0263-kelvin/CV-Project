import uuid
from sqlalchemy import Column, String, Boolean, JSON, ForeignKey, Float
from app.models.base import Base


class PeopleCountingConfig(Base):
    __tablename__ = "people_counting_configs"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    camera_id = Column(String, ForeignKey("cameras.id", ondelete="CASCADE"), unique=True, nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    participate_in_building_count = Column(Boolean, nullable=False, default=False)
    building_id = Column(String(100), nullable=True)
    cross_camera_enabled = Column(Boolean, nullable=False, default=False)
    cross_camera_pair_id = Column(String(100), nullable=True)
    cross_camera_role = Column(String(20), nullable=False, default="none")
    verification_camera_id = Column(String, nullable=True)
    verification_inward_threshold = Column(Float, nullable=False, default=0.02)
    # JSON: [{id, name, points: [[x1,y1],[x2,y2]], direction: "left_to_right"|"right_to_left"}]
    lines = Column(JSON, nullable=False, default=list)
    # JSON: [{id, name, points: [[x1,y1],[x2,y2],[x3,y3],...]}]
    frame_exclude_areas = Column(JSON, nullable=False, default=list)

    def __repr__(self) -> str:
        return f"<PeopleCountingConfig(id={self.id!r}, camera={self.camera_id!r})>"
