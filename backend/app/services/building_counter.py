from collections import defaultdict
import threading
import time
import uuid


_runtime_lock = threading.Lock()
CAPACITY_ALERT_PERSIST_SEC = 60
_building_config = {
    "enabled": True,
    "max_capacity": None,
    "building_ids": [],
    "capacity_by_building_id": {},
}
_sensor_configs: dict[str, dict] = {}
_entrance_rollups: dict[str, dict] = defaultdict(dict)
_camera_rollups: dict[str, dict] = {}
_raw_in = 0
_raw_out = 0
_capacity_exceeded_since_by_building_id: dict[str, float] = {}
_capacity_alert_fired_by_building_id: dict[str, bool] = {}


def sync_building_runtime(building_config: dict, sensor_configs: dict[str, dict]):
    """
    Replace the in-memory building config and participating sensor map.
    Aggregated counts are preserved so config changes do not wipe the current
    building total.
    """
    global _building_config, _sensor_configs

    with _runtime_lock:
        _building_config = {
            "enabled": bool(building_config.get("enabled", True)),
            "max_capacity": _normalize_max_capacity(building_config.get("max_capacity")),
            "building_ids": _normalize_building_ids(building_config.get("building_ids")),
            "capacity_by_building_id": _normalize_capacity_map(
                building_config.get("capacity_by_building_id")
            ),
        }
        _sensor_configs = {
            camera_id: {
                "enabled": bool(cfg.get("enabled", True)),
                "building_id": (cfg.get("building_id") or "").strip(),
            }
            for camera_id, cfg in sensor_configs.items()
        }
        _sync_capacity_alert_state_locked()


def restore_building_runtime(snapshot: dict | None):
    """
    Restore in-memory building rollups from a persisted snapshot.

    The active building config is not replaced here; startup loads config from the
    dedicated config table first, then this function restores the latest raw counts
    and entrance/camera rollups underneath that config.
    """
    global _raw_in, _raw_out, _entrance_rollups, _camera_rollups

    if not isinstance(snapshot, dict):
        return

    restored_entrance_rollups: dict[str, dict] = {}
    restored_camera_rollups: dict[str, dict] = {}

    for raw_entrance_id, raw_entrance_summary in (snapshot.get("entrance_summaries") or {}).items():
        entrance_id = str(raw_entrance_id or "").strip()
        if not entrance_id or not isinstance(raw_entrance_summary, dict):
            continue

        restored_entrance_rollups[entrance_id] = {
            "total_in": max(0, int(raw_entrance_summary.get("total_in", 0) or 0)),
            "total_out": max(0, int(raw_entrance_summary.get("total_out", 0) or 0)),
        }

        for raw_camera_id, raw_camera_summary in (raw_entrance_summary.get("camera_summaries") or {}).items():
            camera_id = str(raw_camera_id or "").strip()
            if not camera_id or not isinstance(raw_camera_summary, dict):
                continue

            camera_rollup = restored_camera_rollups.setdefault(camera_id, {"entrances": {}})
            camera_rollup["entrances"][entrance_id] = {
                "total_in": max(0, int(raw_camera_summary.get("total_in", 0) or 0)),
                "total_out": max(0, int(raw_camera_summary.get("total_out", 0) or 0)),
            }

    with _runtime_lock:
        _raw_in = max(0, int(snapshot.get("raw_in", 0) or 0))
        _raw_out = max(0, int(snapshot.get("raw_out", 0) or 0))
        _entrance_rollups = defaultdict(dict, restored_entrance_rollups)
        _camera_rollups = restored_camera_rollups
        _sync_capacity_alert_state_locked(mark_current_exceeded_as_fired=True)


def reset_building_runtime():
    """Clear all aggregated building counters."""
    global _raw_in, _raw_out, _entrance_rollups, _camera_rollups
    global _capacity_exceeded_since_by_building_id, _capacity_alert_fired_by_building_id

    with _runtime_lock:
        _raw_in = 0
        _raw_out = 0
        _entrance_rollups = defaultdict(dict)
        _camera_rollups = {}
        _capacity_exceeded_since_by_building_id = {}
        _capacity_alert_fired_by_building_id = {}


