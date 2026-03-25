"""
Video Producer Service

Reads video frames, runs YOLO-Pose tracking (BoT-SORT), classifies
lower-body clothing via dresscode_detector, and streams clean frames
+ detection metadata to FRAME_BUFFERS for WebSocket consumption.
"""

import threading
import cv2
import time
import base64
import sys
import os
import uuid
import queue
import hashlib
import re
import subprocess
import inspect
from collections import deque
import numpy as np

# Ensure backend root is in path to import DefishVideoCV
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from DefishVideoCV import FisheyeMultiView
from app.core.video_capture import is_rtsp_source, open_video_capture
from app.core.globals import (
    FRAME_BUFFERS,
    PRODUCER_THREADS,
    PRODUCER_STOP_EVENTS,
    PRODUCER_META,
    PRODUCER_LOCK,
)
from ultralytics import YOLO
from ultralytics.engine.results import Boxes
from ultralytics.trackers.track import TRACKER_MAP
from turbojpeg import TurboJPEG
from ultralytics.utils import IterableSimpleNamespace, YAML
from app.services.dresscode_detector import (
    classify_lower_body_batch,
    classify_lower_body_multi_frame_batch,
    crop_full_person,
)
from app.services.fall_detector import is_person_in_fall_pose
from app.services.building_counter import ingest_sensor_events
from app.services.cross_camera_verifier import (
    apply_primary_camera_correction,
    get_verifier_camera_status,
    observe_verifier_tracks,
    register_primary_in_events,
    register_primary_out_events,
    reset_cross_camera_state,
)
from app.services.people_counter import PeopleCounter
from app.services.source_roi_registry import get_source_detection_roi
from app.routers.counting_router import (
    consume_counting_reset,
    get_counting_views,
    get_counting_camera_id,
    get_counting_config,
    update_live_counts,
    queue_counting_snapshot,
)
from app.routers.fall_detection_router import (
    get_fall_detection_camera_id,
    get_fall_detection_config,
    get_fall_detection_views,
)

# ---------------------------------------------------------------------------
# Snapshot output directory
# ---------------------------------------------------------------------------
BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROJECT_ROOT = os.path.dirname(BACKEND_ROOT)
UPLOAD_ROOT = os.path.abspath(os.path.join(PROJECT_ROOT, "temp_video_uploads"))
SNAPSHOT_DIR = os.path.join(PROJECT_ROOT, "temp_video_uploads", "snapshots")
os.makedirs(SNAPSHOT_DIR, exist_ok=True)


# Fixed runtime tuning for the current project.
# POSE_MODEL_PT_PATH = os.path.join(BACKEND_ROOT, "yolov8l-pose.pt")
POSE_MODEL_ENGINE_PATH = os.path.join(BACKEND_ROOT, "yolov8m-pose.engine")
POSE_MODEL_PT_PATH = "yolov8m-pose.pt"
# POSE_MODEL_ENGINE_PATH = ""

TRACKER_CONFIG_PATH = os.path.join(BACKEND_ROOT, "botsort_custom.yaml")
YOLO_DEVICE = None
# POSE_TRACK_IMGSZ = (576,1024)
POSE_TRACK_IMGSZ = (416,736)
# POSE_TRACK_IMGSZ = 736
DETECTION_STRIDE = 1
COUNTING_SNAPSHOT_HEARTBEAT_SEC = 300

DRESSCODE_RECLASSIFY_INTERVAL_SEC = 1.0
DRESSCODE_VIOLATION_CONFIRMATIONS = 2
DRESSCODE_VIOLATION_WINDOW_SEC = 5.0
PERF_LOG_INTERVAL_FRAMES = 30
PERF_STAGE_LOGS = True
MULTI_STREAM_BATCH_INFER = True
BATCH_INFER_WINDOW_MS = 2
BATCH_INFER_MAX_BATCH = 5
BATCH_INFER_WAIT_MS = 1500
BATCH_INFER_LOG_INTERVAL = 30
ASYNC_CAPTURE_ENABLED = True
ASYNC_CAPTURE_QUEUE_SIZE = 2
ASYNC_CAPTURE_READ_TIMEOUT_MS = 1000
RTSP_ENABLE_NVDEC = False
RTSP_MAX_CONSECUTIVE_READ_FAILURES = 120
RTSP_READ_FAILURE_BACKOFF_MS = 50
RTSP_CORRUPT_FRAME_DETECTION_ENABLED = False
RTSP_CORRUPT_FRAME_RECOVERY_THRESHOLD = 999
RTSP_KEEP_LAST_FRAME_ON_RECOVERY = True
RTSP_CORRUPT_FRAME_STDDEV_MAX = 4.0
RTSP_CORRUPT_FRAME_RANGE_MAX = 18.0
RTSP_CORRUPT_FRAME_COLOR_DELTA_MAX = 2.5
RTSP_CORRUPT_FRAME_DIFF_MIN = 18.0
RTSP_CORRUPT_FRAME_EDGE_VAR_MAX = 0.0
RTSP_HW_FALLBACK_FAILURE_WINDOW_SEC = 10.0
RTSP_HW_FALLBACK_FAILURE_THRESHOLD = 3
NVENC_OUTPUT_ENABLED = False
NVENC_OUTPUT_DIR = os.path.join(PROJECT_ROOT, "temp_video_uploads", "nvenc_outputs")
NVENC_OUTPUT_CONTAINER = "mp4"
NVENC_CODEC = "h264_nvenc"
NVENC_PRESET = "p4"
NVENC_TUNE = "ll"
NVENC_RATE_CONTROL = "vbr"
NVENC_BITRATE_K = 2500
NVENC_MAXRATE_K = 3500
NVENC_BUFSIZE_K = 7000
FFMPEG_BIN = "ffmpeg"


def _resolve_pose_model_path() -> str:
    if os.path.exists(POSE_MODEL_ENGINE_PATH):
        return POSE_MODEL_ENGINE_PATH
    return POSE_MODEL_PT_PATH


POSE_MODEL_PATH = _resolve_pose_model_path()


def _pose_model_uses_engine() -> bool:
    return _resolve_pose_model_path().lower().endswith(".engine")


def _load_pose_model() -> YOLO:
    model_path = _resolve_pose_model_path()
    try:
        model = YOLO(model_path)
        print(f"[Model] Loaded pose model: {model_path}")
        return model
    except Exception as e:
        if model_path != POSE_MODEL_PT_PATH and os.path.exists(POSE_MODEL_PT_PATH):
            print(
                f"[Model] Failed to load pose engine '{model_path}', "
                f"falling back to '{POSE_MODEL_PT_PATH}': {e}"
            )
            model = YOLO(POSE_MODEL_PT_PATH)
            print(f"[Model] Loaded pose model: {POSE_MODEL_PT_PATH}")
            return model
        raise

# ---------------------------------------------------------------------------
# Initialize TurboJPEG
# ---------------------------------------------------------------------------
try:
    jpeg = TurboJPEG()
except Exception as e:
    print(f"[System] Warning: TurboJPEG not found: {e}. Using OpenCV fallback.")
    jpeg = None

# ---------------------------------------------------------------------------
# In-memory violation event queue (consumed by detection_router)
# ---------------------------------------------------------------------------
VIOLATION_QUEUE: list = []  # Thread-safe enough for append; consumed elsewhere
VIOLATION_QUEUE_LOCK = threading.Lock()


def queue_violation_event(event: dict):
    """Append a violation event to the in-memory queue for DB persistence."""
    with VIOLATION_QUEUE_LOCK:
        VIOLATION_QUEUE.append(event)


def drain_violation_queue() -> list:
    """Pop all queued events atomically. Called from the async event loop."""
    with VIOLATION_QUEUE_LOCK:
        events = list(VIOLATION_QUEUE)
        VIOLATION_QUEUE.clear()
    return events


def _build_source_meta(source_path: str) -> dict:
    is_rtsp_stream = is_rtsp_source(source_path)
    if is_rtsp_stream:
        return {
            "is_file_source": False,
            "is_uploaded_source": False,
            "is_rtsp_source": True,
            "is_network_stream_source": True,
        }

    source_abs = os.path.abspath(source_path)
    try:
        is_uploaded_source = os.path.commonpath([source_abs, UPLOAD_ROOT]) == UPLOAD_ROOT
    except ValueError:
        is_uploaded_source = False

    return {
        "is_file_source": os.path.isfile(source_abs),
        "is_uploaded_source": is_uploaded_source,
        "is_rtsp_source": False,
        "is_network_stream_source": False,
    }


def _sanitize_token(value: str, fallback: str = "stream") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", (value or "").strip()).strip("._-")
    return cleaned or fallback


def _build_frame_health_signature(frame: np.ndarray) -> np.ndarray | None:
    if frame is None or not isinstance(frame, np.ndarray) or frame.size == 0:
        return None
    if frame.ndim < 2 or frame.shape[0] < 2 or frame.shape[1] < 2:
        return None

    small = cv2.resize(frame, (64, 36), interpolation=cv2.INTER_AREA)
    if small.ndim == 2:
        gray = small.astype(np.float32)
    else:
        if small.shape[2] > 3:
            small = small[:, :, :3]
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
    return gray


def _set_runtime_stream_status(
    runtime_key: str,
    *,
    status: str,
    reason: str | None = None,
    clear_images: bool = False,
):
    with PRODUCER_LOCK:
        producer_meta = dict(PRODUCER_META.get(runtime_key, {}))
        producer_meta["stream_status"] = status
        if reason:
            producer_meta["stream_reason"] = reason
        else:
            producer_meta.pop("stream_reason", None)
        PRODUCER_META[runtime_key] = producer_meta

        current_buffer = FRAME_BUFFERS.get(runtime_key)
        if clear_images or current_buffer is None:
            current_buffer = {}
        else:
            current_buffer = {
                key: value for key, value in current_buffer.items() if key == "__meta__"
            }

        meta = dict(current_buffer.get("__meta__", {}))
        meta["stream_status"] = status
        if reason:
            meta["stream_reason"] = reason
        else:
            meta.pop("stream_reason", None)
        current_buffer["__meta__"] = meta
        FRAME_BUFFERS[runtime_key] = current_buffer


def _detect_corrupted_rtsp_frame(
    frame: np.ndarray,
    previous_signature: np.ndarray | None,
) -> tuple[bool, str | None, np.ndarray | None]:
    signature = _build_frame_health_signature(frame)
    if signature is None:
        return True, "empty_or_invalid_frame", None

    if not np.isfinite(signature).all():
        return True, "non_finite_pixels", None

    if not RTSP_CORRUPT_FRAME_DETECTION_ENABLED:
        return False, None, signature

    stddev = float(signature.std())
    luma_range = float(signature.max() - signature.min())

    color_delta = 0.0
    if frame.ndim == 3 and frame.shape[2] >= 3:
        small = cv2.resize(frame[:, :, :3], (64, 36), interpolation=cv2.INTER_AREA).astype(np.float32)
        color_delta = float(
            (
                np.abs(small[:, :, 0] - small[:, :, 1])
                + np.abs(small[:, :, 1] - small[:, :, 2])
                + np.abs(small[:, :, 0] - small[:, :, 2])
            ).mean() / 3.0
        )

    if previous_signature is None:
        return False, None, signature

    frame_diff = float(np.mean(np.abs(signature - previous_signature)))
    edge_var = float(cv2.Laplacian(signature, cv2.CV_32F).var())
    if (
        stddev <= RTSP_CORRUPT_FRAME_STDDEV_MAX
        and luma_range <= RTSP_CORRUPT_FRAME_RANGE_MAX
        and color_delta <= RTSP_CORRUPT_FRAME_COLOR_DELTA_MAX
        and frame_diff >= RTSP_CORRUPT_FRAME_DIFF_MIN
    ):
        reason = (
            "suspected_decoder_corruption"
            f"(std={stddev:.1f},range={luma_range:.1f},color={color_delta:.1f},diff={frame_diff:.1f})"
        )
        return True, reason, signature

    if (
        RTSP_CORRUPT_FRAME_EDGE_VAR_MAX > 0.0
        and edge_var <= RTSP_CORRUPT_FRAME_EDGE_VAR_MAX
        and frame_diff >= (RTSP_CORRUPT_FRAME_DIFF_MIN * 0.75)
        and stddev <= max(RTSP_CORRUPT_FRAME_STDDEV_MAX * 2.0, RTSP_CORRUPT_FRAME_STDDEV_MAX + 4.0)
        and color_delta <= max(RTSP_CORRUPT_FRAME_COLOR_DELTA_MAX * 2.0, 6.0)
    ):
        reason = (
            "suspected_blurred_decoder_corruption"
            f"(edge_var={edge_var:.1f},std={stddev:.1f},range={luma_range:.1f},"
            f"color={color_delta:.1f},diff={frame_diff:.1f})"
        )
        return True, reason, signature

    return False, None, signature


