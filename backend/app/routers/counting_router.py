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
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import func, select, delete as sa_delete, desc

from app.core.database import get_db, AsyncSessionLocal
from app.core.video_capture import is_rtsp_source
from app.models.camera_model import Camera
from app.models.building_counting_config import BuildingCountingConfig
from app.models.building_counting_snapshot import BuildingCountingSnapshot
from app.models.people_counting_config import PeopleCountingConfig
from app.models.people_counting_snapshot import PeopleCountingSnapshot
from app.models.stream_config import StreamConfig
from app.routers.auth_router import get_current_user
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
    poll_building_capacity_alert,
    remove_building_rollup,
    reset_camera_rollup,
    reset_building_runtime,
    restore_building_runtime,
    sync_building_runtime,
)
from app.services.cross_camera_verifier import (
    reset_cross_camera_state,
    sync_cross_camera_runtime,
)

router = APIRouter(dependencies=[Depends(get_current_user)])
BUILDING_SNAPSHOT_HEARTBEAT_SEC = 300.0


# ---------------------------------------------------------------------------
# In-memory counting config cache (read by video_processor threads)
# ---------------------------------------------------------------------------
_counting_configs: dict[str, dict] = {}  # camera_id -> config dict

# Runtime-key routing: maps runtime_key -> set of view_keys that need counting
_counting_source_map: dict[str, set[str]] = {}
# Reverse lookup: "runtime_key||view_key" -> camera_id (for cameras with counting)
_counting_camera_resolve: dict[str, str] = {}
_rtsp_counting_camera_ids: set[str] = set()


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
        "building_id": row.building_id,
        "cross_camera_enabled": row.cross_camera_enabled,
        "cross_camera_pair_id": row.cross_camera_pair_id,
        "cross_camera_role": row.cross_camera_role,
        "verification_camera_id": row.verification_camera_id,
        "primary_in_event_idle_timeout_sec": row.primary_in_event_idle_timeout_sec,
        "primary_out_event_idle_timeout_sec": row.primary_out_event_idle_timeout_sec,
        "lines": row.lines or [],
        "frame_exclude_areas": frame_exclude_areas,
    }


def _normalize_capacity_by_building_id(raw_value) -> dict[str, int]:
    normalized: dict[str, int] = {}
    if not isinstance(raw_value, dict):
        return normalized

    for raw_building_id, raw_capacity in raw_value.items():
        building_id = _normalize_building_id(raw_building_id)
        if not building_id:
            continue
        try:
            parsed_capacity = int(raw_capacity)
        except (TypeError, ValueError):
            continue
        if parsed_capacity > 0:
            normalized[building_id] = parsed_capacity

    return normalized


def _normalize_registered_building_ids(raw_value) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    if not isinstance(raw_value, list):
        return normalized

    for raw_building_id in raw_value:
        building_id = _normalize_building_id(raw_building_id)
        if not building_id or building_id in seen:
            continue
        seen.add(building_id)
        normalized.append(building_id)

    return normalized


def _merge_registered_building_ids(*building_id_groups) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()

    for group in building_id_groups:
        for raw_building_id in group or []:
            building_id = _normalize_building_id(raw_building_id)
            if not building_id or building_id in seen:
                continue
            seen.add(building_id)
            merged.append(building_id)

    return merged


async def _get_assigned_camera_labels_for_building_id(
    session: AsyncSession,
    building_id: str,
) -> list[str]:
    normalized_building_id = _normalize_building_id(building_id)
    if not normalized_building_id:
        return []

    result = await session.execute(
        select(PeopleCountingConfig.camera_id, Camera.name)
        .select_from(PeopleCountingConfig)
        .join(Camera, Camera.id == PeopleCountingConfig.camera_id, isouter=True)
        .where(PeopleCountingConfig.participate_in_building_count.is_(True))
        .where(PeopleCountingConfig.building_id == normalized_building_id)
    )

    assigned_camera_labels: list[str] = []
    for camera_id, camera_name in result.all():
        label = str(camera_name or "").strip() or str(camera_id or "").strip()
        if label:
            assigned_camera_labels.append(label)

    return assigned_camera_labels


async def _get_assigned_building_ids(session: AsyncSession) -> list[str]:
    result = await session.execute(
        select(PeopleCountingConfig.building_id)
        .where(PeopleCountingConfig.participate_in_building_count.is_(True))
        .where(PeopleCountingConfig.building_id.is_not(None))
    )

    return _normalize_registered_building_ids([
        building_id
        for (building_id,) in result.all()
    ])


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
        "building_id": row.building_id,
        "cross_camera_enabled": row.cross_camera_enabled,
        "cross_camera_pair_id": row.cross_camera_pair_id,
        "cross_camera_role": row.cross_camera_role,
        "verification_camera_id": row.verification_camera_id,
        "primary_in_event_idle_timeout_sec": row.primary_in_event_idle_timeout_sec,
        "primary_out_event_idle_timeout_sec": row.primary_out_event_idle_timeout_sec,
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
        "foot_traffic_left": 0,
        "foot_traffic_right": 0,
        "foot_traffic_total": 0,
        "foot_traffic_lines": [],
        "raw_total_in": 0,
        "raw_total_out": 0,
        "verification_confirmed_in": 0,
        "verification_correction_in": 0,
        "verification_confirmed_out": 0,
        "verification_correction_out": 0,
        "verification_camera_id": None,
        "cross_camera_pair_id": None,
        "cross_camera_active_event": None,
        "cross_camera_last_event": None,
        "cross_camera_active_in_event": None,
        "cross_camera_last_in_event": None,
        "cross_camera_active_out_event": None,
        "cross_camera_last_out_event": None,
        "lines": config.get("lines", []),
        "frame_exclude_areas": config.get("frame_exclude_areas", []),
    }


