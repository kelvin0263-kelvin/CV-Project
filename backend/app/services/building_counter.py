from collections import defaultdict
import threading
import uuid


_runtime_lock = threading.Lock()
_building_config = {
    "enabled": True,
    "max_capacity": None,
    "manual_offset": 0,
}
_sensor_configs: dict[str, dict] = {}
_entrance_rollups: dict[str, dict] = defaultdict(dict)
_camera_rollups: dict[str, dict] = {}
_raw_in = 0
_raw_out = 0
_capacity_alert_fired = False


def sync_building_runtime(building_config: dict, sensor_configs: dict[str, dict]):
    """
    Replace the in-memory building config and participating sensor map.
    Aggregated counts are preserved so config changes do not wipe the current
    building total.
    """
    global _building_config, _sensor_configs, _capacity_alert_fired

    with _runtime_lock:
        _building_config = {
            "enabled": bool(building_config.get("enabled", True)),
            "max_capacity": _normalize_max_capacity(building_config.get("max_capacity")),
            "manual_offset": int(building_config.get("manual_offset", 0) or 0),
        }
        _sensor_configs = {
            camera_id: {
                "enabled": bool(cfg.get("enabled", True)),
                "entrance_id": (cfg.get("entrance_id") or "").strip(),
            }
            for camera_id, cfg in sensor_configs.items()
        }
        if not _is_capacity_exceeded_locked():
            _capacity_alert_fired = False


def reset_building_runtime(manual_offset: int | None = None):
    """Clear all aggregated counters, optionally replacing the manual offset."""
    global _raw_in, _raw_out, _entrance_rollups, _camera_rollups, _capacity_alert_fired

    with _runtime_lock:
        if manual_offset is not None:
            _building_config["manual_offset"] = int(manual_offset)
        _raw_in = 0
        _raw_out = 0
        _entrance_rollups = defaultdict(dict)
        _camera_rollups = {}
        _capacity_alert_fired = False


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

        entrance_id = (sensor_cfg.get("entrance_id") or "").strip()
        if not entrance_id:
            return None

        rollup = _entrance_rollups.get(entrance_id)
        if not rollup:
            rollup = _new_rollup()
            _entrance_rollups[entrance_id] = rollup
        camera_rollup = _camera_rollups.get(camera_id)
        if not camera_rollup:
            camera_rollup = {"entrances": {}}
            _camera_rollups[camera_id] = camera_rollup
        entrance_camera_rollup = camera_rollup["entrances"].get(entrance_id)
        if not entrance_camera_rollup:
            entrance_camera_rollup = _new_rollup()
            camera_rollup["entrances"][entrance_id] = entrance_camera_rollup

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

        return _maybe_building_capacity_alert_locked()


def reset_camera_rollup(camera_id: str):
    """Remove one camera's historical contribution from building totals."""
    global _raw_in, _raw_out, _capacity_alert_fired

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

        if not _is_capacity_exceeded_locked():
            _capacity_alert_fired = False


def get_building_summary() -> dict:
    """Return the current live building occupancy summary."""
    with _runtime_lock:
        max_capacity = _normalize_max_capacity(_building_config.get("max_capacity"))
        manual_offset = int(_building_config["manual_offset"] or 0)
        raw_occupancy = max(0, _raw_in - _raw_out)
        occupancy = max(0, raw_occupancy + manual_offset)
        capacity_exceeded = bool(max_capacity is not None and occupancy >= max_capacity)

        entrance_ids = {
            cfg["entrance_id"]
            for cfg in _sensor_configs.values()
            if cfg.get("enabled", True) and cfg.get("entrance_id")
        }
        entrance_ids.update(_entrance_rollups.keys())

        entrance_summaries: dict[str, dict] = {}
        for entrance_id in sorted(entrance_ids):
            rollup = _entrance_rollups.get(entrance_id) or _new_rollup()
            camera_ids = [
                camera_id
                for camera_id, cfg in _sensor_configs.items()
                if cfg.get("enabled", True) and (cfg.get("entrance_id") or "").strip() == entrance_id
            ]
            entrance_summaries[entrance_id] = {
                "camera_ids": camera_ids,
                "total_in": rollup["total_in"],
                "total_out": rollup["total_out"],
                "occupancy": max(0, rollup["total_in"] - rollup["total_out"]),
            }

        return {
            "enabled": _building_config["enabled"],
            "max_capacity": max_capacity,
            "capacity_exceeded": capacity_exceeded,
            "manual_offset": manual_offset,
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


def _current_raw_occupancy_locked() -> int:
    return max(0, _raw_in - _raw_out)


def _current_occupancy_locked() -> int:
    manual_offset = int(_building_config.get("manual_offset", 0) or 0)
    return max(0, _current_raw_occupancy_locked() + manual_offset)


def _is_capacity_exceeded_locked() -> bool:
    max_capacity = _normalize_max_capacity(_building_config.get("max_capacity"))
    if max_capacity is None:
        return False
    return _current_occupancy_locked() >= max_capacity


def _maybe_building_capacity_alert_locked():
    global _capacity_alert_fired

    max_capacity = _normalize_max_capacity(_building_config.get("max_capacity"))
    if max_capacity is None:
        _capacity_alert_fired = False
        return None

    occupancy = _current_occupancy_locked()
    if occupancy >= max_capacity:
        if _capacity_alert_fired:
            return None
        _capacity_alert_fired = True
        return {
            "id": str(uuid.uuid4()),
            "camera_id": None,
            "event_type": "Capacity Exceeded",
            "scope": "building",
            "occupancy": occupancy,
            "max_capacity": max_capacity,
        }

    _capacity_alert_fired = False
    return None
