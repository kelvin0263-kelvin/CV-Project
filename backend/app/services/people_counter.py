"""
People Counting Service

Supports THREE counting methods (can coexist):

1. **Line-crossing** — segment intersection + cross product direction detection.
2. **3-zone state machine** — Outside → Door → Inside transitions.
3. **2-zone door counting** — Outside + Door only (no Inside zone).
   IN = person walks Outside → Door → disappears (went inside, camera can't see).
   OUT = new track appears in Door → moves to Outside (came from inside).

All line/zone coordinates are stored in normalized (0-1) form.
"""

import uuid
import time
from typing import Optional


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
ZONE_OUTSIDE = "outside"
ZONE_DOOR = "door"
ZONE_INSIDE = "inside"

# Track states for zone-based counting
STATE_NONE = "none"
STATE_OUTSIDE = "outside"
STATE_DOOR_ENTRY = "door_entry"      # was outside, now in door → heading inside
STATE_DOOR_EXIT = "door_exit"        # was inside, now in door → heading outside
STATE_INSIDE = "inside"
STATE_DOOR_UNKNOWN = "door_unknown"  # first seen in door, direction unknown

# Group modes
MODE_3ZONE = "3zone"  # Outside + Door + Inside
MODE_2ZONE = "2zone"  # Outside + Door only (no Inside visible)

# Anti-noise defaults
DEFAULT_MIN_FRAMES = 3        # Minimum frames a track must be seen before counting
DEFAULT_DISAPPEAR_TIMEOUT = 1.0  # Seconds before inferring from disappearance


# ---------------------------------------------------------------------------
# Per-track zone state
# ---------------------------------------------------------------------------
class _TrackZoneState:
    """Holds the state-machine state for one tracked person in one zone group."""
    __slots__ = ("state", "last_seen_time", "frame_count", "birth_zone")

    def __init__(self, birth_zone: str = ""):
        self.state: str = STATE_NONE
        self.last_seen_time: float = time.time()
        self.frame_count: int = 0        # How many frames this track has been seen in any zone
        self.birth_zone: str = birth_zone  # Which zone the track was first detected in


