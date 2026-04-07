import threading
import time
import uuid


DEFAULT_PRIMARY_IN_EVENT_IDLE_TIMEOUT_SEC = 7.0
DEFAULT_PRIMARY_OUT_EVENT_IDLE_TIMEOUT_SEC = 7.0
TRACK_STALE_TIMEOUT_SEC = 5.0
LINE_SIDE_EPS = 0.002

_runtime_lock = threading.Lock()
_primary_pairs: dict[str, dict] = {}
_verifier_to_primary: dict[str, set[str]] = {}
_pair_states: dict[str, dict] = {}
_verifier_tracks: dict[str, dict[int, dict]] = {}


def _new_pair_state() -> dict:
    return {
        "last_raw_total_in": 0,
        "last_raw_total_out": 0,
        "correction_offset_in": 0,
        "correction_offset_out": 0,
        "active_in_event": None,
        "last_completed_in_event": None,
        "active_out_event": None,
        "last_completed_out_event": None,
    }


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
            "primary_in_event_idle_timeout_sec": float(
                cfg.get("primary_in_event_idle_timeout_sec", DEFAULT_PRIMARY_IN_EVENT_IDLE_TIMEOUT_SEC)
                or DEFAULT_PRIMARY_IN_EVENT_IDLE_TIMEOUT_SEC
            ),
            "primary_out_event_idle_timeout_sec": float(
                cfg.get("primary_out_event_idle_timeout_sec", DEFAULT_PRIMARY_OUT_EVENT_IDLE_TIMEOUT_SEC)
                or DEFAULT_PRIMARY_OUT_EVENT_IDLE_TIMEOUT_SEC
            ),
        }
        new_verifier_to_primary.setdefault(verifier_camera_id, set()).add(camera_id)

    with _runtime_lock:
        old_pair_states = _pair_states
        old_verifier_tracks = _verifier_tracks
        _primary_pairs = new_primary_pairs
        _verifier_to_primary = new_verifier_to_primary
        _pair_states = {
            camera_id: old_pair_states.get(camera_id, _new_pair_state())
            for camera_id in new_primary_pairs
        }
        _verifier_tracks = {
            camera_id: old_verifier_tracks.get(camera_id, {})
            for camera_id in new_verifier_to_primary
        }

    return


def reset_cross_camera_state(camera_id: str) -> None:
    with _runtime_lock:
        if camera_id in _pair_states:
            _pair_states[camera_id] = _new_pair_state()

        if camera_id in _verifier_tracks:
            _verifier_tracks[camera_id] = {}

        for primary_camera_id, pair_cfg in _primary_pairs.items():
            if pair_cfg.get("verifier_camera_id") == camera_id:
                _pair_states[primary_camera_id] = _new_pair_state()

def get_verifier_camera_status(camera_id: str) -> dict:
    with _runtime_lock:
        primary_ids = sorted(_verifier_to_primary.get(camera_id, set()))
        track_states = _verifier_tracks.get(camera_id, {})
        active_in_events: list[dict] = []
        active_out_events: list[dict] = []
        last_in_events: list[dict] = []
        last_out_events: list[dict] = []

        for primary_camera_id in primary_ids:
            pair_cfg = _primary_pairs.get(primary_camera_id)
            pair_state = _pair_states.get(primary_camera_id)
            if not pair_cfg or not pair_state:
                continue

            active_in_event = _serialize_event(pair_state.get("active_in_event"))
            if active_in_event is not None:
                active_in_events.append(
                    {
                        "primary_camera_id": primary_camera_id,
                        "pair_id": pair_cfg.get("pair_id"),
                        **active_in_event,
                    }
                )

            active_out_event = _serialize_event(pair_state.get("active_out_event"))
            if active_out_event is not None:
                active_out_events.append(
                    {
                        "primary_camera_id": primary_camera_id,
                        "pair_id": pair_cfg.get("pair_id"),
                        **active_out_event,
                    }
                )

            last_in_event = _serialize_event(pair_state.get("last_completed_in_event"))
            if last_in_event is not None:
                last_in_events.append(
                    {
                        "primary_camera_id": primary_camera_id,
                        "pair_id": pair_cfg.get("pair_id"),
                        **last_in_event,
                    }
                )

            last_out_event = _serialize_event(pair_state.get("last_completed_out_event"))
            if last_out_event is not None:
                last_out_events.append(
                    {
                        "primary_camera_id": primary_camera_id,
                        "pair_id": pair_cfg.get("pair_id"),
                        **last_out_event,
                    }
                )

        latest_last_in_event = _latest_event(last_in_events)
        latest_last_out_event = _latest_event(last_out_events)
        latest_last_event = _latest_event(
            [event for event in [latest_last_in_event, latest_last_out_event] if event is not None]
        )
        active_in_event = active_in_events[0] if active_in_events else None
        active_out_event = active_out_events[0] if active_out_events else None

        return {
            "cross_camera_role": "verifier",
            "cross_camera_pair_id": primary_ids and str((_primary_pairs.get(primary_ids[0]) or {}).get("pair_id") or "") or None,
            "verifier_primary_camera_ids": primary_ids,
            "verifier_observed_tracks": len(track_states),
            "verifier_active_in_events": active_in_events,
            "verifier_active_in_event": active_in_event,
            "verifier_active_out_events": active_out_events,
            "verifier_active_out_event": active_out_event,
            "verifier_last_in_events": last_in_events,
            "verifier_last_in_event": latest_last_in_event,
            "verifier_last_out_events": last_out_events,
            "verifier_last_out_event": latest_last_out_event,
            "verifier_active_event": active_in_event or active_out_event,
            "verifier_last_event": latest_last_event,
        }


