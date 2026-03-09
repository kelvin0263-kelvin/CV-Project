"""
People Counting Service

Line-only people counting with optional frame exclusion areas.

Supports:
1. OUT line counting on crossing into the configured target side.
2. IN line counting when a tracked person disappears after reaching the
   configured target side.
3. Frame exclusion areas that prevent line-frame accumulation while a track's
   line probe point is inside the excluded polygon.

All coordinates are stored in normalized (0-1) form.
"""

import math
import os
import time
import uuid
from datetime import datetime, timezone


DEBUG_COUNTING = os.getenv("DEBUG_COUNTING", "").strip().lower() in {"1", "true", "yes", "on"}
_DEBUG_COUNTING_TRACK_ID_RAW = os.getenv("DEBUG_COUNTING_TRACK_ID", "").strip()
try:
    DEBUG_COUNTING_TRACK_ID = int(_DEBUG_COUNTING_TRACK_ID_RAW) if _DEBUG_COUNTING_TRACK_ID_RAW else None
except ValueError:
    DEBUG_COUNTING_TRACK_ID = None


LINE_EVENT_IN = "in"
LINE_EVENT_OUT = "out"

DEFAULT_DISAPPEAR_TIMEOUT = 1.0
DEFAULT_COUNT_COOLDOWN = 4.0
DEFAULT_LINE_SIDE_EPS = 0.002
DEFAULT_LINE_IN_MIN_TRACK_FRAMES = 15
DEFAULT_LINE_OUT_MIN_TRACK_FRAMES = 0
DEFAULT_LINE_OUT_MAX_TRACK_FRAMES = 75
DEFAULT_UNCOUNT_IN_REAPPEAR_FRAMES = 20


class _LineTrackState:
    """Tracks lifetime and final line side for line counting."""

    __slots__ = ("last_seen_time", "frame_count", "last_right_point", "last_in_side_value")

    def __init__(self):
        self.last_seen_time: float = time.time()
        self.frame_count: int = 0
        self.last_right_point: tuple[float, float] = (0.0, 0.0)
        self.last_in_side_value: float = 0.0


class _CountedTrackRecord:
    """Permanent count memory for one numeric track ID."""

    __slots__ = ("direction", "source", "count_time", "visible_streak_after_count", "uncounted")

    def __init__(self, direction: str, source: str, count_time: float):
        self.direction = direction
        self.source = source
        self.count_time = count_time
        self.visible_streak_after_count = 0
        self.uncounted = False


def _extract_frame_exclude_areas(config: dict) -> list[dict]:
    normalized: list[dict] = []
    for index, area in enumerate(config.get("frame_exclude_areas") or []):
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


