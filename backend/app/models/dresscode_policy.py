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
    # Legacy shared threshold retained as a fallback for older clients/policies.
    confidence_threshold = Column(Float, nullable=False, default=0.8)
    # Minimum confidence to flag lower-body labels such as shorts or long pants.
    pants_confidence_threshold = Column(Float, nullable=False, default=0.8)
    # Minimum confidence to flag footwear labels such as slipper or non-slipper.
    slipper_confidence_threshold = Column(Float, nullable=False, default=0.8)
    # Whether the policy is active
    enabled = Column(Boolean, nullable=False, default=True)
    # Whether the pants classifier should run
    enable_pants_detection = Column(Boolean, nullable=False, default=True)
    # Whether the slipper classifier should run
    enable_slipper_detection = Column(Boolean, nullable=False, default=False)

    def __repr__(self) -> str:
        return f"<DressCodePolicy(id={self.id!r}, enabled={self.enabled})>"