def register_primary_in_events(camera_id: str, delta_in: int, now: float | None = None) -> None:
    _register_primary_events(camera_id, delta_in, "in", now)


def register_primary_in_reversions(camera_id: str, reverted_count: int, now: float | None = None) -> None:
    if reverted_count <= 0:
        return
    if now is None:
        now = time.time()

    active_key, _, primary_count_key, _ = _event_state_keys("in")

    with _runtime_lock:
        pair_state = _pair_states.get(camera_id)
        if not pair_state:
            return

        pair_state["last_raw_total_in"] = max(
            0,
            int(pair_state.get("last_raw_total_in", 0) or 0) - int(reverted_count),
        )

        active_event = pair_state.get(active_key)
        if active_event is None:
            return

        remaining = max(
            0,
            int(active_event.get(primary_count_key, 0) or 0) - int(reverted_count),
        )
        if remaining <= 0:
            pair_state[active_key] = None
            return

        active_event[primary_count_key] = remaining
        active_event["last_activity_time"] = now


def register_primary_out_events(camera_id: str, delta_out: int, now: float | None = None) -> None:
    _register_primary_events(camera_id, delta_out, "out", now)


def _register_primary_events(
    camera_id: str,
    delta_count: int,
    direction: str,
    now: float | None = None,
) -> None:
    if delta_count <= 0:
        return
    if now is None:
        now = time.time()

    active_key, _, primary_count_key, verifier_count_key = _event_state_keys(direction)

    with _runtime_lock:
        pair_cfg = _primary_pairs.get(camera_id)
        pair_state = _pair_states.get(camera_id)
        if not pair_cfg or not pair_state:
            return

        active_event = pair_state.get(active_key)
        if active_event is None:
            active_event = {
                "event_id": str(uuid.uuid4()),
                "direction": direction,
                "start_time": now,
                "last_primary_time": now,
                "last_activity_time": now,
                primary_count_key: int(delta_count),
                verifier_count_key: 0,
                "accepted_track_ids": set(),
            }
            pair_state[active_key] = active_event
            return

        active_event["last_primary_time"] = now
        active_event["last_activity_time"] = now
        active_event[primary_count_key] = int(active_event.get(primary_count_key, 0) or 0) + int(delta_count)


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
        lines = config.get("lines") or []
        inward_line = _get_inward_line(lines)
        outward_line = _get_outward_line(lines)

        for det in detections:
            track_id = det.get("track_id")
            in_point = _extract_verifier_cross_point(det, inward_line, frame_shape)
            out_point = _extract_verifier_cross_point(det, outward_line, frame_shape)
            if track_id is None or (in_point is None and out_point is None):
                continue

            tid = int(track_id)
            active_track_ids.add(tid)
            ts = track_states.get(tid)
            if ts is None:
                ts = {
                    "birth_time": now,
                    "birth_point": in_point or out_point,
                    "last_in_point": in_point,
                    "last_out_point": out_point,
                    "last_seen": now,
                }
                track_states[tid] = ts
            else:
                ts["last_seen"] = now
                prev_in_point = ts.get("last_in_point")
                prev_out_point = ts.get("last_out_point")

                if prev_in_point is not None and in_point is not None:
                    _observe_verifier_crossing(
                        camera_id=camera_id,
                        primary_ids=primary_ids,
                        track_id=tid,
                        track_state=ts,
                        prev_point=prev_in_point,
                        curr_point=in_point,
                        active_zones=active_zones,
                        line_cfg=inward_line,
                        direction="in",
                        now=now,
                    )
                if prev_out_point is not None and out_point is not None:
                    _observe_verifier_crossing(
                        camera_id=camera_id,
                        primary_ids=primary_ids,
                        track_id=tid,
                        track_state=ts,
                        prev_point=prev_out_point,
                        curr_point=out_point,
                        active_zones=active_zones,
                        line_cfg=outward_line,
                        direction="out",
                        now=now,
                    )

            ts["last_in_point"] = in_point
            ts["last_out_point"] = out_point

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
        last_raw_total_out = int(pair_state.get("last_raw_total_out", 0) or 0)

        if raw_total_in < last_raw_total_in or raw_total_out < last_raw_total_out:
            pair_state["last_raw_total_in"] = raw_total_in
            pair_state["last_raw_total_out"] = raw_total_out
            pair_state["correction_offset_in"] = 0
            pair_state["correction_offset_out"] = 0
            pair_state["active_in_event"] = None
            pair_state["last_completed_in_event"] = None
            pair_state["active_out_event"] = None
            pair_state["last_completed_out_event"] = None
            verifier_camera_id = pair_cfg.get("verifier_camera_id")
            if verifier_camera_id in _verifier_tracks:
                _verifier_tracks[verifier_camera_id] = {}
            corrected = dict(counting_data)
            corrected["raw_total_in"] = raw_total_in
            corrected["raw_total_out"] = raw_total_out
            corrected["verification_confirmed_in"] = 0
            corrected["verification_correction_in"] = 0
            corrected["verification_confirmed_out"] = 0
            corrected["verification_correction_out"] = 0
            corrected["verification_camera_id"] = pair_cfg.get("verifier_camera_id")
            corrected["cross_camera_pair_id"] = pair_cfg.get("pair_id")
            corrected["cross_camera_active_event"] = None
            corrected["cross_camera_last_event"] = None
            corrected["cross_camera_active_in_event"] = None
            corrected["cross_camera_last_in_event"] = None
            corrected["cross_camera_active_out_event"] = None
            corrected["cross_camera_last_out_event"] = None
            return corrected, 0

        pair_state["last_raw_total_in"] = raw_total_in
        pair_state["last_raw_total_out"] = raw_total_out

        correction_delta_in = _close_expired_primary_event(pair_cfg, pair_state, camera_id, "in", now)
        correction_delta_out = _close_expired_primary_event(pair_cfg, pair_state, camera_id, "out", now)

        active_in_event = pair_state.get("active_in_event")
        active_out_event = pair_state.get("active_out_event")
        last_completed_in_event = pair_state.get("last_completed_in_event")
        last_completed_out_event = pair_state.get("last_completed_out_event")
        corrected_total_in = raw_total_in + int(pair_state.get("correction_offset_in", 0) or 0)
        corrected_total_out = raw_total_out + int(pair_state.get("correction_offset_out", 0) or 0)
        corrected = dict(counting_data)
        corrected["raw_total_in"] = raw_total_in
        corrected["raw_total_out"] = raw_total_out
        corrected["verification_confirmed_in"] = _verified_count_for_event(active_in_event, last_completed_in_event, "in")
        corrected["verification_correction_in"] = int(pair_state.get("correction_offset_in", 0) or 0)
        corrected["verification_confirmed_out"] = _verified_count_for_event(active_out_event, last_completed_out_event, "out")
        corrected["verification_correction_out"] = int(pair_state.get("correction_offset_out", 0) or 0)
        corrected["verification_camera_id"] = pair_cfg.get("verifier_camera_id")
        corrected["cross_camera_pair_id"] = pair_cfg.get("pair_id")
        corrected["cross_camera_active_in_event"] = _serialize_event(active_in_event)
        corrected["cross_camera_last_in_event"] = _serialize_event(last_completed_in_event)
        corrected["cross_camera_active_out_event"] = _serialize_event(active_out_event)
        corrected["cross_camera_last_out_event"] = _serialize_event(last_completed_out_event)
        corrected["cross_camera_active_event"] = corrected["cross_camera_active_in_event"] or corrected["cross_camera_active_out_event"]
        corrected["cross_camera_last_event"] = _latest_event(
            [
                corrected["cross_camera_last_in_event"],
                corrected["cross_camera_last_out_event"],
            ]
        )
        corrected["total_in"] = corrected_total_in
        corrected["total_out"] = corrected_total_out
        corrected["occupancy"] = max(0, corrected_total_in - corrected_total_out)

        return corrected, correction_delta_in + correction_delta_out


