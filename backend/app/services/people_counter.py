"""
People Counting Service

Supports THREE counting methods (can coexist):

1. **Line-crossing** — segment intersection + cross product direction detection.
2. **3-zone state machine** — Outside → Door → Inside transitions.
3. **2-zone door counting** — Outside + Door only (no Inside zone).
   IN = person walks Outside → Door → disappears (went inside, camera can't see).
   OUT = new track appears in Door → moves to Outside (came from inside).

**Door Buffer** — event-level merging for tracks that disappear and reappear
in the door zone due to occlusion.  When a new track appears in the door zone
and a recently-disappeared track was nearby, the new track inherits the old
track's state instead of being treated as a fresh arrival.

All line/zone coordinates are stored in normalized (0-1) form.
"""

import math
import uuid
import time
from typing import Optional

# Set to True to enable detailed per-track debug logging
DEBUG_COUNTING = True


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

# Door buffer defaults
DEFAULT_DOOR_BUFFER_TIMEOUT = 0.8   # Seconds to keep a disappeared door-zone track in buffer
DEFAULT_DOOR_BUFFER_DISTANCE = 0.06  # Max normalised distance to match a new track to a buffer entry


# ---------------------------------------------------------------------------
# Door buffer entry — remembers a disappeared track from the door zone
# ---------------------------------------------------------------------------
class _DoorBufferEntry:
    """Short-term memory for a track that disappeared in the door zone."""
    __slots__ = ("track_id", "state", "frame_count", "birth_zone",
                 "last_position", "disappear_time")

    def __init__(self, track_id: int, state: str, frame_count: int,
                 birth_zone: str, last_position: tuple[float, float],
                 disappear_time: float):
        self.track_id = track_id
        self.state = state
        self.frame_count = frame_count
        self.birth_zone = birth_zone
        self.last_position = last_position
        self.disappear_time = disappear_time


