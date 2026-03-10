# Import all models so Alembic can discover them
from app.models.base import Base
from app.models.camera_model import Camera
from app.models.stream_config import StreamConfig
from app.models.user import User
from app.models.detection_event import DetectionEvent
from app.models.dresscode_policy import DressCodePolicy
from app.models.building_counting_config import BuildingCountingConfig
from app.models.building_counting_snapshot import BuildingCountingSnapshot
from app.models.people_counting_config import PeopleCountingConfig
from app.models.people_counting_snapshot import PeopleCountingSnapshot
from app.models.fall_detection_config import FallDetectionConfig

__all__ = [
    "Base",
    "Camera",
    "StreamConfig",
    "User",
    "DetectionEvent",
    "DressCodePolicy",
    "BuildingCountingConfig",
    "BuildingCountingSnapshot",
    "PeopleCountingConfig",
    "PeopleCountingSnapshot",
    "FallDetectionConfig",
]
