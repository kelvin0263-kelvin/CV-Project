"""
People Counting Config & History API

GET    /api/people-counting-config/{camera_id}  -- get config for a camera
PUT    /api/people-counting-config/{camera_id}  -- create/update config
DELETE /api/people-counting-config/{camera_id}  -- remove config
GET    /api/people-counting-history              -- historical snapshots
GET    /api/people-counting-summary              -- live counts from memory
"""

import asyncio
import threading
import time
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete as sa_delete, desc

from app.core.database import get_db, AsyncSessionLocal
from app.models.camera_model import Camera
from app.models.building_counting_config import BuildingCountingConfig
from app.models.building_counting_snapshot import BuildingCountingSnapshot
from app.models.people_counting_config import PeopleCountingConfig
from app.models.people_counting_snapshot import PeopleCountingSnapshot
from app.models.stream_config import StreamConfig
from app.schemas.people_counting import (
    BuildingCountingConfigRead,
    BuildingCountingSnapshotRead,
    BuildingCountingConfigUpdate,
    BuildingOccupancySummaryRead,
    PeopleCountingConfigRead,
    PeopleCountingConfigUpdate,
    PeopleCountingSnapshotRead,
)
from app.services.building_counter import (
    get_building_summary,
    reset_camera_rollup,
    reset_building_runtime,
    sync_building_runtime,
)
from app.services.cross_camera_verifier import (
    reset_cross_camera_state,
    sync_cross_camera_runtime,
)

router = APIRouter()
BUILDING_SNAPSHOT_HEARTBEAT_SEC = 300.0


# ---------------------------------------------------------------------------
# In-memory counting config cache (read by video_processor threads)
# ---------------------------------------------------------------------------
_counting_configs: dict[str, dict] = {}  # camera_id -> config dict

# Runtime-key routing: maps runtime_key -> set of view_keys that need counting
_counting_source_map: dict[str, set[str]] = {}
# Reverse lookup: "runtime_key||view_key" -> camera_id (for cameras with counting)
_counting_camera_resolve: dict[str, str] = {}


def _normalize_frame_exclude_areas(
    raw_areas: list[dict] | None = None,
) -> list[dict]:
    normalized: list[dict] = []
    for index, area in enumerate(raw_areas or []):
        points = area.get("points", [])
        if len(points) < 3:
            continue
        normalized.append(
            {
                "id": str(area.get("id") or f"frame_exclude_{index}"),
                "name": str(area.get("name") or ""),
                "points": points,
            }
        )
    return normalized


def _serialize_counting_config_row(row: PeopleCountingConfig) -> dict:
    frame_exclude_areas = _normalize_frame_exclude_areas(row.frame_exclude_areas or [])
    return {
        "id": row.id,
        "camera_id": row.camera_id,
        "enabled": row.enabled,
        "participate_in_building_count": row.participate_in_building_count,
        "entrance_id": row.entrance_id,
        "cross_camera_enabled": row.cross_camera_enabled,
        "cross_camera_pair_id": row.cross_camera_pair_id,
        "cross_camera_role": row.cross_camera_role,
        "verification_camera_id": row.verification_camera_id,
        "verification_inward_threshold": row.verification_inward_threshold,
        "lines": row.lines or [],
        "frame_exclude_areas": frame_exclude_areas,
    }


def get_counting_config(camera_id: str) -> dict | None:
    """Read counting config for a camera (called from video_processor thread)."""
    return _counting_configs.get(camera_id)


def get_all_counting_configs() -> dict[str, dict]:
    """Return all counting configs."""
    return dict(_counting_configs)


def get_counting_views(runtime_key: str) -> set[str]:
    """Get view keys that need counting for a given runtime key."""
    return _counting_source_map.get(runtime_key, set())


def get_counting_camera_id(runtime_key: str, view_key: str) -> str | None:
    """Resolve camera_id for a runtime key + view key (counting context)."""
    return _counting_camera_resolve.get(f"{runtime_key}||{view_key}")


