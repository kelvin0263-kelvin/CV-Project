"""
Dress Code Detector Service

Loads the best.pt YOLO classification model and provides functions to:
1. Crop lower-body regions from a frame using COCO pose keypoints
2. Classify the crop (e.g., long_pants vs shorts)

The cropping logic mirrors scripts/prepare_training_data.py exactly
so that inference matches the training data distribution.
"""

import numpy as np
import cv2
try:
    from ultralytics import YOLO
except Exception as _yolo_import_error:
    YOLO = None
    print(f"[System] Warning: ultralytics import failed: {_yolo_import_error}")

# ---------------------------------------------------------------------------
# Load classification model once at module level
# ---------------------------------------------------------------------------
print("[System] Loading Dress Code Classification Model (best.pt)...")
try:
    if YOLO is None:
        raise RuntimeError("ultralytics is unavailable")
    dresscode_model = YOLO("best.pt")
    dresscode_class_names = dresscode_model.names  # e.g. {0: 'long_pants', 1: 'shorts'}
    print(f"[System] Dress code model loaded. Classes: {dresscode_class_names}")
except Exception as e:
    print(f"[System] Warning: Failed to load dress code model: {e}")
    dresscode_model = None
    dresscode_class_names = {}


MIN_PERSON_HEIGHT = 160  # Minimum person bbox height in pixels (matches training quality)


def crop_lower_body(frame: np.ndarray, bbox, keypoints=None) -> tuple:
    """
    Crop the lower-body region from a frame using pose keypoints.

    Matches training script (prepare_training_data.py) quality filters:
    - Requires valid keypoints with both hips visible (no heuristic fallback)
    - Hip Y = average of keypoints 11,12 (COCO hip keypoints)
    - Lower body = (x1, hip_y, x2, box_bottom)
    - No padding (padding_percent=0, matching training)
    - Person bbox must be at least MIN_PERSON_HEIGHT pixels tall

    Args:
        frame: Full-resolution frame (numpy array, HxWxC)
        bbox: Person bounding box as (x1, y1, x2, y2)
        keypoints: COCO 17-point keypoints array, shape (17, 2) or None

    Returns:
        (crop_image, lower_bbox) or (None, None) if crop is invalid
    """
    h, w = frame.shape[:2]
    px1, py1, px2, py2 = map(float, bbox)

    # Filter: person bbox must be tall enough (training data was full-res)
    person_h = py2 - py1
    if person_h < MIN_PERSON_HEIGHT:
        return None, None

    # Require valid keypoints (training script line 236: if best_kp is not None)
    if keypoints is None or len(keypoints) < 17:
        return None, None

    # Both hip keypoints must be visible (training script line 246)
    kps = keypoints
    if kps[11][1] <= 0 or kps[12][1] <= 0:
        return None, None

    hip_y = float(np.mean([kps[11][1], kps[12][1]]))

    # Lower body: hip -> feet (matching training script line 265-267)
    if hip_y >= py2:
        return None, None

    # Crop with zero padding (matching training: crop_with_padding(..., 0))
    nx1 = max(0, int(px1))
    ny1 = max(0, int(hip_y))
    nx2 = min(w, int(px2))
    ny2 = min(h, int(py2))

    if nx2 <= nx1 or ny2 <= ny1:
        return None, None

    crop = frame[ny1:ny2, nx1:nx2]
    if crop.size == 0:
        return None, None

    return crop, (nx1, ny1, nx2, ny2)


def classify_lower_body(frame: np.ndarray, bbox, keypoints=None, device='0') -> dict | None:
    """
    Crop the lower body and classify it using best.pt.

    Args:
        frame: Full-resolution frame
        bbox: Person bounding box (x1, y1, x2, y2)
        keypoints: COCO 17-point keypoints or None
        device: CUDA device id

    Returns:
        Dict with classification result, or None if classification failed:
        {
            "label": "shorts",
            "confidence": 0.91,
            "lower_bbox": [x1, y1, x2, y2]  # lower-body crop coordinates
        }
    """
    if dresscode_model is None:
        return None

    crop, lower_bbox = crop_lower_body(frame, bbox, keypoints)
    if crop is None:
        return None

    # Skip if crop is too small for meaningful classification
    if crop.shape[0] < 32 or crop.shape[1] < 32:
        return None

    try:
        results = dresscode_model(
            crop,
            verbose=False,
            device=device,
        )

        if not results or len(results) == 0:
            return None

        r = results[0]
        # YOLO classification: r.probs contains class probabilities
        if r.probs is None:
            return None

        top1_idx = int(r.probs.top1)
        top1_conf = float(r.probs.top1conf)
        label = dresscode_class_names.get(top1_idx, f"class_{top1_idx}")

        return {
            "label": label,
            "confidence": round(top1_conf, 3),
            "lower_bbox": list(map(int, lower_bbox)),
        }

    except Exception as e:
        print(f"[DressCode] Classification error: {e}")
        return None


def crop_full_person(frame: np.ndarray, bbox, padding_percent=0.05) -> np.ndarray | None:
    """
    Crop the full person with slight padding for snapshot evidence.
    Uses the same crop_with_padding logic as the training script.
    """
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = map(float, bbox)

    bw = x2 - x1
    bh = y2 - y1
    pad_w = int(bw * padding_percent)
    pad_h = int(bh * padding_percent)

    nx1 = max(0, int(x1 - pad_w))
    ny1 = max(0, int(y1 - pad_h))
    nx2 = min(w, int(x2 + pad_w))
    ny2 = min(h, int(y2 + pad_h))

    if nx2 <= nx1 or ny2 <= ny1:
        return None

    crop = frame[ny1:ny2, nx1:nx2]
    return crop if crop.size > 0 else None
