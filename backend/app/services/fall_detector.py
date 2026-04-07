import math
from typing import Optional

import numpy as np

# COCO 17: 5,6 shoulders; 7,8 elbows; 9,10 wrists; 11,12 hips; 13,14 knees; 15,16 ankles
_TORSO_LIMB_IDX = (5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16)


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


def _parse_detection_sensitivity(conf: float | int) -> tuple[float, float]:
    """
    Returns (keypoint_conf_threshold_0_1, sensitivity_0_1).

    API / DB use 0–100 (FallDetectionConfig.detection_sensitivity). YOLO keypoint
    confidence is ~0–1. Higher UI sensitivity => react to less extreme poses =>
    lower keypoint bar and slightly looser angle/ratio gates.
    Legacy: pass a float in (0, 1] as direct keypoint threshold; sensitivity_0_1=0.75.
    """
    raw = float(conf)
    if raw > 1.0:
        s01 = max(0.0, min(1.0, raw / 100.0))
        # High sensitivity -> accept noisier keypoints (lower min confidence).
        kp_thr = max(0.06, min(0.92, 0.90 - 0.84 * s01))
        return kp_thr, s01
    kp_thr = max(0.05, min(0.99, raw))
    return kp_thr, 0.75


def body_keypoints_sufficient_for_fall(
    keypoints_data: np.ndarray,
    confidence_threshold: float,
) -> bool:
    """
    Require a near-full person in frame for fall detection: not head-only, foot-only,
    or a thin partial of the body.
    """
    if keypoints_data is None or keypoints_data.shape[0] < 17:
        return False

    def ok(i: int) -> bool:
        return float(keypoints_data[i][2]) >= confidence_threshold

    if not (ok(11) and ok(12)):
        return False
    if not (ok(5) or ok(6)):
        return False
    n = sum(1 for i in _TORSO_LIMB_IDX if ok(i))
    if n < 5:
        return False

    # Need real evidence of legs in the frame (not just inferred hips).
    has_ankle = ok(15) or ok(16)
    has_both_knees = ok(13) and ok(14)
    if not (has_ankle or has_both_knees):
        return False

    return True


def _should_skip_fall_head_only_or_tiny_body(
    keypoints_data: np.ndarray,
    person_bbox: list[float],
    confidence_threshold: float,
) -> bool:
    """
    Do not run fall logic for obvious head-only / hat-cam crops.

    - If neither shoulder passes the gate, we do not have a torso to interpret.
    - If any head keypoint (nose/eyes/ears) is confident but the vertical span of all
      confident joints is a small fraction of the bbox height, the person does not
      occupy the frame like a full-body fall.
    """
    x1, y1, x2, y2 = map(float, person_bbox)
    bw = x2 - x1
    bh = y2 - y1
    if bh <= 1e-6:
        return True

    if (
        float(keypoints_data[5][2]) < confidence_threshold
        and float(keypoints_data[6][2]) < confidence_threshold
    ):
        return True

    ys = [
        float(keypoints_data[i][1])
        for i in range(17)
        if float(keypoints_data[i][2]) >= confidence_threshold
    ]
    if len(ys) < 2:
        return True

    vspan = max(ys) - min(ys)
    head_visible = any(
        float(keypoints_data[i][2]) >= confidence_threshold for i in (0, 1, 2, 3, 4)
    )
    # Lying people often have a wide bbox and small *vertical* span; do not treat as head-only.
    portrait_or_square = bw <= bh * 1.2
    if head_visible and vspan < 0.30 * bh and portrait_or_square:
        return True

    return False


def _should_skip_missing_foot_zone_keypoints(
    keypoints_data: np.ndarray,
    person_bbox: list[float],
    confidence_threshold: float,
) -> bool:
    """
    Very close camera angles: legs never enter the frame, so nothing real should appear
    in the bottom band of the bbox (where feet would be in a standing full-body shot).

    Disabled for very wide boxes — in side-on falls the body is horizontal and feet may
    lie to the side rather than along the bottom edge in Y.
    """
    x1, y1, x2, y2 = map(float, person_bbox)
    bw, bh = x2 - x1, y2 - y1
    if bh <= 1e-6:
        return True

    if bw >= bh * 1.32:
        return False

    bottom_band_top = y2 - 0.15 * bh
    thr = confidence_threshold
    for i in range(17):
        if float(keypoints_data[i][2]) < thr:
            continue
        if float(keypoints_data[i][1]) >= bottom_band_top:
            return False
    return True