# ---------------------------------------------------------------------------
# Main counter
# ---------------------------------------------------------------------------
class PeopleCounter:
    """
    Stateful people counter for a single camera/view.

    Maintains:
      - Per-track centroid history (for line crossing)
      - Per-track zone state machines (for multi-zone counting)
      - Cumulative In/Out counts
    """

    def __init__(self, config: dict):
        self.lines = config.get("lines", [])
        self.zones = config.get("zones", [])
        self.max_capacity = config.get("max_capacity")
        self.enabled = config.get("enabled", True)

        # Parse zone groups from zones list
        self.zone_groups: dict[str, dict[str, dict]] = {}   # group_id -> {type -> zone_cfg}
        self.zone_group_modes: dict[str, str] = {}          # group_id -> MODE_2ZONE | MODE_3ZONE
        self.standalone_zones: list[dict] = []
        self._parse_zone_groups()

        # Tracking state (for line crossing)
        self.prev_centroids: dict[int, tuple[float, float]] = {}
        self.total_in = 0
        self.total_out = 0
        self.capacity_alert_fired = False

        # Zone-group tracking: group_id -> {track_id -> _TrackZoneState}
        self._zone_track_states: dict[str, dict[int, _TrackZoneState]] = {
            gid: {} for gid in self.zone_groups
        }
        # Per-group cumulative counts
        self._group_totals: dict[str, dict[str, int]] = {
            gid: {"in": 0, "out": 0} for gid in self.zone_groups
        }

        # Anti-noise settings
        self.min_frames_for_count: int = config.get("min_frames", DEFAULT_MIN_FRAMES)
        self.disappear_timeout: float = config.get("disappear_timeout", DEFAULT_DISAPPEAR_TIMEOUT)

        # Snapshot timing
        self._last_snapshot_time = time.time()

    # ------------------------------------------------------------------
    # Zone group parsing
    # ------------------------------------------------------------------
    def _parse_zone_groups(self):
        """Separate zones into groups (by group_id) and standalone zones."""
        groups_raw: dict[str, dict[str, dict]] = {}
        for zone in self.zones:
            gid = zone.get("group_id")
            ztype = zone.get("zone_type")
            if gid and ztype in (ZONE_OUTSIDE, ZONE_DOOR, ZONE_INSIDE):
                if gid not in groups_raw:
                    groups_raw[gid] = {}
                groups_raw[gid][ztype] = zone
            else:
                self.standalone_zones.append(zone)

        for gid, group_zones in groups_raw.items():
            has_outside = ZONE_OUTSIDE in group_zones
            has_door = ZONE_DOOR in group_zones
            has_inside = ZONE_INSIDE in group_zones

            if has_outside and has_door and has_inside:
                # Full 3-zone group
                self.zone_groups[gid] = group_zones
                self.zone_group_modes[gid] = MODE_3ZONE
            elif has_outside and has_door:
                # 2-zone group (no inside visible)
                self.zone_groups[gid] = group_zones
                self.zone_group_modes[gid] = MODE_2ZONE
            else:
                # Incomplete → standalone
                for zone in group_zones.values():
                    self.standalone_zones.append(zone)
                present = [t for t in (ZONE_OUTSIDE, ZONE_DOOR, ZONE_INSIDE) if t in group_zones]
                print(f"[PeopleCounter] Warning: Group '{gid}' has only {present}, "
                      f"need at least Outside+Door. Treating as standalone.")

        if self.zone_groups:
            summaries = []
            for gid in self.zone_groups:
                summaries.append(f"{gid}({self.zone_group_modes[gid]})")
            print(f"[PeopleCounter] Loaded {len(self.zone_groups)} zone group(s): {summaries}")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def update(self, detections: list[dict], frame_shape: tuple[int, int]) -> dict:
        if not self.enabled:
            return self._empty_result()

        h, w = frame_shape

        # 1. Compute normalised centroids
        current_centroids: dict[int, tuple[float, float]] = {}
        for det in detections:
            track_id = det.get("track_id")
            bbox = det.get("person_bbox")
            if track_id is None or bbox is None:
                continue
            cx = ((bbox[0] + bbox[2]) / 2.0) / w
            cy = bbox[3] / h
            current_centroids[int(track_id)] = (cx, cy)

        # 2. Line-crossing detection
        for track_id, curr_pos in current_centroids.items():
            if track_id in self.prev_centroids:
                prev_pos = self.prev_centroids[track_id]
                for line_cfg in self.lines:
                    pts = line_cfg.get("points", [])
                    if len(pts) < 2:
                        continue
                    lp1 = (pts[0][0], pts[0][1])
                    lp2 = (pts[1][0], pts[1][1])
                    direction = line_cfg.get("direction", "left_to_right")

                    if _segments_intersect(prev_pos, curr_pos, lp1, lp2):
                        cross = _cross_product_sign(lp1, lp2, curr_pos)
                        if direction == "left_to_right":
                            if cross > 0:
                                self.total_in += 1
                            else:
                                self.total_out += 1
                        else:
                            if cross < 0:
                                self.total_in += 1
                            else:
                                self.total_out += 1

        # 3. Zone-group state machine counting
        for gid, group_zones in self.zone_groups.items():
            mode = self.zone_group_modes[gid]
            in_c, out_c = self._process_zone_group(gid, group_zones, current_centroids, mode)
            self.total_in += in_c
            self.total_out += out_c
            self._group_totals[gid]["in"] += in_c
            self._group_totals[gid]["out"] += out_c

        # 4. Disappear inference
        d_in, d_out, d_group_deltas = self._process_disappears(current_centroids)
        self.total_in += d_in
        self.total_out += d_out
        for gid, (gi, go) in d_group_deltas.items():
            self._group_totals[gid]["in"] += gi
            self._group_totals[gid]["out"] += go

        # 5. Update previous centroids
        self.prev_centroids = current_centroids

        # 6. Standalone zone counting (occupancy only)
        zone_counts: dict[str, int] = {}
        for zone_cfg in self.standalone_zones:
            zone_id = zone_cfg.get("id", "unknown")
            polygon = zone_cfg.get("points", [])
            if len(polygon) < 3:
                continue
            count = 0
            for _, centroid in current_centroids.items():
                if _point_in_polygon(centroid, polygon):
                    count += 1
            zone_counts[zone_id] = count

        # 7. Build zone_group_counts for the response
        zone_group_counts: dict[str, dict] = {}
        for gid, group_zones in self.zone_groups.items():
            mode = self.zone_group_modes[gid]
            door_count = 0
            inside_count = 0
            outside_count = 0
            door_poly = group_zones.get(ZONE_DOOR, {}).get("points", [])
            inside_poly = group_zones.get(ZONE_INSIDE, {}).get("points", []) if mode == MODE_3ZONE else []
            outside_poly = group_zones.get(ZONE_OUTSIDE, {}).get("points", [])

            for _, centroid in current_centroids.items():
                if len(inside_poly) >= 3 and _point_in_polygon(centroid, inside_poly):
                    inside_count += 1
                elif len(door_poly) >= 3 and _point_in_polygon(centroid, door_poly):
                    door_count += 1
                elif len(outside_poly) >= 3 and _point_in_polygon(centroid, outside_poly):
                    outside_count += 1

            g_totals = self._group_totals[gid]
            zone_group_counts[gid] = {
                "name": group_zones.get(ZONE_DOOR, {}).get("name", gid),
                "mode": mode,
                "total_in": g_totals["in"],
                "total_out": g_totals["out"],
                "occupancy": max(0, g_totals["in"] - g_totals["out"]),
                "door_count": door_count,
                "inside_count": inside_count,
                "outside_count": outside_count,
            }

        # 8. Occupancy and capacity check
        occupancy = max(0, self.total_in - self.total_out)
        capacity_exceeded = False
        if self.max_capacity is not None and self.max_capacity > 0:
            capacity_exceeded = occupancy >= self.max_capacity

        return {
            "total_in": self.total_in,
            "total_out": self.total_out,
            "occupancy": occupancy,
            "zone_counts": zone_counts,
            "zone_group_counts": zone_group_counts,
            "capacity_exceeded": capacity_exceeded,
            "lines": self.lines,
            "zones": self.zones,
            "max_capacity": self.max_capacity,
        }

    # ------------------------------------------------------------------
    # Zone-group state machine (handles both 2-zone and 3-zone)
    # ------------------------------------------------------------------
    def _process_zone_group(
        self,
        gid: str,
        group_zones: dict[str, dict],
        current_centroids: dict[int, tuple[float, float]],
        mode: str,
    ) -> tuple[int, int]:
        """
        Run the state machine for one zone group against all tracked people.
        Returns (in_count, out_count) for this frame.
        """
        states = self._zone_track_states[gid]
        in_count = 0
        out_count = 0
        now = time.time()

        outside_poly = group_zones.get(ZONE_OUTSIDE, {}).get("points", [])
        door_poly = group_zones.get(ZONE_DOOR, {}).get("points", [])
        inside_poly = group_zones.get(ZONE_INSIDE, {}).get("points", []) if mode == MODE_3ZONE else []
        has_inside = mode == MODE_3ZONE and len(inside_poly) >= 3

        for track_id, centroid in current_centroids.items():
            # Determine which zone(s) this person is in
            in_outside = len(outside_poly) >= 3 and _point_in_polygon(centroid, outside_poly)
            in_door = len(door_poly) >= 3 and _point_in_polygon(centroid, door_poly)
            in_inside = has_inside and _point_in_polygon(centroid, inside_poly)

            if not (in_outside or in_door or in_inside):
                continue  # Person not in any zone of this group

            # Resolve zone priority: door > inside > outside
            if in_door:
                current_zone = ZONE_DOOR
            elif in_inside:
                current_zone = ZONE_INSIDE
            elif in_outside:
                current_zone = ZONE_OUTSIDE
            else:
                continue

            # Ensure track state exists
            if track_id not in states:
                states[track_id] = _TrackZoneState(birth_zone=current_zone)
            ts = states[track_id]
            ts.last_seen_time = now
            ts.frame_count += 1

            # ---- State transitions ----

            if current_zone == ZONE_OUTSIDE:
                if ts.state == STATE_DOOR_EXIT:
                    # (3-zone) inside → door → outside = EXIT
                    if ts.frame_count >= self.min_frames_for_count:
                        out_count += 1
                    ts.state = STATE_OUTSIDE

                elif ts.state == STATE_DOOR_UNKNOWN:
                    # Track first appeared in door, now moved to outside.
                    # In 2-zone mode: this means they came from inside = OUT
                    # In 3-zone mode: ambiguous, don't count (could be passing through)
                    if mode == MODE_2ZONE and ts.birth_zone == ZONE_DOOR:
                        if ts.frame_count >= self.min_frames_for_count:
                            out_count += 1
                    ts.state = STATE_OUTSIDE

                elif ts.state == STATE_INSIDE:
                    # Direct jump inside → outside (skipped door)
                    if ts.frame_count >= self.min_frames_for_count:
                        out_count += 1
                    ts.state = STATE_OUTSIDE

                else:
                    ts.state = STATE_OUTSIDE

            elif current_zone == ZONE_DOOR:
                if ts.state == STATE_OUTSIDE:
                    ts.state = STATE_DOOR_ENTRY  # heading inside
                elif ts.state == STATE_INSIDE:
                    ts.state = STATE_DOOR_EXIT   # heading outside
                elif ts.state == STATE_NONE:
                    ts.state = STATE_DOOR_UNKNOWN
                # else: stay in current door sub-state

            elif current_zone == ZONE_INSIDE:
                # Only reachable in 3-zone mode
                if ts.state == STATE_DOOR_ENTRY:
                    # outside → door → inside = ENTRY
                    if ts.frame_count >= self.min_frames_for_count:
                        in_count += 1
                    ts.state = STATE_INSIDE
                elif ts.state == STATE_DOOR_UNKNOWN:
                    ts.state = STATE_INSIDE
                elif ts.state == STATE_OUTSIDE:
                    # Direct jump outside → inside
                    if ts.frame_count >= self.min_frames_for_count:
                        in_count += 1
                    ts.state = STATE_INSIDE
                else:
                    ts.state = STATE_INSIDE

        return (in_count, out_count)

    # ------------------------------------------------------------------
    # Disappear inference
    # ------------------------------------------------------------------
    def _process_disappears(
        self,
        current_centroids: dict[int, tuple[float, float]],
    ) -> tuple[int, int, dict[str, tuple[int, int]]]:
        """
        Handle tracks that disappeared while transiting through the door zone.
        Applies anti-noise: only infer if frame_count >= min_frames_for_count.

        Returns:
            (total_in, total_out, {group_id: (in, out)})
        """
        now = time.time()
        active_ids = set(current_centroids.keys())
        total_in = 0
        total_out = 0
        group_deltas: dict[str, tuple[int, int]] = {}

        for gid, states in self._zone_track_states.items():
            mode = self.zone_group_modes.get(gid, MODE_3ZONE)
            g_in = 0
            g_out = 0
            to_remove: list[int] = []

            for track_id, ts in states.items():
                if track_id in active_ids:
                    continue  # Still visible

                elapsed = now - ts.last_seen_time

                if elapsed >= self.disappear_timeout:
                    if ts.state in (STATE_DOOR_ENTRY, STATE_DOOR_EXIT):
                        # Only count if track was visible for enough frames (anti-noise)
                        if ts.frame_count >= self.min_frames_for_count:
                            if ts.state == STATE_DOOR_ENTRY:
                                # Was heading inside, lost at door → infer IN
                                g_in += 1
                            else:
                                # Was heading outside, lost at door → infer OUT
                                g_out += 1
                        to_remove.append(track_id)

                    elif ts.state == STATE_DOOR_UNKNOWN and mode == MODE_2ZONE:
                        # In 2-zone mode, a track born in the door that disappears
                        # without moving to outside → they went back inside, no count.
                        # Just clean up.
                        to_remove.append(track_id)

                    elif elapsed >= self.disappear_timeout * 3:
                        # Very stale non-door state, just clean up
                        to_remove.append(track_id)

            for tid in to_remove:
                del states[tid]

            total_in += g_in
            total_out += g_out
            if g_in or g_out:
                group_deltas[gid] = (g_in, g_out)

        return (total_in, total_out, group_deltas)

    # ------------------------------------------------------------------
    # Snapshot & alerts
    # ------------------------------------------------------------------
    def should_snapshot(self, interval: float = 10.0) -> bool:
        now = time.time()
        if now - self._last_snapshot_time >= interval:
            self._last_snapshot_time = now
            return True
        return False

    def get_snapshot_data(self, camera_id: str) -> dict:
        occupancy = max(0, self.total_in - self.total_out)
        return {
            "id": str(uuid.uuid4()),
            "camera_id": camera_id,
            "total_in": self.total_in,
            "total_out": self.total_out,
            "current_occupancy": occupancy,
            "zone_counts": {},
        }

    def check_capacity_alert(self) -> Optional[dict]:
        if self.max_capacity is None or self.max_capacity <= 0:
            self.capacity_alert_fired = False
            return None
        occupancy = max(0, self.total_in - self.total_out)
        if occupancy >= self.max_capacity and not self.capacity_alert_fired:
            self.capacity_alert_fired = True
            return {
                "id": str(uuid.uuid4()),
                "event_type": "Capacity Exceeded",
                "occupancy": occupancy,
                "max_capacity": self.max_capacity,
            }
        elif occupancy < self.max_capacity:
            self.capacity_alert_fired = False
        return None

    def update_config(self, config: dict):
        """Hot-reload config without resetting counts."""
        self.lines = config.get("lines", [])
        self.zones = config.get("zones", [])
        self.max_capacity = config.get("max_capacity")
        self.enabled = config.get("enabled", True)
        self.disappear_timeout = config.get("disappear_timeout", DEFAULT_DISAPPEAR_TIMEOUT)
        self.min_frames_for_count = config.get("min_frames", DEFAULT_MIN_FRAMES)

        # Re-parse zone groups
        old_groups = set(self.zone_groups.keys())
        self.zone_groups = {}
        self.zone_group_modes = {}
        self.standalone_zones = []
        self._parse_zone_groups()

        new_groups = set(self.zone_groups.keys())
        for gid in new_groups - old_groups:
            self._zone_track_states[gid] = {}
            self._group_totals[gid] = {"in": 0, "out": 0}
        for gid in old_groups - new_groups:
            self._zone_track_states.pop(gid, None)
            self._group_totals.pop(gid, None)

    def reset(self):
        """Reset all counters (e.g. on video loop)."""
        self.prev_centroids = {}
        self.total_in = 0
        self.total_out = 0
        self.capacity_alert_fired = False
        for gid in self._zone_track_states:
            self._zone_track_states[gid] = {}
        for gid in self._group_totals:
            self._group_totals[gid] = {"in": 0, "out": 0}

    def _empty_result(self) -> dict:
        return {
            "total_in": 0,
            "total_out": 0,
            "occupancy": 0,
            "zone_counts": {},
            "zone_group_counts": {},
            "capacity_exceeded": False,
            "lines": self.lines,
            "zones": self.zones,
            "max_capacity": self.max_capacity,
        }


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def _cross_product_sign(a, b, p):
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])


def _on_segment(p, q, r):
    if (min(p[0], r[0]) <= q[0] <= max(p[0], r[0]) and
            min(p[1], r[1]) <= q[1] <= max(p[1], r[1])):
        return True
    return False


def _orientation(p, q, r):
    val = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1])
    if abs(val) < 1e-10:
        return 0
    return 1 if val > 0 else 2


def _segments_intersect(p1, q1, p2, q2):
    o1 = _orientation(p1, q1, p2)
    o2 = _orientation(p1, q1, q2)
    o3 = _orientation(p2, q2, p1)
    o4 = _orientation(p2, q2, q1)

    if o1 != o2 and o3 != o4:
        return True

    if o1 == 0 and _on_segment(p1, p2, q1):
        return True
    if o2 == 0 and _on_segment(p1, q2, q1):
        return True
    if o3 == 0 and _on_segment(p2, p1, q2):
        return True
    if o4 == 0 and _on_segment(p2, q1, q2):
        return True

    return False


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