def remove_building_rollup(building_id: str):
    """Remove one building's live aggregated totals from runtime state."""
    global _raw_in, _raw_out

    normalized_building_id = str(building_id or "").strip()
    if not normalized_building_id:
        return

    with _runtime_lock:
        rollup = _entrance_rollups.pop(normalized_building_id, None)
        if rollup:
            _raw_in = max(0, _raw_in - int(rollup.get("total_in", 0) or 0))
            _raw_out = max(0, _raw_out - int(rollup.get("total_out", 0) or 0))

        empty_camera_ids: list[str] = []
        for camera_id, camera_rollup in _camera_rollups.items():
            entrances = camera_rollup.get("entrances", {})
            entrances.pop(normalized_building_id, None)
            if not entrances:
                empty_camera_ids.append(camera_id)

        for camera_id in empty_camera_ids:
            _camera_rollups.pop(camera_id, None)

        _sync_capacity_alert_state_locked()


def ingest_sensor_events(camera_id: str, events: list[dict]):
    """Record raw per-camera count deltas into their configured entrance group."""
    global _raw_in, _raw_out

    if not events:
        return

    with _runtime_lock:
        if not _building_config.get("enabled", True):
            return None

        sensor_cfg = _sensor_configs.get(camera_id)
        if not sensor_cfg or not sensor_cfg.get("enabled", True):
            return None

        building_id = (sensor_cfg.get("building_id") or "").strip()
        if not building_id:
            return None

        rollup = _entrance_rollups.get(building_id)
        if not rollup:
            rollup = _new_rollup()
            _entrance_rollups[building_id] = rollup
        camera_rollup = _camera_rollups.get(camera_id)
        if not camera_rollup:
            camera_rollup = {"entrances": {}}
            _camera_rollups[camera_id] = camera_rollup
        entrance_camera_rollup = camera_rollup["entrances"].get(building_id)
        if not entrance_camera_rollup:
            entrance_camera_rollup = _new_rollup()
            camera_rollup["entrances"][building_id] = entrance_camera_rollup

        for event in events:
            direction = event.get("direction")
            if direction == "in":
                rollup["total_in"] += 1
                entrance_camera_rollup["total_in"] += 1
                _raw_in += 1
            elif direction == "out":
                rollup["total_out"] += 1
                entrance_camera_rollup["total_out"] += 1
                _raw_out += 1

        _sync_capacity_alert_state_locked()
        return None


def revert_sensor_in_events(camera_id: str, reverted_count: int):
    """Subtract reverted IN events from the camera and building rollups."""
    global _raw_in

    reverted_count = max(0, int(reverted_count or 0))
    if reverted_count <= 0:
        return

    with _runtime_lock:
        if not _building_config.get("enabled", True):
            return

        sensor_cfg = _sensor_configs.get(camera_id)
        if not sensor_cfg or not sensor_cfg.get("enabled", True):
            return

        building_id = (sensor_cfg.get("building_id") or "").strip()
        if not building_id:
            return

        camera_rollup = _camera_rollups.get(camera_id)
        if not camera_rollup:
            return

        entrance_camera_rollup = camera_rollup.get("entrances", {}).get(building_id)
        if not entrance_camera_rollup:
            return

        reverted = min(reverted_count, int(entrance_camera_rollup.get("total_in", 0) or 0))
        if reverted <= 0:
            return

        entrance_camera_rollup["total_in"] = max(0, int(entrance_camera_rollup.get("total_in", 0) or 0) - reverted)
        _raw_in = max(0, _raw_in - reverted)

        entrance_rollup = _entrance_rollups.get(building_id)
        if entrance_rollup:
            entrance_rollup["total_in"] = max(0, int(entrance_rollup.get("total_in", 0) or 0) - reverted)
            if not entrance_rollup["total_in"] and not entrance_rollup["total_out"]:
                _entrance_rollups.pop(building_id, None)

        if not entrance_camera_rollup["total_in"] and not entrance_camera_rollup["total_out"]:
            camera_rollup.get("entrances", {}).pop(building_id, None)
        if not camera_rollup.get("entrances"):
            _camera_rollups.pop(camera_id, None)

        _sync_capacity_alert_state_locked()


