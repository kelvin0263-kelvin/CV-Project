import os
import threading
import time
import uuid


DEFAULT_INWARD_THRESHOLD = 0.02
DEFAULT_PRIMARY_EVENT_IDLE_TIMEOUT_SEC =  10.0
TRACK_STALE_TIMEOUT_SEC = 10.0
LINE_SIDE_EPS = 0.002
DEBUG_CROSS_CAMERA = os.getenv("DEBUG_CROSS_CAMERA", "").strip().lower() in {"1", "true", "yes", "on"}

_runtime_lock = threading.Lock()
_primary_pairs: dict[str, dict] = {}
_verifier_to_primary: dict[str, set[str]] = {}
_pair_states: dict[str, dict] = {}
_verifier_tracks: dict[str, dict[int, dict]] = {}


def _log_cross_camera(message: str) -> None:
    if DEBUG_CROSS_CAMERA:
        print(message)


def sync_cross_camera_runtime(counting_configs: dict[str, dict]) -> None:
    global _primary_pairs, _verifier_to_primary, _pair_states, _verifier_tracks

    new_primary_pairs: dict[str, dict] = {}
    new_verifier_to_primary: dict[str, set[str]] = {}

    for camera_id, cfg in counting_configs.items():
        if not cfg.get("enabled", True):
            continue
        if not cfg.get("cross_camera_enabled", False):
            continue
        if str(cfg.get("cross_camera_role") or "none") != "primary":
            continue

        pair_id = str(cfg.get("cross_camera_pair_id") or "").strip()
        verifier_camera_id = str(cfg.get("verification_camera_id") or "").strip()
        if not pair_id or not verifier_camera_id or verifier_camera_id == camera_id:
            continue

        verifier_cfg = counting_configs.get(verifier_camera_id) or {}
        if not verifier_cfg.get("enabled", True):
            continue
        if not verifier_cfg.get("cross_camera_enabled", False):
            continue
        if str(verifier_cfg.get("cross_camera_role") or "none") != "verifier":
            continue
        if str(verifier_cfg.get("cross_camera_pair_id") or "").strip() != pair_id:
            continue

        new_primary_pairs[camera_id] = {
            "pair_id": pair_id,
            "verifier_camera_id": verifier_camera_id,
            "verification_inward_threshold": max(
                0.0,
                float(cfg.get("verification_inward_threshold", DEFAULT_INWARD_THRESHOLD) or DEFAULT_INWARD_THRESHOLD),
            ),
            "primary_event_idle_timeout_sec": DEFAULT_PRIMARY_EVENT_IDLE_TIMEOUT_SEC,
        }
        new_verifier_to_primary.setdefault(verifier_camera_id, set()).add(camera_id)

    with _runtime_lock:
        old_pair_states = _pair_states
        old_verifier_tracks = _verifier_tracks
        _primary_pairs = new_primary_pairs
        _verifier_to_primary = new_verifier_to_primary
        _pair_states = {
            camera_id: old_pair_states.get(
                camera_id,
                {
                    "last_raw_total_in": 0,
                    "correction_offset_in": 0,
                    "active_event": None,
                    "last_completed_event": None,
                },
            )
            for camera_id in new_primary_pairs
        }
        _verifier_tracks = {
            camera_id: old_verifier_tracks.get(camera_id, {})
            for camera_id in new_verifier_to_primary
        }

    if not new_primary_pairs:
        _log_cross_camera("[CrossCameraSync] no active primary/verifier pairs")
        return

    for primary_camera_id, pair_cfg in new_primary_pairs.items():
        _log_cross_camera(
            " ".join(
                [
                    "[CrossCameraSync]",
                    f"pair_id={pair_cfg.get('pair_id')}",
                    f"primary_camera={primary_camera_id}",
                    f"verifier_camera={pair_cfg.get('verifier_camera_id')}",
                    f"idle_timeout={pair_cfg.get('primary_event_idle_timeout_sec')}",
                    f"inward_threshold={pair_cfg.get('verification_inward_threshold')}",
                ]
            )
        )


