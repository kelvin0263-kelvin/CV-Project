"""
People Counting Config & History API

GET    /api/people-counting-config/{camera_id}  -- get config for a camera
PUT    /api/people-counting-config/{camera_id}  -- create/update config
DELETE /api/people-counting-config/{camera_id}  -- remove config
GET    /api/people-counting-history              -- historical snapshots
GET    /api/people-counting-summary              -- live counts from memory
"""

import asyncio
import uuid

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete as sa_delete, desc

from app.core.database import get_db, AsyncSessionLocal
from app.models.people_counting_config import PeopleCountingConfig
from app.models.people_counting_snapshot import PeopleCountingSnapshot
from app.models.stream_config import StreamConfig
from app.schemas.people_counting import (
    PeopleCountingConfigRead,
    PeopleCountingConfigUpdate,
    PeopleCountingSnapshotRead,
)

router = APIRouter()


# ---------------------------------------------------------------------------
# In-memory counting config cache (read by video_processor threads)
# ---------------------------------------------------------------------------
_counting_configs: dict[str, dict] = {}  # camera_id -> config dict

# Source-path routing: maps source_path -> set of view_keys that need counting
_counting_source_map: dict[str, set[str]] = {}
# Reverse lookup: "source_path||view_key" -> camera_id (for cameras with counting)
_counting_camera_resolve: dict[str, str] = {}


def get_counting_config(camera_id: str) -> dict | None:
    """Read counting config for a camera (called from video_processor thread)."""
    return _counting_configs.get(camera_id)


def get_all_counting_configs() -> dict[str, dict]:
    """Return all counting configs."""
    return dict(_counting_configs)


def get_counting_views(source_path: str) -> set[str]:
    """Get view keys that need counting for a given source_path."""
    return _counting_source_map.get(source_path, set())


def get_counting_camera_id(source_path: str, view_key: str) -> str | None:
    """Resolve camera_id for a source_path + view_key (counting context)."""
    return _counting_camera_resolve.get(f"{source_path}||{view_key}")


def _cache_config(camera_id: str, row: PeopleCountingConfig):
    """Push a DB row into the in-memory cache."""
    _counting_configs[camera_id] = {
        "enabled": row.enabled,
        "max_capacity": row.max_capacity,
        "lines": row.lines or [],
        "zones": row.zones or [],
    }


def _remove_cached_config(camera_id: str):
    _counting_configs.pop(camera_id, None)


# ---------------------------------------------------------------------------
# In-memory live counting state (written by video_processor, read by API)
# ---------------------------------------------------------------------------
_live_counts: dict[str, dict] = {}  # camera_id -> counting_data dict


def update_live_counts(camera_id: str, data: dict):
    """Called from video_processor to publish live counting data."""
    _live_counts[camera_id] = data


def get_live_counts(camera_id: str) -> dict | None:
    return _live_counts.get(camera_id)


# ---------------------------------------------------------------------------
# In-memory snapshot queue (drained by background task)
# ---------------------------------------------------------------------------
_snapshot_queue: list[dict] = []


def queue_counting_snapshot(snapshot: dict):
    """Queue a counting snapshot for async DB persistence."""
    _snapshot_queue.append(snapshot)


def _drain_snapshot_queue() -> list[dict]:
    items = list(_snapshot_queue)
    _snapshot_queue.clear()
    return items


# ---------------------------------------------------------------------------
# Background task: persist counting snapshots
# ---------------------------------------------------------------------------
async def counting_snapshot_persistence_loop():
    """Periodically drain snapshot queue and write to DB."""
    while True:
        await asyncio.sleep(5)
        items = _drain_snapshot_queue()
        if not items:
            continue

        saved = 0
        for snap in items:
            try:
                async with AsyncSessionLocal() as session:
                    row = PeopleCountingSnapshot(
                        id=snap.get("id", str(uuid.uuid4())),
                        camera_id=snap["camera_id"],
                        total_in=snap.get("total_in", 0),
                        total_out=snap.get("total_out", 0),
                        zone_counts=snap.get("zone_counts", {}),
                        current_occupancy=snap.get("current_occupancy", 0),
                    )
                    session.add(row)
                    await session.commit()
                    saved += 1
            except Exception as e:
                print(f"[CountingSnapshot] Failed to save: {e}")

        if saved:
            print(f"[CountingSnapshot] Saved {saved} snapshot(s)")


