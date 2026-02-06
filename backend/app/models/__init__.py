# Import all models so Alembic can discover them
from app.models.base import Base
from app.models.camera_model import Camera
from app.models.stream_config import StreamConfig
from app.models.user import User
from app.models.detection_event import DetectionEvent

__all__ = ["Base", "Camera", "StreamConfig", "User", "DetectionEvent"]
