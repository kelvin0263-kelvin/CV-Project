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
from ultralytics.trackers.track import TRACKER_MAP
from turbojpeg import TurboJPEG
from ultralytics.utils import IterableSimpleNamespace, YAML
from app.services.dresscode_detector import classify_lower_body_batch, crop_full_person
from app.services.building_counter import ingest_sensor_events
from app.services.people_counter import PeopleCounter
from app.routers.counting_router import (
    consume_counting_reset,
    get_counting_views,
    get_counting_camera_id,
    get_counting_config,
    update_live_counts,
    queue_counting_snapshot,
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
POSE_MODEL_PATH = os.path.join(BACKEND_ROOT, "yolo26n-pose.pt")
TRACKER_CONFIG_PATH = os.getenv(
    "TRACKER_CONFIG_PATH",
    os.path.join(BACKEND_ROOT, "botsort_custom.yaml"),
)
YOLO_DEVICE = os.getenv("YOLO_DEVICE")


def _get_env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def _get_env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _get_env_str(name: str, default: str) -> str:
    raw = os.getenv(name)
    if raw is None:
        return default
    value = raw.strip()
    return value or default


POSE_TRACK_IMGSZ = max(320, _get_env_int("POSE_TRACK_IMGSZ", 736))
DETECTION_STRIDE = max(1, _get_env_int("DETECTION_STRIDE", 4))
COUNTING_SNAPSHOT_HEARTBEAT_SEC = max(60, _get_env_int("COUNTING_SNAPSHOT_HEARTBEAT_SEC", 300))
DRESSCODE_RECLASSIFY_FRAMES = max(1, _get_env_int("DRESSCODE_RECLASSIFY_FRAMES", 30))
PERF_LOG_INTERVAL_FRAMES = max(1, _get_env_int("PERF_LOG_INTERVAL_FRAMES", 30))
PERF_STAGE_LOGS = _get_env_bool("PERF_STAGE_LOGS", True)
MULTI_STREAM_BATCH_INFER = _get_env_bool("MULTI_STREAM_BATCH_INFER", True)
BATCH_INFER_WINDOW_MS = max(1, _get_env_int("BATCH_INFER_WINDOW_MS", 5))
BATCH_INFER_MAX_BATCH = max(1, _get_env_int("BATCH_INFER_MAX_BATCH", 8))
BATCH_INFER_WAIT_MS = max(50, _get_env_int("BATCH_INFER_WAIT_MS", 1500))
RTSP_MAX_CONSECUTIVE_READ_FAILURES = max(1, _get_env_int("RTSP_MAX_CONSECUTIVE_READ_FAILURES", 5))
RTSP_READ_FAILURE_BACKOFF_MS = max(0, _get_env_int("RTSP_READ_FAILURE_BACKOFF_MS", 100))
NVENC_OUTPUT_ENABLED = _get_env_bool("NVENC_OUTPUT_ENABLED", False)
NVENC_OUTPUT_DIR = _get_env_str(
    "NVENC_OUTPUT_DIR",
    os.path.join(PROJECT_ROOT, "temp_video_uploads", "nvenc_outputs"),
)
NVENC_OUTPUT_CONTAINER = _get_env_str("NVENC_OUTPUT_CONTAINER", "mp4").lower()
NVENC_CODEC = _get_env_str("NVENC_CODEC", "h264_nvenc")
NVENC_PRESET = _get_env_str("NVENC_PRESET", "p4")
NVENC_TUNE = _get_env_str("NVENC_TUNE", "ll")
NVENC_RATE_CONTROL = _get_env_str("NVENC_RATE_CONTROL", "vbr")
NVENC_BITRATE_K = max(256, _get_env_int("NVENC_BITRATE_K", 2500))
NVENC_MAXRATE_K = max(NVENC_BITRATE_K, _get_env_int("NVENC_MAXRATE_K", 3500))
NVENC_BUFSIZE_K = max(NVENC_MAXRATE_K, _get_env_int("NVENC_BUFSIZE_K", 7000))
FFMPEG_BIN = _get_env_str("FFMPEG_BIN", "ffmpeg")

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


def _is_rtsp_source(source_path: str) -> bool:
    return is_rtsp_source(source_path)


def _build_source_meta(source_path: str) -> dict:
    is_rtsp_source = _is_rtsp_source(source_path)
    if is_rtsp_source:
        return {
            "is_file_source": False,
            "is_uploaded_source": False,
            "is_rtsp_source": True,
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
    }


def _open_video_capture(source_path: str, source_meta: dict) -> cv2.VideoCapture:
    return open_video_capture(source_path, is_rtsp=bool(source_meta.get("is_rtsp_source")))


def _sanitize_token(value: str, fallback: str = "stream") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", (value or "").strip()).strip("._-")
    return cleaned or fallback


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
        self._worker = threading.Thread(target=self._worker_loop, daemon=True)

        tracker_cfg_raw = YAML.load(TRACKER_CONFIG_PATH)
        self._tracker_cfg = IterableSimpleNamespace(**tracker_cfg_raw)
        tracker_type = getattr(self._tracker_cfg, "tracker_type", "")
        if tracker_type not in TRACKER_MAP:
            raise ValueError(f"Unsupported tracker type: {tracker_type}")
        self._tracker_cls = TRACKER_MAP[tracker_type]

        print("[BatchInfer] Loading shared YOLO model...")
        self._model = YOLO(POSE_MODEL_PATH)
        self._worker.start()
        print(
            f"[BatchInfer] Ready: tracker={tracker_type}, window={BATCH_INFER_WINDOW_MS}ms, "
            f"max_batch={BATCH_INFER_MAX_BATCH}"
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
        frame_count: int,
        track_state: dict,
        skip_classification: bool,
    ) -> tuple[list[dict], int, dict, dict]:
        done = threading.Event()
        req = {
            "stream_id": stream_id,
            "img": img,
            "frame_count": frame_count,
            "track_state": track_state,
            "skip_classification": skip_classification,
            "done": done,
            "result": None,
        }
        self._req_queue.put(req)

        if not done.wait(timeout=BATCH_INFER_WAIT_MS / 1000.0):
            return [], 0, track_state, {
                "detect_ms": 0.0,
                "detect_total_ms": 0.0,
                "batch_size": 1,
                "classify_ms": 0.0,
                "classify_candidates": 0,
                "classified": 0,
            }

        result = req.get("result")
        if result is None:
            return [], 0, track_state, {
                "detect_ms": 0.0,
                "detect_total_ms": 0.0,
                "batch_size": 1,
                "classify_ms": 0.0,
                "classify_candidates": 0,
                "classified": 0,
            }
        return result

    def _worker_loop(self):
        batch_window_sec = BATCH_INFER_WINDOW_MS / 1000.0

        while True:
            first = self._req_queue.get()
            if first is None:
                return

            batch = [first]
            deadline = time.perf_counter() + batch_window_sec
            while len(batch) < BATCH_INFER_MAX_BATCH:
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

    def _process_batch(self, batch: list[dict]):
        detect_started_at = time.perf_counter()
        images = [item["img"] for item in batch]

        predict_kwargs = {
            "source": images,
            "verbose": False,
            "classes": [0],
            "conf": 0.30,
            "iou": 0.5,
            "imgsz": POSE_TRACK_IMGSZ,
        }
        if YOLO_DEVICE:
            predict_kwargs["device"] = YOLO_DEVICE

        try:
            results = self._model.predict(**predict_kwargs)
        except Exception as e:
            print(f"[BatchInfer] Predict error: {e}")
            for req in batch:
                req["result"] = (
                    [],
                    0,
                    req["track_state"],
                    {
                        "detect_ms": 0.0,
                        "detect_total_ms": 0.0,
                        "batch_size": len(batch),
                        "classify_ms": 0.0,
                        "classify_candidates": 0,
                        "classified": 0,
                    },
                )
                req["done"].set()
            return

        detect_ms_total = (time.perf_counter() - detect_started_at) * 1000.0
        detect_ms_each = detect_ms_total / max(1, len(batch))

        processed = 0
        for req, result in zip(batch, results):
            processed += 1
            detections: list[dict] = []
            classify_candidates: list[dict] = []
            classified_count = 0
            classify_ms = 0.0

            boxes = result.boxes
            tracker = self._get_tracker(req["stream_id"])
            if boxes is None:
                tracked = np.empty((0, 8), dtype=np.float32)
            else:
                tracked = tracker.update(boxes.cpu().numpy(), img=req["img"])

            keypoints = None
            if not req["skip_classification"] and result.keypoints is not None:
                keypoints = result.keypoints.xy.cpu().numpy()

            track_state = req["track_state"]
            for row in tracked:
                x1, y1, x2, y2, tid, _score, _cls, det_idx = row.tolist()
                track_id = int(tid)
                det_index = int(det_idx)
                person_bbox = [float(x1), float(y1), float(x2), float(y2)]

                cls_result = None
                if not req["skip_classification"]:
                    cached = track_state.get(track_id)
                    if cached is not None:
                        frames_since = req["frame_count"] - cached.get("last_classified_frame", 0)
                        if (
                            frames_since < DRESSCODE_RECLASSIFY_FRAMES
                            and cached.get("label") is not None
                            and cached.get("confidence") is not None
                        ):
                            cls_result = {
                                "label": cached.get("label"),
                                "confidence": cached.get("confidence"),
                                "lower_bbox": cached.get("lower_bbox"),
                            }
                    if cls_result is None:
                        kp_row = None
                        if keypoints is not None and 0 <= det_index < keypoints.shape[0]:
                            kp_row = keypoints[det_index]
                        classify_candidates.append(
                            {
                                "det_pos": len(detections),
                                "track_id": track_id,
                                "bbox": person_bbox,
                                "keypoints": kp_row,
                            }
                        )

                detections.append(
                    {
                        "track_id": track_id,
                        "person_bbox": person_bbox,
                        "label": cls_result["label"] if cls_result else None,
                        "confidence": cls_result["confidence"] if cls_result else None,
                        "lower_bbox": cls_result["lower_bbox"] if cls_result else None,
                        "violation": False,
                    }
                )

            if not req["skip_classification"] and classify_candidates:
                classify_started_at = time.perf_counter()
                batch_results = classify_lower_body_batch(
                    req["img"],
                    [{"bbox": item["bbox"], "keypoints": item["keypoints"]} for item in classify_candidates],
                    device=YOLO_DEVICE,
                )
                classify_ms = (time.perf_counter() - classify_started_at) * 1000.0

                for cand, cls_result in zip(classify_candidates, batch_results):
                    if cls_result is None:
                        continue
                    det = detections[cand["det_pos"]]
                    det["label"] = cls_result["label"]
                    det["confidence"] = cls_result["confidence"]
                    det["lower_bbox"] = cls_result.get("lower_bbox")
                    classified_count += 1

                    track_id = cand["track_id"]
                    if track_id not in track_state:
                        track_state[track_id] = {"violation_saved": False}
                    track_state[track_id].update(
                        {
                            "label": cls_result["label"],
                            "confidence": cls_result["confidence"],
                            "lower_bbox": cls_result.get("lower_bbox"),
                            "last_classified_frame": req["frame_count"],
                        }
                    )

            req["result"] = (
                detections,
                len(tracked),
                track_state,
                {
                    "detect_ms": detect_ms_each,
                    "detect_total_ms": detect_ms_total,
                    "batch_size": len(batch),
                    "classify_ms": classify_ms,
                    "classify_candidates": len(classify_candidates),
                    "classified": classified_count,
                },
            )
            req["done"].set()

        if processed < len(batch):
            for req in batch[processed:]:
                req["result"] = (
                    [],
                    0,
                    req["track_state"],
                    {
                        "detect_ms": 0.0,
                        "detect_total_ms": 0.0,
                        "batch_size": len(batch),
                        "classify_ms": 0.0,
                        "classify_candidates": 0,
                        "classified": 0,
                    },
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
        PRODUCER_META.pop(runtime_key, None)
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

    if stop_event is None:
        stop_event = threading.Event()
    if source_meta is None:
        source_meta = _build_source_meta(source_path)

    cap = _open_video_capture(source_path, source_meta)
    if not cap.isOpened() and source_meta.get("is_rtsp_source"):
        for _ in range(5):
            if stop_event.is_set():
                break
            time.sleep(1.0)
            cap.release()
            cap = _open_video_capture(source_path, source_meta)
            if cap.isOpened():
                break

    if not cap.isOpened():
        print(f"[Producer] Failed to open {source_path} (runtime_key={runtime_key})")
        _cleanup_producer_state(runtime_key, clear_frame_buffer=True)
        return

    local_model = None
    # Ensure shared batch inference engine is ready once.
    if MULTI_STREAM_BATCH_INFER:
        try:
            _get_batch_infer_engine()
        except Exception as e:
            print(f"[Producer] Failed to initialize batch inference engine: {e}")
            cap.release()
            _cleanup_producer_state(runtime_key, clear_frame_buffer=True)
            return
    else:
        # Legacy per-stream detector path.
        print(f"[Producer] Loading YOLO model for runtime_key={runtime_key}, source={source_path}")
        try:
            local_model = YOLO(POSE_MODEL_PATH)
        except Exception as e:
            print(f"[Producer] Failed to load YOLO model for {source_path}: {e}")
            cap.release()
            _cleanup_producer_state(runtime_key, clear_frame_buffer=True)
            return

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
        view_key: str = "original",
    ):
        """
        Run YOLO-Pose tracking on a full-res image.
        If skip_classification is False, also runs dress code classification.

        Returns:
            (detections_list, people_count, updated_track_state, perf_dict)

        Each detection dict:
            {track_id, person_bbox, count_anchor, label, confidence, lower_bbox, violation}
        """
        if MULTI_STREAM_BATCH_INFER:
            engine = _get_batch_infer_engine()
            stream_id = f"{runtime_key}||{view_key}"
            return engine.infer(
                stream_id=stream_id,
                img=img,
                frame_count=frame_count,
                track_state=track_state,
                skip_classification=skip_classification,
            )

        if local_model is None:
            return [], 0, track_state, {
                "detect_ms": 0.0,
                "detect_total_ms": 0.0,
                "batch_size": 1,
                "classify_ms": 0.0,
                "classify_candidates": 0,
                "classified": 0,
            }

        try:
            detect_started_at = time.perf_counter()
            # YOLO-Pose tracking with BoT-SORT for better occlusion handling.
            # BoT-SORT adds ReID appearance features + improved Kalman filter,
            # so tracks survive brief occlusions (e.g. door frame) much better.
            track_kwargs = {
                "source": img,
                "tracker": TRACKER_CONFIG_PATH,
                "persist": True,
                "verbose": False,
                "classes": [0],     # person only
                "conf": 0.30,       # lower threshold: keep detections during partial occlusion
                "iou": 0.5,         # more lenient matching: easier to re-associate after occlusion
                "imgsz": POSE_TRACK_IMGSZ,
            }
            if YOLO_DEVICE:
                track_kwargs["device"] = YOLO_DEVICE

            results = local_model.track(**track_kwargs)

            if not results:
                detect_ms = (time.perf_counter() - detect_started_at) * 1000.0
                return [], 0, track_state, {
                    "detect_ms": detect_ms,
                    "detect_total_ms": detect_ms,
                    "batch_size": 1,
                    "classify_ms": 0.0,
                    "classify_candidates": 0,
                    "classified": 0,
                }

            r = results[0]
            boxes_xyxy = r.boxes.xyxy.cpu().numpy() if r.boxes is not None else np.empty((0, 4))
            track_ids = (
                r.boxes.id.int().cpu().tolist()
                if r.boxes is not None and r.boxes.id is not None
                else []
            )
            keypoints = None
            # Counting-only views do not need keypoints; skip extraction to avoid extra GPU->CPU copies.
            if not skip_classification and r.keypoints is not None:
                keypoints = r.keypoints.xy.cpu().numpy()
            detect_ms = (time.perf_counter() - detect_started_at) * 1000.0

            people_count = len(boxes_xyxy)
            detections = []
            classify_candidates = []
            classified_count = 0
            classify_ms = 0.0

            for i, box_coords in enumerate(boxes_xyxy):
                track_id = int(track_ids[i]) if i < len(track_ids) and track_ids[i] is not None else None

                person_bbox = list(map(float, box_coords))

                cls_result = None

                # Only run dress code classification when needed
                if not skip_classification:
                    # --- Per-track classification throttling ---
                    if track_id is not None and track_id in track_state:
                        cached = track_state[track_id]
                        frames_since = frame_count - cached.get("last_classified_frame", 0)
                        if (
                            frames_since < DRESSCODE_RECLASSIFY_FRAMES
                            and cached.get("label") is not None
                            and cached.get("confidence") is not None
                        ):
                            # Reuse cached label
                            cls_result = {
                                "label": cached.get("label"),
                                "confidence": cached.get("confidence"),
                                "lower_bbox": cached.get("lower_bbox"),
                            }

                    # Queue for batch classification if no cached result.
                    if cls_result is None:
                        kp_row = keypoints[i] if keypoints is not None and keypoints.shape[0] > i else None
                        classify_candidates.append({
                            "det_index": i,
                            "track_id": track_id,
                            "bbox": box_coords,
                            "keypoints": kp_row,
                        })

                # Build detection entry
                det = {
                    "track_id": track_id,
                    "person_bbox": person_bbox,
                    "label": cls_result["label"] if cls_result else None,
                    "confidence": cls_result["confidence"] if cls_result else None,
                    "lower_bbox": cls_result["lower_bbox"] if cls_result else None,
                    "violation": False,  # Will be set by policy check later
                }
                detections.append(det)

            if not skip_classification and classify_candidates:
                classify_started_at = time.perf_counter()
                batch_results = classify_lower_body_batch(
                    img,
                    [{"bbox": item["bbox"], "keypoints": item["keypoints"]} for item in classify_candidates],
                    device=YOLO_DEVICE,
                )
                classify_ms = (time.perf_counter() - classify_started_at) * 1000.0

                for item, cls_result in zip(classify_candidates, batch_results):
                    if cls_result is None:
                        continue
                    det = detections[item["det_index"]]
                    det["label"] = cls_result["label"]
                    det["confidence"] = cls_result["confidence"]
                    det["lower_bbox"] = cls_result.get("lower_bbox")
                    classified_count += 1

                    track_id = item["track_id"]
                    if track_id is not None:
                        if track_id not in track_state:
                            track_state[track_id] = {"violation_saved": False}
                        track_state[track_id].update({
                            "label": cls_result["label"],
                            "confidence": cls_result["confidence"],
                            "lower_bbox": cls_result.get("lower_bbox"),
                            "last_classified_frame": frame_count,
                        })

            return detections, people_count, track_state, {
                "detect_ms": detect_ms,
                "detect_total_ms": detect_ms,
                "batch_size": 1,
                "classify_ms": classify_ms,
                "classify_candidates": len(classify_candidates),
                "classified": classified_count,
            }

        except Exception as e:
            print(f"[Detection] Error: {e}")
            return [], 0, track_state, {
                "detect_ms": 0.0,
                "detect_total_ms": 0.0,
                "batch_size": 1,
                "classify_ms": 0.0,
                "classify_candidates": 0,
                "classified": 0,
            }

    # --- Scale detection coordinates to 640x360 for frontend ---
    def scale_detections(detections, orig_h, orig_w, target_w=640, target_h=360):
        sx = target_w / orig_w
        sy = target_h / orig_h
        scaled = []
        for d in detections:
            sd = dict(d)
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
            scaled.append(sd)
        return scaled

    # -----------------------------------------------------------------------
    # Init buffer and state
    # -----------------------------------------------------------------------
    FRAME_BUFFERS[runtime_key] = {}

    # FPS calculation
    fps_start_time = time.time()
    fps_frame_count = 0
    current_real_fps = 0.0

    # Detection state
    detection_stride = DETECTION_STRIDE
    frame_count = 0
    decoded_frame_index = -1
    rtsp_read_failures = 0
    track_state = {}       # {track_id: {label, confidence, last_classified_frame, violation_saved}}
    cached_detections = [] # Reused between detection frames
    cached_people_count = 0

    # People counting state: view_key -> PeopleCounter instance
    people_counters: dict[str, PeopleCounter] = {}
    cached_counting_data: dict[str, dict] = {}  # view_key -> last counting result
    counting_event_state: dict[str, dict[str, int]] = {}  # view_key -> previous total counts
    nvenc_writers: dict[str, _NvencOutputWriter] = {}
    sync_started_at = None

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
        skipped = cap.grab()
        if skipped:
            decoded_frame_index += 1
        return skipped

    # -----------------------------------------------------------------------
    # Helper: get all views needing detection (dress code OR counting)
    # -----------------------------------------------------------------------
    def _get_all_detection_views():
        """Union of dress-code views and people-counting views."""
        dresscode_views = _get_detection_views(runtime_key)
        counting_views = get_counting_views(runtime_key)
        return dresscode_views | counting_views

    def _run_counting_for_view(view_key, detections_unscaled, frame_shape):
        """Run people counting on unscaled detections for a specific view."""
        camera_id = get_counting_camera_id(runtime_key, view_key)
        if camera_id is None:
            return None

        config = get_counting_config(camera_id)
        if config is None or not config.get("enabled", True):
            return None

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
            counting_event_state[view_key] = {
                "total_in": 0,
                "total_out": 0,
            }
            counting_data = counter._empty_result()
            update_live_counts(camera_id, counting_data)
            return counting_data

        counting_data = counter.update(detections_unscaled, frame_shape)

        prev_state = counting_event_state.get(view_key, {"total_in": 0, "total_out": 0})
        total_in = int(counting_data.get("total_in", 0) or 0)
        total_out = int(counting_data.get("total_out", 0) or 0)
        delta_in = max(0, total_in - int(prev_state.get("total_in", 0) or 0))
        delta_out = max(0, total_out - int(prev_state.get("total_out", 0) or 0))
        counting_event_state[view_key] = {
            "total_in": total_in,
            "total_out": total_out,
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
        read_started_at = time.perf_counter()
        ret, frame = cap.read()
        decode_ms = (time.perf_counter() - read_started_at) * 1000.0
        if ret:
            decoded_frame_index += 1
            if rtsp_read_failures > 0 and source_meta.get("is_rtsp_source"):
                print(
                    f"[Producer] Recovered RTSP stream after {rtsp_read_failures} failed read(s): "
                    f"runtime_key={runtime_key}"
                )
                rtsp_read_failures = 0

        if not ret:
            # Uploaded file source reached EOF: stop producer automatically.
            if source_meta.get("is_uploaded_source") and source_meta.get("is_file_source"):
                print(f"[Producer] EOF reached, stopping uploaded source: {source_path}")
                break

            if source_meta.get("is_rtsp_source"):
                rtsp_read_failures += 1
                if rtsp_read_failures < RTSP_MAX_CONSECUTIVE_READ_FAILURES:
                    if rtsp_read_failures == 1:
                        print(
                            f"[Producer] RTSP read failed; tolerating up to "
                            f"{RTSP_MAX_CONSECUTIVE_READ_FAILURES} consecutive failures before reconnect: "
                            f"runtime_key={runtime_key}"
                        )
                    time.sleep(RTSP_READ_FAILURE_BACKOFF_MS / 1000.0)
                    continue

                print(
                    f"[Producer] RTSP read failed {rtsp_read_failures} consecutive times; reconnecting: "
                    f"runtime_key={runtime_key}"
                )
                cap.release()
                time.sleep(0.5)
                cap = _open_video_capture(source_path, source_meta)
                rtsp_read_failures = 0
                continue

            # Non-upload/live source: transient read failure, keep retrying.
            time.sleep(0.1)
            continue

        frame_count += 1

        # FPS counter
        fps_frame_count += 1
        if (time.time() - fps_start_time) >= 1.0:
            current_real_fps = fps_frame_count / (time.time() - fps_start_time)
            fps_frame_count = 0
            fps_start_time = time.time()

        run_detection_this_frame = (frame_count % detection_stride == 0)

        stage_ms = {
            "decode": decode_ms,
            "fisheye": 0.0,
            "detect": 0.0,
            "detect_total_batch": 0.0,
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
        }

        if is_fisheye and processor:
            try:
                # 1. Fisheye processing (full resolution)
                fisheye_started_at = time.perf_counter()
                processed_frames, _, _ = processor.process_frame(frame, overlay=True, view_id=None)
                stage_ms["fisheye"] += (time.perf_counter() - fisheye_started_at) * 1000.0

                # 2. Process each view
                view_detections = {}  # key -> scaled detections list

                view_counting_data = {}  # key -> counting_data dict
                all_views = _get_all_detection_views()
                dresscode_views = _get_detection_views(runtime_key)

                for key, img in processed_frames.items():
                    try:
                        orig_h, orig_w = img.shape[:2]

                        # Run detection on target views only, respecting stride
                        if run_detection_this_frame and key in all_views:
                            # Skip dress code classification if only counting needs this view
                            only_counting = key not in dresscode_views
                            detections, people_count, track_state, perf = run_detection_and_classify(
                                img, frame_count, track_state,
                                skip_classification=only_counting,
                                view_key=key,
                            )
                            stage_ms["detect"] += perf.get("detect_ms", 0.0)
                            stage_ms["detect_total_batch"] += perf.get("detect_total_ms", 0.0)
                            stage_ms["classify"] += perf.get("classify_ms", 0.0)
                            classify_candidates += perf.get("classify_candidates", 0)
                            classified_count += perf.get("classified", 0)
                            detect_batch_size_sum += perf.get("batch_size", 1)
                            detect_batch_samples += 1
                            # Check policy for violations & save snapshots
                            policy_started_at = time.perf_counter()
                            detections = _apply_policy_and_save(
                                detections, track_state, img, runtime_key, source_path, view_key=key
                            )
                            stage_ms["policy_queue"] += (time.perf_counter() - policy_started_at) * 1000.0

                            # Run people counting on unscaled detections
                            counting_started_at = time.perf_counter()
                            cd = _run_counting_for_view(key, detections, (orig_h, orig_w))
                            stage_ms["counting"] += (time.perf_counter() - counting_started_at) * 1000.0
                            if cd is not None:
                                view_counting_data[key] = cd
                                cached_counting_data[key] = cd

                            scaled = scale_detections(detections, orig_h, orig_w)
                            view_detections[key] = scaled
                            cached_detections = scaled
                            cached_people_count = people_count
                        elif key in all_views:
                            # Reuse cached detections
                            view_detections[key] = cached_detections
                            if key in cached_counting_data:
                                view_counting_data[key] = cached_counting_data[key]
                        else:
                            view_detections[key] = []

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
                orig_h, orig_w = frame.shape[:2]
                all_views = _get_all_detection_views()
                dresscode_views = _get_detection_views(runtime_key)

                if run_detection_this_frame and "original" in all_views:
                    # Skip dress code classification if only counting needs this view
                    only_counting = "original" not in dresscode_views
                    detections, people_count, track_state, perf = run_detection_and_classify(
                        frame, frame_count, track_state,
                        skip_classification=only_counting,
                        view_key="original",
                    )
                    stage_ms["detect"] += perf.get("detect_ms", 0.0)
                    stage_ms["detect_total_batch"] += perf.get("detect_total_ms", 0.0)
                    stage_ms["classify"] += perf.get("classify_ms", 0.0)
                    classify_candidates += perf.get("classify_candidates", 0)
                    classified_count += perf.get("classified", 0)
                    detect_batch_size_sum += perf.get("batch_size", 1)
                    detect_batch_samples += 1
                    policy_started_at = time.perf_counter()
                    detections = _apply_policy_and_save(
                        detections, track_state, frame, runtime_key, source_path, view_key="original"
                    )
                    stage_ms["policy_queue"] += (time.perf_counter() - policy_started_at) * 1000.0

                    # Run people counting on unscaled detections
                    counting_started_at = time.perf_counter()
                    cd = _run_counting_for_view("original", detections, (orig_h, orig_w))
                    stage_ms["counting"] += (time.perf_counter() - counting_started_at) * 1000.0
                    if cd is not None:
                        cached_counting_data["original"] = cd

                    scaled = scale_detections(detections, orig_h, orig_w)
                    cached_detections = scaled
                    cached_people_count = people_count

                # Encode clean frame
                encode_started_at = time.perf_counter()
                current_buffer['original'] = encode_frame(frame)
                stage_ms["encode"] += (time.perf_counter() - encode_started_at) * 1000.0
                stage_ms["nvenc"] += _write_nvenc_frame("original", frame)
                current_buffer['__meta__']['detections'] = {'original': cached_detections}
                current_buffer['__meta__']['people_count'] = cached_people_count
                current_buffer['__meta__']['counting_data'] = {
                    'original': cached_counting_data.get('original', {}),
                }

            except Exception as e:
                print(f"[Producer] Normal video error: {e}")

        if PERF_STAGE_LOGS and (frame_count % PERF_LOG_INTERVAL_FRAMES == 0):
            total_stage_ms = (
                stage_ms["decode"]
                + stage_ms["fisheye"]
                + stage_ms["detect"]
                + stage_ms["classify"]
                + stage_ms["policy_queue"]
                + stage_ms["counting"]
                + stage_ms["encode"]
                + stage_ms["nvenc"]
            )
            avg_detect_batch = (detect_batch_size_sum / detect_batch_samples) if detect_batch_samples else 0.0
            print(
                f"[Perf] decode={stage_ms['decode']:.1f}ms "
                f"fisheye={stage_ms['fisheye']:.1f}ms "
                f"detect={stage_ms['detect']:.1f}ms "
                f"detect_total_batch={stage_ms['detect_total_batch']:.1f}ms "
                f"avg_detect_batch={avg_detect_batch:.2f} "
                f"classify={stage_ms['classify']:.1f}ms "
                f"policy_queue={stage_ms['policy_queue']:.1f}ms "
                f"counting={stage_ms['counting']:.1f}ms "
                f"encode={stage_ms['encode']:.1f}ms "
                f"nvenc={stage_ms['nvenc']:.1f}ms "
                f"total={total_stage_ms:.1f}ms "
                f"classify_batch={classified_count}/{classify_candidates} "
                f"fps={current_real_fps:.1f} "
                f"runtime_key={runtime_key}"
            )

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
    cap.release()
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
    "detection_map": {},       # runtime_key -> set of view_keys
    "camera_id_map": {},       # "runtime_key||view_key" -> camera_id
}
_policy_lock = threading.Lock()


def update_policy(policy: dict):
    """Called by policy_router when policy changes."""
    global _current_policy
    with _policy_lock:
        _current_policy = policy
    print(f"[Policy] Updated: enabled_cameras={policy.get('enabled_camera_ids')}, "
          f"detection_map keys={list(policy.get('detection_map', {}).keys())}")


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
        label = det.get("label")
        conf = det.get("confidence")
        track_id = det.get("track_id")

        if label and conf and label in restricted and conf >= threshold:
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
                        "person_bbox": det["person_bbox"],
                        "snapshot_path": snapshot_path,
                    })

                    # Mark as saved
                    if track_id in track_state:
                        track_state[track_id]["violation_saved"] = True
        else:
            det["violation"] = False

    return detections