def _should_skip_upper_body_only_crop(
    keypoints_data: np.ndarray,
    person_bbox: list[float],
    confidence_threshold: float,
) -> bool:
    """
    Waist-up / chest-up: hips sit low in the bbox and little image remains below the hips.
    Catches cases where the model still assigns leg keypoints mid-torso.
    """
    x1, y1, x2, y2 = map(float, person_bbox)
    bw, bh = x2 - x1, y2 - y1
    if bh <= 1e-6:
        return True

    lh, rh = keypoints_data[11], keypoints_data[12]
    if float(lh[2]) < confidence_threshold or float(rh[2]) < confidence_threshold:
        return False

    hip_y = 0.5 * (float(lh[1]) + float(rh[1]))
    room_below_hip = y2 - hip_y
    hip_rel = (hip_y - y1) / bh

    if room_below_hip >= 0.34 * bh:
        return False

    if hip_rel >= 0.47 and room_below_hip < 0.33 * bh:
        return True

    if bw >= bh * 0.88 and hip_rel >= 0.36 and room_below_hip < 0.28 * bh:
        return True

    return False


def _should_skip_fall_incomplete_lower_body_keypoints(
    keypoints_data: np.ndarray,
    person_bbox: list[float],
    confidence_threshold: float,
) -> bool:
    """
    Close-up / steep top-down: legs not in frame — model may still assign knees. Require at
    least one knee or ankle clearly below the hip line, else do not run fall detection.
    """
    x1, y1, x2, y2 = map(float, person_bbox)
    bh = y2 - y1
    if bh <= 1e-6:
        return True

    lh, rh = keypoints_data[11], keypoints_data[12]
    if float(lh[2]) < confidence_threshold or float(rh[2]) < confidence_threshold:
        return False

    hip_y = 0.5 * (float(lh[1]) + float(rh[1]))
    band = 0.028 * bh
    n_below = 0
    for i in (13, 14, 15, 16):
        if float(keypoints_data[i][2]) < confidence_threshold:
            continue
        if float(keypoints_data[i][1]) > hip_y + band:
            n_below += 1

    if n_below > 0:
        return False
    # Lying-down poses can have knees level with hips (same Y); wide bbox => full-body scene.
    bw = x2 - x1
    if bw >= bh * 1.15:
        return False
    room_below = y2 - hip_y
    if room_below >= 0.30 * bh:
        return False
    return True


def _bbox_and_leg_keypoints_plausible_for_fall(
    person_bbox: list[float],
    keypoints_data: np.ndarray,
    confidence_threshold: float,
) -> bool:
    """
    Pose models often hallucinate knees/ankles with high score when legs are out of frame
    (steep top-down, vehicle crops). Reject those cases:

    - The bbox must extend enough *below* the hips to plausibly contain thighs + lower legs.
    - Every leg keypoint (13–16) that passes the confidence gate must lie inside the
      bbox (with a small margin) and not far above the hip line.
    """
    x1, y1, x2, y2 = map(float, person_bbox)
    bw = x2 - x1
    bh = y2 - y1
    if bh <= 1e-6:
        return False

    lh, rh = keypoints_data[11], keypoints_data[12]
    if float(lh[2]) < confidence_threshold or float(rh[2]) < confidence_threshold:
        return False
    hip_y = 0.5 * (float(lh[1]) + float(rh[1]))

    # Upper-body / dash-cam crop: hips sit near the bottom edge — not enough body below hips.
    room_below_hip = y2 - hip_y
    if room_below_hip < 0.19 * bh:
        return False

    margin = 0.03 * max(bw, bh)
    hip_band = 0.05 * bh
    for i in (13, 14, 15, 16):
        kp = keypoints_data[i]
        if float(kp[2]) < confidence_threshold:
            continue
        px, py = float(kp[0]), float(kp[1])
        if not (x1 - margin <= px <= x2 + margin and y1 - margin <= py <= y2 + margin):
            return False
        if py < hip_y - hip_band:
            return False

    return True


