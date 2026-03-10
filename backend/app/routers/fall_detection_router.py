"""
Fall Detection Config API

GET  /api/fall-detection-config/{camera_id}  -- get config for a camera
PUT  /api/fall-detection-config/{camera_id}  -- create/update config (enabled, inactivity_timer_seconds)

In-memory cache is read by video_processor to run fall detection on the right views.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.database import get_db, AsyncSessionLocal
from app.models.fall_detection_config import FallDetectionConfig
from app.models.stream_config import StreamConfig
from app.models.user import User
from app.routers.auth_router import get_current_user
from pydantic import BaseModel

router = APIRouter()

# ---------------------------------------------------------------------------
# In-memory config cache (read by video_processor)
# ---------------------------------------------------------------------------
_fall_configs: dict[str, dict] = {}  # camera_id -> {enabled, inactivity_timer_seconds}
_fall_source_map: dict[str, set[str]] = {}  # source_path -> set of view_keys
_fall_camera_resolve: dict[str, str] = {}  # "source_path||view_key" -> camera_id


def get_fall_detection_config(camera_id: str) -> dict | None:
    """Read fall detection config for a camera (called from video_processor thread)."""
    return _fall_configs.get(camera_id)


def get_fall_detection_views(source_path: str) -> set[str]:
    """Get view keys that need fall detection for a given source_path."""
    return _fall_source_map.get(source_path, set())


def get_fall_detection_camera_id(source_path: str, view_key: str) -> str | None:
    """Resolve camera_id for source_path + view_key (fall detection context)."""
    return _fall_camera_resolve.get(f"{source_path}||{view_key}")


def _cache_config(camera_id: str, row: FallDetectionConfig):
    _fall_configs[camera_id] = {
        "enabled": row.enabled,
        "detection_sensitivity": getattr(row, "detection_sensitivity", 1),
        "inactivity_timer_seconds": row.inactivity_timer_seconds,
    }


def _remove_cached_config(camera_id: str):
    _fall_configs.pop(camera_id, None)


async def _rebuild_source_map(session: AsyncSession):
    """Rebuild _fall_source_map and _fall_camera_resolve from current configs + stream_configs."""
    global _fall_source_map, _fall_camera_resolve
    enabled_camera_ids = [
        cid for cid, cfg in _fall_configs.items() if cfg.get("enabled", True)
    ]
    new_source_map: dict[str, set[str]] = {}
    new_resolve: dict[str, str] = {}

    if enabled_camera_ids:
        result = await session.execute(
            select(StreamConfig).where(StreamConfig.camera_id.in_(enabled_camera_ids))
        )
        configs = result.scalars().all()
        for sc in configs:
            view_key = "original" if sc.view_index == -1 else f"partition_{sc.view_index}"
            src = sc.source_path
            if src not in new_source_map:
                new_source_map[src] = set()
            new_source_map[src].add(view_key)
            new_resolve[f"{src}||{view_key}"] = sc.camera_id

    _fall_source_map = new_source_map
    _fall_camera_resolve = new_resolve


async def load_fall_detection_configs_from_db():
    """Called at startup to populate in-memory cache."""
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(select(FallDetectionConfig))
            rows = result.scalars().all()
            for row in rows:
                _cache_config(row.camera_id, row)
            await _rebuild_source_map(session)
            print(f"[Startup] Loaded {len(rows)} fall detection config(s)")
    except Exception as e:
        print(f"[Startup] Warning: Could not load fall detection configs: {e}")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class FallDetectionConfigUpdate(BaseModel):
    enabled: bool | None = True
    detection_sensitivity: int | None = None  # 0-100
    inactivity_timer_seconds: float | None = None


class FallDetectionConfigRead(BaseModel):
    id: str
    camera_id: str
    enabled: bool
    detection_sensitivity: int = 75
    inactivity_timer_seconds: float

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
@router.get("/api/fall-detection-config/{camera_id}", response_model=FallDetectionConfigRead)
async def get_config(
    camera_id: str,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    try:
        result = await db.execute(
            select(FallDetectionConfig).where(FallDetectionConfig.camera_id == camera_id)
        )
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="No fall detection config for this camera")
        return FallDetectionConfigRead(
            id=row.id,
            camera_id=row.camera_id,
            enabled=row.enabled,
            detection_sensitivity=getattr(row, "detection_sensitivity", 75),
            inactivity_timer_seconds=row.inactivity_timer_seconds,
        )
    except HTTPException:
        raise
    except Exception as exc:
        await db.rollback()
        raise HTTPException(
            status_code=503,
            detail="Fall detection storage is unavailable. Run Alembic migrations first.",
        ) from exc


@router.put("/api/fall-detection-config/{camera_id}", response_model=FallDetectionConfigRead)
async def upsert_config(
    camera_id: str,
    update: FallDetectionConfigUpdate,
    db: AsyncSession = Depends(get_db),
    _current_user: User = Depends(get_current_user),
):
    try:
        result = await db.execute(
            select(FallDetectionConfig).where(FallDetectionConfig.camera_id == camera_id)
        )
        row = result.scalar_one_or_none()

        if row is None:
            row = FallDetectionConfig(
                id=str(uuid.uuid4()),
                camera_id=camera_id,
                enabled=update.enabled if update.enabled is not None else True,
                detection_sensitivity=min(100, max(0, update.detection_sensitivity)) if update.detection_sensitivity is not None else 75,
                inactivity_timer_seconds=max(0.1, float(update.inactivity_timer_seconds)) if update.inactivity_timer_seconds is not None else 1.0,
            )
            db.add(row)
        else:
            if update.enabled is not None:
                row.enabled = update.enabled
            if update.detection_sensitivity is not None:
                row.detection_sensitivity = min(100, max(0, update.detection_sensitivity))
            if update.inactivity_timer_seconds is not None:
                row.inactivity_timer_seconds = max(0.1, float(update.inactivity_timer_seconds))

        await db.flush()
        await db.refresh(row)
        _cache_config(camera_id, row)
        await _rebuild_source_map(db)
        return FallDetectionConfigRead(
            id=row.id,
            camera_id=row.camera_id,
            enabled=row.enabled,
            detection_sensitivity=getattr(row, "detection_sensitivity", 75),
            inactivity_timer_seconds=row.inactivity_timer_seconds,
        )
    except HTTPException:
        raise
    except Exception as exc:
        await db.rollback()
        raise HTTPException(
            status_code=503,
            detail="Fall detection storage is unavailable. Run Alembic migrations first.",
        ) from exc