def reset_uploaded_runtime_counting_state(camera_ids: list[str] | set[str]) -> None:
    """Reset in-memory counting state for uploaded-video reruns."""
    normalized_camera_ids = {
        str(camera_id).strip()
        for camera_id in (camera_ids or [])
        if str(camera_id).strip()
    }
    for camera_id in normalized_camera_ids:
        request_counting_reset(camera_id)
        reset_camera_rollup(camera_id)
        reset_cross_camera_state(camera_id)
        _last_saved_snapshot_signature.pop(camera_id, None)
        update_live_counts(camera_id, _build_empty_live_count(camera_id))
    if normalized_camera_ids:
        request_building_snapshot_if_needed()


def _effective_snapshot_datetime(
    timestamp: datetime | None,
    processed_at: datetime | None = None,
) -> datetime | None:
    return processed_at or timestamp


def _is_current_local_day_snapshot(
    timestamp: datetime | None,
    processed_at: datetime | None = None,
) -> bool:
    candidate = _effective_snapshot_datetime(timestamp, processed_at)
    if candidate is None:
        return False
    if candidate.tzinfo is None:
        local_timestamp = candidate.replace(tzinfo=timezone.utc).astimezone()
    else:
        local_timestamp = candidate.astimezone()
    return local_timestamp.date() == datetime.now().astimezone().date()


def _build_restored_live_count(camera_id: str, snapshot: PeopleCountingSnapshot) -> dict:
    restored = _build_empty_live_count(camera_id)
    total_in = int(snapshot.total_in or 0)
    total_out = int(snapshot.total_out or 0)
    restored.update(
        {
            "total_in": total_in,
            "total_out": total_out,
            "occupancy": int(snapshot.current_occupancy or 0),
            "foot_traffic_left": int(snapshot.foot_traffic_left or 0),
            "foot_traffic_right": int(snapshot.foot_traffic_right or 0),
            "foot_traffic_total": int(snapshot.foot_traffic_total or 0),
            "raw_total_in": total_in,
            "raw_total_out": total_out,
        }
    )
    return restored


def _build_building_restore_snapshot_from_camera_snapshots(
    latest_snapshots: dict[str, PeopleCountingSnapshot],
) -> tuple[dict | None, datetime | None]:
    raw_in = 0
    raw_out = 0
    latest_effective_at: datetime | None = None
    entrance_summaries: dict[str, dict] = {}

    for camera_id, snapshot in latest_snapshots.items():
        config = get_counting_config(camera_id) or {}
        if not config.get("enabled", True) or not config.get("participate_in_building_count", False):
            continue

        building_id = _normalize_building_id(config.get("building_id"))
        if not building_id:
            continue

        total_in = max(0, int(snapshot.total_in or 0))
        total_out = max(0, int(snapshot.total_out or 0))
        raw_in += total_in
        raw_out += total_out

        entrance_summary = entrance_summaries.setdefault(
            building_id,
            {
                "total_in": 0,
                "total_out": 0,
                "camera_summaries": {},
            },
        )
        entrance_summary["total_in"] += total_in
        entrance_summary["total_out"] += total_out
        entrance_summary["camera_summaries"][camera_id] = {
            "total_in": total_in,
            "total_out": total_out,
        }

        effective_at = _effective_snapshot_datetime(snapshot.timestamp, snapshot.processed_at)
        if effective_at is not None and (
            latest_effective_at is None or effective_at > latest_effective_at
        ):
            latest_effective_at = effective_at

    if not entrance_summaries:
        return None, latest_effective_at

    return {
        "raw_in": raw_in,
        "raw_out": raw_out,
        "entrance_summaries": entrance_summaries,
    }, latest_effective_at


async def _load_latest_snapshot_by_camera(
    session: AsyncSession,
    camera_ids: list[str],
    *,
    current_day_only: bool = True,
) -> dict[str, PeopleCountingSnapshot]:
    if not camera_ids:
        return {}

    result = await session.execute(
        select(PeopleCountingSnapshot)
        .where(PeopleCountingSnapshot.camera_id.in_(camera_ids))
        .order_by(
            PeopleCountingSnapshot.camera_id.asc(),
            desc(func.coalesce(PeopleCountingSnapshot.processed_at, PeopleCountingSnapshot.timestamp)),
            PeopleCountingSnapshot.timestamp.desc(),
            PeopleCountingSnapshot.id.desc(),
        )
    )

    latest_by_camera: dict[str, PeopleCountingSnapshot] = {}
    for snapshot in result.scalars():
        latest_by_camera.setdefault(snapshot.camera_id, snapshot)

    if not current_day_only:
        return latest_by_camera

    return {
        camera_id: snapshot
        for camera_id, snapshot in latest_by_camera.items()
        if _is_current_local_day_snapshot(snapshot.timestamp, snapshot.processed_at)
    }


