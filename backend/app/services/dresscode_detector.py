"""
Dress Code Detector Service

Loads the dress-code and slipper YOLO classification models and provides functions to:
1. Crop lower-body regions from a frame using COCO pose keypoints
2. Crop lower-leg / footwear regions for slipper detection
3. Classify the crops (e.g., long_pants vs shorts, slipper vs non_slipper)

The cropping logic mirrors scripts/prepare_training_data.py exactly
so that inference matches the training data distribution.
"""

import os
import sys
import __main__

import numpy as np
import cv2
from ultralytics import YOLO

BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROJECT_ROOT = os.path.dirname(BACKEND_ROOT)
DEFAULT_DRESSCODE_MODEL_PT_PATH = os.path.join(BACKEND_ROOT, "best.pt")
DEFAULT_SLIPPER_MODEL_PT_PATH = os.path.join(BACKEND_ROOT, "slipper-cls-best.pt")
DEFAULT_DRESSCODE_IMGSZ = int(os.getenv("DRESSCODE_MODEL_IMGSZ", "160"))
DEFAULT_SLIPPER_IMGSZ = int(os.getenv("SLIPPER_MODEL_IMGSZ", "224"))


def _resolve_classifier_model_path(env_var_name: str, default_pt_path: str) -> str:
    explicit_path = os.getenv(env_var_name)
    if explicit_path:
        return explicit_path

    engine_path = os.path.splitext(default_pt_path)[0] + ".engine"
    if os.path.exists(engine_path):
        return engine_path
    return default_pt_path


DRESSCODE_MODEL_PATH = _resolve_classifier_model_path("DRESSCODE_MODEL_PATH", DEFAULT_DRESSCODE_MODEL_PT_PATH)
SLIPPER_MODEL_PATH = _resolve_classifier_model_path("SLIPPER_MODEL_PATH", DEFAULT_SLIPPER_MODEL_PT_PATH)


def _register_slipper_checkpoint_custom_classes() -> None:
    """
    The slipper checkpoint was trained with a custom resize/pad transform, so torch
    needs the same class names available when the checkpoint is deserialized.
    """
    try:
        if PROJECT_ROOT not in sys.path:
            sys.path.insert(0, PROJECT_ROOT)
        import scripts.train_yolo26_classifier as train_mod

        __main__.ResizePadSquare = train_mod.ResizePadSquare
        if getattr(train_mod, "SlipperClassificationDataset", None) is not None:
            __main__.SlipperClassificationDataset = train_mod.SlipperClassificationDataset
        if getattr(train_mod, "SlipperTrainer", None) is not None:
            __main__.SlipperTrainer = train_mod.SlipperTrainer
        if getattr(train_mod, "SlipperValidator", None) is not None:
            __main__.SlipperValidator = train_mod.SlipperValidator
    except Exception as e:
        print(f"[System] Warning: Failed to register slipper checkpoint classes: {e}")


def _load_classifier(
    model_path: str,
    *,
    description: str,
    default_pt_path: str,
    default_imgsz: int,
    register_custom_classes: bool = False,
):
    def _attempt_load(path: str):
        print(f"[System] Loading {description} Classification Model ({path})...")
        if register_custom_classes and path.lower().endswith(".pt"):
            _register_slipper_checkpoint_custom_classes()
        model = YOLO(path, task="classify")
        class_names = model.names
        model_args = getattr(model.model, "args", {}) if hasattr(model, "model") else {}
        imgsz = int(model_args.get("imgsz", default_imgsz)) if isinstance(model_args, dict) else default_imgsz
        backend = "TensorRT" if path.lower().endswith(".engine") else "PyTorch"
        print(f"[System] {description} model loaded via {backend}. imgsz={imgsz}. Classes: {class_names}")
        return model, class_names, imgsz

    try:
        return _attempt_load(model_path)
    except Exception as e:
        if model_path != default_pt_path and os.path.exists(default_pt_path):
            print(
                f"[System] Warning: Failed to load {description} model '{model_path}', "
                f"falling back to '{default_pt_path}': {e}"
            )
            try:
                return _attempt_load(default_pt_path)
            except Exception as fallback_error:
                print(f"[System] Warning: Failed to load fallback {description} model: {fallback_error}")
                return None, {}, default_imgsz

        print(f"[System] Warning: Failed to load {description} model: {e}")
        return None, {}, default_imgsz


