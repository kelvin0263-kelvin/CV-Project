from pydantic import BaseModel
from typing import Optional, Any
from datetime import datetime


# ---------------------------------------------------------------------------
# People Counting Config
# ---------------------------------------------------------------------------

class CountingLineSchema(BaseModel):
    """A single counting line definition."""
    id: str
    name: str = ""
    points: list[list[float]]  # [[x1,y1],[x2,y2]] in normalized 0-1 coords
    direction: str = "left_to_right"  # or "right_to_left"


class CountingZoneSchema(BaseModel):
    """A single ROI zone definition."""
    id: str
    name: str = ""
    points: list[list[float]]  # [[x1,y1],[x2,y2],[x3,y3],...] in normalized 0-1 coords


class PeopleCountingConfigRead(BaseModel):
    """Schema for reading people counting config."""
    id: str
    camera_id: str
    enabled: bool
    max_capacity: Optional[int] = None
    lines: list[dict[str, Any]] = []
    zones: list[dict[str, Any]] = []

    model_config = {"from_attributes": True}


class PeopleCountingConfigUpdate(BaseModel):
    """Schema for creating/updating people counting config."""
    enabled: Optional[bool] = True
    max_capacity: Optional[int] = None
    lines: Optional[list[dict[str, Any]]] = None
    zones: Optional[list[dict[str, Any]]] = None


# ---------------------------------------------------------------------------
# People Counting Snapshot (history)
# ---------------------------------------------------------------------------

class PeopleCountingSnapshotRead(BaseModel):
    """Schema for reading a counting snapshot."""
    id: str
    camera_id: str
    timestamp: datetime
    total_in: int
    total_out: int
    zone_counts: Optional[dict[str, Any]] = None
    current_occupancy: int

    model_config = {"from_attributes": True}