# ---------------------------------------------------------------------------
# Source map rebuild: maps source_path -> view_keys for counting-enabled cameras
# ---------------------------------------------------------------------------
async def _rebuild_source_map(session: AsyncSession):
    """
    Rebuild _counting_source_map and _counting_camera_resolve from the
    current in-memory configs + stream_configs in DB.
    """
    global _counting_source_map, _counting_camera_resolve
    new_source_map: dict[str, set[str]] = {}
    new_resolve: dict[str, str] = {}

    enabled_camera_ids = [
        cid for cid, cfg in _counting_configs.items() if cfg.get("enabled", True)
    ]

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

    _counting_source_map = new_source_map
    _counting_camera_resolve = new_resolve


# ---------------------------------------------------------------------------
# Startup helper: load all configs from DB into memory
# ---------------------------------------------------------------------------
async def load_counting_configs_from_db():
    """Called once at startup to populate the in-memory cache."""
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(select(PeopleCountingConfig))
            rows = result.scalars().all()
            for row in rows:
                _cache_config(row.camera_id, row)
            await _rebuild_source_map(session)
            print(f"[Startup] Loaded {len(rows)} people counting config(s)")
    except Exception as e:
        print(f"[Startup] Warning: Could not load counting configs: {e}")


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------

@router.get("/api/people-counting-config/{camera_id}", response_model=PeopleCountingConfigRead)
async def get_config(camera_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(PeopleCountingConfig).where(PeopleCountingConfig.camera_id == camera_id)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="No counting config for this camera")
    return row


@router.put("/api/people-counting-config/{camera_id}", response_model=PeopleCountingConfigRead)
async def upsert_config(
    camera_id: str,
    update: PeopleCountingConfigUpdate,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(PeopleCountingConfig).where(PeopleCountingConfig.camera_id == camera_id)
    )
    row = result.scalar_one_or_none()

    if row is None:
        # Create new
        row = PeopleCountingConfig(
            id=str(uuid.uuid4()),
            camera_id=camera_id,
            enabled=update.enabled if update.enabled is not None else True,
            max_capacity=update.max_capacity,
            lines=update.lines or [],
            zones=update.zones or [],
        )
        db.add(row)
    else:
        # Update existing
        if update.enabled is not None:
            row.enabled = update.enabled
        if update.max_capacity is not None:
            row.max_capacity = update.max_capacity
        if update.lines is not None:
            row.lines = update.lines
        if update.zones is not None:
            row.zones = update.zones

    await db.flush()
    await db.refresh(row)

    # Update in-memory cache and source map
    _cache_config(camera_id, row)
    await _rebuild_source_map(db)

    return row


@router.delete("/api/people-counting-config/{camera_id}")
async def delete_config(camera_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        sa_delete(PeopleCountingConfig).where(PeopleCountingConfig.camera_id == camera_id)
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="No counting config for this camera")

    _remove_cached_config(camera_id)
    await _rebuild_source_map(db)
    return {"status": "deleted"}


@router.get("/api/people-counting-history", response_model=list[PeopleCountingSnapshotRead])
async def get_history(
    camera_id: str = Query(...),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """Get historical counting snapshots for a camera, newest first."""
    query = (
        select(PeopleCountingSnapshot)
        .where(PeopleCountingSnapshot.camera_id == camera_id)
        .order_by(desc(PeopleCountingSnapshot.timestamp))
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/api/people-counting-summary")
async def get_summary():
    """Return current live counting data for all configured cameras."""
    return {
        camera_id: data
        for camera_id, data in _live_counts.items()
    }