def _cache_config(camera_id: str, row: PeopleCountingConfig):
    """Push a DB row into the in-memory cache."""
    frame_exclude_areas = _normalize_frame_exclude_areas(row.frame_exclude_areas or [])
    _counting_configs[camera_id] = {
        "enabled": row.enabled,
        "participate_in_building_count": row.participate_in_building_count,
        "entrance_id": row.entrance_id,
        "cross_camera_enabled": row.cross_camera_enabled,
        "cross_camera_pair_id": row.cross_camera_pair_id,
        "cross_camera_role": row.cross_camera_role,
        "verification_camera_id": row.verification_camera_id,
        "verification_inward_threshold": row.verification_inward_threshold,
        "lines": row.lines or [],
        "frame_exclude_areas": frame_exclude_areas,
    }


def _remove_cached_config(camera_id: str):
    _counting_configs.pop(camera_id, None)


# ---------------------------------------------------------------------------
# In-memory live counting state (written by video_processor, read by API)
# ---------------------------------------------------------------------------
_live_counts: dict[str, dict] = {}  # camera_id -> counting_data dict
_counting_reset_requests: set[str] = set()
_counting_reset_lock = threading.Lock()


def update_live_counts(camera_id: str, data: dict):
    """Called from video_processor to publish live counting data."""
    _live_counts[camera_id] = data


def get_live_counts(camera_id: str) -> dict | None:
    return _live_counts.get(camera_id)


def _remove_live_count(camera_id: str):
    _live_counts.pop(camera_id, None)


def request_counting_reset(camera_id: str):
    with _counting_reset_lock:
        _counting_reset_requests.add(camera_id)


def consume_counting_reset(camera_id: str) -> bool:
    with _counting_reset_lock:
        if camera_id not in _counting_reset_requests:
            return False
        _counting_reset_requests.remove(camera_id)
        return True


def _build_empty_live_count(camera_id: str) -> dict:
    config = get_counting_config(camera_id) or {}
    return {
        "total_in": 0,
        "total_out": 0,
        "occupancy": 0,
        "raw_total_in": 0,
        "verification_confirmed_in": 0,
        "verification_correction_in": 0,
        "verification_camera_id": None,
        "cross_camera_pair_id": None,
        "cross_camera_active_event": None,
        "cross_camera_last_event": None,
        "lines": config.get("lines", []),
        "frame_exclude_areas": config.get("frame_exclude_areas", []),
    }


# ---------------------------------------------------------------------------
# In-memory snapshot queue (drained by background task)
# ---------------------------------------------------------------------------
_snapshot_queue: list[dict] = []
_last_saved_snapshot_signature: dict[str, tuple[int, int, int]] = {}
_building_snapshot_queue: list[dict] = []
_last_saved_building_snapshot_signature: tuple | None = None
_last_queued_building_snapshot_signature: tuple | None = None
_last_building_snapshot_time: float = 0.0


def queue_counting_snapshot(snapshot: dict):
    """Queue a counting snapshot for async DB persistence."""
    _snapshot_queue.append(snapshot)


def _drain_snapshot_queue() -> list[dict]:
    items = list(_snapshot_queue)
    _snapshot_queue.clear()
    return items


def queue_building_snapshot(snapshot: dict):
    """Queue a building occupancy snapshot for async DB persistence."""
    _building_snapshot_queue.append(snapshot)


def _drain_building_snapshot_queue() -> list[dict]:
    items = list(_building_snapshot_queue)
    _building_snapshot_queue.clear()
    return items


def _snapshot_signature(total_in, total_out, current_occupancy) -> tuple[int, int, int]:
    return (
        int(total_in or 0),
        int(total_out or 0),
        int(current_occupancy or 0),
    )


def _freeze_jsonish(value):
    if isinstance(value, dict):
        return tuple(
            (str(key), _freeze_jsonish(val))
            for key, val in sorted(value.items(), key=lambda item: str(item[0]))
        )
    if isinstance(value, (list, tuple)):
        return tuple(_freeze_jsonish(item) for item in value)
    return value