def _pelvis_above_feet_suppresses_fall(
    keypoints_data: np.ndarray,
    person_bbox: list[float],
    base_confidence: float,
) -> bool:
    """
    Strong prior: if feet (ankles) or knees — or wrists/elbows when reaching into a bucket —
    are clearly below the pelvis in image Y, the person is still vertically supported.

    Does not use bbox heuristics (avoids suppressing true floor falls). If no usable
    hip or no support point passes the relaxed bar, returns False.
    """
    x1, y1, x2, y2 = map(float, person_bbox)
    bbox_h = y2 - y1
    if bbox_h <= 1e-6:
        return False

    rel_hip = max(0.08, min(0.55, float(base_confidence) * 0.55))
    rel_limb = max(0.03, min(0.38, float(base_confidence) * 0.28))
    rel_arm = max(0.055, min(0.42, float(base_confidence) * 0.30))

    hip_ys: list[float] = []
    for i in (11, 12):
        c = float(keypoints_data[i][2])
        if c >= rel_hip:
            hip_ys.append(float(keypoints_data[i][1]))
    if not hip_ys:
        for i in (11, 12):
            if float(keypoints_data[i][2]) >= 0.06:
                hip_ys.append(float(keypoints_data[i][1]))
    if not hip_ys:
        return False
    hip_y = sum(hip_ys) / len(hip_ys)

    # Fallen people often plant hands below the hips; do not treat that as "standing support".
    hip_rel = (hip_y - y1) / bbox_h
    use_arms_for_support = hip_rel < 0.44

    margin = 0.014 * bbox_h
    support_y: float | None = None
    for i in (15, 16, 13, 14):
        if float(keypoints_data[i][2]) >= rel_limb:
            yy = float(keypoints_data[i][1])
            if yy > hip_y + margin:
                support_y = yy if support_y is None else max(support_y, yy)
    if use_arms_for_support:
        for i in (9, 10, 7, 8):
            if float(keypoints_data[i][2]) >= rel_arm:
                yy = float(keypoints_data[i][1])
                if yy > hip_y + 0.018 * bbox_h:
                    support_y = yy if support_y is None else max(support_y, yy)

    if support_y is None:
        return False

    return bool(support_y > hip_y + 0.040 * bbox_h)


def _collapsed_on_ground_do_not_treat_as_standing_bend(
    person_bbox: list[float],
    shoulder_mid_y: float,
    hip_mid_y: float,
    bbox_aspect_w_over_h: float,
) -> bool:
    """
    Fallen / sitting on floor: shoulders and hips are both low in the bbox. The box may be
    wide (w/h>1) *or* roughly square (w/h≈1): high-angle CCTV foreshortens a sprawled body
    so width and height look similar — do not require w/h>1.

    Do not apply the 'bending over' suppressor — hands may touch the floor below hips.
    Standing bends usually keep shoulders higher in the frame (smaller y).
    """
    x1, y1, x2, y2 = map(float, person_bbox)
    bh = y2 - y1
    if bh <= 1e-6:
        return False
    if bbox_aspect_w_over_h < 0.80 or bbox_aspect_w_over_h > 1.98:
        return False
    # Primary: both shoulders and hips well below the top ~third — collapsed, not upright stoop.
    if shoulder_mid_y >= y1 + 0.34 * bh and hip_mid_y >= y1 + 0.34 * bh:
        return True
    # Alternate: pelvis very low (prone/supine on floor). w/h may be ~1 from above; one leg
    # in the air must not require both shoulders “low” — hips alone mark a ground fall.
    if hip_mid_y >= y1 + 0.46 * bh and 0.74 <= bbox_aspect_w_over_h <= 1.48:
        return True
    return False


