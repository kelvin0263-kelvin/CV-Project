"""
People Counting Service

Provides line-crossing detection (segment intersection + cross product)
and ROI zone counting (ray-casting point-in-polygon) logic.

All line/zone coordinates are stored in normalized (0-1) form and
converted to pixel coordinates at runtime using the frame shape.
"""

import uuid
import time
from typing import Optional


class PeopleCounter:
    """
    Stateful people counter for a single camera/view.

    Maintains per-track centroid history and cumulative In/Out counts.
    """

    def __init__(self, config: dict):
        self.lines = config.get("lines", [])
        self.zones = config.get("zones", [])
        self.max_capacity = config.get("max_capacity")
        self.enabled = config.get("enabled", True)

        # Tracking state
        self.prev_centroids: dict[int, tuple[float, float]] = {}  # track_id -> (x, y) normalised
        self.total_in = 0
        self.total_out = 0
        self.capacity_alert_fired = False

        # Snapshot timing
        self._last_snapshot_time = time.time()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def update(self, detections: list[dict], frame_shape: tuple[int, int]) -> dict:
        """
        Process one frame of detections and return counting data.

        Args:
            detections: list of dicts with at least {track_id, person_bbox: [x1,y1,x2,y2]}
                        bboxes are in pixel coordinates for the full-resolution frame
            frame_shape: (height, width) of the full-resolution frame

        Returns:
            dict with {total_in, total_out, occupancy, zone_counts,
                        capacity_exceeded, lines, zones}
        """
        if not self.enabled:
            return self._empty_result()

        h, w = frame_shape

        # 1. Compute normalised centroids for this frame
        #    Priority: ankle midpoint -> hip midpoint -> bbox bottom-center
        current_centroids: dict[int, tuple[float, float]] = {}
        for det in detections:
            track_id = det.get("track_id")
            bbox = det.get("person_bbox")
            if track_id is None or bbox is None:
                continue

            kps = det.get("keypoints")
            cx, cy = None, None

            if kps:
                # Try ankles first (most accurate ground contact point)
                la = kps.get("left_ankle")
                ra = kps.get("right_ankle")
                if la and ra:
                    cx = ((la[0] + ra[0]) / 2.0) / w
                    cy = ((la[1] + ra[1]) / 2.0) / h
                elif la:
                    cx = la[0] / w
                    cy = la[1] / h
                elif ra:
                    cx = ra[0] / w
                    cy = ra[1] / h
                else:
                    # Fall back to hips (more stable, less occluded)
                    lh = kps.get("left_hip")
                    rh = kps.get("right_hip")
                    if lh and rh:
                        cx = ((lh[0] + rh[0]) / 2.0) / w
                        cy = ((lh[1] + rh[1]) / 2.0) / h
                    elif lh:
                        cx = lh[0] / w
                        cy = lh[1] / h
                    elif rh:
                        cx = rh[0] / w
                        cy = rh[1] / h

            # Ultimate fallback: bbox bottom-center
            if cx is None or cy is None:
                cx = ((bbox[0] + bbox[2]) / 2.0) / w
                cy = bbox[3] / h  # bottom of box

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
                        else:  # right_to_left
                            if cross < 0:
                                self.total_in += 1
                            else:
                                self.total_out += 1

        # 3. Update previous centroids (keep only active tracks)
        self.prev_centroids = current_centroids

        # 4. ROI zone counting
        zone_counts: dict[str, int] = {}
        for zone_cfg in self.zones:
            zone_id = zone_cfg.get("id", "unknown")
            polygon = zone_cfg.get("points", [])
            if len(polygon) < 3:
                continue
            count = 0
            for _, centroid in current_centroids.items():
                if _point_in_polygon(centroid, polygon):
                    count += 1
            zone_counts[zone_id] = count

        # 5. Occupancy and capacity check
        occupancy = max(0, self.total_in - self.total_out)
        capacity_exceeded = False
        if self.max_capacity is not None and self.max_capacity > 0:
            capacity_exceeded = occupancy >= self.max_capacity

        return {
            "total_in": self.total_in,
            "total_out": self.total_out,
            "occupancy": occupancy,
            "zone_counts": zone_counts,
            "capacity_exceeded": capacity_exceeded,
            "lines": self.lines,
            "zones": self.zones,
            "max_capacity": self.max_capacity,
        }

    def should_snapshot(self, interval: float = 10.0) -> bool:
        """Return True if enough time has passed for a periodic snapshot."""
        now = time.time()
        if now - self._last_snapshot_time >= interval:
            self._last_snapshot_time = now
            return True
        return False

    def get_snapshot_data(self, camera_id: str) -> dict:
        """Build a snapshot dict suitable for DB persistence."""
        occupancy = max(0, self.total_in - self.total_out)
        zone_counts: dict[str, int] = {}
        # Zone counts from last frame are not stored here; caller can pass them
        return {
            "id": str(uuid.uuid4()),
            "camera_id": camera_id,
            "total_in": self.total_in,
            "total_out": self.total_out,
            "current_occupancy": occupancy,
            "zone_counts": zone_counts,
        }

    def check_capacity_alert(self) -> Optional[dict]:
        """
        Check if a capacity alert should be fired.
        Returns an event dict if alert should fire, None otherwise.
        Uses hysteresis: fires once when exceeded, resets when below.
        """
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
            # Reset so we fire again if it crosses again
            self.capacity_alert_fired = False

        return None

    def update_config(self, config: dict):
        """Hot-reload config without resetting counts."""
        self.lines = config.get("lines", [])
        self.zones = config.get("zones", [])
        self.max_capacity = config.get("max_capacity")
        self.enabled = config.get("enabled", True)

    def reset(self):
        """Reset all counters (e.g. on video loop)."""
        self.prev_centroids = {}
        self.total_in = 0
        self.total_out = 0
        self.capacity_alert_fired = False

    def _empty_result(self) -> dict:
        return {
            "total_in": 0,
            "total_out": 0,
            "occupancy": 0,
            "zone_counts": {},
            "capacity_exceeded": False,
            "lines": self.lines,
            "zones": self.zones,
            "max_capacity": self.max_capacity,
        }


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def _cross_product_sign(
    a: tuple[float, float],
    b: tuple[float, float],
    p: tuple[float, float],
) -> float:
    """
    Compute the sign of the cross product (b-a) x (p-a).
    Positive = p is to the left of line a->b
    Negative = p is to the right
    """
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])