def _building_snapshot_signature_from_summary(summary: dict) -> tuple:
    return (
        bool(summary.get("enabled", True)),
        summary.get("max_capacity"),
        bool(summary.get("capacity_exceeded", False)),
        int(summary.get("manual_offset", 0) or 0),
        int(summary.get("raw_in", 0) or 0),
        int(summary.get("raw_out", 0) or 0),
        int(summary.get("raw_occupancy", 0) or 0),
        int(summary.get("occupancy", 0) or 0),
        int(summary.get("active_camera_count", 0) or 0),
        _freeze_jsonish(summary.get("entrance_summaries") or {}),
    )


def _build_building_snapshot(summary: dict) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "timestamp": datetime.now(timezone.utc),
        "enabled": bool(summary.get("enabled", True)),
        "raw_in": int(summary.get("raw_in", 0) or 0),
        "raw_out": int(summary.get("raw_out", 0) or 0),
        "raw_occupancy": int(summary.get("raw_occupancy", 0) or 0),
        "max_capacity": summary.get("max_capacity"),
        "capacity_exceeded": bool(summary.get("capacity_exceeded", False)),
        "manual_offset": int(summary.get("manual_offset", 0) or 0),
        "occupancy": int(summary.get("occupancy", 0) or 0),
        "active_camera_count": int(summary.get("active_camera_count", 0) or 0),
        "entrance_summaries": summary.get("entrance_summaries") or {},
    }


async def _is_duplicate_snapshot(session: AsyncSession, snapshot: dict) -> tuple[bool, tuple[int, int, int]]:
    camera_id = snapshot["camera_id"]
    incoming_signature = _snapshot_signature(
        snapshot.get("total_in"),
        snapshot.get("total_out"),
        snapshot.get("current_occupancy"),
    )

    cached_signature = _last_saved_snapshot_signature.get(camera_id)
    if cached_signature is None:
        latest_row = await session.scalar(
            select(PeopleCountingSnapshot)
            .where(PeopleCountingSnapshot.camera_id == camera_id)
            .order_by(desc(PeopleCountingSnapshot.timestamp))
            .limit(1)
        )
        if latest_row is not None:
            cached_signature = _snapshot_signature(
                latest_row.total_in,
                latest_row.total_out,
                latest_row.current_occupancy,
            )
            _last_saved_snapshot_signature[camera_id] = cached_signature

    return cached_signature == incoming_signature, incoming_signature


async def _is_duplicate_building_snapshot(session: AsyncSession, snapshot: dict) -> tuple[bool, tuple]:
    global _last_saved_building_snapshot_signature

    incoming_signature = _building_snapshot_signature_from_summary(snapshot)
    cached_signature = _last_saved_building_snapshot_signature
    if cached_signature is None:
        latest_row = await session.scalar(
            select(BuildingCountingSnapshot)
            .order_by(desc(BuildingCountingSnapshot.timestamp))
            .limit(1)
        )
        if latest_row is not None:
            cached_signature = _building_snapshot_signature_from_summary(
                {
                    "enabled": latest_row.enabled,
                    "max_capacity": latest_row.max_capacity,
                    "capacity_exceeded": latest_row.capacity_exceeded,
                    "manual_offset": latest_row.manual_offset,
                    "raw_in": latest_row.raw_in,
                    "raw_out": latest_row.raw_out,
                    "raw_occupancy": latest_row.raw_occupancy,
                    "occupancy": latest_row.occupancy,
                    "active_camera_count": latest_row.active_camera_count,
                    "entrance_summaries": latest_row.entrance_summaries or {},
                }
            )
            _last_saved_building_snapshot_signature = cached_signature

    return cached_signature == incoming_signature, incoming_signature


def _queue_building_snapshot_if_needed(heartbeat_interval: float = BUILDING_SNAPSHOT_HEARTBEAT_SEC):
    global _last_queued_building_snapshot_signature, _last_building_snapshot_time

    summary = get_building_summary()
    signature = _building_snapshot_signature_from_summary(summary)
    now = time.time()

    if _last_queued_building_snapshot_signature is None:
        queue_building_snapshot(_build_building_snapshot(summary))
        _last_queued_building_snapshot_signature = signature
        _last_building_snapshot_time = now
        return

    if signature != _last_queued_building_snapshot_signature or (now - _last_building_snapshot_time) >= heartbeat_interval:
        queue_building_snapshot(_build_building_snapshot(summary))
        _last_queued_building_snapshot_signature = signature
        _last_building_snapshot_time = now