dresscode_model, dresscode_class_names, dresscode_imgsz = _load_classifier(
    DRESSCODE_MODEL_PATH,
    description="Dress Code",
    default_pt_path=DEFAULT_DRESSCODE_MODEL_PT_PATH,
    default_imgsz=DEFAULT_DRESSCODE_IMGSZ,
)
slipper_model, slipper_class_names, slipper_imgsz = _load_classifier(
    SLIPPER_MODEL_PATH,
    description="Slipper",
    default_pt_path=DEFAULT_SLIPPER_MODEL_PT_PATH,
    default_imgsz=DEFAULT_SLIPPER_IMGSZ,
    register_custom_classes=True,
)


MIN_PERSON_HEIGHT = 160  # Minimum person bbox height in pixels (matches training quality)
MIN_SLIPPER_CROP_SIZE = 96  # Matches the minimum size used in prepare_training_data.py


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


def crop_slipper_region(frame: np.ndarray, bbox, keypoints=None) -> tuple:
    """
    Crop the legs/footwear region from a frame using pose keypoints.

    Mirrors the training script legs crop:
    - Requires pose keypoints to exist
    - Uses knee_y = average(knee_left, knee_right) when available
    - Falls back to 75% of the person box height when knee points are missing
    - Crop = (x1, knee_y, x2, box_bottom)
    - Requires the final crop to be at least MIN_SLIPPER_CROP_SIZE in both dimensions
    """
    h, w = frame.shape[:2]
    px1, py1, px2, py2 = map(float, bbox)

    person_h = py2 - py1
    if person_h < MIN_PERSON_HEIGHT:
        return None, None

    if keypoints is None or len(keypoints) < 17:
        return None, None

    kps = keypoints
    if kps[13][1] > 0 and kps[14][1] > 0:
        knee_y = float(np.mean([kps[13][1], kps[14][1]]))
    else:
        knee_y = float(py1 + person_h * 0.75)

    if knee_y >= py2:
        return None, None

    nx1 = max(0, int(px1))
    ny1 = max(0, int(knee_y))
    nx2 = min(w, int(px2))
    ny2 = min(h, int(py2))

    if nx2 <= nx1 or ny2 <= ny1:
        return None, None

    crop = frame[ny1:ny2, nx1:nx2]
    if crop.size == 0:
        return None, None
    if crop.shape[0] < MIN_SLIPPER_CROP_SIZE or crop.shape[1] < MIN_SLIPPER_CROP_SIZE:
        return None, None

    return crop, (nx1, ny1, nx2, ny2)


def _parse_predictions(raw_results, class_names: dict) -> list[dict | None]:
    parsed_results: list[dict | None] = []
    for raw in raw_results:
        if raw.probs is None:
            parsed_results.append(None)
            continue

        top1_idx = int(raw.probs.top1)
        top1_conf = float(raw.probs.top1conf)
        label = class_names.get(top1_idx, f"class_{top1_idx}")
        parsed_results.append(
            {
                "label": label,
                "confidence": round(top1_conf, 3),
            }
        )

    return parsed_results


def _predict_batch(
    model,
    class_names: dict,
    crops: list[np.ndarray],
    *,
    imgsz: int,
    device: str | None = None,
) -> list[dict | None]:
    if model is None or not crops:
        return [None] * len(crops)

    classify_kwargs = {
        "verbose": False,
        "imgsz": imgsz,
    }
    if device:
        classify_kwargs["device"] = device

    try:
        raw_results = model(crops, **classify_kwargs)
        return _parse_predictions(raw_results, class_names)
    except Exception as e:
        print(f"[DressCode] Batch classification error: {e}")
        return [None] * len(crops)


def _finalize_combined_result(entry: dict) -> dict | None:
    classifications = entry.get("classifications") or []
    if not classifications:
        return None

    primary = next(
        (item for item in classifications if item.get("region") == "lower_body"),
        classifications[0],
    )
    entry["label"] = primary.get("label")
    entry["confidence"] = primary.get("confidence")
    return entry