def _observe_verifier_crossing(
    *,
    camera_id: str,
    primary_ids: set[str],
    track_id: int,
    track_state: dict,
    prev_point: tuple[float, float],
    curr_point: tuple[float, float],
    active_zones: list[dict],
    line_cfg: dict | None,
    direction: str,
    now: float,
) -> None:
    if line_cfg is None:
        return

    active_key, _, primary_count_key, verifier_count_key = _event_state_keys(direction)
    prev_side = _line_target_side_value(line_cfg, prev_point)
    curr_side = _line_target_side_value(line_cfg, curr_point)
    cross_point = _line_crossing_point(prev_point, curr_point, prev_side, curr_side)
    if cross_point is None:
        return
    if prev_side > LINE_SIDE_EPS or curr_side <= LINE_SIDE_EPS:
        return
    if not _is_inside_active_zone(cross_point, active_zones):
        return

    for primary_camera_id in primary_ids:
        pair_cfg = _primary_pairs.get(primary_camera_id)
        pair_state = _pair_states.get(primary_camera_id)
        if not pair_cfg or not pair_state:
            continue

        active_event = pair_state.get(active_key)

        if active_event is None and direction == "out":
            event_start_time = float(track_state.get("birth_time", now) or now)
            active_event = {
                "event_id": str(uuid.uuid4()),
                "direction": "out",
                "start_time": event_start_time,
                "last_primary_time": None,
                "last_activity_time": now,
                primary_count_key: 0,
                verifier_count_key: 0,
                "accepted_track_ids": set(),
            }
            pair_state[active_key] = active_event
        if not active_event:
            continue
        if direction != "out" and track_state["birth_time"] < float(active_event.get("start_time", 0.0) or 0.0):
            continue
        if track_id in active_event["accepted_track_ids"]:
            continue

        _accept_verifier_track_for_event(
            pair_cfg=pair_cfg,
            active_event=active_event,
            primary_count_key=primary_count_key,
            verifier_count_key=verifier_count_key,
            primary_camera_id=primary_camera_id,
            verifier_camera_id=camera_id,
            track_id=track_id,
            point=cross_point,
            direction=direction,
            now=now,
        )