# ---------------------------------------------------------------------------
# Per-track zone state
# ---------------------------------------------------------------------------
class _TrackZoneState:
    """Holds the state-machine state for one tracked person in one zone group."""
    __slots__ = ("state", "last_seen_time", "frame_count", "birth_zone",
                 "last_position")

    def __init__(self, birth_zone: str = ""):
        self.state: str = STATE_NONE
        self.last_seen_time: float = time.time()
        self.frame_count: int = 0        # How many frames this track has been seen in any zone
        self.birth_zone: str = birth_zone  # Which zone the track was first detected in
        self.last_position: tuple[float, float] = (0.0, 0.0)  # Last known centroid


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

        # Door buffer: per-group list of recently-disappeared door-zone tracks
        self._door_buffer: dict[str, list[_DoorBufferEntry]] = {
            gid: [] for gid in self.zone_groups
        }
        self.door_buffer_timeout: float = config.get("door_buffer_timeout", DEFAULT_DOOR_BUFFER_TIMEOUT)
        self.door_buffer_distance: float = config.get("door_buffer_distance", DEFAULT_DOOR_BUFFER_DISTANCE)

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
            # Build a signature to detect actual changes
            new_sig = str(sorted(
                (gid, self.zone_group_modes[gid],
                 tuple(tuple(tuple(p) for p in z.get("points", []))
                       for z in gzones.values()))
                for gid, gzones in self.zone_groups.items()
            ))
            old_sig = getattr(self, '_zone_signature', None)
            if new_sig != old_sig:
                self._zone_signature = new_sig
                summaries = [f"{gid}({self.zone_group_modes[gid]})" for gid in self.zone_groups]
                print(f"[PeopleCounter] Loaded {len(self.zone_groups)} zone group(s): {summaries}")
                if DEBUG_COUNTING:
                    for gid, group_zones in self.zone_groups.items():
                        for ztype, zone_cfg in group_zones.items():
                            pts = zone_cfg.get("points", [])
                            if pts:
                                xs = [p[0] for p in pts]
                                ys = [p[1] for p in pts]
                                print(f"  [ZONE] {gid}/{ztype}: X=[{min(xs):.3f}..{max(xs):.3f}], "
                                      f"Y=[{min(ys):.3f}..{max(ys):.3f}], {len(pts)} points")
                                print(f"         points={[(round(p[0],4), round(p[1],4)) for p in pts]}")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def update(self, detections: list[dict], frame_shape: tuple[int, int]) -> dict:
        if not self.enabled:
            return self._empty_result()

        h, w = frame_shape

        # 1. Compute normalised centroids
        current_centroids: dict[int, tuple[float, float]] = {}
        skipped_no_track = 0
        for det in detections:
            track_id = det.get("track_id")
            bbox = det.get("person_bbox")
            if track_id is None or bbox is None:
                skipped_no_track += 1
                continue
            cx = ((bbox[0] + bbox[2]) / 2.0) / w
            cy = bbox[3] / h
            current_centroids[int(track_id)] = (cx, cy)
        if DEBUG_COUNTING and skipped_no_track > 0:
            print(f"  [WARN] {skipped_no_track} detection(s) skipped: no track_id (green box, no ID)")

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
        if DEBUG_COUNTING and current_centroids and self.zone_groups:
            print(f"\n[PeopleCounter] === Frame Update === tracks={list(current_centroids.keys())}, total_in={self.total_in}, total_out={self.total_out}")

        for gid, group_zones in self.zone_groups.items():
            mode = self.zone_group_modes[gid]
            if DEBUG_COUNTING and current_centroids:
                print(f"  [GROUP] {gid} (mode={mode})")
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

        # Debug: print full track state summary periodically
        if DEBUG_COUNTING and self.zone_groups:
            self._debug_frame_counter = getattr(self, '_debug_frame_counter', 0) + 1
            if self._debug_frame_counter % 30 == 0:  # Print every 30 frames
                print(f"\n  [SUMMARY] Frame #{self._debug_frame_counter} | total_in={self.total_in} total_out={self.total_out}")
                for gid, states in self._zone_track_states.items():
                    if states:
                        print(f"    Group '{gid}': {len(states)} tracked")
                        for tid, ts in states.items():
                            active = "ACTIVE" if tid in current_centroids else f"MISSING {time.time()-ts.last_seen_time:.1f}s"
                            print(f"      Track {tid}: state={ts.state}, frames={ts.frame_count}, birth={ts.birth_zone}, {active}")

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
                if DEBUG_COUNTING:
                    # Only print once per track to reduce spam
                    warned_key = f"_warned_nozone_{gid}"
                    warned_set = getattr(self, warned_key, None)
                    if warned_set is None:
                        warned_set = set()
                        setattr(self, warned_key, warned_set)
                    if track_id not in warned_set:
                        warned_set.add(track_id)
                        print(f"    Track {track_id}: centroid=({centroid[0]:.3f},{centroid[1]:.3f}) NOT in any zone of group '{gid}' (first occurrence, won't repeat)")
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
                # --- Door Buffer: check if this new track matches a recent disappearance ---
                # Check buffer for ANY zone (not just door), so occlusion in
                # the outside→door transition can be recovered.
                matched_buffer = self._match_door_buffer(gid, centroid, now)

                if matched_buffer is not None:
                    # Inherit state from the disappeared track
                    ts = _TrackZoneState(birth_zone=matched_buffer.birth_zone)
                    ts.state = matched_buffer.state
                    ts.frame_count = matched_buffer.frame_count
                    ts.last_position = centroid
                    states[track_id] = ts
                    # Remove the old track's state so it won't be double-counted
                    old_tid = matched_buffer.track_id
                    if old_tid in states:
                        del states[old_tid]
                    # Also remove from all door buffers for this group
                    buf = self._door_buffer.get(gid, [])
                    buf[:] = [e for e in buf if e.track_id != old_tid]
                    if DEBUG_COUNTING:
                        print(f"  [BUFFER] Track {track_id}: MERGED with old Track {old_tid} "
                              f"(state={matched_buffer.state}, frames={matched_buffer.frame_count}, "
                              f"dist={math.dist(centroid, matched_buffer.last_position):.4f}) "
                              f"→ old Track {old_tid} removed from states")
                else:
                    states[track_id] = _TrackZoneState(birth_zone=current_zone)

            ts = states[track_id]
            ts.last_seen_time = now
            ts.frame_count += 1
            ts.last_position = centroid

            # ---- State transitions ----
            old_state = ts.state

            if current_zone == ZONE_OUTSIDE:
                if ts.state == STATE_DOOR_EXIT:
                    if ts.frame_count >= self.min_frames_for_count:
                        out_count += 1
                        if DEBUG_COUNTING:
                            print(f"  [COUNT] Track {track_id}: OUT +1 (inside→door→outside, frames={ts.frame_count})")
                    elif DEBUG_COUNTING:
                        print(f"  [REJECT] Track {track_id}: door_exit→outside but frames={ts.frame_count} < {self.min_frames_for_count}, NOT counted")
                    ts.state = STATE_OUTSIDE

                elif ts.state == STATE_DOOR_UNKNOWN:
                    if mode == MODE_2ZONE and ts.birth_zone == ZONE_DOOR:
                        if ts.frame_count >= self.min_frames_for_count:
                            out_count += 1
                            if DEBUG_COUNTING:
                                print(f"  [COUNT] Track {track_id}: OUT +1 (2-zone: born_door→outside, frames={ts.frame_count})")
                        elif DEBUG_COUNTING:
                            print(f"  [REJECT] Track {track_id}: door_unknown→outside but frames={ts.frame_count} < {self.min_frames_for_count}, NOT counted")
                    elif DEBUG_COUNTING and mode == MODE_2ZONE:
                        print(f"  [REJECT] Track {track_id}: door_unknown→outside but birth_zone={ts.birth_zone} != door, NOT counted")
                    elif DEBUG_COUNTING and mode == MODE_3ZONE:
                        print(f"  [SKIP] Track {track_id}: door_unknown→outside in 3-zone mode, ambiguous, no count")
                    ts.state = STATE_OUTSIDE

                elif ts.state == STATE_INSIDE:
                    if ts.frame_count >= self.min_frames_for_count:
                        out_count += 1
                        if DEBUG_COUNTING:
                            print(f"  [COUNT] Track {track_id}: OUT +1 (direct inside→outside, frames={ts.frame_count})")
                    elif DEBUG_COUNTING:
                        print(f"  [REJECT] Track {track_id}: inside→outside but frames={ts.frame_count} < {self.min_frames_for_count}, NOT counted")
                    ts.state = STATE_OUTSIDE

                else:
                    ts.state = STATE_OUTSIDE

            elif current_zone == ZONE_DOOR:
                if ts.state == STATE_OUTSIDE:
                    ts.state = STATE_DOOR_ENTRY
                elif ts.state == STATE_INSIDE:
                    ts.state = STATE_DOOR_EXIT
                elif ts.state == STATE_NONE:
                    ts.state = STATE_DOOR_UNKNOWN

            elif current_zone == ZONE_INSIDE:
                if ts.state == STATE_DOOR_ENTRY:
                    if ts.frame_count >= self.min_frames_for_count:
                        in_count += 1
                        if DEBUG_COUNTING:
                            print(f"  [COUNT] Track {track_id}: IN +1 (outside→door→inside, frames={ts.frame_count})")
                    elif DEBUG_COUNTING:
                        print(f"  [REJECT] Track {track_id}: door_entry→inside but frames={ts.frame_count} < {self.min_frames_for_count}, NOT counted")
                    ts.state = STATE_INSIDE
                elif ts.state == STATE_DOOR_UNKNOWN:
                    ts.state = STATE_INSIDE
                elif ts.state == STATE_OUTSIDE:
                    if ts.frame_count >= self.min_frames_for_count:
                        in_count += 1
                        if DEBUG_COUNTING:
                            print(f"  [COUNT] Track {track_id}: IN +1 (direct outside→inside, frames={ts.frame_count})")
                    elif DEBUG_COUNTING:
                        print(f"  [REJECT] Track {track_id}: outside→inside but frames={ts.frame_count} < {self.min_frames_for_count}, NOT counted")
                    ts.state = STATE_INSIDE
                else:
                    ts.state = STATE_INSIDE

            # Log state transitions
            if DEBUG_COUNTING and ts.state != old_state:
                print(f"  [STATE] Track {track_id}: {old_state} → {ts.state} (zone={current_zone}, frames={ts.frame_count}, birth={ts.birth_zone})")

        return (in_count, out_count)

    # ------------------------------------------------------------------
    # Door buffer: match new track to recently-disappeared track
    # ------------------------------------------------------------------
    def _match_door_buffer(
        self, gid: str, centroid: tuple[float, float], now: float
    ) -> Optional[_DoorBufferEntry]:
        """
        Check if a new track in the door zone matches a recently-disappeared
        track (by position proximity + time window).
        Returns the matched buffer entry (and removes it) or None.
        """
        buf = self._door_buffer.get(gid, [])
        best_entry: Optional[_DoorBufferEntry] = None
        best_dist = float("inf")
        best_idx = -1

        for i, entry in enumerate(buf):
            elapsed = now - entry.disappear_time
            if elapsed > self.door_buffer_timeout:
                continue  # Too old, skip (will be cleaned up later)
            dist = math.dist(centroid, entry.last_position)
            if dist < self.door_buffer_distance and dist < best_dist:
                best_dist = dist
                best_entry = entry
                best_idx = i

        if best_entry is not None and best_idx >= 0:
            buf.pop(best_idx)

        return best_entry

    # ------------------------------------------------------------------
    # Disappear inference (with door buffer integration)
    # ------------------------------------------------------------------
    def _process_disappears(
        self,
        current_centroids: dict[int, tuple[float, float]],
    ) -> tuple[int, int, dict[str, tuple[int, int]]]:
        """
        Handle tracks that disappeared while transiting through the door zone.

        Two-phase approach:
        1. When a door-state track first disappears, add it to the door buffer
           (short-term memory). This gives the tracker a chance to re-detect the
           person with a new ID.
        2. After door_buffer_timeout, if no new track matched, proceed to
           normal disappear inference (IN/OUT counting).

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
            buf = self._door_buffer.setdefault(gid, [])

            for track_id, ts in states.items():
                if track_id in active_ids:
                    continue  # Still visible

                elapsed = now - ts.last_seen_time

                # Bufferable states: door states + outside/inside (for occlusion recovery)
                is_door_state = ts.state in (STATE_DOOR_ENTRY, STATE_DOOR_EXIT, STATE_DOOR_UNKNOWN)
                is_zone_state = ts.state in (STATE_OUTSIDE, STATE_INSIDE)

                # Phase 1: Recently disappeared track → add to buffer
                if is_door_state or (is_zone_state and ts.frame_count >= self.min_frames_for_count):
                    already_buffered = any(e.track_id == track_id for e in buf)
                    if not already_buffered and elapsed < self.door_buffer_timeout:
                        buf.append(_DoorBufferEntry(
                            track_id=track_id,
                            state=ts.state,
                            frame_count=ts.frame_count,
                            birth_zone=ts.birth_zone,
                            last_position=ts.last_position,
                            disappear_time=ts.last_seen_time,
                        ))
                        if DEBUG_COUNTING:
                            print(f"  [BUFFER+] Track {track_id}: added to buffer "
                                  f"(state={ts.state}, pos=({ts.last_position[0]:.3f},{ts.last_position[1]:.3f}), "
                                  f"frames={ts.frame_count})")
                        continue  # Don't process yet, wait for buffer timeout

                    # Phase 2: Buffer timeout expired → proceed to inference / cleanup
                    if elapsed >= self.door_buffer_timeout:
                        buf[:] = [e for e in buf if e.track_id != track_id]

                        if ts.state in (STATE_DOOR_ENTRY, STATE_DOOR_EXIT):
                            if ts.frame_count >= self.min_frames_for_count:
                                if ts.state == STATE_DOOR_ENTRY:
                                    g_in += 1
                                    if DEBUG_COUNTING:
                                        print(f"  [INFER] Track {track_id}: IN +1 (disappeared in door_entry after {elapsed:.1f}s, frames={ts.frame_count})")
                                else:
                                    g_out += 1
                                    if DEBUG_COUNTING:
                                        print(f"  [INFER] Track {track_id}: OUT +1 (disappeared in door_exit after {elapsed:.1f}s, frames={ts.frame_count})")
                            elif DEBUG_COUNTING:
                                print(f"  [REJECT] Track {track_id}: disappeared in {ts.state} after {elapsed:.1f}s but frames={ts.frame_count} < {self.min_frames_for_count}, NOT counted")
                            to_remove.append(track_id)

                        elif ts.state == STATE_DOOR_UNKNOWN and mode == MODE_2ZONE:
                            if DEBUG_COUNTING:
                                print(f"  [CLEANUP] Track {track_id}: door_unknown disappeared after {elapsed:.1f}s, went back inside, no count (frames={ts.frame_count})")
                            to_remove.append(track_id)

                        elif ts.state in (STATE_OUTSIDE, STATE_INSIDE):
                            # Outside/inside track wasn't matched → just clean up, no count
                            if DEBUG_COUNTING:
                                print(f"  [CLEANUP] Track {track_id}: {ts.state} buffer expired after {elapsed:.1f}s, no match, removing (frames={ts.frame_count})")
                            to_remove.append(track_id)

                        else:
                            to_remove.append(track_id)

                elif elapsed >= self.disappear_timeout * 3:
                    if DEBUG_COUNTING:
                        print(f"  [CLEANUP] Track {track_id}: stale state={ts.state} after {elapsed:.1f}s, frames={ts.frame_count}, removing")
                    to_remove.append(track_id)

            # Clean expired buffer entries
            buf[:] = [e for e in buf if (now - e.disappear_time) < self.door_buffer_timeout * 2]

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
        self.door_buffer_timeout = config.get("door_buffer_timeout", DEFAULT_DOOR_BUFFER_TIMEOUT)
        self.door_buffer_distance = config.get("door_buffer_distance", DEFAULT_DOOR_BUFFER_DISTANCE)

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
            self._door_buffer[gid] = []
        for gid in old_groups - new_groups:
            self._zone_track_states.pop(gid, None)
            self._group_totals.pop(gid, None)
            self._door_buffer.pop(gid, None)

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
        for gid in self._door_buffer:
            self._door_buffer[gid] = []

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