def reset_cross_camera_state(camera_id: str) -> None:
    with _runtime_lock:
        if camera_id in _pair_states:
            _pair_states[camera_id] = {
                "last_raw_total_in": 0,
                "correction_offset_in": 0,
                "active_event": None,
                "last_completed_event": None,
            }

        if camera_id in _verifier_tracks:
            _verifier_tracks[camera_id] = {}

        for primary_camera_id, pair_cfg in _primary_pairs.items():
            if pair_cfg.get("verifier_camera_id") == camera_id:
                _pair_states[primary_camera_id] = {
                    "last_raw_total_in": 0,
                    "correction_offset_in": 0,
                    "active_event": None,
                    "last_completed_event": None,
                }

    _log_cross_camera(f"[CrossCameraReset] camera={camera_id}")


def register_primary_in_events(camera_id: str, delta_in: int, now: float | None = None) -> None:
    if delta_in <= 0:
        return
    if now is None:
        now = time.time()

    with _runtime_lock:
        pair_cfg = _primary_pairs.get(camera_id)
        pair_state = _pair_states.get(camera_id)
        if not pair_cfg or not pair_state:
            return

        active_event = pair_state.get("active_event")
        if active_event is None:
            active_event = {
                "event_id": str(uuid.uuid4()),
                "start_time": now,
                "last_primary_in_time": now,
                "primary_in_count": int(delta_in),
                "verifier_in_count": 0,
                "accepted_track_ids": set(),
            }
            pair_state["active_event"] = active_event
            _log_cross_camera(
                " ".join(
                    [
                        "[CrossCameraPrimaryEventStarted]",
                        f"pair_id={pair_cfg.get('pair_id')}",
                        f"event_id={active_event['event_id']}",
                        f"primary_camera={camera_id}",
                        f"verifier_camera={pair_cfg.get('verifier_camera_id')}",
                        f"delta_in={delta_in}",
                        f"primary_in_count={active_event['primary_in_count']}",
                        f"start_time={now:.3f}",
                    ]
                )
            )
            return

        active_event["last_primary_in_time"] = now
        active_event["primary_in_count"] = int(active_event.get("primary_in_count", 0) or 0) + int(delta_in)
        _log_cross_camera(
            " ".join(
                [
                    "[CrossCameraPrimaryEventUpdated]",
                    f"pair_id={pair_cfg.get('pair_id')}",
                    f"event_id={active_event['event_id']}",
                    f"primary_camera={camera_id}",
                    f"delta_in={delta_in}",
                    f"primary_in_count={active_event['primary_in_count']}",
                    f"last_primary_in_time={now:.3f}",
                ]
            )
        )