def classify_lower_body(
    frame: np.ndarray,
    bbox,
    keypoints=None,
    device: str | None = None,
    enable_pants: bool = True,
    enable_slipper: bool = True,
) -> dict | None:
    """
    Crop the lower body and/or footwear and classify them.

    Args:
        frame: Full-resolution frame
        bbox: Person bounding box (x1, y1, x2, y2)
        keypoints: COCO 17-point keypoints or None
        device: CUDA device id

    Returns:
        Dict with combined classification result, or None if classification failed:
        {
            "label": "shorts",
            "confidence": 0.91,
            "lower_bbox": [x1, y1, x2, y2],
            "slipper_bbox": [x1, y1, x2, y2] | None,
            "classifications": [
                {"label": "shorts", "confidence": 0.91, "region": "lower_body"},
                {"label": "slipper", "confidence": 0.84, "region": "footwear"},
            ]
        }
    """
    results = classify_lower_body_batch(
        frame,
        [{"bbox": bbox, "keypoints": keypoints}],
        device=device,
        enable_pants=enable_pants,
        enable_slipper=enable_slipper,
    )
    return results[0] if results else None


def classify_lower_body_batch(
    frame: np.ndarray,
    bbox_keypoint_items: list[dict],
    device: str | None = None,
    enable_pants: bool = True,
    enable_slipper: bool = True,
) -> list[dict | None]:
    """
    Batch classify lower-body crops for one frame.

    Args:
        frame: Full-resolution frame
        bbox_keypoint_items: List of {"bbox": [...], "keypoints": ...}
        device: CUDA device id

    Returns:
        List aligned with input items. Each entry is classification dict or None.
    """
    if not enable_pants and not enable_slipper:
        return [None] * len(bbox_keypoint_items)

    if (dresscode_model is None or not enable_pants) and (slipper_model is None or not enable_slipper):
        return [None] * len(bbox_keypoint_items)

    if not bbox_keypoint_items:
        return []

    lower_pending_indices: list[int] = []
    lower_crops: list[np.ndarray] = []
    lower_bboxes: list[tuple[int, int, int, int]] = []
    slipper_pending_indices: list[int] = []
    slipper_crops: list[np.ndarray] = []
    slipper_bboxes: list[tuple[int, int, int, int]] = []
    results: list[dict | None] = [None] * len(bbox_keypoint_items)

    for idx, item in enumerate(bbox_keypoint_items):
        bbox = item.get("bbox")
        keypoints = item.get("keypoints")
        if bbox is None:
            continue

        entry = {
            "label": None,
            "confidence": None,
            "lower_bbox": None,
            "slipper_bbox": None,
            "classifications": [],
        }
        results[idx] = entry

        lower_crop, lower_bbox = crop_lower_body(frame, bbox, keypoints)
        if lower_crop is not None and dresscode_model is not None and enable_pants:
            if lower_crop.shape[0] >= 32 and lower_crop.shape[1] >= 32:
                lower_pending_indices.append(idx)
                lower_crops.append(lower_crop)
                lower_bboxes.append(lower_bbox)

        slipper_crop, slipper_bbox = crop_slipper_region(frame, bbox, keypoints)
        if slipper_crop is not None and slipper_model is not None and enable_slipper:
            slipper_pending_indices.append(idx)
            slipper_crops.append(slipper_crop)
            slipper_bboxes.append(slipper_bbox)

    lower_predictions = _predict_batch(
        dresscode_model,
        dresscode_class_names,
        lower_crops,
        imgsz=dresscode_imgsz,
        device=device,
    )
    slipper_predictions = _predict_batch(
        slipper_model,
        slipper_class_names,
        slipper_crops,
        imgsz=slipper_imgsz,
        device=device,
    )

    for batch_pos, prediction in enumerate(lower_predictions):
        if prediction is None:
            continue
        result_index = lower_pending_indices[batch_pos]
        entry = results[result_index]
        if entry is None:
            continue
        entry["lower_bbox"] = list(map(int, lower_bboxes[batch_pos]))
        entry["classifications"].append(
            {
                "label": prediction["label"],
                "confidence": prediction["confidence"],
                "region": "lower_body",
            }
        )

    for batch_pos, prediction in enumerate(slipper_predictions):
        if prediction is None:
            continue
        result_index = slipper_pending_indices[batch_pos]
        entry = results[result_index]
        if entry is None:
            continue
        entry["slipper_bbox"] = list(map(int, slipper_bboxes[batch_pos]))
        entry["classifications"].append(
            {
                "label": prediction["label"],
                "confidence": prediction["confidence"],
                "region": "footwear",
            }
        )

    for idx, entry in enumerate(results):
        finalized = _finalize_combined_result(entry) if entry is not None else None
        results[idx] = finalized

    return results