class PeopleCounter:
    """Stateful line-only people counter for a single camera/view."""

    def __init__(self, config: dict):
        self.lines = config.get("lines", [])
        self.frame_exclude_areas = _extract_frame_exclude_areas(config)
        self.enabled = config.get("enabled", True)

        self._line_track_states: dict[str, dict[int, _LineTrackState]] = {}
        self._line_track_frame_totals: dict[int, int] = {}
        self._counted_tracks: dict[int, _CountedTrackRecord] = {}

        self.total_in = 0
        self.total_out = 0

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
        skipped_no_track = 0

        for det in detections:
            bbox = det.get("person_bbox")
            if bbox is None:
                skipped_no_track += 1
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
                skipped_no_track += 1
                continue

            tid = int(track_id)
            track_bboxes[tid] = bbox

            if tid in line_tracks_seen_this_update:
                continue

            line_probe_point = self._bbox_line_right_midlower_point(bbox, w, h)
            if self._should_accumulate_line_frames(line_probe_point):
                self._line_track_frame_totals[tid] = self._line_track_frame_totals.get(tid, 0) + 1
            elif self._should_debug_track(tid):
                print(
                    f"  [LINE-FRAME-SKIP] Track {tid}: point={self._format_point(line_probe_point)} "
                    "inside frame exclusion area, accumulated frames unchanged"
                )
            line_tracks_seen_this_update.add(tid)

        if DEBUG_COUNTING and skipped_no_track > 0:
            print(f"  [WARN] {skipped_no_track} detection(s) skipped: missing bbox or track_id")

        for line_index, line_cfg in enumerate(self.lines):
            points = line_cfg.get("points", [])
            if len(points) < 2:
                continue

            line_key = self._line_state_key(line_cfg, line_index)
            line_name = line_cfg.get("name") or line_cfg.get("id") or f"line_{line_index + 1}"
            line_out_cross_count = 0

            for track_id, bbox in track_bboxes.items():
                line_out_cross_count += self._update_line_track_state(
                    line_key,
                    line_name,
                    line_cfg,
                    track_id,
                    self._bbox_line_target_point(bbox, w, h, line_cfg),
                    now,
                )

            self.total_out += line_out_cross_count

        line_in, line_out = self._process_line_disappears(set(track_bboxes.keys()), now)
        self.total_in += line_in
        self.total_out += line_out

        self._process_count_reversions(set(track_bboxes.keys()))

        occupancy = max(0, self.total_in - self.total_out)

        return {
            "total_in": self.total_in,
            "total_out": self.total_out,
            "occupancy": occupancy,
            "lines": self.lines,
            "frame_exclude_areas": self.frame_exclude_areas,
        }

    def should_snapshot(self, heartbeat_interval: float = 300.0) -> bool:
        now = time.time()
        occupancy = max(0, self.total_in - self.total_out)
        current_signature = (int(self.total_in), int(self.total_out), int(occupancy))

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
        }

    def update_config(self, config: dict):
        """Hot-reload config without resetting counts."""
        self.lines = config.get("lines", [])
        self.frame_exclude_areas = _extract_frame_exclude_areas(config)
        self.enabled = config.get("enabled", True)
        self.disappear_timeout = config.get("disappear_timeout", DEFAULT_DISAPPEAR_TIMEOUT)
        self.count_cooldown = config.get("count_cooldown", DEFAULT_COUNT_COOLDOWN)

        new_line_signature = self._build_line_signature(self.lines)
        if new_line_signature != getattr(self, "_line_signature", None):
            self._line_track_states = {}
            self._line_signature = new_line_signature
        self._sync_line_track_states()

    def reset(self):
        """Reset all counters (e.g. on video loop)."""
        self._line_track_states = {}
        self._line_track_frame_totals = {}
        self._counted_tracks = {}
        self.total_in = 0
        self.total_out = 0
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
            if len(line_cfg.get("points", [])) >= 2
        }
        self._line_track_states = {
            key: self._line_track_states.get(key, {})
            for key in active_line_keys
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

        if ts is None:
            ts = _LineTrackState()
            ts.last_seen_time = now
            ts.frame_count = self._line_track_frame_totals.get(int(track_id), 0)
            ts.last_right_point = right_point
            ts.last_in_side_value = curr_side
            states[track_id] = ts
            self._log_live_track_frame(
                track_id,
                line_name,
                event="spawn",
                point=right_point,
                side=curr_side,
                frame_count=ts.frame_count,
            )
            return 0

        prev_point = ts.last_right_point
        prev_side = ts.last_in_side_value

        ts.last_seen_time = now
        ts.frame_count = self._line_track_frame_totals.get(int(track_id), ts.frame_count)
        ts.last_right_point = right_point
        ts.last_in_side_value = curr_side

        self._log_live_track_frame(
            track_id,
            line_name,
            event="visible",
            point=right_point,
            side=curr_side,
            frame_count=ts.frame_count,
        )

        if DEBUG_COUNTING and ts.frame_count in {10, 30, 60, 100, 101}:
            target_label = self._line_count_event(line_cfg).upper()
            print(
                f"  [LINE-TRACK] Track {track_id}: {line_name} "
                f"target={target_label} frames={ts.frame_count} side={curr_side:.4f} "
                f"point={self._format_point(right_point)}"
            )

        max_frames = self._line_max_track_frames(line_cfg)
        if (
            count_event == LINE_EVENT_OUT
            and prev_side <= DEFAULT_LINE_SIDE_EPS
            and curr_side > DEFAULT_LINE_SIDE_EPS
        ):
            if ts.frame_count >= required_frames and (max_frames is None or ts.frame_count <= max_frames):
                if self._register_count(track_id, "OUT", "line_cross", now):
                    self._log_count_event(
                        track_id,
                        "OUT",
                        "line_cross",
                        point=right_point,
                        prev_point=prev_point,
                        detail=(
                            f"line={line_name} target={count_event} side={curr_side:.4f} "
                            f"frames={ts.frame_count}"
                        ),
                    )
                    if DEBUG_COUNTING:
                        print(
                            f"  [LINE-INFER] Track {track_id}: OUT +1 "
                            f"(crossed into OUT area on {line_name}, frames={ts.frame_count})"
                        )
                    self._log_live_track_frame(
                        track_id,
                        line_name,
                        event="count_out",
                        point=right_point,
                        side=curr_side,
                        frame_count=ts.frame_count,
                    )
                    return 1
            if DEBUG_COUNTING:
                if ts.frame_count < required_frames:
                    reason = f"tracked_updates={ts.frame_count} < required={required_frames}"
                else:
                    reason = f"tracked_updates={ts.frame_count} > max_allowed={max_frames}"
                print(
                    f"  [LINE-REJECT] Track {track_id}: crossed into OUT area on {line_name} "
                    f"but {reason}"
                )

        return 0

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
                    point=ts.last_right_point,
                    side=ts.last_in_side_value,
                    frame_count=ts.frame_count,
                    elapsed=elapsed,
                )
                if elapsed < self.disappear_timeout:
                    continue

                if (
                    count_event == LINE_EVENT_IN
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
                                f"  [LINE-INFER] Track {track_id}: IN +1 "
                                f"(line={line_name}, frames={ts.frame_count})"
                            )
                        self._log_live_track_frame(
                            track_id,
                            line_name,
                            event="count_in",
                            point=ts.last_right_point,
                            side=ts.last_in_side_value,
                            frame_count=ts.frame_count,
                            elapsed=elapsed,
                        )
                elif DEBUG_COUNTING:
                    if count_event == LINE_EVENT_OUT:
                        reason = "OUT lines count on crossing, not disappearance"
                    elif ts.last_in_side_value <= DEFAULT_LINE_SIDE_EPS:
                        reason = f"point not in {count_event.upper()} area at disappear"
                    else:
                        reason = f"tracked_updates={ts.frame_count} < required={required_frames}"
                    print(
                        f"  [LINE-CLEANUP] Track {track_id}: no {count_event.upper()} count for {line_name} "
                        f"({reason}, side={ts.last_in_side_value:.4f}, elapsed={elapsed:.1f}s)"
                    )

                to_remove.append(track_id)

            for track_id in to_remove:
                del states[track_id]

        return (total_in, total_out)

    def _register_count(self, track_id: int, direction: str, source: str, now: float) -> bool:
        if int(track_id) in self._counted_tracks:
            if DEBUG_COUNTING:
                record = self._counted_tracks[int(track_id)]
                print(
                    f"  [COUNT-SKIP] Track {track_id}: already counted once "
                    f"(dir={record.direction}, source={record.source}, uncounted={record.uncounted})"
                )
            return False

        self._counted_tracks[int(track_id)] = _CountedTrackRecord(
            direction=direction,
            source=source,
            count_time=now,
        )
        if direction == "IN":
            self._last_in_count_time[int(track_id)] = now
        return True

    def _can_count_in(self, track_id: int, now: float) -> bool:
        if int(track_id) in self._counted_tracks:
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
        for track_id, record in self._counted_tracks.items():
            if record.direction != "IN":
                continue
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
                        f"[Uncount] dir=IN track_id={track_id} source={record.source} "
                        f"reason=reappeared_visible_over_{DEFAULT_UNCOUNT_IN_REAPPEAR_FRAMES}_frames"
                    )
            else:
                record.visible_streak_after_count = 0

    def _format_point(self, point: tuple[float, float] | None) -> str:
        if point is None:
            return "n/a"
        return f"({point[0]:.3f},{point[1]:.3f})"

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
        point: tuple[float, float] | None,
        side: float,
        frame_count: int,
        elapsed: float | None = None,
    ):
        if not self._should_debug_track(track_id):
            return
        parts = [
            "[LINE-LIVE]",
            f"track_id={track_id}",
            f"line={line_name}",
            f"event={event}",
            f"frames={frame_count}",
            f"target_area={side > DEFAULT_LINE_SIDE_EPS}",
            f"side={side:.4f}",
            f"point={self._format_point(point)}",
        ]
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

    def _should_accumulate_line_frames(self, point: tuple[float, float] | None) -> bool:
        if point is None:
            return False
        for area in self.frame_exclude_areas:
            polygon = area.get("points", [])
            if len(polygon) >= 3 and _point_in_polygon(point, polygon):
                return False
        return True

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
            "lines": self.lines,
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
