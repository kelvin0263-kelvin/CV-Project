from pydantic import BaseModel, Field
from typing import Optional


class CameraCreate(BaseModel):
    """Schema for creating a new camera."""
    id: Optional[str] = None  # Auto-generated if not provided
    name: str
    location: str = ""
    type: str = "File"
    status: str = "Offline"
    mode: str = "People Counting"
    ws_url: str = ""
    resolution: str = "640x360"
    fps: int = 30
    enabled: bool = True
    image: str = ""
    source_path: Optional[str] = None
    view_index: int = -1
    is_fisheye: bool = False


class CameraRead(BaseModel):
    """Schema for reading a camera (API response)."""
    id: str
    name: str
    location: str
    type: str
    status: str
    mode: str
    ws_url: str
    resolution: str
    fps: int
    enabled: bool
    image: str
    source_path: Optional[str] = None
    view_index: int = -1
    is_fisheye: bool = False
    analysis_tags: list[str] = Field(default_factory=list)

    model_config = {"from_attributes": True}


class CameraUpdate(BaseModel):
    """Schema for partially updating a camera."""
    name: Optional[str] = None
    location: Optional[str] = None
    type: Optional[str] = None
    status: Optional[str] = None
    mode: Optional[str] = None
    ws_url: Optional[str] = None
    resolution: Optional[str] = None
    fps: Optional[int] = None
    enabled: Optional[bool] = None
    image: Optional[str] = None
    source_path: Optional[str] = None
    view_index: Optional[int] = None
    is_fisheye: Optional[bool] = None