def _close_expired_primary_event(
    pair_cfg: dict,
    pair_state: dict,
    camera_id: str,
    direction: str,
    now: float,
) -> int:
    active_key, last_key, primary_count_key, verifier_count_key = _event_state_keys(direction)
    active_event = pair_state.get(active_key)
    if active_event is None:
        return 0

    idle_timeout = _primary_event_idle_timeout(pair_cfg, direction)
    last_activity_time = float(
        active_event.get("last_activity_time")
        or active_event.get("last_primary_time")
        or active_event.get("start_time")
        or 0.0
    )
    if (now - last_activity_time) < idle_timeout:
        return 0

    primary_count = int(active_event.get(primary_count_key, 0) or 0)
    verifier_count = int(active_event.get(verifier_count_key, 0) or 0)
    correction_delta = 0
    if primary_count > 0:
        correction_delta = max(0, verifier_count - primary_count)
    correction_offset_key = f"correction_offset_{direction}"
    if correction_delta > 0:
        pair_state[correction_offset_key] = int(pair_state.get(correction_offset_key, 0) or 0) + correction_delta

    completed_event = {
        "event_id": active_event.get("event_id"),
        "direction": direction,
        "start_time": active_event.get("start_time"),
        "end_time": now,
        "last_primary_time": None,
        primary_count_key: primary_count,
        verifier_count_key: verifier_count,
        f"correction_{direction}": correction_delta,
    }
    pair_state[last_key] = completed_event
    pair_state[active_key] = None
    return correction_delta


