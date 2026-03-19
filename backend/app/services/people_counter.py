"""
People Counting Service

Line-based people counting with optional active counting zones.

Supports:
1. Door/occupancy counting with OUT line crosses and IN-on-disappear logic.
2. Foot-traffic counting with directional line-cross totals (left/right).
3. Optional polygons that gate count events. A crossing/disappear event only
   counts when its probe point is inside the configured active zone.

All coordinates are stored in normalized (0-1) form.
"""

import math
import os
import time
import uuid
from datetime import datetime, timezone


# DEBUG_COUNTING = os.getenv("DEBUG_COUNTING", "").strip().lower() in {"1", "true", "yes", "on"}
DEBUG_COUNTING = False
DEBUG_COUNTING_VERBOSE = os.getenv("DEBUG_COUNTING_VERBOSE", "").strip().lower() in {"1", "true", "yes", "on"}
_DEBUG_COUNTING_TRACK_ID_RAW = os.getenv("DEBUG_COUNTING_TRACK_ID", "").strip()
try:
    DEBUG_COUNTING_TRACK_ID = int(_DEBUG_COUNTING_TRACK_ID_RAW) if _DEBUG_COUNTING_TRACK_ID_RAW else None
except ValueError:
    DEBUG_COUNTING_TRACK_ID = None


LINE_EVENT_IN = "in"
LINE_EVENT_OUT = "out"
LINE_TYPE_OCCUPANCY = "occupancy"
LINE_TYPE_FOOT_TRAFFIC = "foot_traffic"


DEFAULT_DISAPPEAR_TIMEOUT = 0
#time cooldown for a track id to trigger again the in count
DEFAULT_COUNT_COOLDOWN = 4.0
DEFAULT_LINE_SIDE_EPS = 0.002 #line tolerance
DEFAULT_FOOT_TRAFFIC_REARM_SIDE_EPS = 0.015
DEFAULT_FOOT_TRAFFIC_RECOUNT_COOLDOWN = 0.75
DEFAULT_LINE_IN_MIN_TRACK_FRAMES = 10

# frame_count >= DEFAULT_LINE_OUT_MIN_TRACK_FRAMES and frame_count <= DEFAULT_LINE_OUT_MAX_TRACK_FRAMES
DEFAULT_LINE_OUT_MIN_TRACK_FRAMES = 0
DEFAULT_LINE_OUT_MAX_TRACK_FRAMES = 10
DEFAULT_OUT_ZONE_ARM_MIN_FRAMES = 5
DEFAULT_UNCOUNT_IN_REAPPEAR_FRAMES = 20 # reverse count frames


class _LineTrackState:
    """Tracks lifetime and final line side for line counting."""

    __slots__ = (
        "last_seen_time",
        "frame_count",
        "last_right_point",
        "last_in_side_value",
        "last_in_active_zone",
        "active_zone_streak",
        "out_zone_armed",
    )

    def __init__(self):
        self.last_seen_time: float = time.time()
        self.frame_count: int = 0
        self.last_right_point: tuple[float, float] = (0.0, 0.0)
        self.last_in_side_value: float = 0.0
        self.last_in_active_zone: bool = False
        self.active_zone_streak: int = 0
        self.out_zone_armed: bool = False


class _CountedTrackRecord:
    """Permanent count memory for one numeric track ID."""

    __slots__ = ("direction", "source", "count_time", "visible_streak_after_count", "uncounted")

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

    def __init__(self):
        self.last_seen_time: float = time.time()
        self.last_point: tuple[float, float] = (0.0, 0.0)
        self.last_side_value: float = 0.0
        self.last_count_direction: str | None = None
        self.last_count_time: float = 0.0
        self.rearmed: bool = True
        self.counted_left: bool = False
        self.counted_right: bool = False


def _extract_active_zones(config: dict) -> list[dict]:
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


