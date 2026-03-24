from pydantic import BaseModel
from typing import Optional


class DressCodePolicyRead(BaseModel):
    """Schema for reading the dress code policy."""
    id: str
    enabled_camera_ids: list[str]
    restricted_labels: list[str]
    confidence_threshold: float
    enabled: bool
    enable_pants_detection: bool
    enable_slipper_detection: bool

    model_config = {"from_attributes": True}


class DressCodePolicyUpdate(BaseModel):
    """Schema for updating the dress code policy from the config panel."""
    enabled_camera_ids: Optional[list[str]] = None
    restricted_labels: Optional[list[str]] = None
    confidence_threshold: Optional[float] = None
    enabled: Optional[bool] = None
    enable_pants_detection: Optional[bool] = None
    enable_slipper_detection: Optional[bool] = None
