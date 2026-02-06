from pydantic import BaseModel
from typing import Optional, Any
from datetime import datetime


class DetectionEventCreate(BaseModel):
    """Schema for creating a detection event."""
    camera_id: str
    event_type: str
    details: Optional[dict[str, Any]] = None


class DetectionEventRead(BaseModel):
    """Schema for reading a detection event (API response)."""
    id: str
    camera_id: str
    event_type: str
    timestamp: datetime
    details: Optional[dict[str, Any]] = None

    model_config = {"from_attributes": True}