async def _load_latest_building_snapshot(
    session: AsyncSession,
) -> BuildingCountingSnapshot | None:
    latest_snapshot = await session.scalar(
        select(BuildingCountingSnapshot)
        .order_by(desc(func.coalesce(BuildingCountingSnapshot.processed_at, BuildingCountingSnapshot.timestamp)))
        .limit(1)
    )
    if latest_snapshot is None:
        return None
    if not _is_current_local_day_snapshot(latest_snapshot.timestamp, latest_snapshot.processed_at):
        return None
    return latest_snapshot


# ---------------------------------------------------------------------------
# In-memory snapshot queue (drained by background task)
# ---------------------------------------------------------------------------
_snapshot_queue: list[dict] = []
_last_saved_snapshot_signature: dict[str, tuple[int, int, int]] = {}
_building_snapshot_queue: list[dict] = []
_last_saved_building_snapshot_signature: tuple | None = None
_last_queued_building_snapshot_signature: tuple | None = None
_last_building_snapshot_time: float = 0.0
_building_snapshot_lock = threading.Lock()


def _normalize_query_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def queue_counting_snapshot(snapshot: dict):
    """Queue a counting snapshot for async DB persistence."""
    _snapshot_queue.append(snapshot)


def _drain_snapshot_queue() -> list[dict]:
    items = list(_snapshot_queue)
    _snapshot_queue.clear()
    return items


def queue_building_snapshot(snapshot: dict):
    """Queue a building occupancy snapshot for async DB persistence."""
    with _building_snapshot_lock:
        _building_snapshot_queue.append(snapshot)


def _drain_building_snapshot_queue() -> list[dict]:
    with _building_snapshot_lock:
        items = list(_building_snapshot_queue)
        _building_snapshot_queue.clear()
        return items


def _snapshot_signature(
    total_in,
    total_out,
    current_occupancy,
    foot_traffic_left=0,
    foot_traffic_right=0,
    foot_traffic_total=0,
) -> tuple[int, int, int, int, int, int]:
    return (
        int(total_in or 0),
        int(total_out or 0),
        int(current_occupancy or 0),
        int(foot_traffic_left or 0),
        int(foot_traffic_right or 0),
        int(foot_traffic_total or 0),
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
        int(summary.get("raw_in", 0) or 0),
        int(summary.get("raw_out", 0) or 0),
        int(summary.get("raw_occupancy", 0) or 0),
        int(summary.get("occupancy", 0) or 0),
        int(summary.get("active_camera_count", 0) or 0),
        _freeze_jsonish(summary.get("entrance_summaries") or {}),
    )


def _extract_building_snapshot_camera_ids(snapshot: dict) -> list[str]:
    camera_ids: set[str] = set()
    for entrance_summary in (snapshot.get("entrance_summaries") or {}).values():
        if not isinstance(entrance_summary, dict):
            continue
        for camera_id in entrance_summary.get("camera_ids") or []:
            normalized_camera_id = str(camera_id or "").strip()
            if normalized_camera_id:
                camera_ids.add(normalized_camera_id)
    return sorted(camera_ids)


def _build_building_snapshot(
    summary: dict,
    *,
    timestamp: datetime | None = None,
    processed_at: datetime | None = None,
) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "timestamp": timestamp,
        "processed_at": processed_at,
        "enabled": bool(summary.get("enabled", True)),
        "raw_in": int(summary.get("raw_in", 0) or 0),
        "raw_out": int(summary.get("raw_out", 0) or 0),
        "raw_occupancy": int(summary.get("raw_occupancy", 0) or 0),
        "max_capacity": summary.get("max_capacity"),
        "capacity_exceeded": bool(summary.get("capacity_exceeded", False)),
        "occupancy": int(summary.get("occupancy", 0) or 0),
        "active_camera_count": int(summary.get("active_camera_count", 0) or 0),
        "entrance_summaries": summary.get("entrance_summaries") or {},
    }


async def _derive_building_snapshot_timestamps(
    session: AsyncSession,
    snapshot: dict,
) -> tuple[datetime | None, datetime | None]:
    camera_ids = _extract_building_snapshot_camera_ids(snapshot)
    fallback_timestamp = _coerce_snapshot_timestamp(snapshot.get("timestamp"), fallback_now=True)
    fallback_processed_at = _coerce_snapshot_timestamp(snapshot.get("processed_at"), fallback_now=False)

    if not camera_ids:
        return fallback_timestamp, fallback_processed_at

    latest_by_camera = await _load_latest_snapshot_by_camera(
        session,
        camera_ids,
        current_day_only=False,
    )
    latest_snapshots = list(latest_by_camera.values())
    if not latest_snapshots:
        return fallback_timestamp, fallback_processed_at

    timestamp_candidates = [row.timestamp for row in latest_snapshots if row.timestamp is not None]
    processed_at_candidates = [row.processed_at for row in latest_snapshots if row.processed_at is not None]

    event_timestamp = max(timestamp_candidates) if timestamp_candidates else None
    processed_at = max(processed_at_candidates) if processed_at_candidates else None
    if event_timestamp is None and processed_at is None:
        return fallback_timestamp, fallback_processed_at
    return event_timestamp, processed_at