def _coerce_snapshot_timestamp(raw_value) -> datetime:
    """
    Normalize incoming snapshot timestamps to UTC-aware datetimes.
    Falls back to current UTC time if input is missing/invalid.
    """
    if isinstance(raw_value, datetime):
        dt = raw_value
    elif isinstance(raw_value, str):
        text = raw_value.strip()
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            return datetime.now(timezone.utc)
    else:
        return datetime.now(timezone.utc)

    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# Background task: persist counting snapshots
# ---------------------------------------------------------------------------
async def counting_snapshot_persistence_loop():
    """Periodically persist per-camera and building-level counting snapshots."""
    global _last_saved_building_snapshot_signature

    while True:
        await asyncio.sleep(5)
        _queue_building_snapshot_if_needed()

        items = _drain_snapshot_queue()
        building_items = _drain_building_snapshot_queue()
        if not items and not building_items:
            continue

        saved = 0
        for snap in items:
            try:
                async with AsyncSessionLocal() as session:
                    camera_name = snap.get("camera_name")
                    camera_row = await session.execute(
                        select(Camera.id, Camera.name).where(Camera.id == snap["camera_id"]).limit(1)
                    )
                    camera_record = camera_row.first()
                    if camera_record is not None:
                        camera_name = camera_record.name
                    else:
                        camera_name = camera_name or snap["camera_id"]

                    duplicate, signature = await _is_duplicate_snapshot(session, snap)
                    if duplicate:
                        continue

                    row = PeopleCountingSnapshot(
                        id=snap.get("id", str(uuid.uuid4())),
                        camera_id=snap["camera_id"],
                        camera_name=camera_name,
                        timestamp=_coerce_snapshot_timestamp(snap.get("timestamp")),
                        total_in=snap.get("total_in", 0),
                        total_out=snap.get("total_out", 0),
                        current_occupancy=snap.get("current_occupancy", 0),
                    )
                    session.add(row)
                    await session.commit()
                    _last_saved_snapshot_signature[snap["camera_id"]] = signature
                    saved += 1
            except Exception as e:
                print(f"[CountingSnapshot] Failed to save: {e}")

        building_saved = 0
        for snap in building_items:
            try:
                async with AsyncSessionLocal() as session:
                    duplicate, signature = await _is_duplicate_building_snapshot(session, snap)
                    if duplicate:
                        continue

                    row = BuildingCountingSnapshot(
                        id=snap.get("id", str(uuid.uuid4())),
                        timestamp=_coerce_snapshot_timestamp(snap.get("timestamp")),
                        enabled=bool(snap.get("enabled", True)),
                        raw_in=int(snap.get("raw_in", 0) or 0),
                        raw_out=int(snap.get("raw_out", 0) or 0),
                        raw_occupancy=int(snap.get("raw_occupancy", 0) or 0),
                        max_capacity=snap.get("max_capacity"),
                        capacity_exceeded=bool(snap.get("capacity_exceeded", False)),
                        manual_offset=int(snap.get("manual_offset", 0) or 0),
                        occupancy=int(snap.get("occupancy", 0) or 0),
                        active_camera_count=int(snap.get("active_camera_count", 0) or 0),
                        entrance_summaries=snap.get("entrance_summaries") or {},
                    )
                    session.add(row)
                    await session.commit()
                    _last_saved_building_snapshot_signature = signature
                    building_saved += 1
            except Exception as e:
                print(f"[BuildingSnapshot] Failed to save: {e}")

        if saved:
            print(f"[CountingSnapshot] Saved {saved} snapshot(s)")
        if building_saved:
            print(f"[BuildingSnapshot] Saved {building_saved} snapshot(s)")


# ---------------------------------------------------------------------------
# Source map rebuild: maps runtime_key -> view_keys for counting-enabled cameras
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
            runtime_key = sc.runtime_key or sc.source_path
            if runtime_key not in new_source_map:
                new_source_map[runtime_key] = set()
            new_source_map[runtime_key].add(view_key)
            new_resolve[f"{runtime_key}||{view_key}"] = sc.camera_id

    _counting_source_map = new_source_map
    _counting_camera_resolve = new_resolve