def _primary_event_idle_timeout(pair_cfg: dict, direction: str) -> float:
    if str(direction).lower() == "out":
        return float(
            pair_cfg.get("primary_out_event_idle_timeout_sec", DEFAULT_PRIMARY_OUT_EVENT_IDLE_TIMEOUT_SEC)
            or DEFAULT_PRIMARY_OUT_EVENT_IDLE_TIMEOUT_SEC
        )
    return float(
        pair_cfg.get("primary_in_event_idle_timeout_sec", DEFAULT_PRIMARY_IN_EVENT_IDLE_TIMEOUT_SEC)
        or DEFAULT_PRIMARY_IN_EVENT_IDLE_TIMEOUT_SEC
    )


def _accept_verifier_track_for_event(
    *,
    pair_cfg: dict,
    active_event: dict,
    primary_count_key: str,
    verifier_count_key: str,
    primary_camera_id: str,
    verifier_camera_id: str,
    track_id: int,
    point: tuple[float, float],
    direction: str,
    now: float,
) -> None:
    active_event["accepted_track_ids"].add(track_id)
    active_event["last_activity_time"] = now
    active_event[verifier_count_key] = int(active_event.get(verifier_count_key, 0) or 0) + 1


def _event_state_keys(direction: str) -> tuple[str, str, str, str]:
    normalized = "out" if str(direction).lower() == "out" else "in"
    return (
        f"active_{normalized}_event",
        f"last_completed_{normalized}_event",
        f"primary_{normalized}_count",
        f"verifier_{normalized}_count",
    )


def _verified_count_for_event(active_event: dict | None, last_event: dict | None, direction: str) -> int:
    _, _, _, verifier_count_key = _event_state_keys(direction)
    if active_event is not None:
        return int(active_event.get(verifier_count_key, 0) or 0)
    return int((last_event or {}).get(verifier_count_key, 0) or 0)


def _latest_event(events: list[dict | None]) -> dict | None:
    normalized_events = [event for event in events if event is not None]
    if not normalized_events:
        return None
    return max(
        normalized_events,
        key=lambda event: float(event.get("end_time") or event.get("start_time") or 0.0),
    )


def _serialize_event(event: dict | None) -> dict | None:
    if not event:
        return None
    direction = "out" if str(event.get("direction") or "").lower() == "out" else "in"
    _, _, primary_count_key, verifier_count_key = _event_state_keys(direction)
    return {
        "event_id": event.get("event_id"),
        "direction": direction,
        "start_time": event.get("start_time"),
        "end_time": event.get("end_time"),
        "last_primary_time": event.get("last_primary_time"),
        "last_activity_time": event.get("last_activity_time"),
        "primary_count": int(event.get(primary_count_key, 0) or 0),
        "verifier_count": int(event.get(verifier_count_key, 0) or 0),
        "correction": int(event.get(f"correction_{direction}", 0) or 0),
        "primary_in_count": int(event.get("primary_in_count", 0) or 0),
        "verifier_in_count": int(event.get("verifier_in_count", 0) or 0),
        "correction_in": int(event.get("correction_in", 0) or 0),
        "primary_out_count": int(event.get("primary_out_count", 0) or 0),
        "verifier_out_count": int(event.get("verifier_out_count", 0) or 0),
        "correction_out": int(event.get("correction_out", 0) or 0),
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
        center_x = ((x1 + x2) / 2.0) / frame_w
        bottom_y = y2 / frame_h
        return (center_x, bottom_y)

    right_x = x2 / frame_w
    bottom_y = y2 / frame_h
    return (right_x, bottom_y)


def _get_inward_line(lines: list[dict]) -> dict | None:
    return _get_line_for_event(lines, "in", fallback_to_any=True)


def _get_outward_line(lines: list[dict]) -> dict | None:
    return _get_line_for_event(lines, "out", fallback_to_any=False)


def _get_line_for_event(
    lines: list[dict],
    count_event: str,
    *,
    fallback_to_any: bool,
) -> dict | None:
    normalized_event = "out" if str(count_event).lower() == "out" else "in"
    for line_cfg in lines:
        if str(line_cfg.get("count_event") or "in") == normalized_event and len(line_cfg.get("points", [])) >= 2:
            return line_cfg
    if fallback_to_any:
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