def _on_segment(
    p: tuple[float, float],
    q: tuple[float, float],
    r: tuple[float, float],
) -> bool:
    """Check if point q lies on segment pr."""
    if (min(p[0], r[0]) <= q[0] <= max(p[0], r[0]) and
            min(p[1], r[1]) <= q[1] <= max(p[1], r[1])):
        return True
    return False


def _orientation(
    p: tuple[float, float],
    q: tuple[float, float],
    r: tuple[float, float],
) -> int:
    """
    Orientation of ordered triplet (p, q, r).
    0 -> colinear, 1 -> clockwise, 2 -> counterclockwise
    """
    val = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1])
    if abs(val) < 1e-10:
        return 0
    return 1 if val > 0 else 2


def _segments_intersect(
    p1: tuple[float, float],
    q1: tuple[float, float],
    p2: tuple[float, float],
    q2: tuple[float, float],
) -> bool:
    """
    Check if line segment p1-q1 intersects with p2-q2.
    Uses orientation-based algorithm.
    """
    o1 = _orientation(p1, q1, p2)
    o2 = _orientation(p1, q1, q2)
    o3 = _orientation(p2, q2, p1)
    o4 = _orientation(p2, q2, q1)

    # General case
    if o1 != o2 and o3 != o4:
        return True

    # Special collinear cases
    if o1 == 0 and _on_segment(p1, p2, q1):
        return True
    if o2 == 0 and _on_segment(p1, q2, q1):
        return True
    if o3 == 0 and _on_segment(p2, p1, q2):
        return True
    if o4 == 0 and _on_segment(p2, q1, q2):
        return True

    return False


def _point_in_polygon(
    point: tuple[float, float],
    polygon: list[list[float]],
) -> bool:
    """
    Ray-casting algorithm for point-in-polygon test.
    polygon is a list of [x, y] pairs (normalised 0-1 coordinates).
    """
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