def _build_perf_dict(
    *,
    detect_ms: float = 0.0,
    detect_total_ms: float | None = None,
    batch_size: int = 1,
    classify_ms: float = 0.0,
    classify_candidates: int = 0,
    classified: int = 0,
    infer_wait_ms: float = 0.0,
    infer_queue_wait_ms: float = 0.0,
    infer_predict_ms: float = 0.0,
    infer_predict_total_ms: float | None = None,
    infer_post_ms: float = 0.0,
) -> dict:
    return {
        "detect_ms": detect_ms,
        "detect_total_ms": detect_ms if detect_total_ms is None else detect_total_ms,
        "batch_size": batch_size,
        "classify_ms": classify_ms,
        "classify_candidates": classify_candidates,
        "classified": classified,
        "infer_wait_ms": infer_wait_ms,
        "infer_queue_wait_ms": infer_queue_wait_ms,
        "infer_predict_ms": infer_predict_ms,
        "infer_predict_total_ms": (
            infer_predict_ms if infer_predict_total_ms is None else infer_predict_total_ms
        ),
        "infer_post_ms": infer_post_ms,
    }


def _empty_detection_result(
    track_state: dict,
    *,
    batch_size: int = 1,
    detect_ms: float = 0.0,
    detect_total_ms: float | None = None,
    infer_wait_ms: float = 0.0,
    infer_queue_wait_ms: float = 0.0,
    ) -> tuple[list[dict], int, dict, dict]:
    return [], 0, track_state, _build_perf_dict(
        detect_ms=detect_ms,
        detect_total_ms=detect_total_ms,
        batch_size=batch_size,
        infer_wait_ms=infer_wait_ms,
        infer_queue_wait_ms=infer_queue_wait_ms,
    )


def _prepare_detection_roi_image(
    img: np.ndarray,
    roi_areas: list[dict] | None,
) -> tuple[np.ndarray, dict | None]:
    if img is None or img.size == 0:
        return img, None

    areas = [area for area in (roi_areas or []) if len(area.get("points", [])) >= 3]
    if not areas:
        return img, None

    frame_h, frame_w = img.shape[:2]
    if frame_h <= 1 or frame_w <= 1:
        return img, None

    polygons_px: list[np.ndarray] = []
    min_x = frame_w - 1
    min_y = frame_h - 1
    max_x = 0
    max_y = 0

    for area in areas:
        polygon = []
        for point in area.get("points", []):
            try:
                px = int(round(float(point[0]) * frame_w))
                py = int(round(float(point[1]) * frame_h))
            except (TypeError, ValueError, IndexError):
                polygon = []
                break
            px = max(0, min(frame_w - 1, px))
            py = max(0, min(frame_h - 1, py))
            polygon.append([px, py])
        if len(polygon) < 3:
            continue
        polygon_np = np.asarray(polygon, dtype=np.int32)
        polygons_px.append(polygon_np)
        min_x = min(min_x, int(polygon_np[:, 0].min()))
        min_y = min(min_y, int(polygon_np[:, 1].min()))
        max_x = max(max_x, int(polygon_np[:, 0].max()))
        max_y = max(max_y, int(polygon_np[:, 1].max()))

    if not polygons_px:
        return img, None

    if min_x >= max_x or min_y >= max_y:
        return img, None

    crop = img[min_y:max_y + 1, min_x:max_x + 1].copy()
    if crop.size == 0:
        return img, None

    mask = np.zeros(crop.shape[:2], dtype=np.uint8)
    shifted_polygons: list[np.ndarray] = []
    for polygon in polygons_px:
        shifted = polygon.copy()
        shifted[:, 0] -= min_x
        shifted[:, 1] -= min_y
        shifted_polygons.append(shifted)
    cv2.fillPoly(mask, shifted_polygons, 255)
    masked_crop = cv2.bitwise_and(crop, crop, mask=mask)

    return masked_crop, {
        "offset_x": float(min_x),
        "offset_y": float(min_y),
        "crop_w": float(masked_crop.shape[1]),
        "crop_h": float(masked_crop.shape[0]),
    }


def _remap_boxes_from_roi(boxes_xyxy: np.ndarray, roi_meta: dict | None) -> np.ndarray:
    if roi_meta is None or boxes_xyxy.size == 0:
        return boxes_xyxy
    remapped = boxes_xyxy.copy()
    remapped[:, [0, 2]] += float(roi_meta.get("offset_x", 0.0))
    remapped[:, [1, 3]] += float(roi_meta.get("offset_y", 0.0))
    return remapped


def _remap_boxes_with_scores_from_roi(boxes, roi_meta: dict | None) -> np.ndarray:
    if boxes is None:
        return boxes

    if isinstance(boxes, Boxes):
        box_data = boxes.data
        if hasattr(box_data, "detach"):
            box_data = box_data.detach().cpu().numpy()
        else:
            box_data = np.array(box_data, copy=True)
        if roi_meta is not None:
            box_data[..., [0, 2]] += float(roi_meta.get("offset_x", 0.0))
            box_data[..., [1, 3]] += float(roi_meta.get("offset_y", 0.0))
        return Boxes(box_data, boxes.orig_shape)

    if hasattr(boxes, "data"):
        boxes = boxes.data
    if hasattr(boxes, "cpu"):
        boxes = boxes.cpu()
    if hasattr(boxes, "numpy"):
        boxes = boxes.numpy()
    boxes = np.asarray(boxes)
    if boxes.size == 0:
        return boxes
    if roi_meta is None:
        return boxes
    remapped = boxes.copy()
    remapped[:, [0, 2]] += float(roi_meta.get("offset_x", 0.0))
    remapped[:, [1, 3]] += float(roi_meta.get("offset_y", 0.0))
    return remapped


def _remap_keypoints_from_roi(keypoints: np.ndarray | None, roi_meta: dict | None) -> np.ndarray | None:
    if keypoints is None or roi_meta is None or keypoints.size == 0:
        return keypoints
    remapped = keypoints.copy()
    remapped[..., 0] += float(roi_meta.get("offset_x", 0.0))
    remapped[..., 1] += float(roi_meta.get("offset_y", 0.0))
    return remapped


def _handle_rtsp_capture_failure_common(
    *,
    reason: str,
    runtime_key: str,
    rtsp_read_failures: int,
    recent_rtsp_failure_times: deque[float],
    capture_allow_hwaccel: bool,
    reopen_capture,
) -> tuple[int, bool, bool]:
    rtsp_read_failures += 1
    is_decoder_corruption = (
        reason.startswith("suspected_decoder_corruption")
        or reason.startswith("suspected_blurred_decoder_corruption")
    )
    clear_images_on_recovery = not RTSP_KEEP_LAST_FRAME_ON_RECOVERY
    failure_now = time.time()
    recent_rtsp_failure_times.append(failure_now)
    while (
        recent_rtsp_failure_times
        and (failure_now - recent_rtsp_failure_times[0]) > RTSP_HW_FALLBACK_FAILURE_WINDOW_SEC
    ):
        recent_rtsp_failure_times.popleft()

    if is_decoder_corruption and rtsp_read_failures < RTSP_CORRUPT_FRAME_RECOVERY_THRESHOLD:
        if rtsp_read_failures == 1:
            print(
                f"[Producer] Decoder corruption suspected; tolerating up to "
                f"{RTSP_CORRUPT_FRAME_RECOVERY_THRESHOLD} consecutive corrupted frame(s) "
                f"before reconnect: runtime_key={runtime_key}, last_reason={reason}"
            )
        time.sleep(RTSP_READ_FAILURE_BACKOFF_MS / 1000.0)
        return rtsp_read_failures, capture_allow_hwaccel, False

    if is_decoder_corruption and capture_allow_hwaccel:
        capture_allow_hwaccel = False
        _set_runtime_stream_status(
            runtime_key,
            status="recovering",
            reason=reason,
            clear_images=clear_images_on_recovery,
        )
        print(
            f"[Producer] Decoder corruption detected with hardware decode; switching immediately "
            f"to software decode: runtime_key={runtime_key}, last_reason={reason}"
        )
        reopen_capture(0.2, capture_allow_hwaccel)
        recent_rtsp_failure_times.clear()
        return 0, capture_allow_hwaccel, True

    if is_decoder_corruption:
        _set_runtime_stream_status(
            runtime_key,
            status="recovering",
            reason=reason,
            clear_images=clear_images_on_recovery,
        )
        print(
            f"[Producer] Decoder corruption detected; reconnecting immediately: "
            f"runtime_key={runtime_key}, last_reason={reason}"
        )
        reopen_capture(0.2, capture_allow_hwaccel)
        recent_rtsp_failure_times.clear()
        return 0, capture_allow_hwaccel, True

    if capture_allow_hwaccel and len(recent_rtsp_failure_times) >= RTSP_HW_FALLBACK_FAILURE_THRESHOLD:
        capture_allow_hwaccel = False
        _set_runtime_stream_status(
            runtime_key,
            status="recovering",
            reason=reason,
            clear_images=clear_images_on_recovery,
        )
        print(
            f"[Producer] RTSP decoder unstable with hardware decode; switching to software decode "
            f"after {len(recent_rtsp_failure_times)} failures within "
            f"{RTSP_HW_FALLBACK_FAILURE_WINDOW_SEC:.1f}s: runtime_key={runtime_key}, "
            f"last_reason={reason}"
        )
        reopen_capture(0.5, capture_allow_hwaccel)
        recent_rtsp_failure_times.clear()
        return 0, capture_allow_hwaccel, True

    if rtsp_read_failures < RTSP_MAX_CONSECUTIVE_READ_FAILURES:
        if rtsp_read_failures == 1:
            print(
                f"[Producer] RTSP frame failure ({reason}); tolerating up to "
                f"{RTSP_MAX_CONSECUTIVE_READ_FAILURES} consecutive failures before recovery: "
                f"runtime_key={runtime_key}"
            )
        time.sleep(RTSP_READ_FAILURE_BACKOFF_MS / 1000.0)
        return rtsp_read_failures, capture_allow_hwaccel, False

    switch_to_software = bool(capture_allow_hwaccel)
    if switch_to_software:
        capture_allow_hwaccel = False
        print(
            f"[Producer] RTSP decoder unstable after {rtsp_read_failures} consecutive failures; "
            f"switching to software decode: runtime_key={runtime_key}, last_reason={reason}"
        )
    else:
        print(
            f"[Producer] RTSP frame failure persisted for {rtsp_read_failures} consecutive reads; "
            f"reconnecting: runtime_key={runtime_key}, last_reason={reason}"
        )

    _set_runtime_stream_status(
        runtime_key,
        status="recovering",
        reason=reason,
        clear_images=clear_images_on_recovery,
    )
    reopen_capture(0.5, capture_allow_hwaccel)
    recent_rtsp_failure_times.clear()
    return 0, capture_allow_hwaccel, True


try:
    _FALL_POSE_ACCEPTS_SENSITIVITY = "detection_sensitivity" in inspect.signature(
        is_person_in_fall_pose
    ).parameters
except (TypeError, ValueError):
    _FALL_POSE_ACCEPTS_SENSITIVITY = False


def _is_person_in_fall_pose_compat(
    person_bbox,
    keypoints_data,
    detection_sensitivity,
):
    if _FALL_POSE_ACCEPTS_SENSITIVITY:
        return is_person_in_fall_pose(
            person_bbox,
            keypoints_data,
            detection_sensitivity=detection_sensitivity,
        )
    return is_person_in_fall_pose(person_bbox, keypoints_data)