async def _is_duplicate_snapshot(session: AsyncSession, snapshot: dict) -> tuple[bool, tuple[int, int, int]]:
    camera_id = snapshot["camera_id"]
    incoming_signature = _snapshot_signature(
        snapshot.get("total_in"),
        snapshot.get("total_out"),
        snapshot.get("current_occupancy"),
        snapshot.get("foot_traffic_left"),
        snapshot.get("foot_traffic_right"),
        snapshot.get("foot_traffic_total"),
    )

    cached_signature = _last_saved_snapshot_signature.get(camera_id)
    if cached_signature is None:
        latest_row = await session.scalar(
            select(PeopleCountingSnapshot)
            .where(PeopleCountingSnapshot.camera_id == camera_id)
            .order_by(desc(func.coalesce(PeopleCountingSnapshot.processed_at, PeopleCountingSnapshot.timestamp)))
            .limit(1)
        )
        if latest_row is not None:
            cached_signature = _snapshot_signature(
                latest_row.total_in,
                latest_row.total_out,
                latest_row.current_occupancy,
                latest_row.foot_traffic_left,
                latest_row.foot_traffic_right,
                latest_row.foot_traffic_total,
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
            .order_by(desc(func.coalesce(BuildingCountingSnapshot.processed_at, BuildingCountingSnapshot.timestamp)))
            .limit(1)
        )
        if latest_row is not None:
            cached_signature = _building_snapshot_signature_from_summary(
                {
                    "enabled": latest_row.enabled,
                    "max_capacity": latest_row.max_capacity,
                    "capacity_exceeded": latest_row.capacity_exceeded,
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


def request_building_snapshot_if_needed(
    *,
    heartbeat_interval: float = BUILDING_SNAPSHOT_HEARTBEAT_SEC,
    timestamp: datetime | None = None,
    processed_at: datetime | None = None,
) -> bool:
    global _last_queued_building_snapshot_signature, _last_building_snapshot_time

    summary = get_building_summary()
    signature = _building_snapshot_signature_from_summary(summary)
    now = time.time()

    with _building_snapshot_lock:
        should_queue = (
            _last_queued_building_snapshot_signature is None
            or signature != _last_queued_building_snapshot_signature
            or (now - _last_building_snapshot_time) >= heartbeat_interval
        )
        if not should_queue:
            return False

        _building_snapshot_queue.append(
            _build_building_snapshot(
                summary,
                timestamp=timestamp,
                processed_at=processed_at,
            )
        )
        _last_queued_building_snapshot_signature = signature
        _last_building_snapshot_time = now
        return True


async def _restart_rtsp_counting_runtimes():
    """Restart RTSP counting producers so tracker state is refreshed at midnight."""
    if not _rtsp_counting_camera_ids:
        return

    from app.services.video_processor import start_producer_thread, stop_producer_thread

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(StreamConfig).where(StreamConfig.camera_id.in_(sorted(_rtsp_counting_camera_ids)))
        )
        stream_rows = result.scalars().all()

    runtime_groups: dict[str, list[StreamConfig]] = {}
    for row in stream_rows:
        runtime_key = (row.runtime_key or row.source_path or "").strip()
        if not runtime_key or not row.source_path or not is_rtsp_source(row.source_path):
            continue
        runtime_groups.setdefault(runtime_key, []).append(row)

    restarted = 0
    for runtime_key, rows in runtime_groups.items():
        first_row = rows[0]
        is_fisheye = any(bool(row.is_fisheye) for row in rows)
        active_views = None
        if is_fisheye:
            active_views = sorted(
                {
                    int(row.view_index)
                    for row in rows
                    if row.view_index is not None and int(row.view_index) >= 0
                }
            ) or None

        stop_producer_thread(runtime_key)
        start_producer_thread(
            runtime_key,
            first_row.source_path,
            is_fisheye,
            active_views,
        )
        restarted += 1

    if restarted:
        print(
            " ".join(
                [
                    "[CountingReset]",
                    "scope=daily_runtime_restart",
                    f"runtime_count={restarted}",
                    f"timestamp={datetime.now().astimezone().isoformat()}",
                ]
            )
        )


async def reset_all_runtime_counts():
    """
    Reset in-memory counting runtime across all cameras.
    Historical rows already stored in the database are preserved.
    """
    global _last_saved_building_snapshot_signature, _last_queued_building_snapshot_signature, _last_building_snapshot_time

    camera_ids = sorted(_rtsp_counting_camera_ids)
    for camera_id in camera_ids:
        request_counting_reset(camera_id)
        reset_camera_rollup(camera_id)
        reset_cross_camera_state(camera_id)
        _last_saved_snapshot_signature.pop(camera_id, None)
        update_live_counts(camera_id, _build_empty_live_count(camera_id))

    _last_saved_building_snapshot_signature = None
    _last_queued_building_snapshot_signature = None
    _last_building_snapshot_time = 0.0
    request_building_snapshot_if_needed()

    print(
        " ".join(
            [
                "[CountingReset]",
                "scope=daily_runtime_reset",
                f"camera_count={len(camera_ids)}",
                f"timestamp={datetime.now().astimezone().isoformat()}",
            ]
        )
    )

    await _restart_rtsp_counting_runtimes()


def _seconds_until_next_local_midnight(now: datetime | None = None) -> float:
    local_now = now or datetime.now().astimezone()
    next_midnight = (local_now + timedelta(days=1)).replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    )
    return max((next_midnight - local_now).total_seconds(), 1.0)


async def daily_runtime_reset_loop():
    """Reset in-memory counting state at the next local midnight, then repeat daily."""
    while True:
        await asyncio.sleep(_seconds_until_next_local_midnight())
        try:
            await reset_all_runtime_counts()
        except Exception as e:
            print(f"[CountingReset] Daily runtime reset failed: {e}")


