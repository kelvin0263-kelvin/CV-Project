import math
from typing import Optional

import numpy as np

# Same as user's code
CONFIDENCE_THRESHOLD = 0.3


def calculate_angle(p1: tuple[float, float], p2: tuple[float, float]) -> float:
    """Angle in degrees between horizontal and the line p1->p2 (vertical=90)."""
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2:
        return 90.0
    dy = abs(y1 - y2)
    dx = abs(x1 - x2)
    angle_rad = math.atan2(dy, dx)
    return math.degrees(angle_rad)


def is_person_in_fall_pose(
    person_bbox: list[float],
    keypoints_data: Optional[np.ndarray],
) -> bool:
    """
    Determine if one person is in fall pose using shoulder/hip angle and bbox ratio.
    keypoints_data: shape (17, 3) with (x, y, confidence). Indices 5,6 = shoulders, 11,12 = hips.
    Returns True if condition1 or condition2 (user's algorithm, unchanged).
    """
    if keypoints_data is None or keypoints_data.shape[0] < 17:
        return False

    x1, y1, x2, y2 = person_bbox
    w = x2 - x1
    h = y2 - y1
    ratio = w / h if h > 0 else 0

    # Keypoints: 5=left_shoulder, 6=right_shoulder, 11=left_hip, 12=right_hip
    l_shoulder = keypoints_data[5]
    r_shoulder = keypoints_data[6]
    l_hip = keypoints_data[11]
    r_hip = keypoints_data[12]

    s_x, s_y, s_count = 0.0, 0.0, 0
    if l_shoulder[2] >= CONFIDENCE_THRESHOLD:
        s_x += l_shoulder[0]
        s_y += l_shoulder[1]
        s_count += 1
    if r_shoulder[2] >= CONFIDENCE_THRESHOLD:
        s_x += r_shoulder[0]
        s_y += r_shoulder[1]
        s_count += 1

    h_x, h_y, h_count = 0.0, 0.0, 0
    if l_hip[2] >= CONFIDENCE_THRESHOLD:
        h_x += l_hip[0]
        h_y += l_hip[1]
        h_count += 1
    if r_hip[2] >= CONFIDENCE_THRESHOLD:
        h_x += r_hip[0]
        h_y += r_hip[1]
        h_count += 1

    if s_count == 0 or h_count == 0:
        return False

    shoulder_mid = (s_x / s_count, s_y / s_count)
    hip_mid = (h_x / h_count, h_y / h_count)
    current_angle = calculate_angle(shoulder_mid, hip_mid)

    # User's rules (unchanged)
    condition1 = (current_angle < 40) and (ratio > 0.7)
    condition2 = (current_angle < 55) and (ratio > 1.15)
    return bool(condition1 or condition2)


def process_detections(detections: list[dict]) -> dict[int | None, bool]:
    """
    Run fall-pose check on each detection.
    detections: list of dicts with keys person_bbox, keypoints_data (optional), track_id (optional).
    Returns: dict track_id -> is_fall_pose. Uses index as key if track_id is None.
    """
    result = {}
    for i, det in enumerate(detections):
        bbox = det.get("person_bbox")
        kp = det.get("keypoints_data")
        if bbox is None or len(bbox) < 4:
            continue
        if kp is not None and not isinstance(kp, np.ndarray):
            kp = np.array(kp, dtype=np.float32)
        is_fall = is_person_in_fall_pose(bbox, kp)
        key = det.get("track_id") if det.get("track_id") is not None else i
        result[key] = is_fall
    return result
