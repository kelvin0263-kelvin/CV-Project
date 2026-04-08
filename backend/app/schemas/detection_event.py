from pydantic import BaseModel
from typing import Optional, Any
from datetime import datetime


class DetectionEventCreate(BaseModel):
    """Schema for creating a detection event."""
    camera_id: Optional[str] = None
    event_type: str
    timestamp: Optional[datetime] = None
    processed_at: Optional[datetime] = None
    details: Optional[dict[str, Any]] = None


class DetectionEventRead(BaseModel):
    """Schema for reading a detection event (API response)."""
    id: str
    camera_id: Optional[str] = None
    camera_name: Optional[str] = None
    event_type: str
    timestamp: Optional[datetime] = None
    processed_at: Optional[datetime] = None
    details: Optional[dict[str, Any]] = None

    model_config = {"from_attributes": True}