def _horizontal_torso_but_limbs_below_hips_not_fall(
    keypoints_data: np.ndarray,
    person_bbox: list[float],
    confidence_threshold: float,
    shoulder_hip_angle_deg: float,
    angle_slack_deg: float,
    bbox_aspect_w_over_h: float,
    hip_mid_y: float,
    shoulder_mid_y: float,
) -> bool:
    """
    Backup after would_fall: shoulder–hip line is nearly horizontal, bbox not *extremely*
    wide (forward bend also widens the box — do not disable this path at w/h≈1.3–1.5),
    and arms or legs still extend below the hip line (弯腰够物).

    When the person is already collapsed on the ground (shoulders+hips low, wide box), do
    not suppress — that path is for upright stooping with weight on feet.
    """
    x1, y1, x2, y2 = map(float, person_bbox)
    bh = y2 - y1
    if bh <= 1e-6:
        return False

    if _collapsed_on_ground_do_not_treat_as_standing_bend(
        person_bbox, shoulder_mid_y, hip_mid_y, bbox_aspect_w_over_h
    ):
        return False

    # Only skip for very flat, full-body horizontal silhouettes (side-on lying).
    if bbox_aspect_w_over_h > 1.92:
        return False

    if shoulder_hip_angle_deg >= min(72.0, 52.0 + angle_slack_deg * 0.48):
        return False

    rel = max(0.032, min(0.42, float(confidence_threshold) * 0.28))
    conf_floor = max(0.052, float(confidence_threshold) * 0.19)
    hip_y = float(hip_mid_y)
    m = 0.016 * bh
    relaxed = frozenset((15, 16, 13, 14, 9, 10))

    for i in (15, 16, 13, 14, 9, 10, 7, 8):
        c = float(keypoints_data[i][2])
        use = c >= rel or (i in relaxed and c >= conf_floor)
        if not use:
            continue
        if float(keypoints_data[i][1]) > hip_y + m:
            return True

    # w/h≈1.0–1.3 deep bend: prefer knees/ankles with a lower bar.
    if bbox_aspect_w_over_h >= 1.0:
        leg_floor = max(0.045, float(confidence_threshold) * 0.17)
        m2 = 0.012 * bh
        for i in (15, 16, 13, 14):
            if float(keypoints_data[i][2]) < leg_floor:
                continue
            if float(keypoints_data[i][1]) > hip_y + m2:
                return True

    return False


def _angle_at_vertex_deg(vertex: np.ndarray, arm_a: np.ndarray, arm_b: np.ndarray) -> float:
    """Interior angle at `vertex` formed with arm_a and arm_b (each x,y,conf)."""
    vx, vy = float(vertex[0]), float(vertex[1])
    ax, ay = float(arm_a[0]) - vx, float(arm_a[1]) - vy
    bx, by = float(arm_b[0]) - vx, float(arm_b[1]) - vy
    na = math.hypot(ax, ay)
    nb = math.hypot(bx, by)
    if na < 1e-6 or nb < 1e-6:
        return 180.0
    cos_t = max(-1.0, min(1.0, (ax * bx + ay * by) / (na * nb)))
    return math.degrees(math.acos(cos_t))


def _likely_squat_crouch_or_sit_not_fall(
    keypoints_data: np.ndarray,
    confidence_threshold: float,
    bbox_height: float,
    bbox_aspect_w_over_h: float,
) -> bool:
    """
    Squat / crouch / sit with bent knees while still weight-bearing (feet under pelvis).

    Previously we required w/h < 0.95, which disabled this path when the torso went
    horizontal and the bbox became wide — exactly the deep-squat case that looks like a fall.
    """
    if bbox_height <= 1e-6:
        return False

    l_hip, r_hip = keypoints_data[11], keypoints_data[12]
    l_ank, r_ank = keypoints_data[15], keypoints_data[16]
    if (
        l_hip[2] < confidence_threshold
        or r_hip[2] < confidence_threshold
        or l_ank[2] < confidence_threshold
        or r_ank[2] < confidence_threshold
    ):
        return False

    hip_y = 0.5 * (float(l_hip[1]) + float(r_hip[1]))
    ankle_y = 0.5 * (float(l_ank[1]) + float(r_ank[1]))
    hip_ankle_span = ankle_y - hip_y
    # Pelvis above feet (typical standing / squatting).
    if hip_ankle_span <= 0.04 * bbox_height:
        return False
    # Need a long hip–ankle segment in the image (squat/stand). Many floor-lying poses are
    # “flat”, so hip and ankles share almost the same row; deep squat still has large span.
    if hip_ankle_span <= 0.15 * bbox_height:
        return False

    for hip_i, knee_i, ankle_i in ((11, 13, 15), (12, 14, 16)):
        hip = keypoints_data[hip_i]
        knee = keypoints_data[knee_i]
        ankle = keypoints_data[ankle_i]
        if (
            hip[2] < confidence_threshold
            or knee[2] < confidence_threshold
            or ankle[2] < confidence_threshold
        ):
            continue
        ang = _angle_at_vertex_deg(knee, hip, ankle)
        # Straight leg ~180°. Deep squat is usually clearly acute.
        # When the bbox is already wide (torso horizontal), a shallow knee angle can still
        # occur in side-lying poses; require a deeper bend before calling it a squat.
        max_knee = 120.0 if bbox_aspect_w_over_h >= 1.0 else 142.0
        if ang < max_knee:
            return True
    return False