# counter = PeopleCounter(config)
class PeopleCounter:
    """Stateful line-only people counter for a single camera/view."""

   
    def __init__(self, config: dict):
         # 1 read config
        self.lines = config.get("lines", [])
        self.active_zones = _extract_active_zones(config)
        self.frame_exclude_areas = self.active_zones
        self.enabled = config.get("enabled", True)

        # init all the variable
        self._line_track_states: dict[str, dict[int, _LineTrackState]] = {}
        self._foot_traffic_track_states: dict[str, dict[int, _FootTrafficTrackState]] = {}
        self._line_track_frame_totals: dict[int, int] = {}
        self._counted_in_tracks: dict[int, _CountedTrackRecord] = {}
        self._counted_out_tracks: dict[int, _CountedTrackRecord] = {}
        self._foot_traffic_line_counts: dict[str, dict[str, int]] = {}

        self.total_in = 0
        self.total_out = 0
        self.foot_traffic_left = 0
        self.foot_traffic_right = 0

        self.disappear_timeout: float = config.get("disappear_timeout", DEFAULT_DISAPPEAR_TIMEOUT)
        self.count_cooldown: float = config.get("count_cooldown", DEFAULT_COUNT_COOLDOWN)
        self._last_in_count_time: dict[int, float] = {}

        self._line_signature = self._build_line_signature(self.lines)
        self._sync_line_track_states()

        self._last_snapshot_time = time.time()
        self._last_snapshot_signature: tuple[int, int, int] | None = None

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

            if self._should_accumulate_track_frames(count_anchor):
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
                    self.total_out += self._update_line_track_state(
                        line_key,
                        line_name,
                        line_cfg,
                        track_id,
                        target_point,
                        now,
                    )

        line_in, line_out = self._process_line_disappears(set(track_bboxes.keys()), now)
        self.total_in += line_in
        self.total_out += line_out
        self._cleanup_foot_traffic_tracks(set(track_bboxes.keys()), now)

        self._process_count_reversions(set(track_bboxes.keys()))

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
        }

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

    def update_config(self, config: dict):
        """Hot-reload config without resetting counts."""
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

    def reset(self):
        """Reset all counters (e.g. on video loop)."""
        self._line_track_states = {}
        self._foot_traffic_track_states = {}
        self._line_track_frame_totals = {}
        self._counted_in_tracks = {}
        self._counted_out_tracks = {}
        self.total_in = 0
        self.total_out = 0
        self.foot_traffic_left = 0
        self.foot_traffic_right = 0
        self._last_in_count_time = {}
        self._sync_line_track_states()

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

    def _line_state_key(self, line_cfg: dict, index: int) -> str:
        return str(line_cfg.get("id") or line_cfg.get("name") or f"line_{index}")

    def _update_line_track_state(
        self,
        line_key: str,
        line_name: str,
        line_cfg: dict,
        track_id: int,
        right_point: tuple[float, float] | None,
        now: float,
    ) -> int:
        if right_point is None:
            return 0

        states = self._line_track_states.setdefault(line_key, {})
        ts = states.get(track_id)
        curr_side = self._line_target_side_value(line_cfg, right_point)
        count_event = self._line_count_event(line_cfg)
        required_frames = self._line_min_track_frames(line_cfg)
        in_active_zone = self._is_inside_active_zone(right_point)
        active_zone_arm_frames = self._out_zone_arm_min_frames(line_cfg)

        if ts is None:
            ts = _LineTrackState()
            ts.last_seen_time = now
            ts.frame_count = self._line_track_frame_totals.get(int(track_id), 0)
            ts.last_right_point = right_point
            ts.last_in_side_value = curr_side
            ts.last_in_active_zone = in_active_zone
            if count_event == LINE_EVENT_OUT and in_active_zone:
                ts.active_zone_streak = 1
                ts.out_zone_armed = active_zone_arm_frames <= 1
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
            return 0

        prev_point = ts.last_right_point
        prev_side = ts.last_in_side_value
        prev_in_active_zone = ts.last_in_active_zone
        prev_active_zone_streak = ts.active_zone_streak
        cross_point = self._line_crossing_point(prev_point, right_point, prev_side, curr_side)
        crossing_point_in_active_zone = self._is_inside_active_zone(cross_point or right_point)

        ts.last_seen_time = now
        ts.frame_count = self._line_track_frame_totals.get(int(track_id), ts.frame_count)
        ts.last_right_point = right_point
        ts.last_in_side_value = curr_side
        ts.last_in_active_zone = in_active_zone
        if count_event == LINE_EVENT_OUT and in_active_zone:
            ts.active_zone_streak += 1
            if ts.active_zone_streak >= active_zone_arm_frames:
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
        if (
            count_event == LINE_EVENT_OUT
            and prev_side <= DEFAULT_LINE_SIDE_EPS
            and curr_side > DEFAULT_LINE_SIDE_EPS
        ):
            if (
                crossing_point_in_active_zone
                and ts.frame_count >= required_frames
                and (max_frames is None or ts.frame_count <= max_frames)
            ):
                if self._register_count(track_id, "OUT", "line_cross", now):
                    self._log_count_event(
                        track_id,
                        "OUT",
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
                                    "direction=OUT",
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
                    return 1
            if DEBUG_COUNTING:
                reasons: list[str] = []
                if not crossing_point_in_active_zone:
                    reasons.append("cross_point_outside_active_zone")
                if ts.frame_count < required_frames:
                    reasons.append(f"frames_below_min({ts.frame_count}<{required_frames})")
                if max_frames is not None and ts.frame_count > max_frames:
                    reasons.append(f"frames_above_max({ts.frame_count}>{max_frames})")
                reason = ",".join(reasons) if reasons else "not_eligible"
                print(
                    " ".join(
                        [
                            "[COUNT-DECISION]",
                            f"track_id={track_id}",
                            f"line={line_name}",
                            "direction=OUT",
                            "source=line_cross",
                            "result=rejected",
                            f"reason={reason}",
                            f"cross_point={self._format_point(cross_point or right_point)}",
                            f"cross_in_active_zone={self._bool_label(crossing_point_in_active_zone)}",
                            f"frames={ts.frame_count}",
                        ]
                    )
                )

        if (
            count_event == LINE_EVENT_OUT
            and ts.out_zone_armed
            and prev_in_active_zone
            and not in_active_zone
            and curr_side > DEFAULT_LINE_SIDE_EPS
            and ts.frame_count >= required_frames
            and (max_frames is None or ts.frame_count <= max_frames)
        ):
            if self._register_count(track_id, "OUT", "zone_exit", now):
                self._log_count_event(
                    track_id,
                    "OUT",
                    "zone_exit",
                    point=right_point,
                    prev_point=prev_point,
                    detail=(
                        f"line={line_name} side={curr_side:.4f} "
                        f"zone_streak={prev_active_zone_streak}"
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
                                "source=zone_exit",
                                "result=counted",
                                f"frames={ts.frame_count}",
                                f"zone_streak={prev_active_zone_streak}",
                                f"side_state={self._side_label(curr_side)}",
                            ]
                        )
                    )
                self._log_live_track_frame(
                    track_id,
                    line_name,
                    event="count_out_zone_exit",
                    count_event=count_event,
                    point=right_point,
                    side=curr_side,
                    frame_count=ts.frame_count,
                    in_active_zone=in_active_zone,
                    out_zone_armed=ts.out_zone_armed,
                    active_zone_streak=ts.active_zone_streak,
                )
                return 1
        elif (
            DEBUG_COUNTING
            and count_event == LINE_EVENT_OUT
            and prev_in_active_zone
            and not in_active_zone
            and curr_side > DEFAULT_LINE_SIDE_EPS
        ):
            reasons: list[str] = []
            if not ts.out_zone_armed:
                reasons.append(
                    f"active_zone_frames_below_arm({prev_active_zone_streak}<{active_zone_arm_frames})"
                )
            if ts.frame_count < required_frames:
                reasons.append(f"frames_below_min({ts.frame_count}<{required_frames})")
            if max_frames is not None and ts.frame_count > max_frames:
                reasons.append(f"frames_above_max({ts.frame_count}>{max_frames})")
            if reasons:
                print(
                    " ".join(
                        [
                            "[COUNT-DECISION]",
                            f"track_id={track_id}",
                            f"line={line_name}",
                            "direction=OUT",
                            "source=zone_exit",
                            "result=rejected",
                            f"reason={','.join(reasons)}",
                            f"side_state={self._side_label(curr_side)}",
                            f"zone_streak={prev_active_zone_streak}",
                        ]
                    )
                )

        return 0

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

        states = self._foot_traffic_track_states.setdefault(line_key, {})
        ts = states.get(track_id)
        curr_side = self._line_target_side_value(line_cfg, target_point)
        in_active_zone = self._is_inside_active_zone(target_point)

        if ts is None:
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

        prev_point = ts.last_point
        prev_side = ts.last_side_value
        cross_point = self._line_crossing_point(prev_point, target_point, prev_side, curr_side)
        traffic_direction = self._foot_traffic_direction(
            prev_point=prev_point,
            curr_point=target_point,
            line_cfg=line_cfg,
            prev_side=prev_side,
            curr_side=curr_side,
        )

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

        direction_already_counted = (
            ts.counted_right if traffic_direction == "right" else ts.counted_left
        ) if traffic_direction else False

        if (
            traffic_direction
            and not direction_already_counted
            and traffic_direction != ts.last_count_direction
            and ts.rearmed
            and self._foot_traffic_cooldown_elapsed(ts, now, line_cfg)
        ):
            self._register_foot_traffic_count(line_key, traffic_direction)
            ts.last_count_direction = traffic_direction
            ts.last_count_time = now
            ts.rearmed = False
            if traffic_direction == "right":
                ts.counted_right = True
            else:
                ts.counted_left = True
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
                if (
                    count_event == LINE_EVENT_IN
                    and in_active_zone
                    and ts.last_in_side_value > DEFAULT_LINE_SIDE_EPS
                    and ts.frame_count >= required_frames
                ):
                    if self._can_count_in(track_id, now):
                        total_in += 1
                        self._register_count(track_id, "IN", "line_disappear", now)
                        self._log_count_event(
                            track_id,
                            "IN",
                            "line_disappear",
                            point=ts.last_right_point,
                            detail=(
                                f"line={line_name} target={count_event} side={ts.last_in_side_value:.4f} "
                                f"elapsed={elapsed:.1f}s"
                            ),
                        )
                        if DEBUG_COUNTING:
                            print(
                                " ".join(
                                    [
                                        "[COUNT-DECISION]",
                                        f"track_id={track_id}",
                                        f"line={line_name}",
                                        "direction=IN",
                                        "source=line_disappear",
                                        "result=counted",
                                        f"frames={ts.frame_count}",
                                        f"elapsed={elapsed:.2f}s",
                                        f"in_active_zone={self._bool_label(in_active_zone)}",
                                    ]
                                )
                            )
                        self._log_live_track_frame(
                            track_id,
                            line_name,
                            event="count_in",
                            count_event=count_event,
                            point=ts.last_right_point,
                            side=ts.last_in_side_value,
                            frame_count=ts.frame_count,
                            elapsed=elapsed,
                            in_active_zone=in_active_zone,
                            out_zone_armed=ts.out_zone_armed,
                            active_zone_streak=ts.active_zone_streak,
                        )
                elif DEBUG_COUNTING:
                    if count_event == LINE_EVENT_OUT:
                        reason = "out_lines_do_not_count_on_disappear"
                    elif not in_active_zone:
                        reason = "last_point_outside_active_zone"
                    elif ts.last_in_side_value <= DEFAULT_LINE_SIDE_EPS:
                        reason = f"last_point_not_in_{count_event}_target_side"
                    else:
                        reason = f"frames_below_min({ts.frame_count}<{required_frames})"
                    print(
                        " ".join(
                            [
                                "[COUNT-DECISION]",
                                f"track_id={track_id}",
                                f"line={line_name}",
                                f"direction={count_event.upper()}",
                                "source=line_disappear",
                                "result=rejected",
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

    def _register_count(self, track_id: int, direction: str, source: str, now: float) -> bool:
        direction = str(direction).upper()
        tid = int(track_id)
        target_tracks = self._get_counted_track_store(direction)
        opposite_tracks = self._get_counted_track_store("OUT" if direction == "IN" else "IN")

        if tid in target_tracks:
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

        if opposite_tracks.pop(tid, None) is not None:
            self._reset_track_frame_history(tid)
        target_tracks[tid] = _CountedTrackRecord(
            direction=direction,
            source=source,
            count_time=now,
        )
        if direction == "IN":
            self._last_in_count_time[tid] = now
        return True

    def _can_count_in(self, track_id: int, now: float) -> bool:
        if int(track_id) in self._counted_in_tracks:
            return False
        if self.count_cooldown <= 0:
            return True
        last_ts = self._last_in_count_time.get(track_id)
        if last_ts is None:
            return True
        return (now - last_ts) >= self.count_cooldown

    def _cleanup_in_cooldown(self, now: float):
        if not self._last_in_count_time:
            return
        keep_for = max(self.count_cooldown, 1.0) * 10.0
        self._last_in_count_time = {
            tid: ts for tid, ts in self._last_in_count_time.items() if (now - ts) < keep_for
        }

    def _process_count_reversions(self, active_ids: set[int]):
        for track_id, record in self._counted_in_tracks.items():
            if record.uncounted:
                continue
            if record.source != "line_disappear":
                continue

            if track_id in active_ids:
                record.visible_streak_after_count += 1
                if record.visible_streak_after_count > DEFAULT_UNCOUNT_IN_REAPPEAR_FRAMES:
                    self.total_in = max(0, self.total_in - 1)
                    record.uncounted = True
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

    def _get_counted_track_store(self, direction: str) -> dict[int, _CountedTrackRecord]:
        if str(direction).upper() == "OUT":
            return self._counted_out_tracks
        return self._counted_in_tracks

    def _reset_track_frame_history(self, track_id: int):
        tid = int(track_id)
        self._line_track_frame_totals.pop(tid, None)
        for states in self._line_track_states.values():
            ts = states.get(tid)
            if ts is not None:
                ts.frame_count = 0

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

    def _register_foot_traffic_count(self, line_key: str, direction: str) -> None:
        counts = self._foot_traffic_line_counts.setdefault(line_key, {"left": 0, "right": 0})
        normalized_direction = "right" if str(direction).lower() in {"right", "down"} else "left"
        counts[normalized_direction] = int(counts.get(normalized_direction, 0) or 0) + 1
        if normalized_direction == "right":
            self.foot_traffic_right += 1
        else:
            self.foot_traffic_left += 1

    def _format_point(self, point: tuple[float, float] | None) -> str:
        if point is None:
            return "n/a"
        return f"({point[0]:.3f},{point[1]:.3f})"

    def _bool_label(self, value: bool) -> str:
        return "yes" if bool(value) else "no"

    def _side_label(self, side: float) -> str:
        if side > DEFAULT_LINE_SIDE_EPS:
            return "target"
        if side < -DEFAULT_LINE_SIDE_EPS:
            return "source"
        return "on_line"

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

    def _foot_traffic_labels(self, line_cfg: dict) -> tuple[str, str]:
        points = line_cfg.get("points", [])
        if len(points) >= 2:
            dx = float(points[1][0]) - float(points[0][0])
            dy = float(points[1][1]) - float(points[0][1])
            if abs(dy) >= abs(dx):
                return ("left", "right")
        return ("up", "down")

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
            return positive_label if line_cfg.get("direction", "left_to_right") == "left_to_right" else negative_label
        if crossed_backward:
            return negative_label if line_cfg.get("direction", "left_to_right") == "left_to_right" else positive_label
        return None

    def _should_accumulate_track_frames(self, point: tuple[float, float] | None) -> bool:
        if point is None:
            return False
        if not self.active_zones:
            return True
        return not self._is_inside_active_zone(point)

    def _should_debug_track(self, track_id: int) -> bool:
        if not DEBUG_COUNTING:
            return False
        if DEBUG_COUNTING_TRACK_ID is None:
            return True
        return int(track_id) == DEBUG_COUNTING_TRACK_ID

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

    def _bbox_bottom_center_point(self, bbox: list[float], frame_w: int, frame_h: int) -> tuple[float, float]:
        x1, y1, x2, y2 = bbox
        cx = ((x1 + x2) / 2.0) / frame_w
        cy = (y1 + ((y2 - y1) * 0.95)) / frame_h
        return (cx, cy)

    def _bbox_line_right_point(self, bbox: list[float], frame_w: int, frame_h: int) -> tuple[float, float]:
        _, _, x2, y2 = bbox
        right_x = x2 / frame_w
        bottom_y = y2 / frame_h
        return (right_x, bottom_y)

    def _bbox_line_right_midlower_point(self, bbox: list[float], frame_w: int, frame_h: int) -> tuple[float, float]:
        _, y1, x2, y2 = bbox
        right_x = x2 / frame_w
        midlower_y = (y1 + ((y2 - y1) * 0.75)) / frame_h
        return (right_x, midlower_y)

    def _bbox_line_target_point(
        self,
        bbox: list[float],
        frame_w: int,
        frame_h: int,
        line_cfg: dict,
    ) -> tuple[float, float]:
        if self._line_type(line_cfg) == LINE_TYPE_FOOT_TRAFFIC:
            return self._bbox_bottom_center_point(bbox, frame_w, frame_h)
        if self._line_count_event(line_cfg) == LINE_EVENT_OUT:
            return self._bbox_line_right_midlower_point(bbox, frame_w, frame_h)
        return self._bbox_line_right_point(bbox, frame_w, frame_h)

    def _line_count_event(self, line_cfg: dict) -> str:
        return LINE_EVENT_OUT if line_cfg.get("count_event") == LINE_EVENT_OUT else LINE_EVENT_IN

    def _line_min_track_frames(self, line_cfg: dict) -> int:
        if self._line_count_event(line_cfg) == LINE_EVENT_OUT:
            return DEFAULT_LINE_OUT_MIN_TRACK_FRAMES
        return DEFAULT_LINE_IN_MIN_TRACK_FRAMES

    def _line_max_track_frames(self, line_cfg: dict) -> int | None:
        if self._line_count_event(line_cfg) == LINE_EVENT_OUT:
            return DEFAULT_LINE_OUT_MAX_TRACK_FRAMES
        return None

    def _out_zone_arm_min_frames(self, line_cfg: dict) -> int:
        if self._line_count_event(line_cfg) == LINE_EVENT_OUT:
            return max(1, int(line_cfg.get("out_zone_arm_frames", DEFAULT_OUT_ZONE_ARM_MIN_FRAMES) or DEFAULT_OUT_ZONE_ARM_MIN_FRAMES))
        return 1

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


def _cross_product_sign(a, b, p):
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])


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