def classify_lower_body_multi_frame_batch(
    items: list[dict],
    device: str | None = None,
    enable_pants: bool = True,
    enable_slipper: bool = True,
) -> list[dict | None]:
    """
    Batch classify lower-body crops across multiple frames/streams.

    Args:
        items: List of {"frame": np.ndarray, "bbox": [...], "keypoints": ...}
        device: CUDA device id

    Returns:
        List aligned with input items. Each entry is classification dict or None.
    """
    if not enable_pants and not enable_slipper:
        return [None] * len(items)

    if (dresscode_model is None or not enable_pants) and (slipper_model is None or not enable_slipper):
        return [None] * len(items)

    if not items:
        return []

    lower_pending_indices: list[int] = []
    lower_crops: list[np.ndarray] = []
    lower_bboxes: list[tuple[int, int, int, int]] = []
    slipper_pending_indices: list[int] = []
    slipper_crops: list[np.ndarray] = []
    slipper_bboxes: list[tuple[int, int, int, int]] = []
    results: list[dict | None] = [None] * len(items)

    for idx, item in enumerate(items):
        frame = item.get("frame")
        bbox = item.get("bbox")
        keypoints = item.get("keypoints")
        if frame is None or bbox is None:
            continue

        entry = {
            "label": None,
            "confidence": None,
            "lower_bbox": None,
            "slipper_bbox": None,
            "classifications": [],
        }
        results[idx] = entry

        lower_crop, lower_bbox = crop_lower_body(frame, bbox, keypoints)
        if lower_crop is not None and dresscode_model is not None and enable_pants:
            if lower_crop.shape[0] >= 32 and lower_crop.shape[1] >= 32:
                lower_pending_indices.append(idx)
                lower_crops.append(lower_crop)
                lower_bboxes.append(lower_bbox)

        slipper_crop, slipper_bbox = crop_slipper_region(frame, bbox, keypoints)
        if slipper_crop is not None and slipper_model is not None and enable_slipper:
            slipper_pending_indices.append(idx)
            slipper_crops.append(slipper_crop)
            slipper_bboxes.append(slipper_bbox)

    lower_predictions = _predict_batch(
        dresscode_model,
        dresscode_class_names,
        lower_crops,
        imgsz=dresscode_imgsz,
        device=device,
    )
    slipper_predictions = _predict_batch(
        slipper_model,
        slipper_class_names,
        slipper_crops,
        imgsz=slipper_imgsz,
        device=device,
    )

    for batch_pos, prediction in enumerate(lower_predictions):
        if prediction is None:
            continue
        result_index = lower_pending_indices[batch_pos]
        entry = results[result_index]
        if entry is None:
            continue
        entry["lower_bbox"] = list(map(int, lower_bboxes[batch_pos]))
        entry["classifications"].append(
            {
                "label": prediction["label"],
                "confidence": prediction["confidence"],
                "region": "lower_body",
            }
        )

    for batch_pos, prediction in enumerate(slipper_predictions):
        if prediction is None:
            continue
        result_index = slipper_pending_indices[batch_pos]
        entry = results[result_index]
        if entry is None:
            continue
        entry["slipper_bbox"] = list(map(int, slipper_bboxes[batch_pos]))
        entry["classifications"].append(
            {
                "label": prediction["label"],
                "confidence": prediction["confidence"],
                "region": "footwear",
            }
        )

    for idx, entry in enumerate(results):
        finalized = _finalize_combined_result(entry) if entry is not None else None
        results[idx] = finalized

    return results


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