def _likely_stoop_straight_legs_not_fall(
    keypoints_data: np.ndarray,
    confidence_threshold: float,
    bbox_height: float,
    bbox_aspect_w_over_h: float,
) -> bool:
    """
    Standing forward bend with legs still extended (shopping cart, tying shoes, etc.).

    Torso + bbox look like a fall, but knees stay nearly straight and feet remain under
    the pelvis. High-angle cameras often put shoulders and hips at similar image Y, so
    this path does not rely on shoulder–hip vertical separation.
    """
    if bbox_height <= 1e-6:
        return False
    # Bending forward often shortens bbox height; from some angles w/h stays < 1, so keep
    # this threshold modest (aligns ~with fall condition1 ratio gates).
    if bbox_aspect_w_over_h < 0.48:
        return False

    l_hip, r_hip = keypoints_data[11], keypoints_data[12]
    l_ank, r_ank = keypoints_data[15], keypoints_data[16]
    if (
        l_hip[2] < confidence_threshold
        or r_hip[2] < confidence_threshold
        or l_ank[2] < confidence_threshold
        or r_ank[2] < confidence_threshold
    ):
        return False

    hip_y = 0.5 * (float(l_hip[1]) + float(r_hip[1]))
    ankle_y = 0.5 * (float(l_ank[1]) + float(r_ank[1]))
    hip_ankle = ankle_y - hip_y
    # Standing stoop: feet are well below the pelvis in Y. Flat-lying poses rarely keep this.
    if hip_ankle <= 0.12 * bbox_height:
        return False

    straight = 0
    for hip_i, knee_i, ankle_i in ((11, 13, 15), (12, 14, 16)):
        hip = keypoints_data[hip_i]
        knee = keypoints_data[knee_i]
        ankle = keypoints_data[ankle_i]
        if (
            hip[2] < confidence_threshold
            or knee[2] < confidence_threshold
            or ankle[2] < confidence_threshold
        ):
            continue
        ang = _angle_at_vertex_deg(knee, hip, ankle)
        # Leaning over a trolley: knees may be slightly flexed; allow moderate bend.
        if ang < 112.0:
            continue
        hy, ky, ay = float(hip[1]), float(knee[1]), float(ankle[1])
        if not (hy <= ky <= ay):
            continue
        if (ay - hy) < 0.06 * bbox_height:
            continue
        straight += 1

    if straight >= 1:
        return True

    # Knees often occluded (cart, bag, skirt) or mis-localised; pelvis–ankle span still
    # indicates upright support with a horizontal-ish bbox.
    lk, rk = keypoints_data[13], keypoints_data[14]
    knee_uncertain = lk[2] < confidence_threshold or rk[2] < confidence_threshold
    if (
        knee_uncertain
        and hip_ankle >= 0.11 * bbox_height
        and bbox_aspect_w_over_h >= 0.48
    ):
        return True

    return False