def observe_verifier_tracks(
    camera_id: str,
    detections: list[dict],
    config: dict,
    frame_shape: tuple[int, int] | None = None,
    now: float | None = None,
) -> None:
    if now is None:
        now = time.time()

    with _runtime_lock:
        primary_ids = _verifier_to_primary.get(camera_id)
        if not primary_ids:
            return

        track_states = _verifier_tracks.setdefault(camera_id, {})
        active_track_ids: set[int] = set()
        active_zones = config.get("frame_exclude_areas") or []
        inward_line = _get_inward_line(config.get("lines") or [])

        for det in detections:
            track_id = det.get("track_id")
            person_bbox = det.get("person_bbox")
            point = _extract_verifier_cross_point(det, inward_line, frame_shape)
            if track_id is None or point is None:
                continue

            tid = int(track_id)
            active_track_ids.add(tid)
            curr_side = _line_target_side_value(inward_line, point) if inward_line else 0.0

            ts = track_states.get(tid)
            if ts is None:
                ts = {
                    "birth_time": now,
                    "birth_point": point,
                    "last_point": point,
                    "last_seen": now,
                    "last_side_value": curr_side,
                }
                track_states[tid] = ts
                prev_point = None
                prev_side = curr_side
            else:
                prev_point = ts["last_point"]
                prev_side = float(ts.get("last_side_value", 0.0) or 0.0)
                ts["last_point"] = point
                ts["last_seen"] = now
                ts["last_side_value"] = curr_side

            if prev_point is None or inward_line is None:
                continue

            cross_point = _line_crossing_point(prev_point, point, prev_side, curr_side)
            if cross_point is None:
                continue
            if prev_side > LINE_SIDE_EPS or curr_side <= LINE_SIDE_EPS:
                continue
            if not _is_inside_active_zone(cross_point, active_zones):
                continue

            for primary_camera_id in primary_ids:
                pair_cfg = _primary_pairs.get(primary_camera_id)
                pair_state = _pair_states.get(primary_camera_id)
                if not pair_cfg or not pair_state:
                    continue

                active_event = pair_state.get("active_event")
                if not active_event:
                    continue
                if ts["birth_time"] < float(active_event.get("start_time", 0.0) or 0.0):
                    continue
                if tid in active_event["accepted_track_ids"]:
                    continue

                active_event["accepted_track_ids"].add(tid)
                active_event["verifier_in_count"] = int(active_event.get("verifier_in_count", 0) or 0) + 1
                _log_cross_camera(
                    " ".join(
                        [
                            "[CrossCameraVerifierCounted]",
                            f"pair_id={pair_cfg.get('pair_id')}",
                            f"event_id={active_event['event_id']}",
                            f"primary_camera={primary_camera_id}",
                            f"verifier_camera={camera_id}",
                            f"track_id={tid}",
                            f"cross_point=({cross_point[0]:.3f},{cross_point[1]:.3f})",
                            f"verifier_in_count={active_event['verifier_in_count']}",
                            f"primary_in_count={active_event['primary_in_count']}",
                        ]
                    )
                )

        stale_before = now - TRACK_STALE_TIMEOUT_SEC
        for track_id in list(track_states.keys()):
            if track_id in active_track_ids:
                continue
            if float(track_states[track_id].get("last_seen", 0.0) or 0.0) < stale_before:
                del track_states[track_id]


