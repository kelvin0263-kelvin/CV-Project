"""
Video Producer Service

Reads video frames, runs YOLO-Pose tracking (ByteTrack), classifies
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
import numpy as np

# Ensure backend root is in path to import DefishVideoCV
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from DefishVideoCV import FisheyeMultiView
from app.core.globals import FRAME_BUFFERS, ACTIVE_PRODUCERS
from ultralytics import YOLO
from turbojpeg import TurboJPEG
from app.services.dresscode_detector import classify_lower_body, crop_full_person
from app.services.people_counter import PeopleCounter
from app.routers.counting_router import (
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
SNAPSHOT_DIR = os.path.join(PROJECT_ROOT, "temp_video_uploads", "snapshots")
os.makedirs(SNAPSHOT_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# Initialize TurboJPEG
# ---------------------------------------------------------------------------
try:
    jpeg = TurboJPEG()
except Exception as e:
    print(f"[System] Warning: TurboJPEG not found: {e}. Using OpenCV fallback.")
    jpeg = None

# ---------------------------------------------------------------------------
# Initialize YOLO-Pose Model
# ---------------------------------------------------------------------------
print("[System] Loading YOLOv11-Pose Model...")
try:
    model = YOLO("yolo11m-pose.pt")
except Exception as e:
    print(f"[System] Warning: Failed to load YOLO model: {e}")
    model = None

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


# ---------------------------------------------------------------------------
# Producer thread management
# ---------------------------------------------------------------------------
def start_producer_thread(source_path: str, is_fisheye: bool, active_views: list = None):
    if source_path in ACTIVE_PRODUCERS:
        return  # Already running

    ACTIVE_PRODUCERS[source_path] = True
    threading.Thread(
        target=video_producer,
        args=(source_path, is_fisheye, active_views),
        daemon=True,
    ).start()


# ---------------------------------------------------------------------------
# Main producer loop
# ---------------------------------------------------------------------------
def video_producer(source_path: str, is_fisheye: bool, active_views: list = None):
    print(f"[Producer] Starting loop for {source_path}")

    cap = cv2.VideoCapture(source_path)
    if not cap.isOpened():
        print(f"[Producer] Failed to open {source_path}")
        if source_path in ACTIVE_PRODUCERS:
            del ACTIVE_PRODUCERS[source_path]
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
    def run_detection_and_classify(img, frame_count, track_state, skip_classification=False):
        """
        Run YOLO-Pose tracking on a full-res image.
        If skip_classification is False, also runs dress code classification.

        Returns:
            (detections_list, people_count, updated_track_state)

        Each detection dict:
            {track_id, person_bbox, label, confidence, lower_bbox, violation}
        """
        if model is None:
            return [], 0, track_state

        try:
            # YOLO-Pose tracking with BoT-SORT for better occlusion handling.
            # BoT-SORT adds ReID appearance features + improved Kalman filter,
            # so tracks survive brief occlusions (e.g. door frame) much better.
            results = model.track(
                source=img,
                tracker="botsort.yaml",
                persist=True,
                verbose=False,
                classes=[0],        # person only
                conf=0.35,          # lower threshold: keep detections during partial occlusion
                iou=0.5,            # more lenient matching: easier to re-associate after occlusion
                imgsz=1280,         # matches training: imgsz=1280
                device='0',
            )

            if not results:
                return [], 0, track_state

            r = results[0]
            boxes_xyxy = r.boxes.xyxy.cpu().numpy() if r.boxes is not None else np.empty((0, 4))
            track_ids = (
                r.boxes.id.int().cpu().tolist()
                if r.boxes is not None and r.boxes.id is not None
                else []
            )
            keypoints = r.keypoints.xy.cpu().numpy() if r.keypoints is not None else None

            people_count = len(boxes_xyxy)
            detections = []

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
                        if frames_since < 30:
                            # Reuse cached label
                            cls_result = {
                                "label": cached["label"],
                                "confidence": cached["confidence"],
                                "lower_bbox": cached.get("lower_bbox"),
                            }

                    # Classify if no cached result
                    if cls_result is None:
                        kp_row = None
                        if keypoints is not None and keypoints.shape[0] > i:
                            kp_row = keypoints[i]

                        cls_result = classify_lower_body(img, box_coords, kp_row, device='0')

                        # Update track state
                        if track_id is not None and cls_result is not None:
                            if track_id not in track_state:
                                track_state[track_id] = {"violation_saved": False}
                            track_state[track_id].update({
                                "label": cls_result["label"],
                                "confidence": cls_result["confidence"],
                                "lower_bbox": cls_result.get("lower_bbox"),
                                "last_classified_frame": frame_count,
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

            return detections, people_count, track_state

        except Exception as e:
            print(f"[Detection] Error: {e}")
            return [], 0, track_state

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
            if sd.get("lower_bbox"):
                b = sd["lower_bbox"]
                sd["lower_bbox"] = [round(b[0]*sx), round(b[1]*sy), round(b[2]*sx), round(b[3]*sy)]
            scaled.append(sd)
        return scaled

    # -----------------------------------------------------------------------
    # Init buffer and state
    # -----------------------------------------------------------------------
    FRAME_BUFFERS[source_path] = {}

    # FPS calculation
    fps_start_time = time.time()
    fps_frame_count = 0
    current_real_fps = 0.0

    # Detection state
    detection_stride = 1  # Run YOLO every frame (set to 3 to skip frames and save GPU)
    frame_count = 0
    track_state = {}       # {track_id: {label, confidence, last_classified_frame, violation_saved}}
    cached_detections = [] # Reused between detection frames
    cached_people_count = 0

    # People counting state: view_key -> PeopleCounter instance
    people_counters: dict[str, PeopleCounter] = {}
    cached_counting_data: dict[str, dict] = {}  # view_key -> last counting result

    # -----------------------------------------------------------------------
    # Helper: get all views needing detection (dress code OR counting)
    # -----------------------------------------------------------------------
    def _get_all_detection_views():
        """Union of dress-code views and people-counting views."""
        dresscode_views = _get_detection_views(source_path)
        counting_views = get_counting_views(source_path)
        return dresscode_views | counting_views

    def _run_counting_for_view(view_key, detections_unscaled, frame_shape):
        """Run people counting on unscaled detections for a specific view."""
        camera_id = get_counting_camera_id(source_path, view_key)
        if camera_id is None:
            return None

        config = get_counting_config(camera_id)
        if config is None or not config.get("enabled", True):
            return None

        # Get or create PeopleCounter for this view
        if view_key not in people_counters:
            people_counters[view_key] = PeopleCounter(config)
            print(f"[Counting] Created counter for {view_key} (camera={camera_id}), "
                  f"lines={len(config.get('lines', []))}, zones={len(config.get('zones', []))}")
        else:
            # Hot-reload config changes
            people_counters[view_key].update_config(config)

        counter = people_counters[view_key]
        counting_data = counter.update(detections_unscaled, frame_shape)

        # Publish live counts
        update_live_counts(camera_id, counting_data)

        # Check capacity alert
        alert = counter.check_capacity_alert()
        if alert:
            alert["camera_id"] = camera_id
            queue_violation_event(alert)

        # Periodic snapshot
        if counter.should_snapshot(interval=10.0):
            snap = counter.get_snapshot_data(camera_id)
            snap["zone_counts"] = counting_data.get("zone_counts", {})
            queue_counting_snapshot(snap)

        return counting_data

    # -----------------------------------------------------------------------
    # Main loop
    # -----------------------------------------------------------------------
    while True:
        loop_start = time.time()
        ret, frame = cap.read()

        if not ret:
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            # Reset tracking state on video loop
            track_state = {}
            cached_detections = []
            cached_people_count = 0
            # Reset people counters on video loop
            for counter in people_counters.values():
                counter.reset()
            continue

        frame_count += 1

        # FPS counter
        fps_frame_count += 1
        if (time.time() - fps_start_time) >= 1.0:
            current_real_fps = fps_frame_count / (time.time() - fps_start_time)
            fps_frame_count = 0
            fps_start_time = time.time()

        run_detection_this_frame = (frame_count % detection_stride == 0)

        # --- Timing ---
        t0 = time.time()

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
                processed_frames, _, _ = processor.process_frame(frame, overlay=True, view_id=None)
                t1 = time.time()

                # 2. Process each view
                view_detections = {}  # key -> scaled detections list

                view_counting_data = {}  # key -> counting_data dict

                for key, img in processed_frames.items():
                    try:
                        orig_h, orig_w = img.shape[:2]

                        # Run detection on target views only, respecting stride
                        all_views = _get_all_detection_views()
                        dresscode_views = _get_detection_views(source_path)
                        if run_detection_this_frame and key in all_views:
                            # Skip dress code classification if only counting needs this view
                            only_counting = key not in dresscode_views
                            detections, people_count, track_state = run_detection_and_classify(
                                img, frame_count, track_state,
                                skip_classification=only_counting,
                            )
                            # Check policy for violations & save snapshots
                            detections = _apply_policy_and_save(
                                detections, track_state, img, source_path, view_key=key
                            )

                            # Run people counting on unscaled detections
                            cd = _run_counting_for_view(key, detections, (orig_h, orig_w))
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
                        current_buffer[key] = encode_frame(img)

                    except Exception as e:
                        print(f"Encoding error for {key}: {e}")

                # Store detections per-view in metadata
                current_buffer['__meta__']['detections'] = view_detections
                current_buffer['__meta__']['people_count'] = cached_people_count
                current_buffer['__meta__']['counting_data'] = view_counting_data

                t2 = time.time()

                # Perf logging
                if fps_frame_count % 30 == 0:
                    fisheye_ms = (t1 - t0) * 1000
                    detect_encode_ms = (t2 - t1) * 1000
                    total_ms = (t2 - t0) * 1000
                    print(
                        f"[Perf] Fisheye: {fisheye_ms:.1f}ms | Detect+Encode: {detect_encode_ms:.1f}ms"
                        f" | Total: {total_ms:.1f}ms | FPS: {current_real_fps:.1f}"
                    )

            except Exception as e:
                print(f"[Producer] Error: {e}")

        else:
            # --- Normal (non-fisheye) video processing ---
            try:
                orig_h, orig_w = frame.shape[:2]
                all_views = _get_all_detection_views()
                dresscode_views = _get_detection_views(source_path)

                if run_detection_this_frame and "original" in all_views:
                    # Skip dress code classification if only counting needs this view
                    only_counting = "original" not in dresscode_views
                    detections, people_count, track_state = run_detection_and_classify(
                        frame, frame_count, track_state,
                        skip_classification=only_counting,
                    )
                    detections = _apply_policy_and_save(
                        detections, track_state, frame, source_path, view_key="original"
                    )

                    # Run people counting on unscaled detections
                    cd = _run_counting_for_view("original", detections, (orig_h, orig_w))
                    if cd is not None:
                        cached_counting_data["original"] = cd

                    scaled = scale_detections(detections, orig_h, orig_w)
                    cached_detections = scaled
                    cached_people_count = people_count

                # Encode clean frame
                current_buffer['original'] = encode_frame(frame)
                current_buffer['__meta__']['detections'] = {'original': cached_detections}
                current_buffer['__meta__']['people_count'] = cached_people_count
                current_buffer['__meta__']['counting_data'] = {
                    'original': cached_counting_data.get('original', {}),
                }

            except Exception as e:
                print(f"[Producer] Normal video error: {e}")

        # Update global buffer (atomic assignment)
        FRAME_BUFFERS[source_path] = current_buffer

        # --- Timing control ---
        elapsed = time.time() - loop_start
        wait = delay - elapsed
        if wait > 0:
            time.sleep(wait)


# ---------------------------------------------------------------------------
# Policy helpers (read from in-memory cache, updated by policy_router)
# ---------------------------------------------------------------------------
# Default policy -- overridden at runtime when policy is loaded from DB
_current_policy = {
    "enabled_camera_ids": [],
    "restricted_labels": ["shorts"],
    "confidence_threshold": 0.8,
    "detection_map": {},       # source_path -> set of view_keys
    "camera_id_map": {},       # "source_path||view_key" -> camera_id
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


def _get_detection_views(source_path: str) -> set:
    """Get set of view keys that should run detection for a specific source."""
    p = get_policy()
    detection_map = p.get("detection_map", {})
    return detection_map.get(source_path, set())


def _get_camera_id(source_path: str, view_key: str) -> str | None:
    """Resolve the camera_id for a specific source + view."""
    p = get_policy()
    camera_id_map = p.get("camera_id_map", {})
    return camera_id_map.get(f"{source_path}||{view_key}")


def _apply_policy_and_save(detections, track_state, frame, source_path, view_key=None):
    """
    Apply the current policy to mark violations and save snapshot evidence.
    Deduplicates by track_id (one snapshot per track).
    """
    policy = get_policy()
    restricted = set(policy.get("restricted_labels", []))
    threshold = policy.get("confidence_threshold", 0.8)

    # Resolve camera_id from the source_path + view_key
    camera_id = _get_camera_id(source_path, view_key) if view_key else None

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
