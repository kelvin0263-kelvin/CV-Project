import uuid

from sqlalchemy import Column, String, Integer, Boolean

from app.models.base import Base


class BuildingCountingConfig(Base):
    __tablename__ = "building_counting_configs"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    enabled = Column(Boolean, nullable=False, default=True)
    max_capacity = Column(Integer, nullable=True)
    manual_offset = Column(Integer, nullable=False, default=0)

    def __repr__(self) -> str:
        return (
            f"<BuildingCountingConfig(id={self.id!r}, enabled={self.enabled!r}, "
            f"max_capacity={self.max_capacity!r}, manual_offset={self.manual_offset!r})>"
        )