def apply_primary_camera_correction(camera_id: str, counting_data: dict, now: float | None = None) -> tuple[dict, int]:
    if now is None:
        now = time.time()

    with _runtime_lock:
        pair_cfg = _primary_pairs.get(camera_id)
        pair_state = _pair_states.get(camera_id)
        if not pair_cfg or not pair_state:
            return counting_data, 0

        raw_total_in = int(counting_data.get("total_in", 0) or 0)
        raw_total_out = int(counting_data.get("total_out", 0) or 0)
        last_raw_total_in = int(pair_state.get("last_raw_total_in", 0) or 0)

        if raw_total_in < last_raw_total_in:
            pair_state["last_raw_total_in"] = raw_total_in
            pair_state["correction_offset_in"] = 0
            pair_state["active_event"] = None
            pair_state["last_completed_event"] = None
            verifier_camera_id = pair_cfg.get("verifier_camera_id")
            if verifier_camera_id in _verifier_tracks:
                _verifier_tracks[verifier_camera_id] = {}
            _log_cross_camera(
                " ".join(
                    [
                        "[CrossCameraPrimaryReset]",
                        f"pair_id={pair_cfg.get('pair_id')}",
                        f"primary_camera={camera_id}",
                        f"verifier_camera={verifier_camera_id}",
                        f"raw_total_in={raw_total_in}",
                    ]
                )
            )
            corrected = dict(counting_data)
            corrected["raw_total_in"] = raw_total_in
            corrected["verification_correction_in"] = 0
            corrected["verification_camera_id"] = pair_cfg.get("verifier_camera_id")
            corrected["cross_camera_pair_id"] = pair_cfg.get("pair_id")
            return corrected, 0

        pair_state["last_raw_total_in"] = raw_total_in

        correction_delta = 0
        active_event = pair_state.get("active_event")
        if active_event is not None:
            idle_timeout = float(pair_cfg.get("primary_event_idle_timeout_sec", DEFAULT_PRIMARY_EVENT_IDLE_TIMEOUT_SEC) or DEFAULT_PRIMARY_EVENT_IDLE_TIMEOUT_SEC)
            last_primary_in_time = float(active_event.get("last_primary_in_time", 0.0) or 0.0)
            if (now - last_primary_in_time) >= idle_timeout:
                primary_in_count = int(active_event.get("primary_in_count", 0) or 0)
                verifier_in_count = int(active_event.get("verifier_in_count", 0) or 0)
                correction_delta = max(0, verifier_in_count - primary_in_count)
                if correction_delta > 0:
                    pair_state["correction_offset_in"] = int(pair_state.get("correction_offset_in", 0) or 0) + correction_delta
                completed_event = {
                    "event_id": active_event.get("event_id"),
                    "start_time": active_event.get("start_time"),
                    "end_time": now,
                    "primary_in_count": primary_in_count,
                    "verifier_in_count": verifier_in_count,
                    "correction_in": correction_delta,
                }
                pair_state["last_completed_event"] = completed_event
                pair_state["active_event"] = None
                _log_cross_camera(
                    " ".join(
                        [
                            "[CrossCameraPrimaryEventClosed]",
                            f"pair_id={pair_cfg.get('pair_id')}",
                            f"event_id={completed_event['event_id']}",
                            f"primary_camera={camera_id}",
                            f"verifier_camera={pair_cfg.get('verifier_camera_id')}",
                            f"primary_in_count={primary_in_count}",
                            f"verifier_in_count={verifier_in_count}",
                            f"correction_in={correction_delta}",
                            f"end_time={now:.3f}",
                        ]
                    )
                )

        corrected_total_in = raw_total_in + int(pair_state.get("correction_offset_in", 0) or 0)
        corrected = dict(counting_data)
        corrected["raw_total_in"] = raw_total_in
        corrected["verification_confirmed_in"] = (
            int(active_event.get("verifier_in_count", 0) or 0)
            if active_event is not None
            else int((pair_state.get("last_completed_event") or {}).get("verifier_in_count", 0) or 0)
        )
        corrected["verification_correction_in"] = int(pair_state.get("correction_offset_in", 0) or 0)
        corrected["verification_camera_id"] = pair_cfg.get("verifier_camera_id")
        corrected["cross_camera_pair_id"] = pair_cfg.get("pair_id")
        corrected["cross_camera_active_event"] = _serialize_event(active_event)
        corrected["cross_camera_last_event"] = _serialize_event(pair_state.get("last_completed_event"))
        corrected["total_in"] = corrected_total_in
        corrected["occupancy"] = max(0, corrected_total_in - raw_total_out)

        if correction_delta > 0:
            _log_cross_camera(
                " ".join(
                    [
                        "[CrossCameraCorrection]",
                        f"pair_id={pair_cfg.get('pair_id')}",
                        f"primary_camera={camera_id}",
                        f"verifier_camera={pair_cfg.get('verifier_camera_id')}",
                        f"extra_in={correction_delta}",
                        f"raw_total_in={raw_total_in}",
                        f"corrected_total_in={corrected_total_in}",
                    ]
                )
            )

        return corrected, correction_delta


def _serialize_event(event: dict | None) -> dict | None:
    if not event:
        return None
    return {
        "event_id": event.get("event_id"),
        "start_time": event.get("start_time"),
        "end_time": event.get("end_time"),
        "last_primary_in_time": event.get("last_primary_in_time"),
        "primary_in_count": int(event.get("primary_in_count", 0) or 0),
        "verifier_in_count": int(event.get("verifier_in_count", 0) or 0),
        "correction_in": int(event.get("correction_in", 0) or 0),
    }