async def _get_or_create_building_config(session: AsyncSession) -> BuildingCountingConfig:
    result = await session.execute(select(BuildingCountingConfig).limit(1))
    row = result.scalar_one_or_none()
    if row is None:
        row = BuildingCountingConfig(
            id="default-building-counting-config",
            enabled=True,
            max_capacity=None,
            manual_offset=0,
        )
        session.add(row)
        await session.flush()
        await session.refresh(row)
    return row


def _normalize_entrance_id(raw_value: str | None) -> str | None:
    value = (raw_value or "").strip()
    return value or None


def _validate_building_entrance_fields(
    *,
    participate_in_building_count: bool,
    entrance_id: str | None,
):
    if not participate_in_building_count:
        return
    if not entrance_id:
        raise HTTPException(status_code=400, detail="entrance_id is required when building counting is enabled for a camera.")


def _normalize_cross_camera_role(raw_value: str | None) -> str:
    value = (raw_value or "none").strip().lower()
    return value if value in {"none", "primary", "verifier"} else "none"


def _normalize_cross_camera_pair_id(raw_value: str | None) -> str | None:
    value = (raw_value or "").strip()
    return value or None


def _coerce_cross_camera_role(
    *,
    enabled: bool,
    requested_role: str,
    existing_role: str,
    verification_camera_id: str | None,
) -> str:
    if not enabled:
        return "none"

    normalized_requested = _normalize_cross_camera_role(requested_role)
    if normalized_requested in {"primary", "verifier"}:
        return normalized_requested

    normalized_existing = _normalize_cross_camera_role(existing_role)
    if normalized_existing in {"primary", "verifier"}:
        return normalized_existing

    if verification_camera_id:
        return "primary"
    return "verifier"


def _validate_cross_camera_fields(
    *,
    camera_id: str,
    cross_camera_enabled: bool,
    cross_camera_pair_id: str | None,
    cross_camera_role: str,
    verification_camera_id: str | None,
):
    if not cross_camera_enabled:
        return
    if cross_camera_role not in {"primary", "verifier"}:
        raise HTTPException(status_code=400, detail="cross_camera_role must be 'primary' or 'verifier' when cross-camera verification is enabled.")
    if not cross_camera_pair_id:
        raise HTTPException(status_code=400, detail="cross_camera_pair_id is required when cross-camera verification is enabled.")
    if cross_camera_role == "primary":
        if not verification_camera_id:
            raise HTTPException(status_code=400, detail="verification_camera_id is required for a primary cross-camera counting config.")
        if verification_camera_id == camera_id:
            raise HTTPException(status_code=400, detail="verification_camera_id must be a different camera.")


async def sync_counting_runtime_from_db(session: AsyncSession):
    """
    Rebuild counting caches from the database.
    This is needed after camera deletion because DB cascade removes rows,
    but the in-memory cache would otherwise keep stale camera IDs.
    """
    global _counting_configs, _live_counts

    result = await session.execute(select(PeopleCountingConfig))
    rows = result.scalars().all()

    new_configs: dict[str, dict] = {}
    building_sensor_configs: dict[str, dict] = {}
    valid_camera_ids: set[str] = set()
    for row in rows:
        valid_camera_ids.add(row.camera_id)
        frame_exclude_areas = _normalize_frame_exclude_areas(row.frame_exclude_areas or [])
        new_configs[row.camera_id] = {
            "enabled": row.enabled,
            "participate_in_building_count": row.participate_in_building_count,
            "entrance_id": row.entrance_id,
            "cross_camera_enabled": row.cross_camera_enabled,
            "cross_camera_pair_id": row.cross_camera_pair_id,
            "cross_camera_role": row.cross_camera_role,
            "verification_camera_id": row.verification_camera_id,
            "verification_inward_threshold": row.verification_inward_threshold,
            "lines": row.lines or [],
            "frame_exclude_areas": frame_exclude_areas,
        }
        if (
            row.enabled
            and row.participate_in_building_count
            and row.entrance_id
        ):
            building_sensor_configs[row.camera_id] = {
                "enabled": True,
                "entrance_id": row.entrance_id,
            }

    _counting_configs = new_configs
    sync_cross_camera_runtime(new_configs)
    _live_counts = {
        camera_id: data
        for camera_id, data in _live_counts.items()
        if camera_id in valid_camera_ids
    }
    await _rebuild_source_map(session)

    building_config = await _get_or_create_building_config(session)
    sync_building_runtime(
        {
            "enabled": building_config.enabled,
            "max_capacity": building_config.max_capacity,
            "manual_offset": building_config.manual_offset,
        },
        building_sensor_configs,
    )