def reset_camera_rollup(camera_id: str):
    """Remove one camera's historical contribution from building totals."""
    global _raw_in, _raw_out

    with _runtime_lock:
        camera_rollup = _camera_rollups.pop(camera_id, None)
        if not camera_rollup:
            return

        for entrance_id, entrance_camera_rollup in camera_rollup.get("entrances", {}).items():
            total_in = int(entrance_camera_rollup.get("total_in", 0) or 0)
            total_out = int(entrance_camera_rollup.get("total_out", 0) or 0)

            _raw_in = max(0, _raw_in - total_in)
            _raw_out = max(0, _raw_out - total_out)

            entrance_rollup = _entrance_rollups.get(entrance_id)
            if not entrance_rollup:
                continue

            entrance_rollup["total_in"] = max(0, int(entrance_rollup.get("total_in", 0) or 0) - total_in)
            entrance_rollup["total_out"] = max(0, int(entrance_rollup.get("total_out", 0) or 0) - total_out)
            if not entrance_rollup["total_in"] and not entrance_rollup["total_out"]:
                _entrance_rollups.pop(entrance_id, None)

        _sync_capacity_alert_state_locked()


def poll_building_capacity_alert():
    """Return a building capacity alert once an exceeded group persists long enough."""
    with _runtime_lock:
        _sync_capacity_alert_state_locked()
        return _maybe_building_capacity_alert_locked()


def get_building_summary() -> dict:
    """Return the current live building occupancy summary."""
    with _runtime_lock:
        monitoring_enabled = bool(_building_config.get("enabled", True))
        raw_occupancy = max(0, _raw_in - _raw_out)
        occupancy = raw_occupancy

        entrance_ids = _get_entrance_ids_locked()
        exceeded_building_ids: list[str] = []
        entrance_summaries: dict[str, dict] = {}
        aggregate_capacity = 0
        aggregate_capacity_known = bool(entrance_ids)

        for entrance_id in sorted(entrance_ids):
            rollup = _entrance_rollups.get(entrance_id) or _new_rollup()
            entrance_occupancy = max(0, int(rollup.get("total_in", 0) or 0) - int(rollup.get("total_out", 0) or 0))
            max_capacity = _max_capacity_for_building_id_locked(entrance_id)
            is_exceeded = bool(monitoring_enabled and max_capacity is not None and entrance_occupancy >= max_capacity)
            if is_exceeded:
                exceeded_building_ids.append(entrance_id)

            if max_capacity is None:
                aggregate_capacity_known = False
            else:
                aggregate_capacity += max_capacity

            camera_ids = [
                camera_id
                for camera_id, cfg in _sensor_configs.items()
                if cfg.get("enabled", True) and (cfg.get("building_id") or "").strip() == entrance_id
            ]
            camera_summaries = {}
            for camera_id in camera_ids:
                camera_rollup = (_camera_rollups.get(camera_id) or {}).get("entrances", {}).get(entrance_id) or _new_rollup()
                camera_total_in = int(camera_rollup.get("total_in", 0) or 0)
                camera_total_out = int(camera_rollup.get("total_out", 0) or 0)
                camera_summaries[camera_id] = {
                    "total_in": camera_total_in,
                    "total_out": camera_total_out,
                    "occupancy": max(0, camera_total_in - camera_total_out),
                }
            entrance_summaries[entrance_id] = {
                "camera_ids": camera_ids,
                "total_in": int(rollup.get("total_in", 0) or 0),
                "total_out": int(rollup.get("total_out", 0) or 0),
                "occupancy": entrance_occupancy,
                "max_capacity": max_capacity,
                "capacity_exceeded": is_exceeded,
                "camera_summaries": camera_summaries,
            }

        return {
            "enabled": _building_config["enabled"],
            "max_capacity": aggregate_capacity if aggregate_capacity_known and entrance_ids else None,
            "capacity_exceeded": bool(monitoring_enabled and exceeded_building_ids),
            "exceeded_building_ids": exceeded_building_ids,
            "default_max_capacity": _normalize_max_capacity(_building_config.get("max_capacity")),
            "building_ids": list(_building_config.get("building_ids") or []),
            "capacity_by_building_id": dict(_building_config.get("capacity_by_building_id") or {}),
            "raw_in": _raw_in,
            "raw_out": _raw_out,
            "raw_occupancy": raw_occupancy,
            "occupancy": occupancy,
            "active_camera_count": sum(1 for cfg in _sensor_configs.values() if cfg.get("enabled", True)),
            "entrance_summaries": entrance_summaries,
        }


def _new_rollup() -> dict:
    return {
        "total_in": 0,
        "total_out": 0,
    }