def _extract_verifier_cross_point(
    det: dict,
    line_cfg: dict | None,
    frame_shape: tuple[int, int] | None,
) -> tuple[float, float] | None:
    person_bbox = det.get("person_bbox")
    if (
        person_bbox is not None
        and frame_shape is not None
        and len(person_bbox) >= 4
        and frame_shape[0] > 0
        and frame_shape[1] > 0
    ):
        return _bbox_line_target_point_norm(person_bbox, frame_shape[1], frame_shape[0], line_cfg)

    anchor = det.get("count_anchor_norm")
    if anchor and len(anchor) >= 2:
        return (float(anchor[0]), float(anchor[1]))
    return None


def _bbox_line_target_point_norm(
    bbox: list[float],
    frame_w: int,
    frame_h: int,
    line_cfg: dict | None,
) -> tuple[float, float]:
    x1, y1, x2, y2 = [float(v) for v in bbox[:4]]
    if not line_cfg:
        cx = ((x1 + x2) / 2.0) / frame_w
        cy = y2 / frame_h
        return (cx, cy)

    count_event = str(line_cfg.get("count_event") or "in")
    if count_event == "out":
        right_x = x2 / frame_w
        midlower_y = (y1 + ((y2 - y1) * 0.75)) / frame_h
        return (right_x, midlower_y)

    right_x = x2 / frame_w
    bottom_y = y2 / frame_h
    return (right_x, bottom_y)


def _get_inward_line(lines: list[dict]) -> dict | None:
    for line_cfg in lines:
        if str(line_cfg.get("count_event") or "in") == "in" and len(line_cfg.get("points", [])) >= 2:
            return line_cfg
    for line_cfg in lines:
        if len(line_cfg.get("points", [])) >= 2:
            return line_cfg
    return None


def _is_inside_active_zone(point: tuple[float, float], active_zones: list[dict]) -> bool:
    if not active_zones:
        return True
    for area in active_zones:
        polygon = area.get("points", [])
        if len(polygon) >= 3 and _point_in_polygon(point, polygon):
            return True
    return False


def _line_target_side_value(line_cfg: dict | None, point: tuple[float, float]) -> float:
    if not line_cfg:
        return 0.0
    points = line_cfg.get("points", [])
    if len(points) < 2:
        return 0.0
    lp1 = (float(points[0][0]), float(points[0][1]))
    lp2 = (float(points[1][0]), float(points[1][1]))
    line_len = max(((lp2[0] - lp1[0]) ** 2 + (lp2[1] - lp1[1]) ** 2) ** 0.5, 1e-9)
    side_value = _cross_product_sign(lp1, lp2, point) / line_len
    if line_cfg.get("direction", "left_to_right") == "left_to_right":
        return side_value
    return -side_value


def _line_crossing_point(
    prev_point: tuple[float, float] | None,
    curr_point: tuple[float, float] | None,
    prev_side: float,
    curr_side: float,
) -> tuple[float, float] | None:
    if prev_point is None or curr_point is None:
        return None
    denominator = prev_side - curr_side
    if abs(denominator) <= 1e-9:
        return None
    t = prev_side / denominator
    t = max(0.0, min(1.0, t))
    return (
        prev_point[0] + ((curr_point[0] - prev_point[0]) * t),
        prev_point[1] + ((curr_point[1] - prev_point[1]) * t),
    )


def _cross_product_sign(a: tuple[float, float], b: tuple[float, float], p: tuple[float, float]) -> float:
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])


def _point_in_polygon(point: tuple[float, float], polygon: list[list[float]]) -> bool:
    x, y = point
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = float(polygon[i][0]), float(polygon[i][1])
        xj, yj = float(polygon[j][0]), float(polygon[j][1])
        intersects = ((yi > y) != (yj > y)) and (
            x < ((xj - xi) * (y - yi) / ((yj - yi) or 1e-9) + xi)
        )
        if intersects:
            inside = not inside
        j = i
    return inside