def _likely_standing_bent_weight_bearing_not_fall(
    keypoints_data: np.ndarray,
    confidence_threshold: float,
    bbox_height: float,
    shoulder_mid_y: float,
    bbox_aspect_w_over_h: float,
) -> bool:
    """
    Standing or stooping: pelvis is above the feet in image coordinates (y grows downward),
    and at least one leg shows hip -> knee -> ankle in vertical order with enough span.

    This filters false positives when someone bends forward deeply: shoulder–hip angle and
    bbox aspect ratio mimic a fall, but the person is still on their feet.

    Supine / side-lying on the floor often has hips and feet at similar image Y (side view)
    or does not show a long hip–ankle vertical gap, so this returns False there.
    """
    if bbox_height <= 1e-6:
        return False

    l_hip, r_hip = keypoints_data[11], keypoints_data[12]
    if l_hip[2] < confidence_threshold or r_hip[2] < confidence_threshold:
        return False
    hip_y = 0.5 * (float(l_hip[1]) + float(r_hip[1]))

    l_ank, r_ank = keypoints_data[15], keypoints_data[16]
    if l_ank[2] < confidence_threshold or r_ank[2] < confidence_threshold:
        return False
    ankle_y = 0.5 * (float(l_ank[1]) + float(r_ank[1]))
    hip_ankle_span = ankle_y - hip_y

    # Lying side-on: shoulders and hips share one “row”. High-angle CCTV stooping over a
    # cart also looks like that, but feet stay well below the pelvis — use span to tell.
    shoulder_row_like = abs(shoulder_mid_y - hip_y) < 0.07 * bbox_height
    if (
        bbox_aspect_w_over_h >= 1.0
        and shoulder_row_like
        and hip_ankle_span <= 0.13 * bbox_height
    ):
        return False

    # Feet clearly below pelvis (not a horizontal lying silhouette in typical side / oblique views).
    if ankle_y <= hip_y + 0.07 * bbox_height:
        return False

    for hip_i, knee_i, ankle_i in ((11, 13, 15), (12, 14, 16)):
        hip = keypoints_data[hip_i]
        knee = keypoints_data[knee_i]
        ankle = keypoints_data[ankle_i]
        if (
            hip[2] < confidence_threshold
            or knee[2] < confidence_threshold
            or ankle[2] < confidence_threshold
        ):
            continue
        hy, ky, ay = float(hip[1]), float(knee[1]), float(ankle[1])
        if hy < ky < ay and (ay - hy) > 0.10 * bbox_height:
            return True
    return False


def _head_face_near_floor_prone_fall(
    keypoints_data: np.ndarray,
    person_bbox: list[float],
    confidence_threshold: float,
) -> bool:
    """
    Face-down / fast collapse: head keypoints sit low in the bbox (near the ground plane
    in the image), hips are also low, bbox is not tall-narrow. Does not rely on the
    shoulder–hip angle (often steep during a fall). Used to keep fall_pose True steadily
    so the stream timer can reach "Fall detected".

    Standing deep bend: hips are usually higher in the box (smaller y) — we require hips
    clearly in the lower half of the bbox.
    """
    x1, y1, x2, y2 = map(float, person_bbox)
    bw, bh = x2 - x1, y2 - y1
    if bh <= 1e-6 or bw <= 0:
        return False
    ratio = bw / bh
    if ratio < 0.66 or ratio > 1.72:
        return False

    thr = float(confidence_threshold)
    head_floor = max(0.055, thr * 0.26)
    head_lowest_y: float | None = None
    for i in (0, 1, 2, 3, 4):
        if float(keypoints_data[i][2]) >= head_floor:
            yy = float(keypoints_data[i][1])
            head_lowest_y = yy if head_lowest_y is None else max(head_lowest_y, yy)

    if head_lowest_y is None:
        return False

    # Head / face in lower ~55% of person box (near floor in image coords).
    if head_lowest_y < y1 + 0.44 * bh:
        return False

    lh, rh = keypoints_data[11], keypoints_data[12]
    if float(lh[2]) < thr or float(rh[2]) < thr:
        return False
    hip_y = 0.5 * (float(lh[1]) + float(rh[1]))
    if hip_y < y1 + 0.40 * bh:
        return False

    sy_vals: list[float] = []
    for i in (5, 6):
        if float(keypoints_data[i][2]) >= thr:
            sy_vals.append(float(keypoints_data[i][1]))
    if not sy_vals:
        return False
    shoulder_y = sum(sy_vals) / len(sy_vals)

    v_sh_hip = abs(shoulder_y - hip_y)
    # Stacked prone / face-down: torso short in Y; or head extremely low (cheek on tiles).
    if head_lowest_y >= y1 + 0.54 * bh:
        return True
    if v_sh_hip <= 0.15 * bh and head_lowest_y >= y1 + 0.46 * bh:
        return True
    return False