def _normalize_max_capacity(value):
    if value in (None, "", 0, "0"):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _normalize_capacity_map(raw_map) -> dict[str, int]:
    normalized: dict[str, int] = {}
    if not isinstance(raw_map, dict):
        return normalized

    for raw_building_id, raw_capacity in raw_map.items():
        building_id = str(raw_building_id or "").strip()
        max_capacity = _normalize_max_capacity(raw_capacity)
        if not building_id or max_capacity is None:
            continue
        normalized[building_id] = max_capacity
    return normalized


def _normalize_building_ids(raw_value) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    if not isinstance(raw_value, list):
        return normalized

    for raw_building_id in raw_value:
        building_id = str(raw_building_id or "").strip()
        if not building_id or building_id in seen:
            continue
        seen.add(building_id)
        normalized.append(building_id)
    return normalized


def _get_entrance_ids_locked() -> set[str]:
    entrance_ids = {
        cfg["building_id"]
        for cfg in _sensor_configs.values()
        if cfg.get("enabled", True) and cfg.get("building_id")
    }
    entrance_ids.update(_building_config.get("building_ids") or [])
    entrance_ids.update((_building_config.get("capacity_by_building_id") or {}).keys())
    entrance_ids.update(_entrance_rollups.keys())
    return entrance_ids


def _building_occupancy_locked(building_id: str) -> int:
    rollup = _entrance_rollups.get(building_id) or _new_rollup()
    return max(0, int(rollup.get("total_in", 0) or 0) - int(rollup.get("total_out", 0) or 0))


def _max_capacity_for_building_id_locked(building_id: str) -> int | None:
    normalized_building_id = str(building_id or "").strip()
    overrides = _building_config.get("capacity_by_building_id") or {}
    override_capacity = _normalize_max_capacity(overrides.get(normalized_building_id))
    if override_capacity is not None:
        return override_capacity
    return _normalize_max_capacity(_building_config.get("max_capacity"))


def _sync_capacity_alert_state_locked(mark_current_exceeded_as_fired: bool = False) -> None:
    global _capacity_exceeded_since_by_building_id, _capacity_alert_fired_by_building_id

    if not _building_config.get("enabled", True):
        _capacity_exceeded_since_by_building_id = {}
        _capacity_alert_fired_by_building_id = {}
        return

    now = time.monotonic()
    next_since: dict[str, float] = {}
    next_fired: dict[str, bool] = {}

    for building_id in _get_entrance_ids_locked():
        max_capacity = _max_capacity_for_building_id_locked(building_id)
        occupancy = _building_occupancy_locked(building_id)
        is_exceeded = bool(max_capacity is not None and occupancy >= max_capacity)
        if not is_exceeded:
            continue

        if mark_current_exceeded_as_fired:
            next_fired[building_id] = True
            next_since[building_id] = now - CAPACITY_ALERT_PERSIST_SEC
            continue

        was_fired = bool(_capacity_alert_fired_by_building_id.get(building_id))
        next_fired[building_id] = was_fired
        if was_fired:
            next_since[building_id] = _capacity_exceeded_since_by_building_id.get(
                building_id,
                now - CAPACITY_ALERT_PERSIST_SEC,
            )
        else:
            next_since[building_id] = _capacity_exceeded_since_by_building_id.get(
                building_id,
                now,
            )

    _capacity_exceeded_since_by_building_id = next_since
    _capacity_alert_fired_by_building_id = next_fired


def _maybe_building_capacity_alert_locked():
    if not _building_config.get("enabled", True):
        return None

    for building_id in sorted(_get_entrance_ids_locked()):
        max_capacity = _max_capacity_for_building_id_locked(building_id)
        if max_capacity is None:
            continue

        occupancy = _building_occupancy_locked(building_id)
        if occupancy < max_capacity:
            continue

        if _capacity_alert_fired_by_building_id.get(building_id):
            continue

        exceeded_since = _capacity_exceeded_since_by_building_id.get(building_id)
        if exceeded_since is None:
            continue
        if (time.monotonic() - exceeded_since) < CAPACITY_ALERT_PERSIST_SEC:
            continue

        _capacity_alert_fired_by_building_id[building_id] = True
        return {
            "id": str(uuid.uuid4()),
            "camera_id": None,
            "event_type": "Capacity Exceeded",
            "scope": "building",
            "building_id": building_id,
            "occupancy": occupancy,
            "max_capacity": max_capacity,
        }

    return None