# ---------------------------------------------------------------------------
# Startup helper: load all configs from DB into memory
# ---------------------------------------------------------------------------
async def load_counting_configs_from_db():
    """Called once at startup to populate the in-memory cache."""
    try:
        async with AsyncSessionLocal() as session:
            await sync_counting_runtime_from_db(session)
            print(f"[Startup] Loaded {len(_counting_configs)} people counting config(s)")
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
    return _serialize_counting_config_row(row)


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

    participate_in_building_count = (
        update.participate_in_building_count
        if update.participate_in_building_count is not None
        else (row.participate_in_building_count if row is not None else False)
    )
    entrance_id = (
        _normalize_entrance_id(update.entrance_id)
        if update.entrance_id is not None
        else (row.entrance_id if row is not None else None)
    )
    _validate_building_entrance_fields(
        participate_in_building_count=bool(participate_in_building_count),
        entrance_id=entrance_id,
    )

    cross_camera_enabled = (
        update.cross_camera_enabled
        if update.cross_camera_enabled is not None
        else (row.cross_camera_enabled if row is not None else False)
    )
    cross_camera_pair_id = (
        _normalize_cross_camera_pair_id(update.cross_camera_pair_id)
        if update.cross_camera_pair_id is not None
        else (row.cross_camera_pair_id if row is not None else None)
    )
    verification_camera_id = (
        _normalize_entrance_id(update.verification_camera_id)
        if update.verification_camera_id is not None
        else (row.verification_camera_id if row is not None else None)
    )
    cross_camera_role = _coerce_cross_camera_role(
        enabled=bool(cross_camera_enabled),
        requested_role=update.cross_camera_role if update.cross_camera_role is not None else (row.cross_camera_role if row is not None else "none"),
        existing_role=row.cross_camera_role if row is not None else "none",
        verification_camera_id=verification_camera_id,
    )
    verification_inward_threshold = (
        float(update.verification_inward_threshold)
        if update.verification_inward_threshold is not None
        else float(row.verification_inward_threshold if row is not None else 0.02)
    )
    _validate_cross_camera_fields(
        camera_id=camera_id,
        cross_camera_enabled=bool(cross_camera_enabled),
        cross_camera_pair_id=cross_camera_pair_id,
        cross_camera_role=cross_camera_role,
        verification_camera_id=verification_camera_id,
    )

    frame_exclude_areas = None
    if update.frame_exclude_areas is not None:
        frame_exclude_areas = _normalize_frame_exclude_areas(update.frame_exclude_areas)

    if row is None:
        # Create new
        row = PeopleCountingConfig(
            id=str(uuid.uuid4()),
            camera_id=camera_id,
            enabled=update.enabled if update.enabled is not None else True,
            participate_in_building_count=bool(participate_in_building_count),
            entrance_id=entrance_id,
            cross_camera_enabled=bool(cross_camera_enabled),
            cross_camera_pair_id=cross_camera_pair_id,
            cross_camera_role=cross_camera_role,
            verification_camera_id=verification_camera_id,
            verification_inward_threshold=max(0.0, verification_inward_threshold),
            lines=update.lines or [],
            frame_exclude_areas=frame_exclude_areas or [],
        )
        db.add(row)
    else:
        # Update existing
        if update.enabled is not None:
            row.enabled = update.enabled
        if update.participate_in_building_count is not None:
            row.participate_in_building_count = update.participate_in_building_count
        if update.entrance_id is not None:
            row.entrance_id = entrance_id
        if update.cross_camera_enabled is not None:
            row.cross_camera_enabled = bool(cross_camera_enabled)
        if update.cross_camera_pair_id is not None:
            row.cross_camera_pair_id = cross_camera_pair_id
        if update.cross_camera_role is not None or row.cross_camera_enabled:
            row.cross_camera_role = cross_camera_role
        if update.verification_camera_id is not None:
            row.verification_camera_id = verification_camera_id
        if update.verification_inward_threshold is not None:
            row.verification_inward_threshold = max(0.0, verification_inward_threshold)
        if update.lines is not None:
            row.lines = update.lines
        if frame_exclude_areas is not None:
            row.frame_exclude_areas = frame_exclude_areas

    if not row.participate_in_building_count:
        row.entrance_id = None
    if not row.cross_camera_enabled:
        row.cross_camera_pair_id = None
        row.cross_camera_role = "none"
        row.verification_camera_id = None
    elif row.cross_camera_role == "primary":
        row.verification_camera_id = verification_camera_id

    await db.flush()
    await db.refresh(row)

    await sync_counting_runtime_from_db(db)

    return _serialize_counting_config_row(row)