class _NvencOutputWriter:
    """Optional FFmpeg NVENC sink for processed frames."""

    def __init__(self, runtime_key: str, view_key: str, fps: float):
        self.runtime_key = runtime_key
        self.view_key = view_key
        self.fps = max(1.0, float(fps) if fps else 30.0)
        self.process: subprocess.Popen | None = None
        self.width: int | None = None
        self.height: int | None = None
        self.output_path: str | None = None
        self.disabled = False

    def _output_ext(self) -> str:
        return "mkv" if NVENC_OUTPUT_CONTAINER == "mkv" else "mp4"

    def _build_output_path(self) -> str:
        os.makedirs(NVENC_OUTPUT_DIR, exist_ok=True)
        runtime_hash = hashlib.sha1(self.runtime_key.encode("utf-8", errors="ignore")).hexdigest()[:10]
        view_label = _sanitize_token(self.view_key, fallback="view")[:32]
        ts = time.strftime("%Y%m%d_%H%M%S")
        suffix = uuid.uuid4().hex[:6]
        return os.path.join(NVENC_OUTPUT_DIR, f"{runtime_hash}_{view_label}_{ts}_{suffix}.{self._output_ext()}")

    def _build_cmd(self, width: int, height: int) -> list[str]:
        cmd = [
            FFMPEG_BIN,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "-s:v",
            f"{width}x{height}",
            "-r",
            f"{self.fps:.3f}",
            "-i",
            "-",
            "-an",
            "-c:v",
            NVENC_CODEC,
            "-preset",
            NVENC_PRESET,
        ]
        if NVENC_TUNE:
            cmd.extend(["-tune", NVENC_TUNE])
        if NVENC_RATE_CONTROL:
            cmd.extend(["-rc", NVENC_RATE_CONTROL])
        cmd.extend(
            [
                "-b:v",
                f"{NVENC_BITRATE_K}k",
                "-maxrate",
                f"{NVENC_MAXRATE_K}k",
                "-bufsize",
                f"{NVENC_BUFSIZE_K}k",
                "-pix_fmt",
                "yuv420p",
            ]
        )
        if self._output_ext() == "mp4":
            cmd.extend(["-movflags", "+faststart"])
        cmd.append(self.output_path or self._build_output_path())
        return cmd

    def _start(self, frame: np.ndarray) -> bool:
        if self.disabled:
            return False
        if frame is None or frame.size == 0:
            return False

        height, width = frame.shape[:2]
        if height <= 0 or width <= 0:
            return False

        self.width = int(width)
        self.height = int(height)
        self.output_path = self._build_output_path()
        cmd = self._build_cmd(self.width, self.height)

        try:
            self.process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            print(
                f"[NVENC] Started writer for runtime_key={self.runtime_key}, "
                f"view={self.view_key}, output={self.output_path}"
            )
            return True
        except FileNotFoundError:
            print(f"[NVENC] FFmpeg executable not found: {FFMPEG_BIN}")
        except Exception as e:
            print(f"[NVENC] Failed to start writer for {self.runtime_key} ({self.view_key}): {e}")

        self.disabled = True
        self.process = None
        return False

    def write(self, frame: np.ndarray) -> bool:
        if self.disabled:
            return False
        if frame is None or frame.size == 0:
            return False
        if self.process is None and not self._start(frame):
            return False
        if self.process is None or self.process.stdin is None:
            return False
        if self.process.poll() is not None:
            self.disabled = True
            print(
                f"[NVENC] Writer exited early for runtime_key={self.runtime_key}, "
                f"view={self.view_key}"
            )
            return False

        out = frame
        if self.width and self.height and (frame.shape[1] != self.width or frame.shape[0] != self.height):
            out = cv2.resize(frame, (self.width, self.height), interpolation=cv2.INTER_AREA)

        try:
            self.process.stdin.write(out.tobytes())
            return True
        except Exception as e:
            print(f"[NVENC] Failed to write frame for {self.runtime_key} ({self.view_key}): {e}")
            self.close()
            self.disabled = True
            return False

    def close(self):
        proc = self.process
        self.process = None
        if proc is None:
            return
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=2.0)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Shared multi-stream batched inference engine
# ---------------------------------------------------------------------------
class _BatchInferenceEngine:
    def __init__(self):
        self._req_queue: queue.Queue = queue.Queue()
        self._trackers: dict[str, object] = {}
        self._tracker_lock = threading.Lock()
        self._batch_cap_lock = threading.Lock()
        self._worker = threading.Thread(target=self._worker_loop, daemon=True)
        self._engine_mode = _pose_model_uses_engine()
        self._effective_max_batch = max(1, int(BATCH_INFER_MAX_BATCH))
        self._processed_batches = 0

        tracker_cfg_raw = YAML.load(TRACKER_CONFIG_PATH)
        self._tracker_cfg = IterableSimpleNamespace(**tracker_cfg_raw)
        tracker_type = getattr(self._tracker_cfg, "tracker_type", "")
        if tracker_type not in TRACKER_MAP:
            raise ValueError(f"Unsupported tracker type: {tracker_type}")
        self._tracker_cls = TRACKER_MAP[tracker_type]

        print("[BatchInfer] Loading shared YOLO model...")
        self._model = _load_pose_model()
        self._worker.start()
        print(
            f"[BatchInfer] Ready: tracker={tracker_type}, backend={'TensorRT' if self._engine_mode else 'PyTorch'}, "
            f"window={BATCH_INFER_WINDOW_MS}ms, max_batch={self._effective_max_batch}"
        )

    def _get_tracker(self, stream_id: str):
        with self._tracker_lock:
            tracker = self._trackers.get(stream_id)
            if tracker is None:
                tracker = self._tracker_cls(args=self._tracker_cfg, frame_rate=30)
                self._trackers[stream_id] = tracker
            return tracker

    def infer(
        self,
        *,
        stream_id: str,
        img: np.ndarray,
        infer_img: np.ndarray,
        roi_meta: dict | None,
        frame_count: int,
        track_state: dict,
        skip_classification: bool,
        need_fall_detection: bool,
    ) -> tuple[list[dict], int, dict, dict]:
        done = threading.Event()
        wait_started_at = time.perf_counter()
        req = {
            "stream_id": stream_id,
            "img": img,
            "infer_img": infer_img,
            "roi_meta": roi_meta,
            "frame_count": frame_count,
            "track_state": track_state,
            "skip_classification": skip_classification,
            "need_fall_detection": need_fall_detection,
            "done": done,
            "result": None,
            "enqueued_at": wait_started_at,
        }
        self._req_queue.put(req)

        if not done.wait(timeout=BATCH_INFER_WAIT_MS / 1000.0):
            infer_wait_ms = (time.perf_counter() - wait_started_at) * 1000.0
            return _empty_detection_result(track_state, infer_wait_ms=infer_wait_ms)

        result = req.get("result")
        if result is None:
            infer_wait_ms = (time.perf_counter() - wait_started_at) * 1000.0
            return _empty_detection_result(track_state, infer_wait_ms=infer_wait_ms)

        infer_wait_ms = (time.perf_counter() - wait_started_at) * 1000.0
        detections, people_count, updated_track_state, perf = result
        perf = dict(perf)
        perf["infer_wait_ms"] = infer_wait_ms
        return detections, people_count, updated_track_state, perf

    def _worker_loop(self):
        batch_window_sec = BATCH_INFER_WINDOW_MS / 1000.0

        while True:
            first = self._req_queue.get()
            if first is None:
                return

            batch = [first]
            deadline = time.perf_counter() + batch_window_sec
            with self._batch_cap_lock:
                max_batch = self._effective_max_batch
            while len(batch) < max_batch:
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    break
                try:
                    item = self._req_queue.get(timeout=remaining)
                except queue.Empty:
                    break
                if item is None:
                    continue
                batch.append(item)

            self._process_batch(batch)

    def _predict_images(self, images: list[np.ndarray]):
        predict_kwargs = {
            "source": images,
            "verbose": False,
            "classes": [0],
            "conf": 0.30,
            "iou": 0.4,
            "imgsz": POSE_TRACK_IMGSZ,
        }
        if YOLO_DEVICE:
            predict_kwargs["device"] = YOLO_DEVICE
        return self._model.predict(**predict_kwargs)

    def _predict_images_adaptive(self, images: list[np.ndarray]):
        if not images:
            return []

        try:
            return self._predict_images(images)
        except Exception as e:
            if not self._engine_mode or len(images) <= 1:
                raise

            next_cap = max(1, len(images) // 2)
            with self._batch_cap_lock:
                if next_cap < self._effective_max_batch:
                    self._effective_max_batch = next_cap

            print(
                f"[BatchInfer] TensorRT batch={len(images)} failed ({e}). "
                f"Retrying with smaller micro-batches; effective max batch now {self._effective_max_batch}."
            )

            midpoint = max(1, len(images) // 2)
            left = self._predict_images_adaptive(images[:midpoint])
            right = self._predict_images_adaptive(images[midpoint:])
            return list(left) + list(right)

    def _process_batch(self, batch: list[dict]):
        detect_started_at = time.perf_counter()
        batch_started_at = detect_started_at
        images = [item.get("infer_img") if item.get("infer_img") is not None else item["img"] for item in batch]
        self._processed_batches += 1
        # if len(batch) > 1 or (self._processed_batches % BATCH_INFER_LOG_INTERVAL == 0):
        #     print(
        #         f"[BatchInfer] Running batch size={len(batch)} "
        #         f"(backend={'TensorRT' if self._engine_mode else 'PyTorch'}, "
        #         f"effective_max={self._effective_max_batch})"
        #     )

        try:
            results = self._predict_images_adaptive(images)
        except Exception as e:
            print(f"[BatchInfer] Predict error: {e}")
            for req in batch:
                req["result"] = _empty_detection_result(
                    req["track_state"],
                    batch_size=len(batch),
                )
                req["done"].set()
            return

        detect_ms_total = (time.perf_counter() - detect_started_at) * 1000.0
        detect_ms_each = detect_ms_total / max(1, len(batch))

        req_contexts: list[dict] = []
        global_classify_candidates: list[dict] = []
        processed = 0
        for req, result in zip(batch, results):
            processed += 1
            detections: list[dict] = []
            classify_candidates: list[dict] = []
            classified_count = 0
            classify_ms = 0.0
            req_post_started_at = time.perf_counter()

            boxes = result.boxes
            tracker = self._get_tracker(req["stream_id"])
            if boxes is None:
                tracked = np.empty((0, 8), dtype=np.float32)
            else:
                tracked = tracker.update(
                    _remap_boxes_with_scores_from_roi(boxes, req.get("roi_meta")),
                    img=req["img"],
                )

            keypoints_xy = None
            keypoints_with_conf = None
            if result.keypoints is not None:
                if not req["skip_classification"]:
                    keypoints_xy = result.keypoints.xy.cpu().numpy()
                if req.get("need_fall_detection"):
                    keypoints_with_conf = result.keypoints.data.cpu().numpy()
            keypoints_xy = _remap_keypoints_from_roi(keypoints_xy, req.get("roi_meta"))
            keypoints_with_conf = _remap_keypoints_from_roi(keypoints_with_conf, req.get("roi_meta"))

            track_state = req["track_state"]
            classify_now_monotonic = time.monotonic()
            for row in tracked:
                x1, y1, x2, y2, tid, _score, _cls, det_idx = row.tolist()
                track_id = int(tid)
                det_index = int(det_idx)
                person_bbox = [float(x1), float(y1), float(x2), float(y2)]

                kp_row_xy = None
                if keypoints_xy is not None and 0 <= det_index < keypoints_xy.shape[0]:
                    kp_row_xy = keypoints_xy[det_index]
                kp_row_fall = None
                if keypoints_with_conf is not None and 0 <= det_index < keypoints_with_conf.shape[0]:
                    kp_row_fall = keypoints_with_conf[det_index]

                cls_result = None
                classification_fresh = False
                if not req["skip_classification"]:
                    enable_pants_detection, enable_slipper_detection = _get_classifier_flags()
                    cached = track_state.get(track_id)
                    if cached is not None:
                        if _should_reuse_cached_classification(cached, now_monotonic=classify_now_monotonic):
                            cls_result = _get_cached_classification_for_enabled_models(
                                cached,
                                enable_pants=enable_pants_detection,
                                enable_slipper=enable_slipper_detection,
                            )
                    if cls_result is None:
                        classify_candidates.append(
                            {
                                "det_pos": len(detections),
                                "track_id": track_id,
                                "bbox": person_bbox,
                                "keypoints": kp_row_xy,
                            }
                        )

                detections.append(
                    {
                        "track_id": track_id,
                        "person_bbox": person_bbox,
                        "label": cls_result["label"] if cls_result else None,
                        "confidence": cls_result["confidence"] if cls_result else None,
                        "lower_bbox": cls_result["lower_bbox"] if cls_result else None,
                        "slipper_bbox": cls_result["slipper_bbox"] if cls_result else None,
                        "classifications": list(cls_result.get("classifications") or []) if cls_result else [],
                        "_classification_fresh": classification_fresh,
                        "violation": False,
                        "fall_pose": False,
                        "fall_detected": False,
                        "keypoints_data": kp_row_fall,
                    }
                )
            req_context = {
                "req": req,
                "detections": detections,
                "track_state": track_state,
                "tracked_count": len(tracked),
                "classify_candidates": classify_candidates,
                "classified_count": classified_count,
                "classify_ms": classify_ms,
                "infer_queue_wait_ms": max(
                    0.0,
                    (batch_started_at - float(req.get("enqueued_at") or batch_started_at)) * 1000.0,
                ),
                "req_post_started_at": req_post_started_at,
                "classify_now_monotonic": classify_now_monotonic,
            }
            req_contexts.append(req_context)

            for cand in classify_candidates:
                global_classify_candidates.append(
                    {
                        "req_context": req_context,
                        "det_pos": cand["det_pos"],
                        "track_id": cand["track_id"],
                        "frame": req["img"],
                        "bbox": cand["bbox"],
                        "keypoints": cand["keypoints"],
                    }
                )

        total_classify_ms = 0.0
        if global_classify_candidates:
            enable_pants_detection, enable_slipper_detection = _get_classifier_flags()
            classify_started_at = time.perf_counter()
            batch_results = classify_lower_body_multi_frame_batch(
                [
                    {
                        "frame": item["frame"],
                        "bbox": item["bbox"],
                        "keypoints": item["keypoints"],
                    }
                    for item in global_classify_candidates
                ],
                device=YOLO_DEVICE,
                enable_pants=enable_pants_detection,
                enable_slipper=enable_slipper_detection,
            )
            total_classify_ms = (time.perf_counter() - classify_started_at) * 1000.0

            total_candidates = len(global_classify_candidates)
            for item, cls_result in zip(global_classify_candidates, batch_results):
                req_context = item["req_context"]
                if total_candidates > 0:
                    req_context["classify_ms"] += total_classify_ms / total_candidates
                if cls_result is None:
                    continue

                det = req_context["detections"][item["det_pos"]]
                det["label"] = cls_result["label"]
                det["confidence"] = cls_result["confidence"]
                det["lower_bbox"] = cls_result.get("lower_bbox")
                det["slipper_bbox"] = cls_result.get("slipper_bbox")
                det["classifications"] = list(cls_result.get("classifications") or [])
                det["_classification_fresh"] = True
                req_context["classified_count"] += 1

                track_id = item["track_id"]
                if track_id not in req_context["track_state"]:
                    req_context["track_state"][track_id] = {"violation_saved": False}
                req_context["track_state"][track_id].update(
                    {
                        "label": cls_result["label"],
                        "confidence": cls_result["confidence"],
                        "lower_bbox": cls_result.get("lower_bbox"),
                        "slipper_bbox": cls_result.get("slipper_bbox"),
                        "classifications": list(cls_result.get("classifications") or []),
                        "last_classified_at_monotonic": req_context["classify_now_monotonic"],
                    }
                )

        for req_context in req_contexts:
            req_total_post_ms = (time.perf_counter() - req_context["req_post_started_at"]) * 1000.0
            req_post_ms = max(0.0, req_total_post_ms - req_context["classify_ms"])
            req_context["req"]["result"] = (
                req_context["detections"],
                req_context["tracked_count"],
                req_context["track_state"],
                _build_perf_dict(
                    detect_ms=detect_ms_each,
                    detect_total_ms=detect_ms_total,
                    batch_size=len(batch),
                    classify_ms=req_context["classify_ms"],
                    classify_candidates=len(req_context["classify_candidates"]),
                    classified=req_context["classified_count"],
                    infer_queue_wait_ms=req_context["infer_queue_wait_ms"],
                    infer_predict_ms=detect_ms_each,
                    infer_predict_total_ms=detect_ms_total,
                    infer_post_ms=req_post_ms,
                ),
            )
            req_context["req"]["done"].set()

        if processed < len(batch):
            for req in batch[processed:]:
                req["result"] = _empty_detection_result(
                    req["track_state"],
                    batch_size=len(batch),
                )
                req["done"].set()


_BATCH_INFER_ENGINE: _BatchInferenceEngine | None = None
_BATCH_INFER_LOCK = threading.Lock()


def _get_batch_infer_engine() -> _BatchInferenceEngine:
    global _BATCH_INFER_ENGINE
    with _BATCH_INFER_LOCK:
        if _BATCH_INFER_ENGINE is None:
            _BATCH_INFER_ENGINE = _BatchInferenceEngine()
        return _BATCH_INFER_ENGINE


class _AsyncFrameReader:
    """Owns VideoCapture in a separate thread and keeps only the latest frames."""

    def __init__(
        self,
        *,
        runtime_key: str,
        source_path: str,
        source_meta: dict,
        stop_event: threading.Event,
        cap: cv2.VideoCapture,
        capture_allow_hwaccel: bool,
    ):
        self.runtime_key = runtime_key
        self.source_path = source_path
        self.source_meta = source_meta
        self.stop_event = stop_event
        self._cap = cap
        self._capture_allow_hwaccel = capture_allow_hwaccel
        self._queue: queue.Queue = queue.Queue(maxsize=ASYNC_CAPTURE_QUEUE_SIZE)
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._closed = threading.Event()
        self._rtsp_read_failures = 0
        self._recent_rtsp_failure_times: deque[float] = deque()
        self._last_good_frame_signature: np.ndarray | None = None
        self._fatal_reason: str | None = None
        self._reached_eof = False

    def start(self):
        self._thread.start()

    def read(self, timeout: float) -> dict | None:
        try:
            item = self._queue.get(timeout=timeout)
        except queue.Empty:
            return None

        latest = item
        while True:
            try:
                latest = self._queue.get_nowait()
            except queue.Empty:
                break
        return latest

    def close(self, join_timeout: float = 2.0):
        self._closed.set()
        if self._thread.is_alive():
            self._thread.join(timeout=join_timeout)
        if self._thread.is_alive():
            print(f"[Producer] Async reader still stopping for runtime_key={self.runtime_key}")

    def _enqueue_frame(self, item: dict):
        while not self.stop_event.is_set() and not self._closed.is_set():
            try:
                self._queue.put_nowait(item)
                return
            except queue.Full:
                try:
                    self._queue.get_nowait()
                except queue.Empty:
                    pass

    def _enqueue_control(self, item: dict):
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break
        try:
            self._queue.put_nowait(item)
        except queue.Full:
            pass

    def _reopen_capture(self, sleep_seconds: float):
        cap = self._cap
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass

        if self.stop_event.is_set() or self._closed.is_set():
            self._cap = None
            return

        if sleep_seconds > 0:
            time.sleep(sleep_seconds)

        self._cap = open_video_capture(
            self.source_path,
            is_rtsp=bool(self.source_meta.get("is_rtsp_source")),
            allow_hwaccel=self._capture_allow_hwaccel,
        )

    def _handle_rtsp_capture_failure(self, reason: str):
        self._rtsp_read_failures, self._capture_allow_hwaccel, reset_signature = (
            _handle_rtsp_capture_failure_common(
                reason=reason,
                runtime_key=self.runtime_key,
                rtsp_read_failures=self._rtsp_read_failures,
                recent_rtsp_failure_times=self._recent_rtsp_failure_times,
                capture_allow_hwaccel=self._capture_allow_hwaccel,
                reopen_capture=self._reopen_capture_with_mode,
            )
        )
        if reset_signature:
            self._last_good_frame_signature = None

    def _reopen_capture_with_mode(self, sleep_seconds: float, allow_hwaccel: bool):
        self._capture_allow_hwaccel = allow_hwaccel
        self._reopen_capture(sleep_seconds)

    def _run(self):
        try:
            while not self.stop_event.is_set() and not self._closed.is_set():
                cap = self._cap
                if cap is None or not cap.isOpened():
                    if self.source_meta.get("is_network_stream_source"):
                        _set_runtime_stream_status(
                            self.runtime_key,
                            status="recovering",
                            reason="capture_not_open",
                            clear_images=not RTSP_KEEP_LAST_FRAME_ON_RECOVERY,
                        )
                        self._reopen_capture(1.0)
                        continue
                    self._fatal_reason = "capture_not_open"
                    break

                read_started_at = time.perf_counter()
                try:
                    ret, frame = cap.read()
                except Exception as e:
                    ret, frame = False, None
                    if self.source_meta.get("is_network_stream_source"):
                        self._handle_rtsp_capture_failure(f"read_exception:{type(e).__name__}")
                        continue
                    self._fatal_reason = f"read_exception:{type(e).__name__}"
                    break
                decode_ms = (time.perf_counter() - read_started_at) * 1000.0

                if ret:
                    if self._rtsp_read_failures > 0 and self.source_meta.get("is_network_stream_source"):
                        print(
                            f"[Producer] Recovered live stream after {self._rtsp_read_failures} failed frame(s): "
                            f"runtime_key={self.runtime_key}"
                        )
                        self._rtsp_read_failures = 0

                if not ret:
                    if self.source_meta.get("is_uploaded_source") and self.source_meta.get("is_file_source"):
                        self._reached_eof = True
                        break

                    if self.source_meta.get("is_network_stream_source"):
                        self._handle_rtsp_capture_failure("read_failed")
                        continue

                    time.sleep(0.1)
                    continue

                if self.source_meta.get("is_rtsp_source"):
                    is_bad_frame, bad_frame_reason, frame_signature = _detect_corrupted_rtsp_frame(
                        frame,
                        self._last_good_frame_signature,
                    )
                    if is_bad_frame:
                        self._handle_rtsp_capture_failure(bad_frame_reason or "corrupted_frame")
                        continue
                    self._last_good_frame_signature = frame_signature

                self._enqueue_frame(
                    {
                        "type": "frame",
                        "frame": frame,
                        "decode_ms": decode_ms,
                    }
                )
        except Exception as e:
            self._fatal_reason = f"reader_crash:{type(e).__name__}"
            print(f"[Producer] Async reader crashed for runtime_key={self.runtime_key}: {e}")
        finally:
            cap = self._cap
            self._cap = None
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass

            if self._reached_eof:
                self._enqueue_control({"type": "eof"})
            elif self._fatal_reason and not self.stop_event.is_set():
                self._enqueue_control({"type": "fatal", "reason": self._fatal_reason})


# ---------------------------------------------------------------------------
# Producer thread management
# ---------------------------------------------------------------------------
def start_producer_thread(
    runtime_key: str,
    source_path: str,
    is_fisheye: bool,
    active_views: list = None,
    sync_barrier: threading.Barrier | None = None,
    sync_state: dict | None = None,
):
    with PRODUCER_LOCK:
        existing = PRODUCER_THREADS.get(runtime_key)
        if existing is not None and existing.is_alive():
            return  # Already running for this source

        stop_event = threading.Event()
        source_meta = _build_source_meta(source_path)

        thread = threading.Thread(
            target=video_producer,
            args=(
                runtime_key,
                source_path,
                is_fisheye,
                active_views,
                stop_event,
                source_meta,
                sync_barrier,
                sync_state,
            ),
            daemon=True,
        )
        PRODUCER_THREADS[runtime_key] = thread
        PRODUCER_STOP_EVENTS[runtime_key] = stop_event
        PRODUCER_META[runtime_key] = {
            **source_meta,
            "source_path": source_path,
            "runtime_key": runtime_key,
        }
        thread.start()


def stop_producer_thread(runtime_key: str, join_timeout: float = 2.0) -> bool:
    """Request producer shutdown for a source. Returns True if fully stopped."""
    with PRODUCER_LOCK:
        thread = PRODUCER_THREADS.get(runtime_key)
        stop_event = PRODUCER_STOP_EVENTS.get(runtime_key)

    if thread is None or stop_event is None:
        return True  # Already stopped / unknown source

    stop_event.set()
    if thread.is_alive():
        thread.join(timeout=join_timeout)

    if thread.is_alive():
        print(f"[Producer] Stop requested but still alive for {runtime_key}")
        return False

    _cleanup_producer_state(runtime_key, clear_frame_buffer=True)
    return True


def stop_all_producer_threads(join_timeout: float = 2.0) -> list[str]:
    """
    Request shutdown for all producers and return any sources that
    failed to stop within the timeout.
    """
    with PRODUCER_LOCK:
        runtime_keys = list(PRODUCER_STOP_EVENTS.keys())

    for runtime_key in runtime_keys:
        stop_event = PRODUCER_STOP_EVENTS.get(runtime_key)
        if stop_event is not None:
            stop_event.set()

    still_running: list[str] = []
    for runtime_key in runtime_keys:
        thread = PRODUCER_THREADS.get(runtime_key)
        if thread is not None and thread.is_alive():
            thread.join(timeout=join_timeout)
        if thread is not None and thread.is_alive():
            still_running.append(runtime_key)
        else:
            _cleanup_producer_state(runtime_key, clear_frame_buffer=True)

    return still_running


def is_producer_running(runtime_key: str) -> bool:
    with PRODUCER_LOCK:
        thread = PRODUCER_THREADS.get(runtime_key)
        return thread.is_alive() if thread is not None else False


def _cleanup_producer_state(runtime_key: str, clear_frame_buffer: bool):
    with PRODUCER_LOCK:
        PRODUCER_THREADS.pop(runtime_key, None)
        PRODUCER_STOP_EVENTS.pop(runtime_key, None)
    if clear_frame_buffer:
        FRAME_BUFFERS.pop(runtime_key, None)


# ---------------------------------------------------------------------------
# Main producer loop
# ---------------------------------------------------------------------------
def video_producer(
    runtime_key: str,
    source_path: str,
    is_fisheye: bool,
    active_views: list = None,
    stop_event: threading.Event | None = None,
    source_meta: dict | None = None,
    sync_barrier: threading.Barrier | None = None,
    sync_state: dict | None = None,
):
    print(f"[Producer] Starting loop for runtime_key={runtime_key}, source={source_path}")
    _set_runtime_stream_status(runtime_key, status="connecting", reason="initializing", clear_images=True)
    reached_eof = False

    if stop_event is None:
        stop_event = threading.Event()
    if source_meta is None:
        source_meta = _build_source_meta(source_path)

    capture_allow_hwaccel = bool(source_meta.get("is_rtsp_source")) and RTSP_ENABLE_NVDEC
    cap = open_video_capture(
        source_path,
        is_rtsp=bool(source_meta.get("is_rtsp_source")),
        allow_hwaccel=capture_allow_hwaccel,
    )
    if not cap.isOpened() and source_meta.get("is_rtsp_source") and capture_allow_hwaccel:
        print(
            f"[Producer] Initial RTSP open with hardware decode failed; retrying with software decode: "
            f"runtime_key={runtime_key}"
        )
        cap.release()
        capture_allow_hwaccel = False
        cap = open_video_capture(
            source_path,
            is_rtsp=bool(source_meta.get("is_rtsp_source")),
            allow_hwaccel=capture_allow_hwaccel,
        )
    if not cap.isOpened() and source_meta.get("is_rtsp_source"):
        for _ in range(5):
            if stop_event.is_set():
                break
            time.sleep(1.0)
            cap.release()
            cap = open_video_capture(
                source_path,
                is_rtsp=bool(source_meta.get("is_rtsp_source")),
                allow_hwaccel=capture_allow_hwaccel,
            )
            if cap.isOpened():
                _set_runtime_stream_status(
                    runtime_key,
                    status="connecting",
                    reason="reopen_pending_frame",
                    clear_images=True,
                )
                break

    if not cap.isOpened():
        print(f"[Producer] Failed to open {source_path} (runtime_key={runtime_key})")
        _set_runtime_stream_status(runtime_key, status="offline", reason="open_failed", clear_images=True)
        _cleanup_producer_state(runtime_key, clear_frame_buffer=True)
        return

    local_model = None
    local_models_by_view: dict[str, YOLO] = {}
    use_batch_infer = MULTI_STREAM_BATCH_INFER
    if use_batch_infer and _pose_model_uses_engine():
        print("[Producer] TensorRT engine detected; enabling shared multi-stream batching.")
    # Ensure shared batch inference engine is ready once.
    if use_batch_infer:
        try:
            _get_batch_infer_engine()
        except Exception as e:
            print(f"[Producer] Failed to initialize batch inference engine: {e}")
            print("[Producer] Falling back to per-stream detector path.")
            use_batch_infer = False

    if not use_batch_infer:
        # Legacy per-stream detector path.
        print(f"[Producer] Loading YOLO model for runtime_key={runtime_key}, source={source_path}")
        try:
            local_model = _load_pose_model()
        except Exception as e:
            print(f"[Producer] Failed to load YOLO model for {source_path}: {e}")
            cap.release()
            _cleanup_producer_state(runtime_key, clear_frame_buffer=True)
            return

    def _get_local_model_for_view(view_key: str) -> YOLO | None:
        if local_model is None:
            return None
        if not is_fisheye:
            return local_model

        model_for_view = local_models_by_view.get(view_key)
        if model_for_view is None:
            # The TensorRT fallback path uses persist=True inside YOLO.track(),
            # so fisheye partitions need isolated model instances to avoid
            # sharing one tracker namespace across views.
            print(f"[Producer] Loading isolated YOLO model for runtime_key={runtime_key}, view={view_key}")
            model_for_view = _load_pose_model()
            local_models_by_view[view_key] = model_for_view
        return model_for_view

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    delay = 1.0 / fps

    # Detect CUDA availability once
    cuda_available = hasattr(cv2, "cuda") and cv2.cuda.getCudaEnabledDeviceCount() > 0
    if cuda_available:
        print("[System] CUDA detected: enabling GPU remap/resize")
    else:
        print("[System] CUDA not available, using CPU pipeline")
    if NVENC_OUTPUT_ENABLED:
        print(
            f"[NVENC] Enabled: codec={NVENC_CODEC}, preset={NVENC_PRESET}, "
            f"container={NVENC_OUTPUT_CONTAINER}, output_dir={NVENC_OUTPUT_DIR}"
        )

    # --- Fisheye processor setup ---
    processor = None
    if is_fisheye:
        all_configs = [
            {'angle_z': 0,   'angle_up': 35, 'zoom': 80},  # View 0
            {'angle_z': 45,  'angle_up': 35, 'zoom': 80},  # View 1
            {'angle_z': 90,  'angle_up': 35, 'zoom': 80},  # View 2
            {'angle_z': 135, 'angle_up': 35, 'zoom': 80},  # View 3
            {'angle_z': 180, 'angle_up': 35, 'zoom': 80},  # View 4
            {'angle_z': 225, 'angle_up': 35, 'zoom': 80},  # View 5
            {'angle_z': 270, 'angle_up': 35, 'zoom': 80},  # View 6
            {'angle_z': 315, 'angle_up': 35, 'zoom': 80},  # View 7
        ]

        final_configs = []
        for i in range(8):
            if active_views is None or i in active_views:
                final_configs.append(all_configs[i])
            else:
                final_configs.append(None)  # Skip this view

        processor = FisheyeMultiView(
            (height, width),
            final_configs,
            show_original=False,
            use_cuda=cuda_available,
            downscale_size=None,  # Keep full resolution for accurate classification
        )

    # --- GPU-aware resize helper ---
    def resize_for_web(img):
        if cuda_available and hasattr(cv2, "cuda"):
            try:
                gpu_img = cv2.cuda_GpuMat()
                gpu_img.upload(img)
                gpu_resized = cv2.cuda.resize(gpu_img, (640, 360), interpolation=cv2.INTER_AREA)
                return gpu_resized.download()
            except Exception:
                pass
        return cv2.resize(img, (640, 360))

    # --- Encode frame to base64 JPEG ---
    def encode_frame(img):
        img_small = resize_for_web(img)
        if jpeg:
            buf = jpeg.encode(img_small, quality=40)
        else:
            _, buf = cv2.imencode('.jpg', img_small, [cv2.IMWRITE_JPEG_QUALITY, 40])
        return base64.b64encode(buf).decode('utf-8')

    # --- Detection + optional classification for a single view ---
    def run_detection_and_classify(
        img,
        frame_count,
        track_state,
        skip_classification=False,
        need_fall_detection=False,
        view_key: str = "original",
        detection_roi_areas=None,
    ):
        """
        Run YOLO-Pose tracking on a full-res image.
        If skip_classification is False, also runs dress code classification.

        Returns:
            (detections_list, people_count, updated_track_state, perf_dict)

        Each detection dict:
            {track_id, person_bbox, count_anchor, label, confidence, lower_bbox, slipper_bbox, classifications, violation, fall_pose, fall_detected}
        """
        infer_img, roi_meta = _prepare_detection_roi_image(img, detection_roi_areas)

        if use_batch_infer:
            engine = _get_batch_infer_engine()
            stream_id = f"{runtime_key}||{view_key}"
            return engine.infer(
                stream_id=stream_id,
                img=img,
                infer_img=infer_img,
                roi_meta=roi_meta,
                frame_count=frame_count,
                track_state=track_state,
                skip_classification=skip_classification,
                need_fall_detection=need_fall_detection,
            )

        model_for_view = _get_local_model_for_view(view_key)
        if model_for_view is None:
            return _empty_detection_result(track_state)

        try:
            detect_started_at = time.perf_counter()
            # YOLO-Pose tracking with BoT-SORT for better occlusion handling.
            # BoT-SORT adds ReID appearance features + improved Kalman filter,
            # so tracks survive brief occlusions (e.g. door frame) much better.
            track_kwargs = {
                "source": infer_img,
                "tracker": TRACKER_CONFIG_PATH,
                "persist": True,
                "verbose": False,
                "classes": [0],     # person only
                "conf": 0.30,       # lower threshold: keep detections during partial occlusion
                "iou": 0.4,         # more lenient matching: easier to re-associate after occlusion
                "imgsz": POSE_TRACK_IMGSZ,
            }
            if YOLO_DEVICE:
                track_kwargs["device"] = YOLO_DEVICE

            results = model_for_view.track(**track_kwargs)
            infer_predict_ms = (time.perf_counter() - detect_started_at) * 1000.0

            if not results:
                return _empty_detection_result(
                    track_state,
                    detect_ms=infer_predict_ms,
                    infer_wait_ms=infer_predict_ms,
                )

            r = results[0]
            boxes_xyxy = r.boxes.xyxy.cpu().numpy() if r.boxes is not None else np.empty((0, 4))
            boxes_xyxy = _remap_boxes_from_roi(boxes_xyxy, roi_meta)
            track_ids = (
                r.boxes.id.int().cpu().tolist()
                if r.boxes is not None and r.boxes.id is not None
                else []
            )
            keypoints_xy = None
            keypoints_with_conf = None
            if r.keypoints is not None:
                if not skip_classification:
                    keypoints_xy = r.keypoints.xy.cpu().numpy()
                if need_fall_detection:
                    keypoints_with_conf = r.keypoints.data.cpu().numpy()
            keypoints_xy = _remap_keypoints_from_roi(keypoints_xy, roi_meta)
            keypoints_with_conf = _remap_keypoints_from_roi(keypoints_with_conf, roi_meta)
            detect_ms = infer_predict_ms

            people_count = len(boxes_xyxy)
            detections = []
            classify_candidates = []
            classified_count = 0
            classify_ms = 0.0
            post_started_at = time.perf_counter()
            classify_now_monotonic = time.monotonic()

            for i, box_coords in enumerate(boxes_xyxy):
                track_id = int(track_ids[i]) if i < len(track_ids) and track_ids[i] is not None else None

                person_bbox = list(map(float, box_coords))
                kp_row_xy = keypoints_xy[i] if keypoints_xy is not None and keypoints_xy.shape[0] > i else None
                kp_row_fall = (
                    keypoints_with_conf[i]
                    if keypoints_with_conf is not None and keypoints_with_conf.shape[0] > i
                    else None
                )

                cls_result = None
                classification_fresh = False

                # Only run dress code classification when needed
                if not skip_classification:
                    enable_pants_detection, enable_slipper_detection = _get_classifier_flags()
                    # --- Per-track classification throttling ---
                    if track_id is not None and track_id in track_state:
                        cached = track_state[track_id]
                        if _should_reuse_cached_classification(cached, now_monotonic=classify_now_monotonic):
                            # Reuse cached label
                            cls_result = _get_cached_classification_for_enabled_models(
                                cached,
                                enable_pants=enable_pants_detection,
                                enable_slipper=enable_slipper_detection,
                            )

                    # Queue for batch classification if no cached result.
                    if cls_result is None:
                        classify_candidates.append({
                            "det_index": i,
                            "track_id": track_id,
                            "bbox": box_coords,
                            "keypoints": kp_row_xy,
                        })

                # Build detection entry
                det = {
                    "track_id": track_id,
                    "person_bbox": person_bbox,
                    "label": cls_result["label"] if cls_result else None,
                    "confidence": cls_result["confidence"] if cls_result else None,
                    "lower_bbox": cls_result["lower_bbox"] if cls_result else None,
                    "slipper_bbox": cls_result["slipper_bbox"] if cls_result else None,
                    "classifications": list(cls_result.get("classifications") or []) if cls_result else [],
                    "_classification_fresh": classification_fresh,
                    "violation": False,  # Will be set by policy check later
                    "fall_pose": False,
                    "fall_detected": False,
                    "keypoints_data": kp_row_fall,
                }
                detections.append(det)

            if not skip_classification and classify_candidates:
                classify_started_at = time.perf_counter()
                batch_results = classify_lower_body_batch(
                    img,
                    [{"bbox": item["bbox"], "keypoints": item["keypoints"]} for item in classify_candidates],
                    device=YOLO_DEVICE,
                    enable_pants=enable_pants_detection,
                    enable_slipper=enable_slipper_detection,
                )
                classify_ms = (time.perf_counter() - classify_started_at) * 1000.0

                for item, cls_result in zip(classify_candidates, batch_results):
                    if cls_result is None:
                        continue
                    det = detections[item["det_index"]]
                    det["label"] = cls_result["label"]
                    det["confidence"] = cls_result["confidence"]
                    det["lower_bbox"] = cls_result.get("lower_bbox")
                    det["slipper_bbox"] = cls_result.get("slipper_bbox")
                    det["classifications"] = list(cls_result.get("classifications") or [])
                    det["_classification_fresh"] = True
                    classified_count += 1

                    track_id = item["track_id"]
                    if track_id is not None:
                        if track_id not in track_state:
                            track_state[track_id] = {"violation_saved": False}
                        track_state[track_id].update({
                            "label": cls_result["label"],
                            "confidence": cls_result["confidence"],
                            "lower_bbox": cls_result.get("lower_bbox"),
                            "slipper_bbox": cls_result.get("slipper_bbox"),
                            "classifications": list(cls_result.get("classifications") or []),
                            "last_classified_at_monotonic": classify_now_monotonic,
                        })

            total_post_ms = (time.perf_counter() - post_started_at) * 1000.0
            infer_post_ms = max(0.0, total_post_ms - classify_ms)
            return detections, people_count, track_state, _build_perf_dict(
                detect_ms=detect_ms,
                classify_ms=classify_ms,
                classify_candidates=len(classify_candidates),
                classified=classified_count,
                infer_wait_ms=detect_ms + infer_post_ms + classify_ms,
                infer_predict_ms=detect_ms,
                infer_post_ms=infer_post_ms,
            )

        except Exception as e:
            print(f"[Detection] Error: {e}")
            return _empty_detection_result(track_state)

    # --- Scale detection coordinates to 640x360 for frontend ---
    def scale_detections(detections, orig_h, orig_w, target_w=640, target_h=360):
        sx = target_w / orig_w
        sy = target_h / orig_h
        scaled = []
        for d in detections:
            sd = dict(d)
            sd.pop("keypoints_data", None)
            sd.pop("_classification_fresh", None)
            if sd.get("person_bbox"):
                b = sd["person_bbox"]
                sd["person_bbox"] = [round(b[0]*sx), round(b[1]*sy), round(b[2]*sx), round(b[3]*sy)]
            if sd.get("count_anchor"):
                p = sd["count_anchor"]
                sd["count_anchor"] = [round(p[0]*sx), round(p[1]*sy)]
            if sd.get("display_anchor"):
                p = sd["display_anchor"]
                sd["display_anchor"] = [round(p[0]*sx), round(p[1]*sy)]
            if sd.get("lower_bbox"):
                b = sd["lower_bbox"]
                sd["lower_bbox"] = [round(b[0]*sx), round(b[1]*sy), round(b[2]*sx), round(b[3]*sy)]
            if sd.get("slipper_bbox"):
                b = sd["slipper_bbox"]
                sd["slipper_bbox"] = [round(b[0]*sx), round(b[1]*sy), round(b[2]*sx), round(b[3]*sy)]
            scaled.append(sd)
        return scaled

    # -----------------------------------------------------------------------
    # Init buffer and state
    # -----------------------------------------------------------------------
    _set_runtime_stream_status(runtime_key, status="connecting", reason="awaiting_frames", clear_images=True)

    # FPS calculation
    fps_start_time = time.time()
    fps_frame_count = 0
    current_real_fps = 0.0

    # Detection state
    detection_stride = DETECTION_STRIDE
    if source_meta.get("is_uploaded_source") and source_meta.get("is_file_source"):
        detection_stride = max(DETECTION_STRIDE, 1)
    frame_count = 0
    decoded_frame_index = -1
    rtsp_read_failures = 0
    recent_rtsp_failure_times: deque[float] = deque()
    last_good_frame_signature: np.ndarray | None = None
    track_state = {}       # Per-track dress-code and fall-detection state.
    cached_detections = [] # Reused between detection frames
    cached_people_count = 0

    # People counting state: view_key -> PeopleCounter instance
    people_counters: dict[str, PeopleCounter] = {}
    cached_counting_data: dict[str, dict] = {}  # view_key -> last counting result
    counting_event_state: dict[str, dict[str, int]] = {}  # view_key -> previous total counts
    nvenc_writers: dict[str, _NvencOutputWriter] = {}
    sync_started_at = None
    async_reader: _AsyncFrameReader | None = None

    if sync_barrier is not None:
        try:
            print(f"[Producer] Waiting for sync start: runtime_key={runtime_key}")
            sync_barrier.wait(timeout=30.0)
            sync_started_at = (sync_state or {}).get("started_at") or time.perf_counter()
            print(f"[Producer] Sync start released: runtime_key={runtime_key}")
        except threading.BrokenBarrierError:
            print(f"[Producer] Sync start barrier broken, continuing unsynchronized: runtime_key={runtime_key}")
    elif sync_state is not None:
        sync_started_at = (sync_state or {}).get("started_at") or time.perf_counter()

    sync_timeline_active = bool(
        sync_started_at is not None and source_meta.get("is_uploaded_source") and source_meta.get("is_file_source")
    )
    use_async_capture = bool(
        ASYNC_CAPTURE_ENABLED
        and source_meta.get("is_network_stream_source")
        and not sync_timeline_active
    )
    if use_async_capture:
        async_reader = _AsyncFrameReader(
            runtime_key=runtime_key,
            source_path=source_path,
            source_meta=source_meta,
            stop_event=stop_event,
            cap=cap,
            capture_allow_hwaccel=capture_allow_hwaccel,
        )
        async_reader.start()
        print(
            f"[Producer] Async capture enabled: runtime_key={runtime_key}, "
            f"queue_size={ASYNC_CAPTURE_QUEUE_SIZE}"
        )

    def _write_nvenc_frame(view_key: str, img: np.ndarray) -> float:
        if not NVENC_OUTPUT_ENABLED:
            return 0.0
        writer = nvenc_writers.get(view_key)
        if writer is None:
            writer = _NvencOutputWriter(runtime_key, view_key, fps)
            nvenc_writers[view_key] = writer
        started_at = time.perf_counter()
        writer.write(img)
        return (time.perf_counter() - started_at) * 1000.0

    def _skip_file_frame() -> bool:
        nonlocal decoded_frame_index
        if use_async_capture:
            return False
        skipped = cap.grab()
        if skipped:
            decoded_frame_index += 1
        return skipped

    def _handle_rtsp_capture_failure(reason: str):
        nonlocal cap, rtsp_read_failures, capture_allow_hwaccel, last_good_frame_signature
        def _reopen_capture(sleep_seconds: float, allow_hwaccel: bool):
            nonlocal cap, capture_allow_hwaccel
            capture_allow_hwaccel = allow_hwaccel
            cap.release()
            time.sleep(sleep_seconds)
            cap = open_video_capture(
                source_path,
                is_rtsp=bool(source_meta.get("is_rtsp_source")),
                allow_hwaccel=capture_allow_hwaccel,
            )

        rtsp_read_failures, capture_allow_hwaccel, reset_signature = (
            _handle_rtsp_capture_failure_common(
                reason=reason,
                runtime_key=runtime_key,
                rtsp_read_failures=rtsp_read_failures,
                recent_rtsp_failure_times=recent_rtsp_failure_times,
                capture_allow_hwaccel=capture_allow_hwaccel,
                reopen_capture=_reopen_capture,
            )
        )
        if reset_signature:
            last_good_frame_signature = None

    # -----------------------------------------------------------------------
    # Helper: get all views needing detection
    # -----------------------------------------------------------------------
    def _get_all_detection_views(source_path: str):
        """Union of dress-code, people-counting, and fall-detection views."""
        dresscode_views = _get_detection_views(runtime_key)
        counting_views = get_counting_views(runtime_key)
        fall_views = get_fall_detection_views(source_path)
        return dresscode_views | counting_views | fall_views

    def _get_source_detection_roi_areas(view_key: str) -> list[dict]:
        roi = get_source_detection_roi(runtime_key, view_key)
        if roi is None:
            return []
        return [roi]

    def _run_counting_for_view(view_key, detections_unscaled, frame_shape):
        """Run people counting on unscaled detections for a specific view."""
        camera_id = get_counting_camera_id(runtime_key, view_key)
        if camera_id is None:
            return None

        config = get_counting_config(camera_id)
        if config is None or not config.get("enabled", True):
            return None

        is_verifier_only = (
            bool(config.get("cross_camera_enabled", False))
            and str(config.get("cross_camera_role") or "none") == "verifier"
        )

        if is_verifier_only:
            people_counters.pop(view_key, None)
            if consume_counting_reset(camera_id):
                reset_cross_camera_state(camera_id)
            now_ts = time.time()
            observe_verifier_tracks(camera_id, detections_unscaled, config, frame_shape, now_ts)
            verifier_status = get_verifier_camera_status(camera_id)
            counting_event_state[view_key] = {
                "total_in": 0,
                "total_out": 0,
                "raw_total_in": 0,
                "raw_total_out": 0,
            }
            counting_data = {
                "total_in": 0,
                "total_out": 0,
                "occupancy": 0,
                "foot_traffic_left": 0,
                "foot_traffic_right": 0,
                "foot_traffic_total": 0,
                "foot_traffic_lines": [],
                "raw_total_in": 0,
                "raw_total_out": 0,
                "verification_confirmed_in": 0,
                "verification_correction_in": 0,
                "verification_confirmed_out": 0,
                "verification_correction_out": 0,
                "verification_camera_id": None,
                "cross_camera_pair_id": config.get("cross_camera_pair_id"),
                "cross_camera_active_event": None,
                "cross_camera_last_event": None,
                "cross_camera_active_in_event": None,
                "cross_camera_last_in_event": None,
                "cross_camera_active_out_event": None,
                "cross_camera_last_out_event": None,
                "lines": config.get("lines", []),
                "active_zones": config.get("active_zones", config.get("frame_exclude_areas", [])),
                "frame_exclude_areas": config.get("frame_exclude_areas", []),
            }
            counting_data.update(verifier_status)
            update_live_counts(camera_id, counting_data)
            return counting_data

        # Get or create PeopleCounter for this view
        if view_key not in people_counters:
            people_counters[view_key] = PeopleCounter(config)
            print(f"[Counting] Created counter for {view_key} (camera={camera_id}), "
                  f"lines={len(config.get('lines', []))}, "
                  f"frame_exclude_areas={len(config.get('frame_exclude_areas', []))}")
        else:
            # Hot-reload config changes
            people_counters[view_key].update_config(config)

        counter = people_counters[view_key]
        if consume_counting_reset(camera_id):
            counter.reset()
            reset_cross_camera_state(camera_id)
            counting_event_state[view_key] = {
                "total_in": 0,
                "total_out": 0,
                "raw_total_in": 0,
                "raw_total_out": 0,
            }
            counting_data = counter._empty_result()
            update_live_counts(camera_id, counting_data)
            return counting_data

        now_ts = time.time()
        raw_counting_data = counter.update(detections_unscaled, frame_shape)
        prev_state = counting_event_state.get(
            view_key,
            {"total_in": 0, "total_out": 0, "raw_total_in": 0, "raw_total_out": 0},
        )
        raw_total_in = int(raw_counting_data.get("total_in", 0) or 0)
        raw_total_out = int(raw_counting_data.get("total_out", 0) or 0)
        raw_delta_in = max(0, raw_total_in - int(prev_state.get("raw_total_in", 0) or 0))
        raw_delta_out = max(0, raw_total_out - int(prev_state.get("raw_total_out", 0) or 0))

        register_primary_in_events(camera_id, raw_delta_in, now_ts)
        register_primary_out_events(camera_id, raw_delta_out, now_ts)
        observe_verifier_tracks(camera_id, detections_unscaled, config, frame_shape, now_ts)
        counting_data, _ = apply_primary_camera_correction(camera_id, raw_counting_data, now_ts)

        total_in = int(counting_data.get("total_in", 0) or 0)
        total_out = int(counting_data.get("total_out", 0) or 0)
        delta_in = max(0, total_in - int(prev_state.get("total_in", 0) or 0))
        delta_out = max(0, total_out - int(prev_state.get("total_out", 0) or 0))
        counting_event_state[view_key] = {
            "total_in": total_in,
            "total_out": total_out,
            "raw_total_in": raw_total_in,
            "raw_total_out": raw_total_out,
        }

        # Publish live counts
        update_live_counts(camera_id, counting_data)

        if delta_in or delta_out:
            event_time = time.time()
            sensor_events = []
            for idx in range(delta_in):
                sensor_events.append({
                    "direction": "in",
                    "timestamp": event_time + (idx * 0.001),
                    "count_after": total_in - delta_in + idx + 1,
                })
            for idx in range(delta_out):
                sensor_events.append({
                    "direction": "out",
                    "timestamp": event_time + ((delta_in + idx) * 0.001),
                    "count_after": total_out - delta_out + idx + 1,
                })
            building_alert = ingest_sensor_events(camera_id, sensor_events)
            if building_alert:
                queue_violation_event(building_alert)

        # Snapshot on change + periodic heartbeat to preserve timeline continuity.
        if counter.should_snapshot(heartbeat_interval=COUNTING_SNAPSHOT_HEARTBEAT_SEC):
            snap = counter.get_snapshot_data(camera_id)
            queue_counting_snapshot(snap)

        return counting_data

    def _run_fall_detection_for_view(view_key, detections_unscaled, frame, source_path):
        """Run fall detection on unscaled detections for a specific view."""
        camera_id = get_fall_detection_camera_id(source_path, view_key)
        if camera_id is None:
            for det in detections_unscaled:
                det["fall_pose"] = False
                det["fall_detected"] = False
            return detections_unscaled

        config = get_fall_detection_config(camera_id)
        if config is None or not config.get("enabled", True):
            for det in detections_unscaled:
                det["fall_pose"] = False
                det["fall_detected"] = False
            return detections_unscaled

        detection_sensitivity = int(config.get("detection_sensitivity", 75) or 75)
        inactivity_timer_seconds = max(0.1, float(config.get("inactivity_timer_seconds", 1.0) or 1.0))
        now_ts = time.time()

        for det in detections_unscaled:
            track_id = det.get("track_id")
            person_bbox = det.get("person_bbox")
            keypoints_data = det.get("keypoints_data")
            fall_pose = bool(
                person_bbox
                and keypoints_data is not None
                and _is_person_in_fall_pose_compat(
                    person_bbox,
                    keypoints_data,
                    detection_sensitivity,
                )
            )
            det["fall_pose"] = fall_pose
            det["fall_detected"] = False

            if track_id is None:
                continue

            if track_id not in track_state:
                track_state[track_id] = {"violation_saved": False}
            ts = track_state[track_id]

            if not fall_pose:
                ts.pop("fall_started_at", None)
                ts["fall_saved"] = False
                continue

            started_at = ts.get("fall_started_at")
            if started_at is None:
                started_at = now_ts
                ts["fall_started_at"] = started_at

            fall_confirmed = (now_ts - started_at) >= inactivity_timer_seconds
            if ts.get("fall_saved", False):
                fall_confirmed = True

            det["fall_detected"] = fall_confirmed

            if fall_confirmed and not ts.get("fall_saved", False):
                snapshot_id = str(uuid.uuid4())
                person_crop = crop_full_person(frame, det["person_bbox"])
                snapshot_path = None
                if person_crop is not None:
                    snapshot_path = os.path.join(SNAPSHOT_DIR, f"{snapshot_id}.jpg")
                    cv2.imwrite(snapshot_path, person_crop)

                queue_violation_event({
                    "id": snapshot_id,
                    "camera_id": camera_id,
                    "source_path": source_path,
                    "track_id": track_id,
                    "event_type": "Fall Detected",
                    "person_bbox": det["person_bbox"],
                    "snapshot_path": snapshot_path,
                    "detection_sensitivity": detection_sensitivity,
                    "inactivity_timer_seconds": inactivity_timer_seconds,
                })
                ts["fall_saved"] = True

        return detections_unscaled

    def _process_view_frame(
        view_key: str,
        img: np.ndarray,
        all_views: set,
        dresscode_views: set,
        fall_views: set,
    ) -> tuple[list[dict], dict | None]:
        nonlocal track_state
        nonlocal cached_detections
        nonlocal cached_people_count
        nonlocal classify_candidates
        nonlocal classified_count
        nonlocal detect_batch_size_sum
        nonlocal detect_batch_samples

        orig_h, orig_w = img.shape[:2]
        scaled_detections: list[dict] = []
        counting_data = None

        if run_detection_this_frame and view_key in all_views:
            needs_fall_detection = view_key in fall_views
            enable_pants_detection, enable_slipper_detection = _get_classifier_flags()
            skip_classification = (
                view_key not in dresscode_views
                or not (enable_pants_detection or enable_slipper_detection)
            )
            detection_roi_areas = _get_source_detection_roi_areas(view_key)
            detections, people_count, track_state, perf = run_detection_and_classify(
                img,
                frame_count,
                track_state,
                skip_classification=skip_classification,
                need_fall_detection=needs_fall_detection,
                view_key=view_key,
                detection_roi_areas=detection_roi_areas,
            )
            stage_ms["infer_wait"] += perf.get("infer_wait_ms", perf.get("detect_ms", 0.0))
            stage_ms["infer_queue_wait"] += perf.get("infer_queue_wait_ms", 0.0)
            stage_ms["infer_predict"] += perf.get("infer_predict_ms", perf.get("detect_ms", 0.0))
            stage_ms["infer_predict_total_batch"] += perf.get(
                "infer_predict_total_ms",
                perf.get("detect_total_ms", 0.0),
            )
            stage_ms["infer_post"] += perf.get("infer_post_ms", 0.0)
            stage_ms["classify"] += perf.get("classify_ms", 0.0)
            classify_candidates += perf.get("classify_candidates", 0)
            classified_count += perf.get("classified", 0)
            detect_batch_size_sum += perf.get("batch_size", 1)
            detect_batch_samples += 1

            policy_started_at = time.perf_counter()
            detections = _apply_policy_and_save(
                detections,
                track_state,
                img,
                runtime_key,
                source_path,
                view_key=view_key,
            )
            stage_ms["policy_queue"] += (time.perf_counter() - policy_started_at) * 1000.0

            if needs_fall_detection:
                detections = _run_fall_detection_for_view(view_key, detections, img, source_path)

            counting_started_at = time.perf_counter()
            counting_data = _run_counting_for_view(view_key, detections, (orig_h, orig_w))
            stage_ms["counting"] += (time.perf_counter() - counting_started_at) * 1000.0
            if counting_data is not None:
                cached_counting_data[view_key] = counting_data

            scaled_detections = scale_detections(detections, orig_h, orig_w)
            cached_detections = scaled_detections
            cached_people_count = people_count
        elif view_key in all_views:
            scaled_detections = cached_detections
            counting_data = cached_counting_data.get(view_key)

        return scaled_detections, counting_data

    # -----------------------------------------------------------------------
    # Main loop
    # -----------------------------------------------------------------------
    while True:
        if stop_event.is_set():
            print(f"[Producer] Stop requested for runtime_key={runtime_key}, source={source_path}")
            break

        if sync_timeline_active and fps > 0:
            target_frame_index = max(0, int((time.perf_counter() - sync_started_at) * fps))
            while decoded_frame_index < target_frame_index - 1:
                if not _skip_file_frame():
                    break

        loop_start = time.time()
        if use_async_capture:
            packet = async_reader.read(timeout=ASYNC_CAPTURE_READ_TIMEOUT_MS / 1000.0) if async_reader else None
            if packet is None:
                continue

            packet_type = packet.get("type")
            if packet_type == "fatal":
                print(
                    f"[Producer] Async capture failed for runtime_key={runtime_key}, "
                    f"reason={packet.get('reason')}"
                )
                break
            if packet_type == "eof":
                print(f"[Producer] EOF reached, stopping uploaded source: {source_path}")
                reached_eof = True
                break
            if packet_type != "frame":
                continue

            frame = packet.get("frame")
            if frame is None:
                continue
            decode_ms = float(packet.get("decode_ms", 0.0))
        else:
            read_started_at = time.perf_counter()
            ret, frame = cap.read()
            decode_ms = (time.perf_counter() - read_started_at) * 1000.0
            if ret:
                decoded_frame_index += 1
                if rtsp_read_failures > 0 and source_meta.get("is_network_stream_source"):
                    print(
                        f"[Producer] Recovered live stream after {rtsp_read_failures} failed frame(s): "
                        f"runtime_key={runtime_key}"
                    )
                    rtsp_read_failures = 0

            if not ret:
                # Uploaded file source reached EOF: stop producer automatically.
                if source_meta.get("is_uploaded_source") and source_meta.get("is_file_source"):
                    print(f"[Producer] EOF reached, stopping uploaded source: {source_path}")
                    reached_eof = True
                    break

                if source_meta.get("is_network_stream_source"):
                    _handle_rtsp_capture_failure("read_failed")
                    continue

                # Non-upload/live source: transient read failure, keep retrying.
                time.sleep(0.1)
                continue

            if source_meta.get("is_rtsp_source"):
                is_bad_frame, bad_frame_reason, frame_signature = _detect_corrupted_rtsp_frame(
                    frame,
                    last_good_frame_signature,
                )
                if is_bad_frame:
                    _handle_rtsp_capture_failure(bad_frame_reason or "corrupted_frame")
                    continue
                last_good_frame_signature = frame_signature

        frame_count += 1

        # FPS counter
        fps_frame_count += 1
        if (time.time() - fps_start_time) >= 1.0:
            current_real_fps = fps_frame_count / (time.time() - fps_start_time)
            fps_frame_count = 0
            fps_start_time = time.time()

        run_detection_this_frame = (frame_count % detection_stride == 0)
        producer_started_at = time.perf_counter()

        stage_ms = {
            "capture_decode": decode_ms,
            "fisheye": 0.0,
            "infer_wait": 0.0,
            "infer_queue_wait": 0.0,
            "infer_predict": 0.0,
            "infer_predict_total_batch": 0.0,
            "infer_post": 0.0,
            "classify": 0.0,
            "policy_queue": 0.0,
            "counting": 0.0,
            "encode": 0.0,
            "nvenc": 0.0,
        }
        classify_candidates = 0
        classified_count = 0
        detect_batch_size_sum = 0
        detect_batch_samples = 0

        current_buffer = {}
        current_buffer['__meta__'] = {
            'fps': round(current_real_fps, 1),
            'people_count': cached_people_count,
            'detections': [],
            'counting_data': {},
            'stream_status': 'live',
        }
        all_views = _get_all_detection_views(source_path)
        dresscode_views = _get_detection_views(runtime_key)
        fall_views = get_fall_detection_views(source_path)

        if is_fisheye and processor:
            try:
                # 1. Fisheye processing (full resolution)
                fisheye_started_at = time.perf_counter()
                processed_frames, _, _ = processor.process_frame(frame, overlay=True, view_id=None)
                stage_ms["fisheye"] += (time.perf_counter() - fisheye_started_at) * 1000.0

                # 2. Process each view
                view_detections = {}  # key -> scaled detections list
                view_counting_data = {}  # key -> counting_data dict

                for key, img in processed_frames.items():
                    try:
                        scaled, counting_data = _process_view_frame(
                            key,
                            img,
                            all_views,
                            dresscode_views,
                            fall_views,
                        )
                        view_detections[key] = scaled
                        if counting_data is not None:
                            view_counting_data[key] = counting_data

                        # Encode clean frame (no plot)
                        encode_started_at = time.perf_counter()
                        current_buffer[key] = encode_frame(img)
                        stage_ms["encode"] += (time.perf_counter() - encode_started_at) * 1000.0
                        stage_ms["nvenc"] += _write_nvenc_frame(key, img)

                    except Exception as e:
                        print(f"Encoding error for {key}: {e}")

                # Store detections per-view in metadata
                current_buffer['__meta__']['detections'] = view_detections
                current_buffer['__meta__']['people_count'] = cached_people_count
                current_buffer['__meta__']['counting_data'] = view_counting_data

            except Exception as e:
                print(f"[Producer] Error: {e}")

        else:
            # --- Normal (non-fisheye) video processing ---
            try:
                scaled, counting_data = _process_view_frame(
                    "original",
                    frame,
                    all_views,
                    dresscode_views,
                    fall_views,
                )

                # Encode clean frame
                encode_started_at = time.perf_counter()
                current_buffer['original'] = encode_frame(frame)
                stage_ms["encode"] += (time.perf_counter() - encode_started_at) * 1000.0
                stage_ms["nvenc"] += _write_nvenc_frame("original", frame)
                current_buffer['__meta__']['detections'] = {'original': scaled}
                current_buffer['__meta__']['people_count'] = cached_people_count
                current_buffer['__meta__']['counting_data'] = {
                    'original': counting_data if counting_data is not None else {},
                }

            except Exception as e:
                print(f"[Producer] Normal video error: {e}")

        producer_wall_ms = (time.perf_counter() - producer_started_at) * 1000.0
        if PERF_STAGE_LOGS and (frame_count % PERF_LOG_INTERVAL_FRAMES == 0):
            producer_stage_sum_ms = (
                + stage_ms["fisheye"]
                + stage_ms["infer_wait"]
                + stage_ms["policy_queue"]
                + stage_ms["counting"]
                + stage_ms["encode"]
                + stage_ms["nvenc"]
            )
            avg_detect_batch = (detect_batch_size_sum / detect_batch_samples) if detect_batch_samples else 0.0
            # print(
            #     f"[Perf] capture_decode={stage_ms['capture_decode']:.1f}ms "
            #     f"producer_wall={producer_wall_ms:.1f}ms "
            #     f"producer_stage_sum={producer_stage_sum_ms:.1f}ms "
            #     f"fisheye={stage_ms['fisheye']:.1f}ms "
            #     f"infer_wait={stage_ms['infer_wait']:.1f}ms "
            #     f"infer_queue_wait={stage_ms['infer_queue_wait']:.1f}ms "
            #     f"infer_predict={stage_ms['infer_predict']:.1f}ms "
            #     f"infer_predict_total_batch={stage_ms['infer_predict_total_batch']:.1f}ms "
            #     f"infer_post={stage_ms['infer_post']:.1f}ms "
            #     f"avg_detect_batch={avg_detect_batch:.2f} "
            #     f"classify={stage_ms['classify']:.1f}ms "
            #     f"policy_queue={stage_ms['policy_queue']:.1f}ms "
            #     f"counting={stage_ms['counting']:.1f}ms "
            #     f"encode={stage_ms['encode']:.1f}ms "
            #     f"nvenc={stage_ms['nvenc']:.1f}ms "
            #     f"classify_batch={classified_count}/{classify_candidates} "
            #     f"fps={current_real_fps:.1f} "
            #     f"runtime_key={runtime_key}"
            # )

        # Update global buffer (atomic assignment)
        FRAME_BUFFERS[runtime_key] = current_buffer

        # --- Timing control ---
        if sync_timeline_active and fps > 0:
            next_frame_deadline = sync_started_at + ((decoded_frame_index + 1) / fps)
            wait = next_frame_deadline - time.perf_counter()
            if wait > 0:
                time.sleep(wait)
        else:
            elapsed = time.time() - loop_start
            wait = delay - elapsed
            if wait > 0:
                time.sleep(wait)

    for writer in nvenc_writers.values():
        writer.close()
    if async_reader is not None:
        async_reader.close()
    else:
        cap.release()
    final_reason = "finished" if reached_eof else "stopped"
    _set_runtime_stream_status(runtime_key, status="offline", reason=final_reason, clear_images=True)
    _cleanup_producer_state(runtime_key, clear_frame_buffer=True)
    print(f"[Producer] Stopped loop for runtime_key={runtime_key}, source={source_path}")


# ---------------------------------------------------------------------------
# Policy helpers (read from in-memory cache, updated by policy_router)
# ---------------------------------------------------------------------------
# Default policy -- overridden at runtime when policy is loaded from DB
_current_policy = {
    "enabled_camera_ids": [],
    "restricted_labels": ["shorts"],
    "confidence_threshold": 0.8,
    "enable_pants_detection": True,
    "enable_slipper_detection": False,
    "detection_map": {},       # runtime_key -> set of view_keys
    "camera_id_map": {},       # "runtime_key||view_key" -> camera_id
}
_policy_lock = threading.Lock()


def update_policy(policy: dict):
    """Called by policy_router when policy changes."""
    global _current_policy
    with _policy_lock:
        _current_policy = policy
    print(
        f"[Policy] Updated: enabled_cameras={policy.get('enabled_camera_ids')}, "
        f"pants_enabled={policy.get('enable_pants_detection', True)}, "
        f"slipper_enabled={policy.get('enable_slipper_detection', False)}, "
        f"detection_map keys={list(policy.get('detection_map', {}).keys())}"
    )


def get_policy() -> dict:
    with _policy_lock:
        return dict(_current_policy)


def _get_detection_views(runtime_key: str) -> set:
    """Get set of view keys that should run detection for a specific runtime key."""
    p = get_policy()
    detection_map = p.get("detection_map", {})
    return detection_map.get(runtime_key, set())


def _get_camera_id(runtime_key: str, view_key: str) -> str | None:
    """Resolve the camera_id for a specific runtime key + view."""
    p = get_policy()
    camera_id_map = p.get("camera_id_map", {})
    return camera_id_map.get(f"{runtime_key}||{view_key}")


def _get_classifier_flags() -> tuple[bool, bool]:
    policy = get_policy()
    return (
        bool(policy.get("enable_pants_detection", True)),
        bool(policy.get("enable_slipper_detection", False)),
    )


def _should_reuse_cached_classification(cached: dict, *, now_monotonic: float) -> bool:
    last_classified_at = cached.get("last_classified_at_monotonic")
    if last_classified_at is None:
        return False
    if (now_monotonic - float(last_classified_at)) >= DRESSCODE_RECLASSIFY_INTERVAL_SEC:
        return False
    return bool(cached.get("label") is not None or cached.get("classifications"))


def _get_cached_classification_for_enabled_models(cached: dict, *, enable_pants: bool, enable_slipper: bool) -> dict | None:
    classifications = []
    for item in list(cached.get("classifications") or []):
        region = item.get("region")
        if region == "lower_body" and enable_pants:
            classifications.append(dict(item))
        elif region == "footwear" and enable_slipper:
            classifications.append(dict(item))

    if not classifications:
        label = cached.get("label")
        confidence = cached.get("confidence")
        if enable_pants and label is not None and confidence is not None:
            classifications = [
                {
                    "label": label,
                    "confidence": confidence,
                    "region": "lower_body",
                }
            ]
        else:
            return None

    primary = next(
        (item for item in classifications if item.get("region") == "lower_body"),
        classifications[0],
    )
    return {
        "label": primary.get("label"),
        "confidence": primary.get("confidence"),
        "lower_bbox": cached.get("lower_bbox") if enable_pants else None,
        "slipper_bbox": cached.get("slipper_bbox") if enable_slipper else None,
        "classifications": classifications,
    }


def _collect_violation_classifications(det: dict, restricted: set[str], threshold: float) -> list[dict]:
    classifications = list(det.get("classifications") or [])

    if not classifications and det.get("label") is not None and det.get("confidence") is not None:
        classifications = [
            {
                "label": det.get("label"),
                "confidence": det.get("confidence"),
                "region": "lower_body",
            }
        ]

    candidates = []
    for item in classifications:
        label = item.get("label")
        confidence = item.get("confidence")
        if label is None or confidence is None:
            continue
        if label in restricted and confidence >= threshold:
            candidates.append(dict(item))

    return candidates


def _select_display_violation(matched_violations: list[dict]) -> dict | None:
    if not matched_violations:
        return None
    return max(
        matched_violations,
        key=lambda item: float(item.get("confidence", 0.0)),
    )


def _clear_violation_tracking(track_entry: dict) -> None:
    track_entry.pop("violation_candidate_label", None)
    track_entry.pop("violation_candidate_count", None)
    track_entry.pop("violation_candidate_started_at_monotonic", None)
    track_entry.pop("confirmed_violation", None)
    track_entry.pop("confirmed_matched_violations", None)
    track_entry.pop("last_matched_violations", None)


def _clear_pending_violation_candidate(track_entry: dict) -> None:
    track_entry.pop("violation_candidate_label", None)
    track_entry.pop("violation_candidate_count", None)
    track_entry.pop("violation_candidate_started_at_monotonic", None)


def _update_violation_confirmation_state(
    track_entry: dict,
    matched_violations: list[dict],
    *,
    classification_fresh: bool,
) -> tuple[dict | None, list[dict]]:
    now_monotonic = time.monotonic()
    candidate_started_at = track_entry.get("violation_candidate_started_at_monotonic")
    if candidate_started_at is not None:
        candidate_age_sec = now_monotonic - float(candidate_started_at)
        if candidate_age_sec > DRESSCODE_VIOLATION_WINDOW_SEC:
            _clear_pending_violation_candidate(track_entry)

    if not matched_violations:
        track_entry.pop("confirmed_violation", None)
        track_entry.pop("confirmed_matched_violations", None)
        track_entry.pop("last_matched_violations", None)
        return None, []

    display_violation = _select_display_violation(matched_violations)
    if display_violation is None:
        track_entry.pop("confirmed_violation", None)
        track_entry.pop("confirmed_matched_violations", None)
        track_entry.pop("last_matched_violations", None)
        return None, []

    track_entry["last_matched_violations"] = [dict(item) for item in matched_violations]

    if classification_fresh:
        display_label = display_violation.get("label")
        candidate_label = track_entry.get("violation_candidate_label")
        candidate_started_at = track_entry.get("violation_candidate_started_at_monotonic")
        candidate_within_window = (
            candidate_label == display_label
            and candidate_started_at is not None
            and (now_monotonic - float(candidate_started_at)) <= DRESSCODE_VIOLATION_WINDOW_SEC
        )

        if candidate_within_window:
            track_entry["violation_candidate_count"] = int(track_entry.get("violation_candidate_count", 0)) + 1
        else:
            track_entry["violation_candidate_label"] = display_label
            track_entry["violation_candidate_count"] = 1
            track_entry["violation_candidate_started_at_monotonic"] = now_monotonic

        if int(track_entry.get("violation_candidate_count", 0)) >= DRESSCODE_VIOLATION_CONFIRMATIONS:
            track_entry["confirmed_violation"] = dict(display_violation)
            track_entry["confirmed_matched_violations"] = [dict(item) for item in matched_violations]

    confirmed_violation = track_entry.get("confirmed_violation")
    if confirmed_violation is None:
        return None, []

    confirmed_label = confirmed_violation.get("label")
    if confirmed_label is None:
        _clear_violation_tracking(track_entry)
        return None, []

    if not any(item.get("label") == confirmed_label for item in matched_violations):
        _clear_violation_tracking(track_entry)
        return None, []

    latest_display = next(
        (item for item in matched_violations if item.get("label") == confirmed_label),
        confirmed_violation,
    )
    track_entry["confirmed_violation"] = dict(latest_display)
    track_entry["confirmed_matched_violations"] = [dict(item) for item in matched_violations]
    return dict(latest_display), [dict(item) for item in matched_violations]


def _apply_policy_and_save(detections, track_state, frame, runtime_key, source_path, view_key=None):
    """
    Apply the current policy to mark violations and save snapshot evidence.
    Deduplicates by track_id (one snapshot per track).
    """
    policy = get_policy()
    restricted = set(policy.get("restricted_labels", []))
    threshold = policy.get("confidence_threshold", 0.8)

    # Resolve camera_id from the runtime key + view key
    camera_id = _get_camera_id(runtime_key, view_key) if view_key else None

    for det in detections:
        track_id = det.get("track_id")
        matched_violations = _collect_violation_classifications(det, restricted, threshold)
        det["matched_violations"] = [dict(item) for item in matched_violations]

        track_entry = None
        if track_id is not None:
            if track_id not in track_state:
                track_state[track_id] = {"violation_saved": False}
            track_entry = track_state[track_id]

        classification_fresh = bool(det.get("_classification_fresh", False))
        if track_entry is not None:
            violation_cls, confirmed_matches = _update_violation_confirmation_state(
                track_entry,
                matched_violations,
                classification_fresh=classification_fresh,
            )
        else:
            violation_cls = _select_display_violation(matched_violations)
            confirmed_matches = [dict(item) for item in matched_violations] if violation_cls is not None else []

        if violation_cls is not None:
            label = violation_cls.get("label")
            conf = violation_cls.get("confidence")
            det["label"] = label
            det["confidence"] = conf
            det["matched_violations"] = confirmed_matches
            det["violation"] = True

            # Dedup: only save once per track
            if track_id is not None and camera_id is not None:
                ts = track_state.get(track_id, {})
                if not ts.get("violation_saved", False):
                    # Save snapshot evidence
                    snapshot_id = str(uuid.uuid4())
                    person_crop = crop_full_person(frame, det["person_bbox"])
                    snapshot_path = None
                    if person_crop is not None:
                        snapshot_path = os.path.join(SNAPSHOT_DIR, f"{snapshot_id}.jpg")
                        cv2.imwrite(snapshot_path, person_crop)

                    # Queue violation event for async DB write
                    queue_violation_event({
                        "id": snapshot_id,
                        "camera_id": camera_id,
                        "source_path": source_path,
                        "track_id": track_id,
                        "event_type": "Dress Code Violation",
                        "label": label,
                        "confidence": conf,
                        "classifications": det.get("classifications") or [],
                        "matched_violations": det.get("matched_violations") or [],
                        "lower_bbox": det.get("lower_bbox"),
                        "slipper_bbox": det.get("slipper_bbox"),
                        "person_bbox": det["person_bbox"],
                        "snapshot_path": snapshot_path,
                    })

                    # Mark as saved
                    if track_id in track_state:
                        track_state[track_id]["violation_saved"] = True
        else:
            det["violation"] = False

    return detections