def is_person_in_fall_pose(
    person_bbox: list[float],
    keypoints_data: Optional[np.ndarray],
    conf: float | int = 0.35,
    *,
    detection_sensitivity: float | int | None = None,
) -> bool:
    """
    Determine if one person is in fall pose using shoulder/hip angle and bbox ratio.

    Returns False when keypoints do not show enough body to evaluate, or when pose
    looks like squat/sit more than a fall (heuristic).

    The streaming pipeline maps this to UI "Fall risk" until an inactivity timer elapses
    (configured per camera); keeping this True frame-to-frame for a prone/supine person is
    required for the UI to show "Fall detected".
    """
    eff = detection_sensitivity if detection_sensitivity is not None else conf
    CONFIDENCE_THRESHOLD, sens01 = _parse_detection_sensitivity(eff)
    if person_bbox is None or len(person_bbox) < 4:
        return False

    if keypoints_data is None or keypoints_data.shape[0] < 17:
        return False

    if _should_skip_fall_head_only_or_tiny_body(
        keypoints_data, person_bbox, CONFIDENCE_THRESHOLD
    ):
        return False

    if _should_skip_missing_foot_zone_keypoints(
        keypoints_data, person_bbox, CONFIDENCE_THRESHOLD
    ):
        return False

    if _should_skip_upper_body_only_crop(
        keypoints_data, person_bbox, CONFIDENCE_THRESHOLD
    ):
        return False

    if _should_skip_fall_incomplete_lower_body_keypoints(
        keypoints_data, person_bbox, CONFIDENCE_THRESHOLD
    ):
        return False

    if not body_keypoints_sufficient_for_fall(keypoints_data, CONFIDENCE_THRESHOLD):
        return False

    if not _bbox_and_leg_keypoints_plausible_for_fall(
        person_bbox, keypoints_data, CONFIDENCE_THRESHOLD
    ):
        return False

    x1, y1, x2, y2 = person_bbox
    w = x2 - x1
    h = y2 - y1
    if h <= 0 or w <= 0:
        return False

    # Face / head near ground: skip pelvis–wrist "support" (hands on floor look like standing).
    if _head_face_near_floor_prone_fall(
        keypoints_data, person_bbox, CONFIDENCE_THRESHOLD
    ):
        return True

    if _pelvis_above_feet_suppresses_fall(
        keypoints_data, person_bbox, CONFIDENCE_THRESHOLD
    ):
        return False

    ratio = w / h

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

    ang = 12.0 * sens01
    r_loose = 0.12 * sens01
    condition1 = (current_angle < (40 + ang)) and (ratio > max(0.55, 0.7 - r_loose))
    condition2 = (current_angle < (55 + ang * 0.5)) and (ratio > max(1.0, 1.15 - r_loose))
    condition3 = ratio > max(1.15, 1.3 - 0.2 * sens01)
    # Sprawled on ground: bbox often ~square (w/h≈1) from above — condition2/3 miss that.
    condition_sprawl = (
        current_angle < (52 + ang * 0.45)
        and 0.78 <= ratio <= 1.30
        and _collapsed_on_ground_do_not_treat_as_standing_bend(
            person_bbox, shoulder_mid[1], hip_mid[1], ratio
        )
    )

    would_fall = bool(condition1 or condition2 or condition3 or condition_sprawl)
    if not would_fall:
        return False

    collapsed_ground = _collapsed_on_ground_do_not_treat_as_standing_bend(
        person_bbox, shoulder_mid[1], hip_mid[1], ratio
    )

    if _horizontal_torso_but_limbs_below_hips_not_fall(
        keypoints_data,
        person_bbox,
        CONFIDENCE_THRESHOLD,
        current_angle,
        ang,
        ratio,
        hip_mid[1],
        shoulder_mid[1],
    ):
        return False

    # On the ground, one leg may be kicked up: averaged ankles still look "below" hips like a
    # stoop — these suppressors are for standing weight-bearing only.
    if not collapsed_ground:
        if _likely_squat_crouch_or_sit_not_fall(
            keypoints_data, CONFIDENCE_THRESHOLD, h, ratio
        ):
            return False

        if _likely_stoop_straight_legs_not_fall(
            keypoints_data, CONFIDENCE_THRESHOLD, h, ratio
        ):
            return False

        if _likely_standing_bent_weight_bearing_not_fall(
            keypoints_data,
            CONFIDENCE_THRESHOLD,
            h,
            shoulder_mid[1],
            ratio,
        ):
            return False

    return True


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

        is_fall = is_person_in_fall_pose(bbox, kp, det.get("detection_sensitivity", 75))
        key = det.get("track_id") if det.get("track_id") is not None else i
        result[key] = is_fall
    return result