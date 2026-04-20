"""
People Counting Service

Line-based people counting with optional active counting zones.

Supports:
1. Door/occupancy counting with IN/OUT line-cross logic.
2. Foot-traffic counting with per-line directional line-cross totals.
3. Optional polygons that gate count events. A crossing/disappear event only
   counts when its probe point is inside the configured active zone.

All coordinates are stored in normalized (0-1) form.

High-level execution order:
1. `PeopleCounter(config)` loads lines/zones, prepares runtime state, and
   synchronizes per-line dictionaries.
2. `update(detections, frame_shape)` runs once per frame.
3. Each detection is normalized into anchor points and frame-age tracking data.
4. Each configured line routes the track through either occupancy logic
   (`_update_line_track_state`) or foot-traffic logic
   (`_update_foot_traffic_track_state`).
5. After line updates, disappear cleanup and fallback counting run.
6. A result payload is returned, and snapshot helpers can be called separately
   by the outer pipeline when persistence is needed.
"""

import math
import os
import time
import uuid
from datetime import datetime, timezone


DEBUG_COUNTING = False
DEBUG_COUNTING_VERBOSE = False
DEBUG_COUNTING_TRACK_ID = 31



LINE_EVENT_IN = "in"
LINE_EVENT_OUT = "out"
LINE_TYPE_OCCUPANCY = "occupancy"
LINE_TYPE_FOOT_TRAFFIC = "foot_traffic"


DEFAULT_DISAPPEAR_TIMEOUT = 0
#time cooldown for a track id to trigger again the in count
DEFAULT_COUNT_COOLDOWN = 1.0
DEFAULT_LINE_SIDE_EPS = 0 #line tolerance
DEFAULT_FOOT_TRAFFIC_REARM_SIDE_EPS = 0.1
DEFAULT_FOOT_TRAFFIC_RECOUNT_COOLDOWN = 0.75
DEFAULT_FOOT_TRAFFIC_SEGMENT_ENDPOINT_TOL = 0.01
DEFAULT_LINE_IN_MIN_TRACK_FRAMES = 10

# frame_count >= DEFAULT_LINE_OUT_MIN_TRACK_FRAMES and frame_count <= DEFAULT_LINE_OUT_MAX_TRACK_FRAMES
DEFAULT_LINE_OUT_MIN_TRACK_FRAMES = 0
DEFAULT_LINE_OUT_MAX_TRACK_FRAMES = 1
DEFAULT_OUT_ZONE_ARM_MIN_FRAMES = 5
DEFAULT_OUT_TRAVEL_MIN_DISTANCE = 0.07
DEFAULT_UNCOUNT_IN_REAPPEAR_FRAMES = 150 # reverse count frames

# =============================================================================
# State Classes
# =============================================================================

class _LineTrackState:
    """Tracks lifetime and final line side for line counting."""

    __slots__ = (
        "last_seen_time",
        "frame_count",
        "birth_point",
        "born_in_active_zone",
        "last_right_point",
        "last_in_side_value",
        "last_in_active_zone",
        "active_zone_streak",
        "out_zone_armed",
    )

    # Helper initializer: creates per-track occupancy state used only inside `PeopleCounter`.
    def __init__(self):
        self.last_seen_time: float = time.time()
        self.frame_count: int = 0
        self.birth_point: tuple[float, float] = (0.0, 0.0)
        self.born_in_active_zone: bool = False
        self.last_right_point: tuple[float, float] = (0.0, 0.0)
        self.last_in_side_value: float = 0.0
        self.last_in_active_zone: bool = False
        self.active_zone_streak: int = 0
        self.out_zone_armed: bool = False

class _CountedTrackRecord:
    """Permanent count memory for one numeric track ID."""

    __slots__ = ("direction", "source", "count_time", "visible_streak_after_count", "uncounted")

    # Helper initializer: stores one counted-track record so duplicate line events can be blocked.
    def __init__(self, direction: str, source: str, count_time: float):
        self.direction = direction
        self.source = source
        self.count_time = count_time
        self.visible_streak_after_count = 0
        self.uncounted = False

class _FootTrafficTrackState:
    """Tracks one line-cross lifecycle for directional foot traffic."""

    __slots__ = (
        "last_seen_time",
        "last_point",
        "last_side_value",
        "last_count_direction",
        "last_count_time",
        "rearmed",
        "counted_left",
        "counted_right",
    )

    # Helper initializer: creates per-track foot-traffic state for internal line-cross checks.
    def __init__(self):
        self.last_seen_time: float = time.time()
        self.last_point: tuple[float, float] = (0.0, 0.0)
        self.last_side_value: float = 0.0
        self.last_count_direction: str | None = None
        self.last_count_time: float = 0.0
        self.rearmed: bool = True
        self.counted_left: bool = False
        self.counted_right: bool = False


# =============================================================================
# Geometry Helpers
# =============================================================================

# Helper function: returns the signed cross product used for line-side calculations.
# To determine which side of the directed line a → b a point lies on using the cross-product sign
# Positive ： p  at line a -> b (upper side)
# Negative ： p  at line a -> b (below side)
# 0：p online
def _cross_product_sign(a, b, p):
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])

# Helper function: uses ray casting to test whether a normalized point lies inside a polygon.
# To determine whether a point lies inside a polygon.
def _point_in_polygon(point, polygon):
    x, y = point
    n = len(polygon)
    inside = False

    j = n - 1
    for i in range(n):
        xi, yi = polygon[i][0], polygon[i][1]
        xj, yj = polygon[j][0], polygon[j][1]

        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i

    return inside

# =============================================================================
# Config Helpers
# =============================================================================

# To extract and normalize valid active-zone polygons from the configuration before counting starts.
# At least 3 point
def _extract_active_zones(config: dict) -> list[dict]:
    """Helper function: normalizes active-zone polygons from config before counting starts."""
    normalized: list[dict] = []
    raw_areas = config.get("active_zones")
    if raw_areas is None:
        raw_areas = config.get("frame_exclude_areas") or []
    for index, area in enumerate(raw_areas):
        points = area.get("points", [])
        if len(points) < 3:
            continue
        normalized.append(
            {
                "id": str(area.get("id") or f"active_zone_{index}"),
                "name": str(area.get("name") or ""),
                "points": points,
            }
        )
    return normalized



# =============================================================================
# Entry Points
# =============================================================================