@router.delete("/api/people-counting-config/{camera_id}")
async def delete_config(camera_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        sa_delete(PeopleCountingConfig).where(PeopleCountingConfig.camera_id == camera_id)
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="No counting config for this camera")

    await sync_counting_runtime_from_db(db)
    return {"status": "deleted"}


@router.get("/api/people-counting-history", response_model=list[PeopleCountingSnapshotRead])
async def get_history(
    camera_id: str | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """Get historical counting snapshots, newest first."""
    query = select(PeopleCountingSnapshot).order_by(desc(PeopleCountingSnapshot.timestamp))
    if camera_id:
        query = query.where(PeopleCountingSnapshot.camera_id == camera_id)
    query = query.offset(offset).limit(limit)
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/api/people-counting-summary")
async def get_summary():
    """Return current live counting data for all configured cameras."""
    return {
        camera_id: data
        for camera_id, data in _live_counts.items()
    }


@router.post("/api/people-counting-config/{camera_id}/reset")
async def reset_camera_counting(camera_id: str):
    request_counting_reset(camera_id)
    reset_camera_rollup(camera_id)
    reset_cross_camera_state(camera_id)
    _last_saved_snapshot_signature.pop(camera_id, None)

    empty_data = _build_empty_live_count(camera_id)
    update_live_counts(camera_id, empty_data)

    return {
        "camera_id": camera_id,
        "counting_data": empty_data,
        "building_summary": get_building_summary(),
    }


@router.get("/api/building-counting-config", response_model=BuildingCountingConfigRead)
async def get_building_config(db: AsyncSession = Depends(get_db)):
    row = await _get_or_create_building_config(db)
    return row


@router.put("/api/building-counting-config", response_model=BuildingCountingConfigRead)
async def update_building_config(
    update: BuildingCountingConfigUpdate,
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_building_config(db)
    if update.enabled is not None:
        row.enabled = update.enabled
    if update.max_capacity is not None:
        row.max_capacity = int(update.max_capacity) if int(update.max_capacity) > 0 else None
    if update.manual_offset is not None:
        row.manual_offset = int(update.manual_offset)

    await db.flush()
    await db.refresh(row)
    await sync_counting_runtime_from_db(db)
    return row


@router.get("/api/building-counting-history", response_model=list[BuildingCountingSnapshotRead])
async def get_building_history(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    query = (
        select(BuildingCountingSnapshot)
        .order_by(desc(BuildingCountingSnapshot.timestamp))
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/api/building-occupancy-summary", response_model=BuildingOccupancySummaryRead)
async def get_building_occupancy_summary():
    return get_building_summary()


@router.post("/api/building-occupancy-summary/reset", response_model=BuildingOccupancySummaryRead)
async def reset_building_occupancy_summary(db: AsyncSession = Depends(get_db)):
    row = await _get_or_create_building_config(db)
    reset_building_runtime(manual_offset=row.manual_offset)
    return get_building_summary()
