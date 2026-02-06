import uuid
from sqlalchemy import Column, String, Float, Boolean, JSON
from app.models.base import Base


class DressCodePolicy(Base):
    __tablename__ = "dresscode_policies"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    # JSON array of camera IDs that have dress code detection enabled
    enabled_camera_ids = Column(JSON, nullable=False, default=list)
    # JSON array of labels considered violations, e.g. ["shorts"]
    restricted_labels = Column(JSON, nullable=False, default=lambda: ["shorts"])
    # Minimum confidence to flag a violation
    confidence_threshold = Column(Float, nullable=False, default=0.8)
    # Whether the policy is active
    enabled = Column(Boolean, nullable=False, default=True)

    def __repr__(self) -> str:
        return f"<DressCodePolicy(id={self.id!r}, enabled={self.enabled})>"