class PeopleCounter:
    """Stateful line-only people counter for a single camera/view."""

    # ========================================================================
    # Entry Points
    # ========================================================================

    # Core function: initializes one counter instance from camera config before frame updates begin.
    def __init__(self, config: dict):
        self.lines = config.get("lines", [])
        self.active_zones = _extract_active_zones(config)
        self.frame_exclude_areas = self.active_zones
        self.enabled = config.get("enabled", True)

        self._line_track_states: dict[str, dict[int, _LineTrackState]] = {}
        self._foot_traffic_track_states: dict[str, dict[int, _FootTrafficTrackState]] = {}
        self._line_track_frame_totals: dict[int, int] = {}
        self._persistent_birth_points: dict[int, tuple[float, float]] = {}
        self._persistent_birth_in_active_zone: dict[int, bool] = {}
        self._counted_in_tracks: dict[int, _CountedTrackRecord] = {}
        self._counted_out_tracks: dict[int, _CountedTrackRecord] = {}
        self._counted_foot_traffic_tracks: set[int] = set()
        self._foot_traffic_line_counts: dict[str, dict[str, int]] = {}

        self.total_in = 0
        self.total_out = 0
        self.foot_traffic_left = 0
        self.foot_traffic_right = 0

        self.disappear_timeout: float = config.get("disappear_timeout", DEFAULT_DISAPPEAR_TIMEOUT)
        self.count_cooldown: float = config.get("count_cooldown", DEFAULT_COUNT_COOLDOWN)
        self._last_in_count_time: dict[int, float] = {}
        self._last_in_count_points: dict[int, tuple[float, float]] = {}

        self._line_signature = self._build_line_signature(self.lines)
        self._sync_line_track_states()

        self._last_snapshot_time = time.time()
        self._last_snapshot_signature: tuple[int, int, int] | None = None

    # Core function: call once per frame with detections and `(height, width)` to update counts.
    def update(self, detections: list[dict], frame_shape: tuple[int, int]) -> dict:
        if not self.enabled:
            return self._empty_result()

        h, w = frame_shape
        now = time.time()
        self._cleanup_in_cooldown(now)

        track_bboxes: dict[int, list[float]] = {}
        line_tracks_seen_this_update: set[int] = set()
        skipped_missing_bbox = 0
        skipped_missing_track = 0

        for det in detections:
            bbox = det.get("person_bbox")
            if bbox is None:
                skipped_missing_bbox += 1
                continue

            count_anchor = self._bbox_bottom_center_point(bbox, w, h)
            if self.lines:
                display_anchor = self._bbox_line_target_point(bbox, w, h, self.lines[0])
            else:
                display_anchor = count_anchor
            accumulation_anchor = self._bbox_frame_accumulation_point(bbox, w, h)

            det["count_anchor_norm"] = [round(count_anchor[0], 6), round(count_anchor[1], 6)]
            det["count_anchor"] = [round(count_anchor[0] * w), round(count_anchor[1] * h)]
            det["display_anchor_norm"] = [round(display_anchor[0], 6), round(display_anchor[1], 6)]
            det["display_anchor"] = [round(display_anchor[0] * w), round(display_anchor[1] * h)]

            track_id = det.get("track_id")
            if track_id is None:
                skipped_missing_track += 1
                continue

            tid = int(track_id)
            track_bboxes[tid] = bbox

            if tid in line_tracks_seen_this_update:
                continue

            if self._should_accumulate_track_frames(accumulation_anchor):
                self._line_track_frame_totals[tid] = self._line_track_frame_totals.get(tid, 0) + 1
            line_tracks_seen_this_update.add(tid)

        if DEBUG_COUNTING_VERBOSE and (skipped_missing_bbox > 0 or skipped_missing_track > 0):
            print(
                " ".join(
                    [
                        "[COUNT-SKIP]",
                        "event=invalid_detection",
                        f"missing_bbox={skipped_missing_bbox}",
                        f"missing_track_id={skipped_missing_track}",
                    ]
                )
            )

        for line_index, line_cfg in enumerate(self.lines):
            points = line_cfg.get("points", [])
            if len(points) < 2:
                continue

            line_key = self._line_state_key(line_cfg, line_index)
            line_name = line_cfg.get("name") or line_cfg.get("id") or f"line_{line_index + 1}"
            for track_id, bbox in track_bboxes.items():
                target_point = self._bbox_line_target_point(bbox, w, h, line_cfg)
                if self._line_type(line_cfg) == LINE_TYPE_FOOT_TRAFFIC:
                    self._update_foot_traffic_track_state(
                        line_key,
                        line_name,
                        line_cfg,
                        track_id,
                        target_point,
                        now,
                    )
                else:
                    line_delta = self._update_line_track_state(
                        line_key,
                        line_name,
                        line_cfg,
                        track_id,
                        target_point,
                        now,
                    )
                    if self._line_count_event(line_cfg) == LINE_EVENT_IN:
                        self.total_in += line_delta
                    else:
                        self.total_out += line_delta

        line_in, line_out = self._process_line_disappears(set(track_bboxes.keys()), now)
        self.total_in += line_in
        self.total_out += line_out
        self._cleanup_foot_traffic_tracks(set(track_bboxes.keys()), now)

        reverted_in = self._process_count_reversions(set(track_bboxes.keys()))

        occupancy = max(0, self.total_in - self.total_out)

        return {
            "total_in": self.total_in,
            "total_out": self.total_out,
            "occupancy": occupancy,
            "foot_traffic_left": self.foot_traffic_left,
            "foot_traffic_right": self.foot_traffic_right,
            "foot_traffic_total": self.foot_traffic_left + self.foot_traffic_right,
            "foot_traffic_lines": self._build_foot_traffic_summary(),
            "lines": self.lines,
            "active_zones": self.active_zones,
            "frame_exclude_areas": self.frame_exclude_areas,
            "in_reversions": reverted_in,
        }

    # Core helper: tells the caller when current totals should be persisted or emitted again.
    # To decide whether a new snapshot should be saved when counts change or the heartbeat interval is reached.
    def should_snapshot(self, heartbeat_interval: float = 300.0) -> bool:
        now = time.time()
        occupancy = max(0, self.total_in - self.total_out)
        current_signature = (
            int(self.total_in),
            int(self.total_out),
            int(occupancy),
            int(self.foot_traffic_left),
            int(self.foot_traffic_right),
            int(self.foot_traffic_left + self.foot_traffic_right),
        )

        if self._last_snapshot_signature is None:
            self._last_snapshot_signature = current_signature
            self._last_snapshot_time = now
            return True

        if current_signature != self._last_snapshot_signature:
            self._last_snapshot_signature = current_signature
            self._last_snapshot_time = now
            return True

        if now - self._last_snapshot_time >= heartbeat_interval:
            self._last_snapshot_time = now
            return True

        return False

    # Core helper: builds a snapshot payload for storing the current totals of one camera.
    # To build a snapshot record containing the current counting and occupancy data for a camera.
    def get_snapshot_data(self, camera_id: str) -> dict:
        occupancy = max(0, self.total_in - self.total_out)
        return {
            "id": str(uuid.uuid4()),
            "camera_id": camera_id,
            "timestamp": datetime.now(timezone.utc),
            "total_in": self.total_in,
            "total_out": self.total_out,
            "current_occupancy": occupancy,
            "foot_traffic_left": self.foot_traffic_left,
            "foot_traffic_right": self.foot_traffic_right,
            "foot_traffic_total": self.foot_traffic_left + self.foot_traffic_right,
        }

    # Core helper: restores persisted totals after an RTSP runtime restart so counting can resume from the latest snapshot.
    # To restore previously saved counting values and update the snapshot baseline accordingly
    def restore_counts(
        self,
        *,
        total_in: int = 0,
        total_out: int = 0,
        foot_traffic_left: int = 0,
        foot_traffic_right: int = 0,
    ):
        self.total_in = max(0, int(total_in or 0))
        self.total_out = max(0, int(total_out or 0))
        self.foot_traffic_left = max(0, int(foot_traffic_left or 0))
        self.foot_traffic_right = max(0, int(foot_traffic_right or 0))
        occupancy = max(0, self.total_in - self.total_out)
        self._last_snapshot_signature = (
            int(self.total_in),
            int(self.total_out),
            int(occupancy),
            int(self.foot_traffic_left),
            int(self.foot_traffic_right),
            int(self.foot_traffic_left + self.foot_traffic_right),
        )
        self._last_snapshot_time = time.time()

    # Core function: hot-reloads line and zone settings while preserving accumulated counts.
    # o hot-reload the counter configuration while preserving accumulated counts and resetting tracking state only when line settings change
    def update_config(self, config: dict):
        self.lines = config.get("lines", [])
        self.active_zones = _extract_active_zones(config)
        self.frame_exclude_areas = self.active_zones
        self.enabled = config.get("enabled", True)
        self.disappear_timeout = config.get("disappear_timeout", DEFAULT_DISAPPEAR_TIMEOUT)
        self.count_cooldown = config.get("count_cooldown", DEFAULT_COUNT_COOLDOWN)

        new_line_signature = self._build_line_signature(self.lines)
        if new_line_signature != getattr(self, "_line_signature", None):
            self._line_track_states = {}
            self._foot_traffic_track_states = {}
            self._line_signature = new_line_signature
        self._sync_line_track_states()

    # Core function: clears runtime state and totals, typically when restarting or looping video.
    # To fully reset the counter’s tracking and counting state back to a fresh initial state.
    def reset(self):
        self._line_track_states = {}
        self._foot_traffic_track_states = {}
        self._line_track_frame_totals = {}
        self._persistent_birth_points = {}
        self._persistent_birth_in_active_zone = {}
        self._counted_in_tracks = {}
        self._counted_out_tracks = {}
        self._counted_foot_traffic_tracks = set()
        self.total_in = 0
        self.total_out = 0
        self.foot_traffic_left = 0
        self.foot_traffic_right = 0
        self._last_in_count_time = {}
        self._last_in_count_points = {}
        self._sync_line_track_states()

    # ========================================================================
    # Setup
    # ========================================================================


    # Helper function: creates a stable signature so config changes can reset per-line runtime state.
    # To build a comparable signature for the current line configuration so changes can be detected reliably.
    def _build_line_signature(self, lines: list[dict]) -> tuple:
        signature: list[tuple] = []
        for idx, line_cfg in enumerate(lines):
            points = line_cfg.get("points", [])
            normalized_points = tuple(
                (round(float(point[0]), 6), round(float(point[1]), 6))
                for point in points[:2]
            )
            signature.append(
                (
                    str(line_cfg.get("id") or line_cfg.get("name") or f"line_{idx}"),
                    self._line_type(line_cfg),
                    line_cfg.get("direction", "left_to_right"),
                    self._line_count_event(line_cfg),
                    normalized_points,
                )
            )
        return tuple(signature)

    # Helper function: keeps internal state dictionaries aligned with the currently configured lines.
    # To synchronize internal track-state dictionaries so they match only the currently active occupancy and foot-traffic lines.
    def _sync_line_track_states(self):
        active_line_keys = {
            self._line_state_key(line_cfg, idx)
            for idx, line_cfg in enumerate(self.lines)
            if len(line_cfg.get("points", [])) >= 2 and self._line_type(line_cfg) == LINE_TYPE_OCCUPANCY
        }
        active_foot_traffic_keys = {
            self._line_state_key(line_cfg, idx)
            for idx, line_cfg in enumerate(self.lines)
            if len(line_cfg.get("points", [])) >= 2 and self._line_type(line_cfg) == LINE_TYPE_FOOT_TRAFFIC
        }
        self._line_track_states = {
            key: self._line_track_states.get(key, {})
            for key in active_line_keys
        }
        self._foot_traffic_track_states = {
            key: self._foot_traffic_track_states.get(key, {})
            for key in active_foot_traffic_keys
        }
        self._foot_traffic_line_counts = {
            key: self._foot_traffic_line_counts.get(key, {"left": 0, "right": 0})
            for key in active_foot_traffic_keys
        }

    # Helper function: returns the internal dictionary key used to store state for one line.
    # To generate a stable state key for identifying a line’s tracking and counting state.
    def _line_state_key(self, line_cfg: dict, index: int) -> str:
        return str(line_cfg.get("id") or line_cfg.get("name") or f"line_{index}")

    # Helper function: decides whether a track should keep aging for minimum-frame occupancy checks.
    # To determine whether track frames should continue accumulating based on the point’s position relative to active zones.
    def _should_accumulate_track_frames(self, point: tuple[float, float] | None) -> bool:
        if point is None:
            return False
        if not self.active_zones:
            return True
        return not self._is_inside_active_zone(point)

    # Helper function: returns the zeroed payload shape used when counting is disabled.
    def _empty_result(self) -> dict:
        return {
            "total_in": 0,
            "total_out": 0,
            "occupancy": 0,
            "foot_traffic_left": 0,
            "foot_traffic_right": 0,
            "foot_traffic_total": 0,
            "foot_traffic_lines": self._build_foot_traffic_summary(),
            "lines": self.lines,
            "active_zones": self.active_zones,
            "frame_exclude_areas": self.frame_exclude_areas,
        }

    # ========================================================================
    # Occupancy Logic
    # ========================================================================

    # Core helper: updates one occupancy track against one line and returns any new IN or OUT count.
    # Handle：

    ### A line
    ### A track_id
    ### A Track id anchor point right_point

    # Deicde below：

    # update the person on Line state (Single Line)
    # decide count
    # if     count，return 1
    # if not count，return 0
    def _update_line_track_state(
        self,
        line_key: str,# line key to find track state table
        line_name: str,
        line_cfg: dict, # line config like point,direction,line type
        track_id: int,
        right_point: tuple[float, float] | None,
        now: float,
    ) -> int:
        if right_point is None: # if no point direct return
            return 0

        states = self._line_track_states.setdefault(line_key, {}) # get the track state dict
        ts = states.get(track_id) # the ""state of the track id" on this line
        curr_side = self._line_target_side_value(line_cfg, right_point) # calculate which side the point at
        count_event = self._line_count_event(line_cfg) # determine in or out event
        required_frames = self._line_min_track_frames(line_cfg) # min frames
        in_active_zone = self._is_inside_active_zone(right_point) # cuurent point in active zone?
        active_zone_arm_frames = self._out_zone_arm_min_frames(line_cfg) # out line need at least how many frames

        if ts is None: # mean first time see the track
            ts = _LineTrackState()
            ts.last_seen_time = now
            ts.frame_count = self._line_track_frame_totals.get(int(track_id), 0) # bring the frames that the track already acuumulated 
            persistent_birth_point = self._persistent_birth_points.get(int(track_id)) # get the birth point
            persistent_birth_in_active_zone = self._persistent_birth_in_active_zone.get(int(track_id)) # store as birth point in the active zone
            if persistent_birth_point is None:
                persistent_birth_point = right_point
                self._persistent_birth_points[int(track_id)] = persistent_birth_point
                persistent_birth_in_active_zone = bool(in_active_zone)
                self._persistent_birth_in_active_zone[int(track_id)] = persistent_birth_in_active_zone

            # write all value in to state    
            ts.birth_point = persistent_birth_point
            ts.born_in_active_zone = bool(persistent_birth_in_active_zone)
            ts.last_right_point = right_point
            ts.last_in_side_value = curr_side
            ts.last_in_active_zone = in_active_zone


            if count_event == LINE_EVENT_OUT and in_active_zone: # if outline and birth at active zone
                ts.active_zone_streak = 1
                ts.out_zone_armed = active_zone_arm_frames <= 1
            # store the ts state     
            states[track_id] = ts 
            self._log_live_track_frame(
                track_id,
                line_name,
                event="spawn",
                count_event=count_event,
                point=right_point,
                side=curr_side,
                frame_count=ts.frame_count,
                in_active_zone=in_active_zone,
                out_zone_armed=ts.out_zone_armed,
                active_zone_streak=ts.active_zone_streak,
            )
            return 0 # due to first time so never count

        # here mean the ts see before
        
        # previous frame info
        prev_point = ts.last_right_point
        prev_side = ts.last_in_side_value
        prev_in_active_zone = ts.last_in_active_zone
        prev_active_zone_streak = ts.active_zone_streak

        cross_point = self._line_crossing_point(prev_point, right_point, prev_side, curr_side) # count crossing point prev_point -> right_point
        crossing_point_in_active_zone = self._is_inside_active_zone(cross_point or right_point) # and then determine whether this crossing point on active zone?

        # update the latest ts state
        ts.last_seen_time = now
        ts.frame_count = self._line_track_frame_totals.get(int(track_id), ts.frame_count)
        ts.last_right_point = right_point
        ts.last_in_side_value = curr_side
        ts.last_in_active_zone = in_active_zone

        if count_event == LINE_EVENT_OUT and in_active_zone:
            ts.active_zone_streak += 1
            if ts.active_zone_streak >= active_zone_arm_frames: # if reacd threahold set = True
                ts.out_zone_armed = True
        elif count_event == LINE_EVENT_OUT and not in_active_zone:
            ts.active_zone_streak = 0

        self._log_live_track_frame(
            track_id,
            line_name,
            event="visible",
            count_event=count_event,
            point=right_point,
            side=curr_side,
            frame_count=ts.frame_count,
            in_active_zone=in_active_zone,
            out_zone_armed=ts.out_zone_armed,
            active_zone_streak=ts.active_zone_streak,
        )

        if DEBUG_COUNTING_VERBOSE and self._should_debug_track(track_id) and ts.frame_count in {10, 30, 60, 100, 101}:
            print(
                " ".join(
                    [
                        "[LINE-TRACK]",
                        f"track_id={track_id}",
                        f"line={line_name}",
                        f"count_event={count_event.upper()}",
                        f"frames={ts.frame_count}",
                        f"side_state={self._side_label(curr_side)}",
                        f"side_value={curr_side:.4f}",
                        f"in_active_zone={self._bool_label(in_active_zone)}",
                        f"out_zone_armed={self._bool_label(ts.out_zone_armed)}",
                        f"zone_streak={ts.active_zone_streak}",
                        f"point={self._format_point(right_point)}",
                    ]
                )
            )

        max_frames = self._line_max_track_frames(line_cfg)

        # Start Check IN logic
        ### if line is IN AND last point is source side now reach "target side"
        ### So mean cross the IN line
        if count_event == LINE_EVENT_IN and prev_side <= DEFAULT_LINE_SIDE_EPS and curr_side > DEFAULT_LINE_SIDE_EPS:
            direction = "IN"
            if ( ## Another If
                crossing_point_in_active_zone # cross point must at active zone
                and ts.frame_count >= required_frames # must reach min frames
                and (max_frames is None or ts.frame_count <= max_frames) # can not reach max frames
                and self._can_count_in(track_id, now) # must exceed in coldnow time 
            ):
                if self._register_count(track_id, direction, "line_cross", now): ## if all pass Register IN Event first
                    self._last_in_count_points[int(track_id)] = cross_point or right_point ## save last in point (use for OUT event)
                    self._log_count_event(
                        track_id,
                        direction,
                        "line_cross",
                        point=cross_point or right_point,
                        prev_point=prev_point,
                        detail=(
                            f"line={line_name} target={count_event} side={curr_side:.4f} "
                            f"frames={ts.frame_count}"
                        ),
                    )
                    if DEBUG_COUNTING:
                        print(
                            " ".join(
                                [
                                    "[COUNT-DECISION]",
                                    f"track_id={track_id}",
                                    f"line={line_name}",
                                    f"direction={direction}",
                                    "source=line_cross",
                                    "result=counted",
                                    f"frames={ts.frame_count}",
                                    f"cross_point={self._format_point(cross_point or right_point)}",
                                    f"cross_in_active_zone={self._bool_label(crossing_point_in_active_zone)}",
                                ]
                            )
                        )
                    self._log_live_track_frame(
                        track_id,
                        line_name,
                        event="count_out",
                        count_event=count_event,
                        point=right_point,
                        side=curr_side,
                        frame_count=ts.frame_count,
                        in_active_zone=in_active_zone,
                        out_zone_armed=ts.out_zone_armed,
                        active_zone_streak=ts.active_zone_streak,
                    )
                    return 1 ## return count 1
            if DEBUG_COUNTING:
                reasons: list[str] = []
                if not crossing_point_in_active_zone:
                    reasons.append("cross_point_outside_active_zone")
                if ts.frame_count < required_frames:
                    reasons.append(f"frames_below_min({ts.frame_count}<{required_frames})")
                if max_frames is not None and ts.frame_count > max_frames:
                    reasons.append(f"frames_above_max({ts.frame_count}>{max_frames})")
                if not self._can_count_in(track_id, now):
                    reasons.append("in_count_cooldown_active")
                reason = ",".join(reasons) if reasons else "not_eligible"
                print(
                    " ".join(
                        [
                            "[COUNT-DECISION]",
                            f"track_id={track_id}",
                            f"line={line_name}",
                            f"direction={direction}",
                            "source=line_cross",
                            "result=rejected",
                            f"reason={reason}",
                            f"cross_point={self._format_point(cross_point or right_point)}",
                            f"cross_in_active_zone={self._bool_label(crossing_point_in_active_zone)}",
                            f"frames={ts.frame_count}",
                        ]
                    )
                )


        # Start Check OUT logic
        if count_event == LINE_EVENT_OUT:
            counted_in_record = self._counted_in_tracks.get(int(track_id))  ## Find track id previous count IN point
            has_active_in_reference = counted_in_record is not None and not counted_in_record.uncounted ## Whther being uncounted before
            reference_point = None
            reference_source = "none"

            #Decide OUT reference point use which one 
            if has_active_in_reference and ts.born_in_active_zone: # if have count in record AND born in active zone
                reference_point = ts.birth_point
                reference_source = "birth_point"
            elif has_active_in_reference: # if have count in record but not born in active zone
                reference_point = self._last_in_count_points.get(int(track_id))
                reference_source = "last_in_count"
            elif ts.born_in_active_zone: # if have not count in record but born in active zone (Most comon)
                reference_point = ts.birth_point
                reference_source = "birth_point"

            # calculate travel distrance using current point with reference point
            travel_distance = (
                math.dist(reference_point, right_point)
                if reference_point is not None
                else 0.0
            )
            min_travel_distance = self._out_travel_min_distance(line_cfg)


            ### Out event Logic Start here
            if (
                reference_point is not None 
                and curr_side > DEFAULT_LINE_SIDE_EPS ## at out side
                and ts.frame_count >= required_frames
                and travel_distance >= min_travel_distance ## enough distance
            ):
                if self._register_count(track_id, "OUT", "travel_exit", now): # Register OUT event
                    self._last_in_count_points.pop(int(track_id), None) # clear _last_in_count_points
                    self._log_count_event(
                        track_id,
                        "OUT",
                        "travel_exit",
                        point=right_point,
                        prev_point=prev_point,
                        detail=(
                            f"line={line_name} side={curr_side:.4f} "
                            f"travel={travel_distance:.4f} ref={reference_source}"
                        ),
                    )
                    if DEBUG_COUNTING:
                        print(
                            " ".join(
                                [
                                    "[COUNT-DECISION]",
                                    f"track_id={track_id}",
                                    f"line={line_name}",
                                    "direction=OUT",
                                    "source=travel_exit",
                                    "result=counted",
                                    f"frames={ts.frame_count}",
                                    f"travel={travel_distance:.4f}",
                                    f"min_travel={min_travel_distance:.4f}",
                                    f"reference={reference_source}",
                                    f"side_state={self._side_label(curr_side)}",
                                ]
                            )
                        )
                    self._log_live_track_frame(
                        track_id,
                        line_name,
                        event="count_out_travel_exit",
                        count_event=count_event,
                        point=right_point,
                        side=curr_side,
                        frame_count=ts.frame_count,
                        in_active_zone=in_active_zone,
                        out_zone_armed=ts.out_zone_armed,
                        active_zone_streak=ts.active_zone_streak,
                    )
                    return 1  ## sucessful out event return 1
            elif DEBUG_COUNTING and curr_side > DEFAULT_LINE_SIDE_EPS:
                reasons: list[str] = []
                if reference_point is None:
                    reasons.append("no_out_reference_point")
                if ts.frame_count < required_frames:
                    reasons.append(f"frames_below_min({ts.frame_count}<{required_frames})")
                if reference_point is not None and travel_distance < min_travel_distance:
                    reasons.append(f"travel_below_min({travel_distance:.4f}<{min_travel_distance:.4f})")
                if reasons:
                    print(
                        " ".join(
                            [
                                "[COUNT-DECISION]",
                                f"track_id={track_id}",
                                f"line={line_name}",
                                "direction=OUT",
                                "source=travel_exit",
                                "result=rejected",
                                f"reason={','.join(reasons)}",
                                f"reference={reference_source}",
                                f"side_state={self._side_label(curr_side)}",
                            ]
                        )
                    )

        return 0

    # Core helper: handles tracks that vanished and applies disappear-based fallback counting rules.
    def _process_line_disappears(self, active_ids: set[int], now: float) -> tuple[int, int]:
        total_in = 0
        total_out = 0

        for line_index, line_cfg in enumerate(self.lines):
            line_key = self._line_state_key(line_cfg, line_index)
            line_name = line_cfg.get("name") or line_cfg.get("id") or f"line_{line_index + 1}"
            count_event = self._line_count_event(line_cfg)
            required_frames = self._line_min_track_frames(line_cfg)
            states = self._line_track_states.get(line_key, {})
            to_remove: list[int] = []

            for track_id, ts in states.items():
                if track_id in active_ids:
                    continue

                elapsed = now - ts.last_seen_time
                self._log_live_track_frame(
                    track_id,
                    line_name,
                    event="missing",
                    count_event=count_event,
                    point=ts.last_right_point,
                    side=ts.last_in_side_value,
                    frame_count=ts.frame_count,
                    elapsed=elapsed,
                    in_active_zone=self._is_inside_active_zone(ts.last_right_point),
                    out_zone_armed=ts.out_zone_armed,
                    active_zone_streak=ts.active_zone_streak,
                )
                if elapsed < self.disappear_timeout:
                    continue

                in_active_zone = self._is_inside_active_zone(ts.last_right_point)
                counted = False
                if (
                    count_event == LINE_EVENT_IN
                    and in_active_zone
                    and ts.last_in_side_value > DEFAULT_LINE_SIDE_EPS
                    and ts.frame_count >= required_frames
                    and self._can_count_in(track_id, now)
                ):
                    if self._register_count(track_id, "IN", "line_disappear", now):
                        total_in += 1
                        counted = True
                        self._last_in_count_points[int(track_id)] = ts.last_right_point
                        self._log_count_event(
                            track_id,
                            "IN",
                            "line_disappear",
                            point=ts.last_right_point,
                            prev_point=ts.last_right_point,
                            detail=(
                                f"line={line_name} side={ts.last_in_side_value:.4f} "
                                f"frames={ts.frame_count} elapsed={elapsed:.2f}s"
                            ),
                        )

                if DEBUG_COUNTING:
                    if counted:
                        result = "counted"
                        reason = "in_fallback_on_disappear"
                    elif count_event == LINE_EVENT_OUT:
                        result = "rejected"
                        reason = "out_lines_do_not_count_on_disappear"
                    elif not in_active_zone:
                        result = "rejected"
                        reason = "last_point_outside_active_zone"
                    elif ts.last_in_side_value <= DEFAULT_LINE_SIDE_EPS:
                        result = "rejected"
                        reason = "last_side_not_countable"
                    elif ts.frame_count < required_frames:
                        result = "rejected"
                        reason = f"frames_below_min({ts.frame_count}<{required_frames})"
                    elif not self._can_count_in(track_id, now):
                        result = "rejected"
                        reason = "in_count_cooldown_active"
                    else:
                        result = "rejected"
                        reason = "not_eligible"

                    print(
                        " ".join(
                            [
                                "[COUNT-DECISION]",
                                f"track_id={track_id}",
                                f"line={line_name}",
                                f"direction={count_event.upper()}",
                                "source=line_disappear",
                                f"result={result}",
                                f"reason={reason}",
                                f"side_state={self._side_label(ts.last_in_side_value)}",
                                f"side_value={ts.last_in_side_value:.4f}",
                                f"elapsed={elapsed:.2f}s",
                                f"in_active_zone={self._bool_label(in_active_zone)}",
                            ]
                        )
                    )

                to_remove.append(track_id)

            for track_id in to_remove:
                del states[track_id]

        return (total_in, total_out)

    # Core helper: records a finalized count and blocks duplicate events for the same track ID.
    # To register a confirmed IN or OUT count while preventing duplicate same-direction counts and replacing any opposite-direction record when needed.
    # Never update global counter
    def _register_count(self, track_id: int, direction: str, source: str, now: float) -> bool:
        direction = str(direction).upper() ## standalized all line direction become uppercase
        tid = int(track_id)

        # find target direction for counted store (in order to know which direction to store)
        target_tracks = self._get_counted_track_store(direction) 
        opposite_tracks = self._get_counted_track_store("OUT" if direction == "IN" else "IN")

        if tid in target_tracks: # if track id is in target side dont update (prevent duplicate)
            if DEBUG_COUNTING:
                record = target_tracks[tid]
                print(
                    " ".join(
                        [
                            "[COUNT-SKIP]",
                            "event=duplicate_count_attempt",
                            f"track_id={track_id}",
                            f"existing_direction={direction}",
                            f"existing_source={record.source}",
                            f"uncounted={self._bool_label(record.uncounted)}",
                        ]
                    )
                )
            return False

        if opposite_tracks.pop(tid, None) is not None: # if opposite direction have this track id remove it like In delete Out or Out delete In
            self._reset_track_frame_history(tid) # if remve the track id in the opposite direction also remove its accumulated frame
        
        # write the track id (into track record)
        target_tracks[tid] = _CountedTrackRecord( 
            direction=direction,
            source=source,
            count_time=now,
        )


        if direction == "IN":
            self._last_in_count_time[tid] = now ## record the last count in (for reversion and colddown)
            self._reset_track_frame_history(tid) ## reset the frame history
        return True

    # Helper function: checks whether an IN event can pass duplicate and cooldown guards.
    def _can_count_in(self, track_id: int, now: float) -> bool:
        if int(track_id) in self._counted_in_tracks:
            return False
        if self.count_cooldown <= 0:
            return True
        last_ts = self._last_in_count_time.get(track_id)
        if last_ts is None:
            return True
        return (now - last_ts) >= self.count_cooldown

    # Helper function: prunes old cooldown timestamps so the cache does not grow forever.
    def _cleanup_in_cooldown(self, now: float):
        if not self._last_in_count_time:
            return
        keep_for = max(self.count_cooldown, 1.0) * 10.0
        self._last_in_count_time = {
            tid: ts for tid, ts in self._last_in_count_time.items() if (now - ts) < keep_for
        }

    # Core helper: reverses fallback IN counts when a supposedly disappeared track keeps reappearing.
    def _process_count_reversions(self, active_ids: set[int]) -> int:
        reverted_count = 0
        for track_id, record in list(self._counted_in_tracks.items()):
            if track_id in active_ids:
                record.visible_streak_after_count += 1
                if record.visible_streak_after_count > DEFAULT_UNCOUNT_IN_REAPPEAR_FRAMES:
                    self.total_in = max(0, self.total_in - 1)
                    self._counted_in_tracks.pop(int(track_id), None)
                    self._last_in_count_time.pop(int(track_id), None)
                    self._last_in_count_points.pop(int(track_id), None)
                    self._prime_track_frame_history_for_recount(int(track_id))
                    reverted_count += 1
                    print(
                        " ".join(
                            [
                                "[COUNT-DECISION]",
                                f"track_id={track_id}",
                                "direction=IN",
                                f"source={record.source}",
                                "result=uncounted",
                                (
                                    "reason="
                                    f"reappeared_visible_over_{DEFAULT_UNCOUNT_IN_REAPPEAR_FRAMES}_frames"
                                ),
                            ]
                        )
                    )
            else:
                record.visible_streak_after_count = 0
        return reverted_count

    # Helper function: returns the internal count store for either IN or OUT track memory.
    def _get_counted_track_store(self, direction: str) -> dict[int, _CountedTrackRecord]:
        if str(direction).upper() == "OUT":
            return self._counted_out_tracks
        return self._counted_in_tracks

    # Helper function: clears accumulated frame-age data for one track after a finalized count.
    def _reset_track_frame_history(self, track_id: int):
        tid = int(track_id)
        self._line_track_frame_totals.pop(tid, None)
        for states in self._line_track_states.values():
            ts = states.get(tid)
            if ts is not None:
                ts.frame_count = 0

    # Helper function: primes a track with enough visible-frame history so an
    # uncounted track can trigger a fresh IN event on the next valid crossing.
    def _prime_track_frame_history_for_recount(self, track_id: int):
        tid = int(track_id)
        minimum_frames = max(0, int(DEFAULT_LINE_IN_MIN_TRACK_FRAMES))
        self._line_track_frame_totals[tid] = max(
            int(self._line_track_frame_totals.get(tid, 0) or 0),
            minimum_frames,
        )
        for states in self._line_track_states.values():
            ts = states.get(tid)
            if ts is not None:
                ts.frame_count = max(int(ts.frame_count or 0), minimum_frames)

    # ========================================================================
    # Foot Traffic Logic
    # ========================================================================
    # Handle：

    ### A line
    ### A track_id
    ### A Track id target point

    # Deicde below：

    # update the person on Line state (Single Line)
    # decide count
    # if     count，return 1
    # if not count，return 0
    # Core helper: updates one foot-traffic track and records a directional crossing when eligible.
    ##### why dont need return???? 
    def _update_foot_traffic_track_state(
        self,
        line_key: str,
        line_name: str,
        line_cfg: dict,
        track_id: int,
        target_point: tuple[float, float] | None,
        now: float,
    ) -> None:
        if target_point is None:
            return

        states = self._foot_traffic_track_states.setdefault(line_key, {}) # get the track state dict
        ts = states.get(track_id) # the state of track id on this line
        curr_side = self._line_target_side_value(line_cfg, target_point) # # calculate which side the point at
        in_active_zone = self._is_inside_active_zone(target_point) ## only for log info (traffic not use active zone)

        if ts is None: # mean first time see the track
            ts = _FootTrafficTrackState()
            ts.last_seen_time = now
            ts.last_point = target_point
            ts.last_side_value = curr_side
            states[track_id] = ts
            self._log_live_track_frame(
                track_id,
                line_name,
                event="spawn",
                count_event="foot",
                point=target_point,
                side=curr_side,
                frame_count=0,
                in_active_zone=in_active_zone,
            )
            return

        # here mean the ts see before

        # previous frame info
        prev_point = ts.last_point
        prev_side = ts.last_side_value

        cross_point = self._line_crossing_point(prev_point, target_point, prev_side, curr_side) # count crossing point prev_point -> right_point
        crosses_segment = self._foot_traffic_crosses_segment(line_cfg, cross_point) ### check wehter on the line only
        traffic_direction = self._foot_traffic_direction( ## check the direction LEFT or RIGHT or NONE
            prev_point=prev_point,
            curr_point=target_point,
            line_cfg=line_cfg,
            prev_side=prev_side,
            curr_side=curr_side,
        )

        #Update current track id state
        ts.last_seen_time = now
        ts.last_point = target_point
        ts.last_side_value = curr_side

        if not ts.rearmed and abs(curr_side) >= self._foot_traffic_rearm_side_eps(line_cfg):
            ts.rearmed = True

        self._log_live_track_frame(
            track_id,
            line_name,
            event="visible",
            count_event="foot",
            point=target_point,
            side=curr_side,
            frame_count=0,
            in_active_zone=in_active_zone,
        )

        direction_already_counted = (                                             # check if left/right side count before or not
            ts.counted_right if traffic_direction == "right" else ts.counted_left
        ) if traffic_direction else False

        track_already_counted = int(track_id) in self._counted_foot_traffic_tracks # checkk this track id record in foot traffic set before?
        allowed_direction = self._foot_traffic_allowed_direction(line_cfg) # get the foot traffic line direction

        #### foot traffic counting Logic
        if (
            traffic_direction # must have direction left or right
            and crosses_segment # muust cross the line
            and (allowed_direction is None or traffic_direction == allowed_direction) # must fulfill the line direction
            and not track_already_counted ## must not count before 
            and not direction_already_counted ## must not count before in same direction
            and traffic_direction != ts.last_count_direction ## must not same direction with last time
            and ts.rearmed ## must be rearmed
            and self._foot_traffic_cooldown_elapsed(ts, now, line_cfg) ## must more than coldown time
        ):
            
            self._register_foot_traffic_count(line_key, traffic_direction, line_cfg, track_id) # if all fulfill register count event

            # upldate track id latest state
            ts.last_count_direction = traffic_direction
            ts.last_count_time = now
            ts.rearmed = False

            if traffic_direction == "right":
                ts.counted_right = True
            else:
                ts.counted_left = True

            ## Log only
            self._log_count_event(
                track_id,
                traffic_direction.upper(),
                "foot_traffic_cross",
                point=cross_point or target_point,
                prev_point=prev_point,
                detail=f"line={line_name}",
            )
            self._log_live_track_frame(
                track_id,
                line_name,
                event=f"count_{traffic_direction}",
                count_event="foot",
                point=target_point,
                side=curr_side,
                frame_count=0,
                in_active_zone=in_active_zone,
            )

    # Helper function: removes expired foot-traffic track state after tracks stop appearing.
    def _cleanup_foot_traffic_tracks(self, active_ids: set[int], now: float) -> None:
        for line_key, states in self._foot_traffic_track_states.items():
            to_remove: list[int] = []
            for track_id, ts in states.items():
                if track_id in active_ids:
                    continue
                if (now - ts.last_seen_time) < self.disappear_timeout:
                    continue
                to_remove.append(track_id)

            for track_id in to_remove:
                del states[track_id]

    # Helper function: formats per-line foot-traffic totals for the result payload returned to callers.
    def _build_foot_traffic_summary(self) -> list[dict]:
        summaries: list[dict] = []
        for line_index, line_cfg in enumerate(self.lines):
            if self._line_type(line_cfg) != LINE_TYPE_FOOT_TRAFFIC:
                continue
            line_key = self._line_state_key(line_cfg, line_index)
            counts = self._foot_traffic_line_counts.get(line_key, {"left": 0, "right": 0})
            left = int(counts.get("left", 0) or 0)
            right = int(counts.get("right", 0) or 0)
            negative_label, positive_label = self._foot_traffic_labels(line_cfg)
            summaries.append(
                {
                    "id": line_key,
                    "name": line_cfg.get("name") or line_key,
                    "left": left,
                    "right": right,
                    "negative_label": negative_label,
                    "positive_label": positive_label,
                    "total": left + right,
                }
            )
        return summaries

    # Core helper: increments foot-traffic totals once a valid directional crossing is confirmed.
    ## To record a confirmed foot-traffic count by updating 
    # the line-level direction totals, (1)
    # the overall foot-traffic totals, (2)
    # and the counted-track set (3)
    def _register_foot_traffic_count(self, line_key: str, direction: str, line_cfg: dict, track_id: int) -> None:
        counts = self._foot_traffic_line_counts.setdefault(line_key, {"left": 0, "right": 0})  ## locate this line count record IF dont have create a new one
        normalized_direction = self._foot_traffic_bucket_direction(direction, line_cfg) ## normalized the count direction (based on line config)
        counts[normalized_direction] = int(counts.get(normalized_direction, 0) or 0) + 1 ## update left/right count for this "line" + 1
        self._counted_foot_traffic_tracks.add(int(track_id)) ## mark this track id is counted 
        
        ## here is update global foot traffic count
        if normalized_direction == "right":
            self.foot_traffic_right += 1
        else:
            self.foot_traffic_left += 1

    # Helper function: maps raw movement direction into the summary bucket expected by the UI.
    def _foot_traffic_bucket_direction(self, direction: str, line_cfg: dict) -> str:
        normalized = str(direction).lower()
        negative_label, positive_label = self._foot_traffic_labels(line_cfg)

        # Vertical-style FT lines report left/right motion, but the user wants
        # the inside-facing FT side to contribute to the opposite summary bucket.
        if (negative_label, positive_label) == ("left", "right"):
            return "left" if normalized == "right" else "right"

        # Horizontal-style FT lines keep the original bucket expectation:
        # down contributes to the right total, up contributes to the left total.
        return "right" if normalized == "down" else "left"

    # Helper function: checks whether a foot-traffic track has waited long enough to count again.
    def _foot_traffic_cooldown_elapsed(
        self,
        ts: _FootTrafficTrackState,
        now: float,
        line_cfg: dict,
    ) -> bool:
        cooldown = self._foot_traffic_recount_cooldown(line_cfg)
        if cooldown <= 0:
            return True
        if ts.last_count_time <= 0:
            return True
        return (now - ts.last_count_time) >= cooldown

    # Helper function: infers movement direction when a track crosses a foot-traffic line.
    def _foot_traffic_direction(
        self,
        *,
        prev_point: tuple[float, float],
        curr_point: tuple[float, float],
        line_cfg: dict,
        prev_side: float,
        curr_side: float,
    ) -> str | None:
        crossed_forward = prev_side <= DEFAULT_LINE_SIDE_EPS and curr_side > DEFAULT_LINE_SIDE_EPS
        crossed_backward = prev_side >= -DEFAULT_LINE_SIDE_EPS and curr_side < -DEFAULT_LINE_SIDE_EPS
        if not crossed_forward and not crossed_backward:
            return None

        negative_label, positive_label = self._foot_traffic_labels(line_cfg)
        if (negative_label, positive_label) == ("left", "right"):
            horizontal_delta = float(curr_point[0]) - float(prev_point[0])
            if horizontal_delta > DEFAULT_LINE_SIDE_EPS:
                return "right"
            if horizontal_delta < -DEFAULT_LINE_SIDE_EPS:
                return "left"
        else:
            vertical_delta = float(curr_point[1]) - float(prev_point[1])
            if vertical_delta > DEFAULT_LINE_SIDE_EPS:
                return "down"
            if vertical_delta < -DEFAULT_LINE_SIDE_EPS:
                return "up"

        if crossed_forward:
            return negative_label if line_cfg.get("direction", "left_to_right") == "left_to_right" else positive_label
        if crossed_backward:
            return positive_label if line_cfg.get("direction", "left_to_right") == "left_to_right" else negative_label
        return None

    # Helper function: ensures the computed crossing actually lands on the configured line segment.
    def _foot_traffic_crosses_segment(
        self,
        line_cfg: dict,
        cross_point: tuple[float, float] | None,
    ) -> bool:
        if cross_point is None:
            return False
        points = line_cfg.get("points", [])
        if len(points) < 2:
            return False
        start = (float(points[0][0]), float(points[0][1]))
        end = (float(points[1][0]), float(points[1][1]))
        return self._point_projects_onto_segment(
            point=cross_point,
            seg_start=start,
            seg_end=end,
            endpoint_tol=DEFAULT_FOOT_TRAFFIC_SEGMENT_ENDPOINT_TOL,
        )

    # ========================================================================
    # Geometry Helpers
    # ========================================================================

    # Helper function: checks whether a normalized point is inside any configured active zone.
    def _is_inside_active_zone(self, point: tuple[float, float] | None) -> bool:
        if point is None:
            return False
        if not self.active_zones:
            return True
        for area in self.active_zones:
            polygon = area.get("points", [])
            if len(polygon) >= 3 and _point_in_polygon(point, polygon):
                return True
        return False

    # Helper function: interpolates the approximate point where a track crossed a counting line.
    def _line_crossing_point(
        self,
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

    # Helper function: checks whether a point projection falls within a line segment and endpoint tolerance.
    def _point_projects_onto_segment(
        self,
        *,
        point: tuple[float, float],
        seg_start: tuple[float, float],
        seg_end: tuple[float, float],
        endpoint_tol: float = 0.0,
    ) -> bool:
        seg_dx = seg_end[0] - seg_start[0]
        seg_dy = seg_end[1] - seg_start[1]
        seg_len_sq = (seg_dx * seg_dx) + (seg_dy * seg_dy)
        if seg_len_sq <= 1e-12:
            return False

        proj = (
            ((point[0] - seg_start[0]) * seg_dx) +
            ((point[1] - seg_start[1]) * seg_dy)
        ) / seg_len_sq
        tol_ratio = max(0.0, endpoint_tol / max(math.sqrt(seg_len_sq), 1e-9))
        return (-tol_ratio) <= proj <= (1.0 + tol_ratio)

    # Helper function: returns the normalized bottom-center anchor used by foot-traffic counting.
    def _bbox_bottom_center_point(self, bbox: list[float], frame_w: int, frame_h: int) -> tuple[float, float]:
        x1, y1, x2, y2 = bbox
        cx = ((x1 + x2) / 2.0) / frame_w
        cy = (y1 + ((y2 - y1) * 0.95)) / frame_h
        return (cx, cy)

    # Helper function: returns the normalized right-bottom anchor used by standard occupancy IN lines.
    def _bbox_line_right_point(self, bbox: list[float], frame_w: int, frame_h: int) -> tuple[float, float]:
        _, _, x2, y2 = bbox
        right_x = x2 / frame_w
        bottom_y = y2 / frame_h
        return (right_x, bottom_y)

    # Helper function: returns the normalized right-side mid-lower anchor used by occupancy OUT logic.
    def _bbox_line_right_midlower_point(self, bbox: list[float], frame_w: int, frame_h: int) -> tuple[float, float]:
        _, y1, x2, y2 = bbox
        right_x = x2 / frame_w
        midlower_y = (y1 + ((y2 - y1) * 0.75)) / frame_h
        return (right_x, midlower_y)

    # Helper function: chooses the correct bbox anchor for the current line type and count event.
    def _bbox_line_target_point(
        self,
        bbox: list[float],
        frame_w: int,
        frame_h: int,
        line_cfg: dict,
    ) -> tuple[float, float]:
        if self._line_type(line_cfg) == LINE_TYPE_FOOT_TRAFFIC:
            return self._bbox_bottom_center_point(bbox, frame_w, frame_h)
        return self._bbox_line_right_midlower_point(bbox, frame_w, frame_h)

    # Helper function: chooses the anchor used to accumulate visible-frame totals for a track.
    def _bbox_frame_accumulation_point(
        self,
        bbox: list[float],
        frame_w: int,
        frame_h: int,
    ) -> tuple[float, float]:
        occupancy_lines = [
            line_cfg
            for line_cfg in self.lines
            if self._line_type(line_cfg) == LINE_TYPE_OCCUPANCY and len(line_cfg.get("points", [])) >= 2
        ]
        if occupancy_lines:
            return self._bbox_line_target_point(bbox, frame_w, frame_h, occupancy_lines[0])
        return self._bbox_line_right_point(bbox, frame_w, frame_h)

    # Helper function: computes which side of a line a point is on for crossing and direction checks.
    def _line_target_side_value(self, line_cfg: dict, point: tuple[float, float]) -> float:
        points = line_cfg.get("points", [])
        if len(points) < 2:
            return 0.0
        lp1 = (points[0][0], points[0][1])
        lp2 = (points[1][0], points[1][1])
        line_len = max(math.dist(lp1, lp2), 1e-9)
        side_value = _cross_product_sign(lp1, lp2, point) / line_len
        if line_cfg.get("direction", "left_to_right") == "left_to_right":
            return side_value
        return -side_value

    # ========================================================================
    # Config Helpers
    # ========================================================================

    # Helper function: normalizes each line config into either occupancy or foot-traffic mode.
    def _line_type(self, line_cfg: dict) -> str:
        raw_value = str(
            line_cfg.get("line_type")
            or line_cfg.get("metric")
            or line_cfg.get("purpose")
            or LINE_TYPE_OCCUPANCY
        ).strip().lower()
        if raw_value == LINE_TYPE_FOOT_TRAFFIC:
            return LINE_TYPE_FOOT_TRAFFIC
        return LINE_TYPE_OCCUPANCY

    # Helper function: reads the rearm threshold used before a foot-traffic track can count again.
    def _foot_traffic_rearm_side_eps(self, line_cfg: dict) -> float:
        return max(
            DEFAULT_LINE_SIDE_EPS,
            float(
                line_cfg.get(
                    "foot_traffic_rearm_side_eps",
                    DEFAULT_FOOT_TRAFFIC_REARM_SIDE_EPS,
                )
                or DEFAULT_FOOT_TRAFFIC_REARM_SIDE_EPS
            ),
        )

    # Helper function: reads the minimum delay between repeated foot-traffic counts for one track.
    def _foot_traffic_recount_cooldown(self, line_cfg: dict) -> float:
        return max(
            0.0,
            float(
                line_cfg.get(
                    "foot_traffic_recount_cooldown",
                    DEFAULT_FOOT_TRAFFIC_RECOUNT_COOLDOWN,
                )
                or DEFAULT_FOOT_TRAFFIC_RECOUNT_COOLDOWN
            ),
        )

    # Helper function: derives human-readable direction labels from the line orientation.
    def _foot_traffic_labels(self, line_cfg: dict) -> tuple[str, str]:
        points = line_cfg.get("points", [])
        if len(points) >= 2:
            dx = float(points[1][0]) - float(points[0][0])
            dy = float(points[1][1]) - float(points[0][1])
            if abs(dy) >= abs(dx):
                return ("left", "right")
        return ("down", "up")

    # Helper function: converts configured line direction into the only allowed foot-traffic movement.
    def _foot_traffic_allowed_direction(self, line_cfg: dict) -> str | None:
        configured_direction = str(line_cfg.get("direction") or "").strip().lower()
        if configured_direction not in {"left_to_right", "right_to_left"}:
            return None

        negative_label, positive_label = self._foot_traffic_labels(line_cfg)
        if (negative_label, positive_label) == ("left", "right"):
            return "left" if configured_direction == "left_to_right" else "right"

        return "down" if configured_direction == "left_to_right" else "up"

    # Helper function: normalizes the configured event type so line logic can treat it consistently.
    def _line_count_event(self, line_cfg: dict) -> str:
        return LINE_EVENT_OUT if line_cfg.get("count_event") == LINE_EVENT_OUT else LINE_EVENT_IN

    # Helper function: returns the minimum visible-frame requirement before a line event can count.
    def _line_min_track_frames(self, line_cfg: dict) -> int:
        if self._line_count_event(line_cfg) == LINE_EVENT_OUT:
            return DEFAULT_LINE_OUT_MIN_TRACK_FRAMES
        return DEFAULT_LINE_IN_MIN_TRACK_FRAMES

    # Helper function: returns the optional maximum frame-age allowed for the current line event.
    def _line_max_track_frames(self, line_cfg: dict) -> int | None:
        if self._line_count_event(line_cfg) == LINE_EVENT_OUT:
            return DEFAULT_LINE_OUT_MAX_TRACK_FRAMES
        return None

    # Helper function: returns how long an OUT track must stay in-zone before disappear logic is armed.
    def _out_zone_arm_min_frames(self, line_cfg: dict) -> int:
        if self._line_count_event(line_cfg) == LINE_EVENT_OUT:
            return max(1, int(line_cfg.get("out_zone_arm_frames", DEFAULT_OUT_ZONE_ARM_MIN_FRAMES) or DEFAULT_OUT_ZONE_ARM_MIN_FRAMES))
        return 1

    # Helper function: reads the minimum travel distance required before a travel-exit OUT count is allowed.
    def _out_travel_min_distance(self, line_cfg: dict) -> float:
        return max(
            0.0,
            float(
                line_cfg.get(
                    "out_travel_min_distance",
                    DEFAULT_OUT_TRAVEL_MIN_DISTANCE,
                )
                or DEFAULT_OUT_TRAVEL_MIN_DISTANCE
            ),
        )

    # ========================================================================
    # Debug Helpers
    # ========================================================================

    # Helper function: formats a normalized point for debug logging output.
    def _format_point(self, point: tuple[float, float] | None) -> str:
        if point is None:
            return "n/a"
        return f"({point[0]:.3f},{point[1]:.3f})"

    # Helper function: converts booleans into short debug-friendly yes/no labels.
    def _bool_label(self, value: bool) -> str:
        return "yes" if bool(value) else "no"

    # Helper function: turns a signed side value into a readable line-side label for logs.
    def _side_label(self, side: float) -> str:
        if side > DEFAULT_LINE_SIDE_EPS:
            return "target"
        if side < -DEFAULT_LINE_SIDE_EPS:
            return "source"
        return "on_line"

    # Helper function: filters verbose debug logging to the configured track or all tracks.
    def _should_debug_track(self, track_id: int) -> bool:
        if not DEBUG_COUNTING:
            return False
        if DEBUG_COUNTING_TRACK_ID is None:
            return True
        return int(track_id) == DEBUG_COUNTING_TRACK_ID

    # Helper function: prints per-frame line-state diagnostics when verbose debugging is enabled.
    def _log_live_track_frame(
        self,
        track_id: int,
        line_name: str,
        *,
        event: str,
        count_event: str,
        point: tuple[float, float] | None,
        side: float,
        frame_count: int,
        elapsed: float | None = None,
        in_active_zone: bool | None = None,
        out_zone_armed: bool | None = None,
        active_zone_streak: int | None = None,
    ):
        if not DEBUG_COUNTING_VERBOSE:
            return
        if not self._should_debug_track(track_id):
            return
        parts = [
            "[LINE-LIVE]",
            f"track_id={track_id}",
            f"line={line_name}",
            f"count_event={count_event.upper()}",
            f"event={event}",
            f"frames={frame_count}",
            f"side_state={self._side_label(side)}",
            f"side={side:.4f}",
            f"point={self._format_point(point)}",
        ]
        if in_active_zone is not None:
            parts.append(f"in_active_zone={self._bool_label(in_active_zone)}")
        if out_zone_armed is not None:
            parts.append(f"out_zone_armed={self._bool_label(out_zone_armed)}")
        if active_zone_streak is not None:
            parts.append(f"zone_streak={active_zone_streak}")
        if elapsed is not None:
            parts.append(f"elapsed={elapsed:.2f}s")
        print(" ".join(parts))

    # Helper function: prints a compact log entry whenever the service accepts a count event.
    def _log_count_event(
        self,
        track_id: int,
        direction: str,
        source: str,
        point: tuple[float, float] | None = None,
        prev_point: tuple[float, float] | None = None,
        detail: str | None = None,
    ):
        parts = [
            "[Count]",
            f"dir={direction}",
            f"track_id={track_id}",
            f"source={source}",
        ]
        if detail:
            parts.append(detail)
        if prev_point is not None:
            parts.append(f"prev={self._format_point(prev_point)}")
        if point is not None:
            parts.append(f"point={self._format_point(point)}")
        print(" ".join(parts))
