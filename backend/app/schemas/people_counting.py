from pydantic import BaseModel, Field
from typing import Optional, Any, Literal
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


class FrameExcludeAreaSchema(BaseModel):
    """A single frame exclusion polygon for line counting."""
    id: str
    name: str = ""
    points: list[list[float]]  # [[x1,y1],[x2,y2],[x3,y3],...] in normalized 0-1 coords


class PeopleCountingConfigRead(BaseModel):
    """Schema for reading people counting config."""
    id: str
    camera_id: str
    enabled: bool
    participate_in_building_count: bool = False
    entrance_id: Optional[str] = None
    lines: list[dict[str, Any]] = Field(default_factory=list)
    frame_exclude_areas: list[dict[str, Any]] = Field(default_factory=list)

    model_config = {"from_attributes": True}


class PeopleCountingConfigUpdate(BaseModel):
    """Schema for creating/updating people counting config."""
    enabled: Optional[bool] = True
    participate_in_building_count: Optional[bool] = None
    entrance_id: Optional[str] = None
    lines: Optional[list[dict[str, Any]]] = None
    frame_exclude_areas: Optional[list[dict[str, Any]]] = None


class BuildingCountingConfigRead(BaseModel):
    """Schema for reading building-level counting config."""
    id: str
    enabled: bool
    max_capacity: Optional[int] = None
    manual_offset: int

    model_config = {"from_attributes": True}


class BuildingCountingConfigUpdate(BaseModel):
    """Schema for updating building-level counting config."""
    enabled: Optional[bool] = None
    max_capacity: Optional[int] = None
    manual_offset: Optional[int] = None


class BuildingOccupancySummaryRead(BaseModel):
    """Schema for reading live building-level occupancy summary."""
    enabled: bool
    max_capacity: Optional[int] = None
    capacity_exceeded: bool
    manual_offset: int
    raw_in: int
    raw_out: int
    raw_occupancy: int
    occupancy: int
    active_camera_count: int
    entrance_summaries: dict[str, Any]


class BuildingCountingSnapshotRead(BaseModel):
    """Schema for reading historical building-level occupancy snapshots."""
    id: str
    timestamp: datetime
    enabled: bool
    raw_in: int
    raw_out: int
    raw_occupancy: int
    max_capacity: Optional[int] = None
    capacity_exceeded: bool
    manual_offset: int
    occupancy: int
    active_camera_count: int
    entrance_summaries: dict[str, Any]

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# People Counting Snapshot (history)
# ---------------------------------------------------------------------------

class PeopleCountingSnapshotRead(BaseModel):
    """Schema for reading a counting snapshot."""
    id: str
    camera_id: str
    camera_name: Optional[str] = None
    timestamp: datetime
    total_in: int
    total_out: int
    current_occupancy: int

    model_config = {"from_attributes": True}