def _coerce_snapshot_timestamp(raw_value, *, fallback_now: bool = True) -> datetime | None:
    """
    Normalize incoming snapshot timestamps to UTC-aware datetimes.
    Falls back to current UTC time only when requested.
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
            return datetime.now(timezone.utc) if fallback_now else None
    else:
        return datetime.now(timezone.utc) if fallback_now else None

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
        request_building_snapshot_if_needed()
        building_alert = poll_building_capacity_alert()
        if building_alert:
            from app.services.video_processor import queue_violation_event

            alert_timestamp = datetime.now(timezone.utc)
            building_alert.setdefault("timestamp", alert_timestamp)
            building_alert.setdefault("processed_at", alert_timestamp)
            queue_violation_event(building_alert)

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
                        timestamp=_coerce_snapshot_timestamp(snap.get("timestamp"), fallback_now=False),
                        processed_at=_coerce_snapshot_timestamp(snap.get("processed_at"), fallback_now=False),
                        total_in=snap.get("total_in", 0),
                        total_out=snap.get("total_out", 0),
                        current_occupancy=snap.get("current_occupancy", 0),
                        foot_traffic_left=snap.get("foot_traffic_left", 0),
                        foot_traffic_right=snap.get("foot_traffic_right", 0),
                        foot_traffic_total=snap.get("foot_traffic_total", 0),
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
                    event_timestamp, processed_at = await _derive_building_snapshot_timestamps(session, snap)

                    row = BuildingCountingSnapshot(
                        id=snap.get("id", str(uuid.uuid4())),
                        timestamp=event_timestamp,
                        processed_at=processed_at,
                        enabled=bool(snap.get("enabled", True)),
                        raw_in=int(snap.get("raw_in", 0) or 0),
                        raw_out=int(snap.get("raw_out", 0) or 0),
                        raw_occupancy=int(snap.get("raw_occupancy", 0) or 0),
                        max_capacity=snap.get("max_capacity"),
                        capacity_exceeded=bool(snap.get("capacity_exceeded", False)),
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
    global _counting_source_map, _counting_camera_resolve, _rtsp_counting_camera_ids
    new_source_map: dict[str, set[str]] = {}
    new_resolve: dict[str, str] = {}
    new_rtsp_camera_ids: set[str] = set()

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
            if is_rtsp_source(sc.source_path):
                new_rtsp_camera_ids.add(sc.camera_id)

    _counting_source_map = new_source_map
    _counting_camera_resolve = new_resolve
    _rtsp_counting_camera_ids = new_rtsp_camera_ids


async def _get_or_create_building_config(session: AsyncSession) -> BuildingCountingConfig:
    result = await session.execute(select(BuildingCountingConfig).limit(1))
    row = result.scalar_one_or_none()
    if row is None:
        row = BuildingCountingConfig(
            id="default-building-counting-config",
            enabled=True,
            max_capacity=None,
            building_ids=[],
            capacity_by_building_id={},
        )
        session.add(row)
        await session.flush()
        await session.refresh(row)
    return row


def _normalize_building_id(raw_value: str | None) -> str | None:
    value = (raw_value or "").strip()
    return value or None


def _validate_building_entrance_fields(
    *,
    participate_in_building_count: bool,
    building_id: str | None,
):
    if not participate_in_building_count:
        return
    if not building_id:
        raise HTTPException(status_code=400, detail="building_id is required when building counting is enabled for a camera.")


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


async def _validate_cross_camera_pair_uniqueness(
    *,
    db: AsyncSession,
    camera_id: str,
    camera_enabled: bool,
    cross_camera_enabled: bool,
    cross_camera_pair_id: str | None,
    cross_camera_role: str,
    verification_camera_id: str | None,
):
    if not camera_enabled or not cross_camera_enabled:
        return
    if cross_camera_role not in {"primary", "verifier"} or not cross_camera_pair_id:
        return

    result = await db.execute(
        select(PeopleCountingConfig).where(
            PeopleCountingConfig.camera_id != camera_id,
            PeopleCountingConfig.cross_camera_enabled.is_(True),
        )
    )
    other_rows = [
        row for row in result.scalars().all()
        if bool(row.enabled)
    ]

    normalized_pair_id = _normalize_cross_camera_pair_id(cross_camera_pair_id)
    normalized_verification_camera_id = _normalize_building_id(verification_camera_id)

    same_pair_rows = [
        row for row in other_rows
        if _normalize_cross_camera_pair_id(row.cross_camera_pair_id) == normalized_pair_id
    ]

    if cross_camera_role == "primary":
        for other in same_pair_rows:
            other_role = _normalize_cross_camera_role(other.cross_camera_role)
            if other_role == "primary":
                raise HTTPException(
                    status_code=400,
                    detail=f"Pair ID '{normalized_pair_id}' is already used by primary camera '{other.camera_id}'.",
                )
            if other_role == "verifier" and other.camera_id != normalized_verification_camera_id:
                raise HTTPException(
                    status_code=400,
                    detail=f"Pair ID '{normalized_pair_id}' is already assigned to verifier camera '{other.camera_id}'.",
                )

        if normalized_verification_camera_id:
            for other in other_rows:
                other_role = _normalize_cross_camera_role(other.cross_camera_role)
                other_pair_id = _normalize_cross_camera_pair_id(other.cross_camera_pair_id)
                other_verification_camera_id = _normalize_building_id(other.verification_camera_id)

                if other_role == "primary" and other_verification_camera_id == normalized_verification_camera_id:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Verification camera '{normalized_verification_camera_id}' is already paired with primary camera '{other.camera_id}'.",
                    )

                if (
                    other.camera_id == normalized_verification_camera_id
                    and other_role == "verifier"
                    and other_pair_id
                    and other_pair_id != normalized_pair_id
                ):
                    raise HTTPException(
                        status_code=400,
                        detail=f"Verification camera '{normalized_verification_camera_id}' already belongs to pair '{other_pair_id}'.",
                    )

    if cross_camera_role == "verifier":
        for other in same_pair_rows:
            other_role = _normalize_cross_camera_role(other.cross_camera_role)
            other_verification_camera_id = _normalize_building_id(other.verification_camera_id)

            if other_role == "verifier":
                raise HTTPException(
                    status_code=400,
                    detail=f"Pair ID '{normalized_pair_id}' is already assigned to verifier camera '{other.camera_id}'.",
                )

            if other_role == "primary" and other_verification_camera_id and other_verification_camera_id != camera_id:
                raise HTTPException(
                    status_code=400,
                    detail=f"Pair ID '{normalized_pair_id}' is already linked to verifier camera '{other_verification_camera_id}'.",
                )

        for other in other_rows:
            other_role = _normalize_cross_camera_role(other.cross_camera_role)
            other_pair_id = _normalize_cross_camera_pair_id(other.cross_camera_pair_id)
            other_verification_camera_id = _normalize_building_id(other.verification_camera_id)

            if (
                other_role == "primary"
                and other_verification_camera_id == camera_id
                and other_pair_id
                and other_pair_id != normalized_pair_id
            ):
                raise HTTPException(
                    status_code=400,
                    detail=f"This verifier camera is already paired under pair '{other_pair_id}'.",
                )


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
            "building_id": row.building_id,
            "cross_camera_enabled": row.cross_camera_enabled,
            "cross_camera_pair_id": row.cross_camera_pair_id,
            "cross_camera_role": row.cross_camera_role,
            "verification_camera_id": row.verification_camera_id,
            "primary_in_event_idle_timeout_sec": row.primary_in_event_idle_timeout_sec,
            "primary_out_event_idle_timeout_sec": row.primary_out_event_idle_timeout_sec,
            "lines": row.lines or [],
            "frame_exclude_areas": frame_exclude_areas,
        }
        if (
            row.enabled
            and row.participate_in_building_count
            and row.building_id
        ):
            building_sensor_configs[row.camera_id] = {
                "enabled": True,
                "building_id": row.building_id,
            }

    _counting_configs = new_configs
    sync_cross_camera_runtime(new_configs)
    await _rebuild_source_map(session)

    latest_rtsp_snapshots = await _load_latest_snapshot_by_camera(
        session,
        sorted(_rtsp_counting_camera_ids),
    )

    next_live_counts: dict[str, dict] = {}
    for camera_id in valid_camera_ids:
        existing = _live_counts.get(camera_id)
        if existing is not None:
            merged = _build_empty_live_count(camera_id)
            merged.update(
                {
                    key: value
                    for key, value in existing.items()
                    if key not in {"lines", "frame_exclude_areas"}
                }
            )
            next_live_counts[camera_id] = merged
            continue

        latest_snapshot = latest_rtsp_snapshots.get(camera_id)
        if latest_snapshot is not None:
            next_live_counts[camera_id] = _build_restored_live_count(camera_id, latest_snapshot)

    _live_counts = next_live_counts

    building_config = await _get_or_create_building_config(session)
    normalized_capacity_map = _normalize_capacity_by_building_id(building_config.capacity_by_building_id)
    registered_building_ids = _merge_registered_building_ids(
        _normalize_registered_building_ids(building_config.building_ids),
        normalized_capacity_map.keys(),
        [cfg.get("building_id") for cfg in building_sensor_configs.values()],
    )
    sync_building_runtime(
        {
            "enabled": building_config.enabled,
            "max_capacity": building_config.max_capacity,
            "building_ids": registered_building_ids,
            "capacity_by_building_id": normalized_capacity_map,
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
            latest_rtsp_snapshots = await _load_latest_snapshot_by_camera(
                session,
                sorted(_rtsp_counting_camera_ids),
            )
            latest_building_snapshot = await _load_latest_building_snapshot(session)
            camera_restore_snapshot, camera_restore_at = (
                _build_building_restore_snapshot_from_camera_snapshots(latest_rtsp_snapshots)
            )
            building_restore_at = (
                _effective_snapshot_datetime(
                    latest_building_snapshot.timestamp,
                    latest_building_snapshot.processed_at,
                )
                if latest_building_snapshot is not None
                else None
            )

            # Prefer the freshest persisted source so a stale building snapshot
            # cannot override newer per-camera totals after restart.
            if camera_restore_snapshot is not None and (
                latest_building_snapshot is None
                or building_restore_at is None
                or (camera_restore_at is not None and camera_restore_at > building_restore_at)
            ):
                restore_building_runtime(camera_restore_snapshot)
                print(
                    "[Startup] Restored building summary from camera snapshots "
                    f"timestamp={camera_restore_at}"
                )
            elif latest_building_snapshot is not None:
                restore_building_runtime(
                    {
                        "raw_in": latest_building_snapshot.raw_in,
                        "raw_out": latest_building_snapshot.raw_out,
                        "entrance_summaries": latest_building_snapshot.entrance_summaries or {},
                    }
                )
                print(
                    "[Startup] Restored building summary from snapshot "
                    f"timestamp={_effective_snapshot_datetime(latest_building_snapshot.timestamp, latest_building_snapshot.processed_at)}"
                )
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
    building_id = (
        _normalize_building_id(update.building_id)
        if update.building_id is not None
        else (row.building_id if row is not None else None)
    )
    _validate_building_entrance_fields(
        participate_in_building_count=bool(participate_in_building_count),
        building_id=building_id,
    )
    camera_enabled = (
        update.enabled
        if update.enabled is not None
        else (row.enabled if row is not None else True)
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
        _normalize_building_id(update.verification_camera_id)
        if update.verification_camera_id is not None
        else (row.verification_camera_id if row is not None else None)
    )
    cross_camera_role = _coerce_cross_camera_role(
        enabled=bool(cross_camera_enabled),
        requested_role=update.cross_camera_role if update.cross_camera_role is not None else (row.cross_camera_role if row is not None else "none"),
        existing_role=row.cross_camera_role if row is not None else "none",
        verification_camera_id=verification_camera_id,
    )
    primary_in_event_idle_timeout_sec = (
        max(0.0, float(update.primary_in_event_idle_timeout_sec))
        if update.primary_in_event_idle_timeout_sec is not None
        else float(row.primary_in_event_idle_timeout_sec if row is not None else 7.0)
    )
    primary_out_event_idle_timeout_sec = (
        max(0.0, float(update.primary_out_event_idle_timeout_sec))
        if update.primary_out_event_idle_timeout_sec is not None
        else float(row.primary_out_event_idle_timeout_sec if row is not None else 7.0)
    )
    _validate_cross_camera_fields(
        camera_id=camera_id,
        cross_camera_enabled=bool(cross_camera_enabled),
        cross_camera_pair_id=cross_camera_pair_id,
        cross_camera_role=cross_camera_role,
        verification_camera_id=verification_camera_id,
    )
    await _validate_cross_camera_pair_uniqueness(
        db=db,
        camera_id=camera_id,
        camera_enabled=bool(camera_enabled),
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
            enabled=bool(camera_enabled),
            participate_in_building_count=bool(participate_in_building_count),
            building_id=building_id,
            cross_camera_enabled=bool(cross_camera_enabled),
            cross_camera_pair_id=cross_camera_pair_id,
            cross_camera_role=cross_camera_role,
            verification_camera_id=verification_camera_id,
            primary_in_event_idle_timeout_sec=primary_in_event_idle_timeout_sec,
            primary_out_event_idle_timeout_sec=primary_out_event_idle_timeout_sec,
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
        if update.building_id is not None:
            row.building_id = building_id
        if update.cross_camera_enabled is not None:
            row.cross_camera_enabled = bool(cross_camera_enabled)
        if update.cross_camera_pair_id is not None:
            row.cross_camera_pair_id = cross_camera_pair_id
        if update.cross_camera_role is not None or row.cross_camera_enabled:
            row.cross_camera_role = cross_camera_role
        if update.verification_camera_id is not None:
            row.verification_camera_id = verification_camera_id
        if update.primary_in_event_idle_timeout_sec is not None:
            row.primary_in_event_idle_timeout_sec = primary_in_event_idle_timeout_sec
        if update.primary_out_event_idle_timeout_sec is not None:
            row.primary_out_event_idle_timeout_sec = primary_out_event_idle_timeout_sec
        if update.lines is not None:
            row.lines = update.lines
        if frame_exclude_areas is not None:
            row.frame_exclude_areas = frame_exclude_areas

    if not row.participate_in_building_count:
        row.building_id = None
    if not row.cross_camera_enabled:
        row.cross_camera_pair_id = None
        row.cross_camera_role = "none"
        row.verification_camera_id = None
    elif row.cross_camera_role == "primary":
        row.verification_camera_id = verification_camera_id

    await db.flush()
    await db.refresh(row)

    await sync_counting_runtime_from_db(db)
    request_building_snapshot_if_needed()

    return _serialize_counting_config_row(row)


@router.delete("/api/people-counting-config/{camera_id}")
async def delete_config(camera_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        sa_delete(PeopleCountingConfig).where(PeopleCountingConfig.camera_id == camera_id)
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="No counting config for this camera")

    await sync_counting_runtime_from_db(db)
    request_building_snapshot_if_needed()
    return {"status": "deleted"}


@router.get("/api/people-counting-history", response_model=list[PeopleCountingSnapshotRead])
async def get_history(
    camera_id: str | None = Query(None),
    start: datetime | None = Query(None),
    end: datetime | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """Get historical counting snapshots, newest first."""
    start = _normalize_query_datetime(start)
    end = _normalize_query_datetime(end)
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=400, detail="start must be earlier than or equal to end")

    effective_time = func.coalesce(PeopleCountingSnapshot.processed_at, PeopleCountingSnapshot.timestamp)
    query = select(PeopleCountingSnapshot).order_by(desc(effective_time))
    if camera_id:
        query = query.where(PeopleCountingSnapshot.camera_id == camera_id)
    if start is not None:
        query = query.where(effective_time >= start)
    if end is not None:
        query = query.where(effective_time <= end)
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
    request_building_snapshot_if_needed()

    return {
        "camera_id": camera_id,
        "counting_data": empty_data,
        "building_summary": get_building_summary(),
    }


@router.get("/api/building-counting-config", response_model=BuildingCountingConfigRead)
async def get_building_config(db: AsyncSession = Depends(get_db)):
    row = await _get_or_create_building_config(db)
    assigned_building_ids = await _get_assigned_building_ids(db)
    row.building_ids = _merge_registered_building_ids(
        _normalize_registered_building_ids(row.building_ids),
        _normalize_capacity_by_building_id(row.capacity_by_building_id).keys(),
        assigned_building_ids,
    )
    row.capacity_by_building_id = _normalize_capacity_by_building_id(row.capacity_by_building_id)
    return row


@router.put("/api/building-counting-config", response_model=BuildingCountingConfigRead)
async def update_building_config(
    update: BuildingCountingConfigUpdate,
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create_building_config(db)
    assigned_building_ids = await _get_assigned_building_ids(db)
    normalized_building_ids = _merge_registered_building_ids(
        _normalize_registered_building_ids(row.building_ids),
        _normalize_capacity_by_building_id(row.capacity_by_building_id).keys(),
        assigned_building_ids,
    )
    normalized_capacity_map = _normalize_capacity_by_building_id(row.capacity_by_building_id)

    if update.enabled is not None:
        row.enabled = update.enabled
    if update.building_ids is not None:
        normalized_building_ids = _merge_registered_building_ids(
            _normalize_registered_building_ids(update.building_ids),
            assigned_building_ids,
        )
    if update.capacity_by_building_id is not None:
        normalized_capacity_map = _normalize_capacity_by_building_id(update.capacity_by_building_id)
    if update.building_id is not None:
        normalized_building_id = _normalize_building_id(update.building_id)
        if normalized_building_id:
            if normalized_building_id not in normalized_building_ids:
                normalized_building_ids.append(normalized_building_id)
            parsed_capacity = int(update.max_capacity or 0)
            if parsed_capacity > 0:
                normalized_capacity_map[normalized_building_id] = parsed_capacity
            else:
                normalized_capacity_map.pop(normalized_building_id, None)
    elif update.max_capacity is not None:
        row.max_capacity = int(update.max_capacity) if int(update.max_capacity) > 0 else None
    row.building_ids = _merge_registered_building_ids(
        normalized_building_ids,
        normalized_capacity_map.keys(),
        assigned_building_ids,
    )
    row.capacity_by_building_id = normalized_capacity_map

    await db.flush()
    await db.refresh(row)
    assigned_building_ids = await _get_assigned_building_ids(db)
    row.building_ids = _merge_registered_building_ids(
        _normalize_registered_building_ids(row.building_ids),
        _normalize_capacity_by_building_id(row.capacity_by_building_id).keys(),
        assigned_building_ids,
    )
    row.capacity_by_building_id = _normalize_capacity_by_building_id(row.capacity_by_building_id)
    await sync_counting_runtime_from_db(db)
    request_building_snapshot_if_needed()
    return row


@router.delete("/api/building-counting-config/{building_id}", response_model=BuildingCountingConfigRead)
async def delete_building_id_config(
    building_id: str,
    db: AsyncSession = Depends(get_db),
):
    normalized_building_id = _normalize_building_id(building_id)
    if not normalized_building_id:
        raise HTTPException(status_code=400, detail="building_id is required.")

    assigned_camera_labels = await _get_assigned_camera_labels_for_building_id(db, normalized_building_id)
    if assigned_camera_labels:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot delete building ID '{normalized_building_id}' because it is still assigned to: "
                f"{', '.join(sorted(assigned_camera_labels, key=str.lower))}."
            ),
        )

    row = await _get_or_create_building_config(db)
    normalized_building_ids = [
        registered_building_id
        for registered_building_id in _normalize_registered_building_ids(row.building_ids)
        if registered_building_id != normalized_building_id
    ]
    normalized_capacity_map = _normalize_capacity_by_building_id(row.capacity_by_building_id)
    normalized_capacity_map.pop(normalized_building_id, None)

    row.building_ids = normalized_building_ids
    row.capacity_by_building_id = normalized_capacity_map

    await db.flush()
    await db.refresh(row)
    await sync_counting_runtime_from_db(db)
    remove_building_rollup(normalized_building_id)
    request_building_snapshot_if_needed()

    assigned_building_ids = await _get_assigned_building_ids(db)
    row.building_ids = _merge_registered_building_ids(
        _normalize_registered_building_ids(row.building_ids),
        assigned_building_ids,
    )
    row.capacity_by_building_id = _normalize_capacity_by_building_id(row.capacity_by_building_id)
    return row


@router.get("/api/building-counting-history", response_model=list[BuildingCountingSnapshotRead])
async def get_building_history(
    start: datetime | None = Query(None),
    end: datetime | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    start = _normalize_query_datetime(start)
    end = _normalize_query_datetime(end)
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=400, detail="start must be earlier than or equal to end")

    effective_time = func.coalesce(BuildingCountingSnapshot.processed_at, BuildingCountingSnapshot.timestamp)
    query = select(BuildingCountingSnapshot).order_by(desc(effective_time))
    if start is not None:
        query = query.where(effective_time >= start)
    if end is not None:
        query = query.where(effective_time <= end)
    query = query.offset(offset).limit(limit)
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/api/building-occupancy-summary", response_model=BuildingOccupancySummaryRead)
async def get_building_occupancy_summary():
    return get_building_summary()


@router.post("/api/building-occupancy-summary/reset", response_model=BuildingOccupancySummaryRead)
async def reset_building_occupancy_summary():
    reset_building_runtime()
    request_building_snapshot_if_needed()
    return get_building_summary()
