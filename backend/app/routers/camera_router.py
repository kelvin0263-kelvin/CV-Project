from fastapi import APIRouter, UploadFile, File, Form, HTTPException, WebSocket, WebSocketDisconnect, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete as sa_delete
from typing import List, Any
import uuid
import os
import asyncio
import cv2
import base64
import json
import tempfile
import time
import threading
import re
import subprocess

import numpy as np

from pydantic import BaseModel

from app.core.video_capture import is_rtsp_source, open_video_capture
from app.models.camera_model import Camera
from app.models.dresscode_policy import DressCodePolicy
from app.models.fall_detection_config import FallDetectionConfig
from app.models.people_counting_config import PeopleCountingConfig
from app.models.stream_config import StreamConfig
from app.schemas.camera import CameraCreate, CameraRead
from app.core.database import get_db, AsyncSessionLocal
from app.core.globals import FRAME_BUFFERS, PRODUCER_META, PRODUCER_LOCK
from app.services.video_processor import (
    FFMPEG_BIN,
    start_producer_thread,
    stop_producer_thread,
    is_producer_running,
)
from app.services.source_roi_registry import replace_source_detection_rois
from app.services.upload_sync import (
    discard_pending_runtime_key,
    is_pending_runtime_key,
    list_sync_groups,
    register_pending_upload,
    start_sync_group,
)
from app.routers.policy_router import sync_policy_runtime_from_db
from app.routers.counting_router import sync_counting_runtime_from_db
from DefishVideoCV import FisheyeMultiView

router = APIRouter()

# Directories
# We place uploads OUTSIDE the backend directory to prevent uvicorn auto-reload from triggering
# when a new file is written. This prevents in-memory state from being wiped.
BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROJECT_ROOT = os.path.dirname(BACKEND_ROOT)  # Go up one level to CV-UI/
UPLOAD_DIR = os.path.join(PROJECT_ROOT, "temp_video_uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

try:
    WS_MAX_FPS = float(os.getenv("WS_MAX_FPS", "30"))
except ValueError:
    WS_MAX_FPS = 30.0
WS_SEND_INTERVAL = 0.0 if WS_MAX_FPS <= 0 else 1.0 / WS_MAX_FPS


class StreamConnectionTestRequest(BaseModel):
    source_path: str
    enable_fisheye: bool = False
    selected_view: int | None = None


class StreamSourceCreateRequest(BaseModel):
    name: str
    location: str = ""
    source_path: str
    mode: str = "Unassigned"
    resolution: str = "640x360"
    fps: int = 30
    enabled: bool = True
    enable_fisheye: bool = False
    selected_views: list[int] = []
    detection_roi: dict[str, Any] | None = None


class UploadRuntimeActionRequest(BaseModel):
    runtime_keys: list[str]


class UploadPreviewRequest(BaseModel):
    runtime_key: str
    camera_id: str | None = None
    selected_view: int | None = None


class UploadVideoUpdateRequest(BaseModel):
    runtime_key: str
    name: str
    location: str = ""
    detection_roi: dict[str, Any] | None = None
    is_fisheye: bool | None = None
    view_index: int | None = None


FISHEYE_VIEW_CONFIGS = [
    {"angle_z": 0, "angle_up": 35, "zoom": 80},
    {"angle_z": 45, "angle_up": 35, "zoom": 80},
    {"angle_z": 90, "angle_up": 35, "zoom": 80},
    {"angle_z": 135, "angle_up": 35, "zoom": 80},
    {"angle_z": 180, "angle_up": 35, "zoom": 80},
    {"angle_z": 225, "angle_up": 35, "zoom": 80},
    {"angle_z": 270, "angle_up": 35, "zoom": 80},
    {"angle_z": 315, "angle_up": 35, "zoom": 80},
]

FISHEYE_UPLOAD_NAME_PATTERN = re.compile(r"^(?P<prefix>.+?)\s-\sView\s\d+\s*\([^)]*\)$")


def _build_uploaded_camera_name(base_name: str, view_index: int, is_fisheye: bool) -> str:
    normalized_base_name = (base_name or "").strip() or "Uploaded Camera"
    if not is_fisheye or view_index < 0:
        return normalized_base_name
    angle = view_index * 45
    return f"{normalized_base_name} - View {view_index + 1} ({angle}°)"


def _normalize_detection_roi(raw_roi: dict | None) -> dict | None:
    if not isinstance(raw_roi, dict):
        return None

    points = raw_roi.get("points", [])
    normalized_points: list[list[float]] = []
    for point in points:
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            continue
        try:
            x = max(0.0, min(1.0, float(point[0])))
            y = max(0.0, min(1.0, float(point[1])))
        except (TypeError, ValueError):
            continue
        normalized_points.append([x, y])

    if len(normalized_points) < 3:
        return None

    return {
        "id": str(raw_roi.get("id") or "detection_roi"),
        "name": str(raw_roi.get("name") or "Detection ROI"),
        "points": normalized_points,
    }


def _infer_stream_camera_type(source_path: str, *, is_fisheye: bool = False) -> str:
    if is_rtsp_source(source_path):
        return "RTSP Fisheye" if is_fisheye else "RTSP"
    return "Network Stream Fisheye" if is_fisheye else "Network Stream"


def _default_ws_url(camera_id: str) -> str:
    return f"ws://localhost:8000/ws/{camera_id}"


def _is_uploaded_source_path(source_path: str | None) -> bool:
    if not source_path:
        return False
    try:
        source_abs = os.path.abspath(source_path)
        return os.path.commonpath([source_abs, UPLOAD_DIR]) == UPLOAD_DIR
    except ValueError:
        return False


def _infer_source_kind(source_path: str | None) -> str:
    if not source_path:
        return "other"
    if _is_uploaded_source_path(source_path):
        return "uploaded_video"
    if is_rtsp_source(source_path):
        return "rtsp"
    return "network"


def _normalize_runtime_key(source_path: str, runtime_key: str | None = None) -> str:
    normalized_source = source_path.strip()
    normalized_runtime_key = (runtime_key or normalized_source).strip()
    return normalized_runtime_key or normalized_source


def _get_runtime_key(stream_config: StreamConfig) -> str:
    return _normalize_runtime_key(
        stream_config.source_path,
        getattr(stream_config, "runtime_key", None),
    )


async def _sync_runtime_state(db: AsyncSession):
    await sync_stream_roi_runtime_from_db(db)
    await sync_policy_runtime_from_db(db)
    await sync_counting_runtime_from_db(db)


def _build_camera_read(
    camera: Camera,
    stream_config: StreamConfig | None = None,
    analysis_tags: list[str] | None = None,
) -> CameraRead:
    source_path = stream_config.source_path if stream_config is not None else None
    runtime_key = _get_runtime_key(stream_config) if stream_config is not None else None
    is_uploaded = _is_uploaded_source_path(source_path)
    source_kind = _infer_source_kind(source_path)
    producer_running = bool(runtime_key and is_producer_running(runtime_key))
    status = camera.status
    if is_uploaded:
        status = _resolve_uploaded_runtime_status(runtime_key, producer_running)

    return CameraRead(
        id=camera.id,
        name=camera.name,
        location=camera.location,
        type=camera.type,
        status=status,
        mode=camera.mode,
        ws_url=camera.ws_url or _default_ws_url(camera.id),
        resolution=camera.resolution,
        fps=camera.fps,
        enabled=camera.enabled,
        image=camera.image,
        source_path=source_path,
        runtime_key=runtime_key,
        view_index=stream_config.view_index if stream_config is not None else -1,
        is_fisheye=bool(stream_config.is_fisheye) if stream_config is not None else False,
        is_uploaded=is_uploaded,
        is_rtsp=bool(source_path and is_rtsp_source(source_path)),
        source_kind=source_kind,
        producer_running=producer_running,
        detection_roi=_normalize_detection_roi(stream_config.detection_roi) if stream_config is not None else None,
        analysis_tags=analysis_tags or [],
    )


async def sync_stream_roi_runtime_from_db(session: AsyncSession):
    result = await session.execute(select(StreamConfig))
    rows = result.scalars().all()

    next_map: dict[str, dict] = {}
    for row in rows:
        runtime_key = _get_runtime_key(row)
        view_key = "original" if row.view_index == -1 else f"partition_{row.view_index}"
        normalized_roi = _normalize_detection_roi(row.detection_roi)
        if normalized_roi is not None:
            next_map[f"{runtime_key}||{view_key}"] = normalized_roi

    replace_source_detection_rois(next_map)


def _get_runtime_stream_state(runtime_key: str | None) -> dict[str, Any]:
    if not runtime_key:
        return {}

    frame_meta = {}
    if runtime_key in FRAME_BUFFERS:
        frame_meta = dict((FRAME_BUFFERS.get(runtime_key) or {}).get("__meta__", {}))

    with PRODUCER_LOCK:
        producer_meta = dict(PRODUCER_META.get(runtime_key, {}))

    if frame_meta:
        producer_meta.update(frame_meta)
    return producer_meta


def _resolve_uploaded_runtime_status(runtime_key: str | None, producer_running: bool) -> str:
    if producer_running:
        return "Running"

    runtime_state = _get_runtime_stream_state(runtime_key)
    stream_reason = str(runtime_state.get("stream_reason") or "").lower()
    if stream_reason == "finished":
        return "Finished"
    return "Ready"


async def load_stream_roi_runtime_from_db():
    try:
        async with AsyncSessionLocal() as session:
            await sync_stream_roi_runtime_from_db(session)
            print("[Startup] Loaded source detection ROI config(s)")
    except Exception as e:
        print(f"[Startup] Warning: Could not load source detection ROIs: {e}")


async def _derive_analysis_tags_by_camera(
    session: AsyncSession,
    camera_ids: list[str],
) -> dict[str, list[str]]:
    if not camera_ids:
        return {}

    tags_map: dict[str, list[str]] = {camera_id: [] for camera_id in camera_ids}

    counting_result = await session.execute(
        select(PeopleCountingConfig.camera_id).where(
            PeopleCountingConfig.camera_id.in_(camera_ids),
            PeopleCountingConfig.enabled.is_(True),
        )
    )
    for camera_id in set(counting_result.scalars().all()):
        tags_map.setdefault(camera_id, []).append("People Counting")

    policy_result = await session.execute(select(DressCodePolicy).limit(1))
    policy = policy_result.scalar_one_or_none()
    if policy is not None and policy.enabled:
        enabled_dress_ids = set(policy.enabled_camera_ids or [])
        for camera_id in camera_ids:
            if camera_id in enabled_dress_ids:
                tags_map[camera_id].append("Dress Code")

    fall_result = await session.execute(
        select(FallDetectionConfig.camera_id).where(
            FallDetectionConfig.camera_id.in_(camera_ids),
            FallDetectionConfig.enabled.is_(True),
        )
    )
    for camera_id in set(fall_result.scalars().all()):
        tags_map.setdefault(camera_id, []).append("Fall Detection")

    for camera_id in camera_ids:
        if not tags_map[camera_id]:
            tags_map[camera_id].append("Unassigned")

    return tags_map


async def _get_stream_config(session: AsyncSession, camera_id: str) -> StreamConfig | None:
    result = await session.execute(
        select(StreamConfig).where(StreamConfig.camera_id == camera_id)
    )
    return result.scalar_one_or_none()


async def _get_active_views_for_runtime(
    session: AsyncSession,
    runtime_key: str,
    is_fisheye: bool,
) -> list[int] | None:
    if not is_fisheye:
        return None

    result = await session.execute(
        select(StreamConfig.view_index).where(
            StreamConfig.runtime_key == runtime_key,
            StreamConfig.is_fisheye.is_(True),
        )
    )
    active_views = sorted({
        view_index
        for view_index in result.scalars().all()
        if view_index is not None and view_index >= 0
    })
    return active_views or None


async def _get_uploaded_runtime_rows(
    session: AsyncSession,
    runtime_keys: list[str] | None = None,
) -> list[tuple[Camera, StreamConfig]]:
    result = await session.execute(
        select(Camera, StreamConfig).join(StreamConfig, StreamConfig.camera_id == Camera.id)
    )
    rows = []
    allowed_runtime_keys = set(runtime_keys or [])
    for camera, stream_config in result.all():
        if not _is_uploaded_source_path(stream_config.source_path):
            continue
        runtime_key = _get_runtime_key(stream_config)
        if allowed_runtime_keys and runtime_key not in allowed_runtime_keys:
            continue
        rows.append((camera, stream_config))
    return rows


def _build_upload_runtime_payload(
    runtime_key: str,
    rows: list[tuple[Camera, StreamConfig]],
    tags_map: dict[str, list[str]],
) -> dict:
    first_camera, first_stream = rows[0]
    source_path = first_stream.source_path
    unique_tags: list[str] = []
    seen_tags: set[str] = set()
    cameras_payload = []
    for camera, stream_config in rows:
        camera_tags = tags_map.get(camera.id, ["Unassigned"])
        for tag in camera_tags:
            if tag not in seen_tags:
                unique_tags.append(tag)
                seen_tags.add(tag)
        cameras_payload.append(
            _build_camera_read(camera, stream_config, analysis_tags=camera_tags).model_dump()
        )

    producer_running = is_producer_running(runtime_key)
    status = _resolve_uploaded_runtime_status(runtime_key, producer_running)
    first_camera_name = (first_camera.name or "").strip()
    display_name = first_camera_name
    matched_prefix = FISHEYE_UPLOAD_NAME_PATTERN.match(first_camera_name)
    if matched_prefix:
        display_name = matched_prefix.group("prefix").strip() or first_camera_name
    upload_metadata = _probe_uploaded_video_metadata(source_path)

    return {
        "runtime_key": runtime_key,
        "source_path": source_path,
        "file_name": os.path.basename(source_path),
        "display_name": display_name or os.path.basename(source_path),
        "source_kind": _infer_source_kind(source_path),
        "is_fisheye": bool(first_stream.is_fisheye),
        "selected_views": sorted({
            int(stream_config.view_index)
            for _, stream_config in rows
            if stream_config.view_index is not None and int(stream_config.view_index) >= 0
        }),
        "primary_camera_id": first_camera.id,
        "producer_running": producer_running,
        "status": status,
        "camera_count": len(rows),
        "analysis_tags": unique_tags or ["Unassigned"],
        "cameras": cameras_payload,
        "video_duration_seconds": upload_metadata.get("duration_seconds"),
        "video_resolution": upload_metadata.get("resolution"),
        "video_fps": upload_metadata.get("fps"),
        "video_frame_width": upload_metadata.get("frame_width"),
        "video_frame_height": upload_metadata.get("frame_height"),
        "uploaded_at": time.strftime(
            "%Y-%m-%dT%H:%M:%S",
            time.localtime(os.path.getmtime(source_path)),
        ) if os.path.exists(source_path) else None,
    }


def _normalize_fisheye_view_index(selected_view: int | None) -> int:
    try:
        view_index = int(selected_view if selected_view is not None else 0)
    except (TypeError, ValueError):
        return 0
    return view_index if 0 <= view_index < len(FISHEYE_VIEW_CONFIGS) else 0


def _build_single_fisheye_view_config(selected_view: int | None) -> list[dict | None]:
    normalized_index = _normalize_fisheye_view_index(selected_view)
    configs: list[dict | None] = []
    for index, config in enumerate(FISHEYE_VIEW_CONFIGS):
        configs.append(config if index == normalized_index else None)
    return configs


def _apply_fisheye_preview(frame, selected_view: int | None):
    if frame is None or not hasattr(frame, "shape"):
        return frame
    processor = FisheyeMultiView(
        frame.shape[:2],
        _build_single_fisheye_view_config(selected_view),
        show_original=False,
        use_cuda=False,
        downscale_size=(640, 360),
    )
    normalized_index = _normalize_fisheye_view_index(selected_view)
    processed_frames, _, _ = processor.process_frame(frame, overlay=False, view_id=f"partition_{normalized_index}")
    preview_frame = processed_frames.get(f"partition_{normalized_index}")
    return preview_frame if preview_frame is not None else frame


async def _get_uploaded_runtime_stream(
    session: AsyncSession,
    runtime_key: str,
) -> StreamConfig | None:
    rows = await _get_uploaded_runtime_rows(session, [runtime_key])
    if not rows:
        return None
    return rows[0][1]


async def _get_uploaded_camera_stream(
    session: AsyncSession,
    camera_id: str,
    runtime_key: str | None = None,
) -> StreamConfig | None:
    result = await session.execute(
        select(StreamConfig).where(StreamConfig.camera_id == camera_id).limit(1)
    )
    stream_config = result.scalars().first()
    if stream_config is None:
        return None
    if runtime_key and _get_runtime_key(stream_config) != runtime_key:
        return None
    return stream_config



# make the video sync at run time
def _start_uploaded_runtime_members(members: list[dict]) -> int:
    if not members:
        return 0

    if len(members) > 1:
        sync_state = {"started_at": None}
        sync_barrier = threading.Barrier(
            len(members),
            action=lambda: sync_state.__setitem__("started_at", time.perf_counter()),
        )
    else:
        sync_barrier = None
        sync_state = None

    for member in members:
        start_producer_thread(
            member["runtime_key"],
            member["source_path"],
            member["is_fisheye"],
            member["active_views"],
            sync_barrier=sync_barrier,
            sync_state=sync_state,
        )
    return len(members)


async def _ensure_stream_running(session: AsyncSession, stream_config: StreamConfig):
    if _is_uploaded_source_path(stream_config.source_path):
        return
    runtime_key = _get_runtime_key(stream_config)
    if is_pending_runtime_key(runtime_key):
        return
    active_views = await _get_active_views_for_runtime(
        session,
        runtime_key,
        bool(stream_config.is_fisheye),
    )
    start_producer_thread(
        runtime_key,
        stream_config.source_path,
        bool(stream_config.is_fisheye),
        active_views,
    )


async def _stop_producer_if_unused(session: AsyncSession, runtime_key: str):
    remaining = await session.execute(
        select(StreamConfig.id).where(StreamConfig.runtime_key == runtime_key).limit(1)
    )
    if remaining.scalar_one_or_none() is None:
        stop_producer_thread(runtime_key)


async def _create_camera_with_stream(
    session: AsyncSession,
    *,
    name: str,
    location: str,
    camera_type: str,
    status: str,
    mode: str,
    resolution: str,
    fps: int,
    enabled: bool,
    source_path: str,
    runtime_key: str | None = None,
    view_index: int = -1,
    is_fisheye: bool = False,
    detection_roi: dict | None = None,
    image: str = "",
) -> tuple[Camera, StreamConfig]:
    camera_id = str(uuid.uuid4())
    camera = Camera(
        id=camera_id,
        name=name,
        location=location,
        type=camera_type,
        status=status,
        mode=mode,
        ws_url=_default_ws_url(camera_id),
        resolution=resolution,
        fps=fps,
        enabled=enabled,
        image=image,
    )
    session.add(camera)

    stream_config = StreamConfig(
        id=str(uuid.uuid4()),
        camera_id=camera_id,
        source_path=source_path,
        runtime_key=_normalize_runtime_key(source_path, runtime_key),
        view_index=view_index,
        is_fisheye=is_fisheye,
        detection_roi=_normalize_detection_roi(detection_roi),
    )
    session.add(stream_config)

    await session.flush()
    await session.refresh(camera)
    return camera, stream_config


def _open_probe_capture(source_path: str) -> cv2.VideoCapture:
    return open_video_capture(
        source_path,
        is_rtsp=is_rtsp_source(source_path),
        allow_hwaccel=False,
    )


def _is_usable_preview_frame(frame) -> bool:
    if frame is None or not hasattr(frame, "size") or frame.size == 0:
        return False
    if len(frame.shape) < 2 or frame.shape[0] < 2 or frame.shape[1] < 2:
        return False

    try:
        preview = cv2.resize(frame, (64, 36), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(preview, cv2.COLOR_BGR2GRAY) if len(preview.shape) == 3 else preview
        stddev = float(gray.std())
        dynamic_range = float(gray.max() - gray.min())
        return stddev >= 6.0 and dynamic_range >= 24.0
    except cv2.error:
        return False


def _probe_stream(
    source_path: str,
    *,
    enable_fisheye: bool = False,
    selected_view: int | None = None,
) -> dict:
    cap = _open_probe_capture(source_path)
    try:
        if not cap.isOpened():
            return {"ok": False, "detail": "Unable to open stream."}

        frame = None
        best_frame = None
        for attempt in range(30):
            ok, next_frame = cap.read()
            if not ok or next_frame is None:
                if attempt < 5:
                    continue
                break
            frame = next_frame
            if _is_usable_preview_frame(next_frame):
                best_frame = next_frame
                break
            if best_frame is None:
                best_frame = next_frame

        frame = best_frame if best_frame is not None else frame
        if frame is None:
            return {"ok": False, "detail": "Connected, but no frame was received."}

        preview_source = _apply_fisheye_preview(frame, selected_view) if enable_fisheye else frame
        height, width = preview_source.shape[:2]
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        preview = preview_source
        max_preview_w = 960
        if width > max_preview_w:
            scale = max_preview_w / float(width)
            preview = cv2.resize(
                preview_source,
                (max_preview_w, max(1, int(round(height * scale)))),
                interpolation=cv2.INTER_AREA,
            )
        ok_jpg, preview_buf = cv2.imencode(".jpg", preview, [cv2.IMWRITE_JPEG_QUALITY, 75])
        return {
            "ok": True,
            "detail": "Stream connection successful.",
            "resolution": f"{width}x{height}",
            "fps": round(float(fps), 1),
            "stream_kind": "rtsp" if is_rtsp_source(source_path) else "network",
            "preview_view_index": _normalize_fisheye_view_index(selected_view) if enable_fisheye else None,
            "preview_image": base64.b64encode(preview_buf).decode("utf-8") if ok_jpg else None,
            "frame_width": int(width),
            "frame_height": int(height),
        }
    finally:
        cap.release()


def _probe_uploaded_video_file(
    file_path: str,
    *,
    enable_fisheye: bool = False,
    selected_view: int | None = None,
) -> dict:
    cap = _open_probe_capture(file_path)
    try:
        duration_hint = None
        if cap.isOpened():
            fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
            frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            if fps > 0.0 and frame_count > 0:
                duration_hint = frame_count / fps

        frame = _extract_preview_frame_with_ffmpeg(
            file_path,
            duration_hint=duration_hint,
        )

        if frame is None and cap.isOpened():
            seek_positions: list[int] = []
            if frame_count > 0:
                ratios = [0.02, 0.08, 0.15, 0.25, 0.4, 0.55, 0.7]
                seek_positions = sorted({
                    max(0, min(frame_count - 1, int(frame_count * ratio)))
                    for ratio in ratios
                })

            frame = None
            best_frame = None

            def _try_read_candidate() -> bool:
                nonlocal frame, best_frame
                for _ in range(20):
                    ok, next_frame = cap.read()
                    if not ok or next_frame is None:
                        continue
                    frame = next_frame
                    if _is_usable_preview_frame(next_frame):
                        best_frame = next_frame
                        return True
                    if best_frame is None:
                        best_frame = next_frame
                return False

            if seek_positions:
                for frame_index in seek_positions:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
                    if _try_read_candidate():
                        break
            else:
                _try_read_candidate()

            frame = best_frame if best_frame is not None else frame

        if frame is None:
            return {"ok": False, "detail": "Uploaded video did not yield a readable preview frame."}

        preview_source = _apply_fisheye_preview(frame, selected_view) if enable_fisheye else frame
        height, width = preview_source.shape[:2]
        preview = preview_source
        max_preview_w = 960
        if width > max_preview_w:
            scale = max_preview_w / float(width)
            preview = cv2.resize(
                preview_source,
                (max_preview_w, max(1, int(round(height * scale)))),
                interpolation=cv2.INTER_AREA,
            )

        ok_jpg, preview_buf = cv2.imencode(".jpg", preview, [cv2.IMWRITE_JPEG_QUALITY, 80])
        return {
            "ok": True,
            "detail": "Upload preview generated successfully.",
            "preview_view_index": _normalize_fisheye_view_index(selected_view) if enable_fisheye else None,
            "preview_image": base64.b64encode(preview_buf).decode("utf-8") if ok_jpg else None,
            "frame_width": int(width),
            "frame_height": int(height),
        }
    finally:
        cap.release()


def _probe_uploaded_video_metadata(file_path: str) -> dict[str, Any]:
    if not file_path or not os.path.exists(file_path):
        return {
            "duration_seconds": None,
            "resolution": None,
            "fps": None,
            "frame_width": None,
            "frame_height": None,
        }

    cap = _open_probe_capture(file_path)
    try:
        if not cap.isOpened():
            return {
                "duration_seconds": None,
                "resolution": None,
                "fps": None,
                "frame_width": None,
                "frame_height": None,
            }

        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

        duration_seconds = None
        if fps > 0.0 and frame_count > 0:
            duration_seconds = round(frame_count / fps, 3)

        return {
            "duration_seconds": duration_seconds,
            "resolution": f"{width}x{height}" if width > 0 and height > 0 else None,
            "fps": round(fps, 2) if fps > 0.0 else None,
            "frame_width": width if width > 0 else None,
            "frame_height": height if height > 0 else None,
        }
    finally:
        cap.release()


def _decode_image_buffer(image_bytes: bytes):
    if not image_bytes:
        return None

    encoded = np.frombuffer(image_bytes, dtype=np.uint8)
    if encoded.size == 0:
        return None

    try:
        return cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    except cv2.error:
        return None


def _extract_preview_frame_with_ffmpeg(
    file_path: str,
    *,
    duration_hint: float | None = None,
):
    seek_points = [0.5, 1.0, 1.8, 3.0]
    if duration_hint and duration_hint > 0.0:
        seek_points.extend(
            max(0.0, min(duration_hint - 0.05, duration_hint * ratio))
            for ratio in (0.08, 0.15, 0.25, 0.4, 0.55, 0.7)
        )

    ordered_seek_points: list[float] = []
    seen_seek_points: set[float] = set()
    for point in seek_points:
        normalized = round(max(0.0, float(point)), 3)
        if normalized in seen_seek_points:
            continue
        ordered_seek_points.append(normalized)
        seen_seek_points.add(normalized)

    best_frame = None
    for seek_seconds in ordered_seek_points:
        command = [
            FFMPEG_BIN,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-i",
            file_path,
        ]
        if seek_seconds > 0.0:
            command.extend(["-ss", f"{seek_seconds:.3f}"])
        command.extend([
            "-frames:v",
            "1",
            "-an",
            "-sn",
            "-dn",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "-",
        ])

        try:
            completed = subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=15,
            )
        except (OSError, subprocess.SubprocessError):
            return best_frame

        if completed.returncode != 0 or not completed.stdout:
            continue

        decoded = _decode_image_buffer(completed.stdout)
        if decoded is None:
            continue
        if _is_usable_preview_frame(decoded):
            return decoded
        if best_frame is None:
            best_frame = decoded

    return best_frame


# --- WebSocket Endpoint ---
@router.websocket("/ws/{camera_id}")
async def websocket_endpoint(websocket: WebSocket, camera_id: str):
    await websocket.accept()
    print(f"[WS] Connection accepted for {camera_id}")

    # Look up stream config from the database
    async with AsyncSessionLocal() as session:
        config_row = await _get_stream_config(session, camera_id)

        if not config_row:
            print(f"[WS] Error: No config found for {camera_id}.")
            await websocket.close()
            return

        runtime_key = _get_runtime_key(config_row)
        print(
            f"[WS] Config found for {camera_id}: source={config_row.source_path}, "
            f"runtime_key={runtime_key}, view={config_row.view_index}"
        )
        if not _is_uploaded_source_path(config_row.source_path):
            await _ensure_stream_running(session, config_row)

    runtime_key = _get_runtime_key(config_row)
    view_index = config_row.view_index

    # Map view_index to buffer key
    target_key = "original"
    if view_index != -1:
        target_key = f"partition_{view_index}"

    try:
        while True:
            # Fetch latest frame + metadata from global buffer
            if runtime_key in FRAME_BUFFERS:
                frames = FRAME_BUFFERS[runtime_key]
                b64_data = frames.get(target_key)

                # Extract metadata
                meta = frames.get("__meta__", {})
                fps = meta.get("fps", 0)
                people_count = meta.get("people_count", 0)

                # Get detections for this specific view
                all_detections = meta.get("detections", {})
                view_detections = all_detections.get(target_key, [])

                # Get counting data for this specific view
                all_counting = meta.get("counting_data", {})
                view_counting = all_counting.get(target_key, {})

                await websocket.send_json({
                    "image": b64_data,
                    "fps": fps,
                    "people_count": people_count,
                    "detections": view_detections,
                    "counting_data": view_counting,
                    "stream_status": meta.get("stream_status", "live" if b64_data else "recovering"),
                    "stream_reason": meta.get("stream_reason"),
                })

            if WS_SEND_INTERVAL > 0:
                await asyncio.sleep(WS_SEND_INTERVAL)
            else:
                await asyncio.sleep(0)

    except WebSocketDisconnect:
        pass


# --- HTTP API Endpoints ---

@router.get("/api/cameras", response_model=List[CameraRead])
async def get_cameras(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Camera, StreamConfig).outerjoin(StreamConfig, StreamConfig.camera_id == Camera.id)
    )
    rows = result.all()
    camera_ids = [camera.id for camera, _ in rows]
    tags_map = await _derive_analysis_tags_by_camera(db, camera_ids)
    return [
        _build_camera_read(
            camera,
            stream_config,
            analysis_tags=tags_map.get(camera.id, ["Unassigned"]),
        )
        for camera, stream_config in rows
    ]


@router.post("/api/cameras", response_model=CameraRead)
async def add_camera(camera: CameraCreate, db: AsyncSession = Depends(get_db)):
    source_path = (camera.source_path or "").strip() or None
    if camera.type.upper().startswith(("RTSP", "NETWORK")) and not source_path:
        raise HTTPException(status_code=400, detail="Stream camera requires a source_path.")

    camera_id = camera.id or str(uuid.uuid4())
    db_camera = Camera(
        id=camera_id,
        name=camera.name,
        location=camera.location,
        type=camera.type,
        status=camera.status,
        mode=camera.mode,
        ws_url=camera.ws_url or _default_ws_url(camera_id),
        resolution=camera.resolution,
        fps=camera.fps,
        enabled=camera.enabled,
        image=camera.image,
    )
    db.add(db_camera)
    await db.flush()

    stream_config = None
    if source_path:
        stream_config = StreamConfig(
            id=str(uuid.uuid4()),
            camera_id=camera_id,
            source_path=source_path,
            runtime_key=_normalize_runtime_key(source_path),
            view_index=camera.view_index,
            is_fisheye=camera.is_fisheye,
            detection_roi=_normalize_detection_roi(camera.detection_roi),
        )
        db.add(stream_config)
        await db.flush()

    await db.refresh(db_camera)

    if stream_config is not None and db_camera.enabled and not _is_uploaded_source_path(source_path):
        await _ensure_stream_running(db, stream_config)
        await _sync_runtime_state(db)

    return _build_camera_read(db_camera, stream_config)


@router.put("/api/cameras/{camera_id}", response_model=CameraRead)
async def update_camera(camera_id: str, camera: CameraCreate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Camera).where(Camera.id == camera_id))
    db_camera = result.scalar_one_or_none()
    if db_camera is None:
        raise HTTPException(status_code=404, detail="Camera not found")

    stream_config = await _get_stream_config(db, camera_id)
    old_source_path = stream_config.source_path if stream_config is not None else None
    old_runtime_key = _get_runtime_key(stream_config) if stream_config is not None else None
    old_view_index = stream_config.view_index if stream_config is not None else None
    old_is_fisheye = bool(stream_config.is_fisheye) if stream_config is not None else False

    source_path = (camera.source_path or "").strip() or None
    if old_source_path:
        if source_path and source_path != old_source_path:
            raise HTTPException(status_code=400, detail="Stream source_path cannot be changed after creation.")
        source_path = old_source_path
    if camera.type.upper().startswith(("RTSP", "NETWORK")) and not source_path:
        raise HTTPException(status_code=400, detail="Stream camera requires a source_path.")

    db_camera.name = camera.name
    db_camera.location = camera.location
    db_camera.type = camera.type
    db_camera.status = camera.status
    db_camera.mode = camera.mode
    db_camera.ws_url = camera.ws_url or db_camera.ws_url or _default_ws_url(camera_id)
    db_camera.resolution = camera.resolution
    db_camera.fps = camera.fps
    db_camera.enabled = camera.enabled
    db_camera.image = camera.image

    if source_path:
        if stream_config is None:
            stream_config = StreamConfig(
                id=str(uuid.uuid4()),
                camera_id=camera_id,
                source_path=source_path,
                runtime_key=_normalize_runtime_key(source_path),
                view_index=camera.view_index,
                is_fisheye=camera.is_fisheye,
                detection_roi=_normalize_detection_roi(camera.detection_roi),
            )
            db.add(stream_config)
        else:
            stream_config.source_path = source_path
            if not camera.is_fisheye or not stream_config.runtime_key:
                stream_config.runtime_key = _normalize_runtime_key(source_path)
            stream_config.view_index = camera.view_index
            stream_config.is_fisheye = camera.is_fisheye
            stream_config.detection_roi = _normalize_detection_roi(camera.detection_roi)
    elif stream_config is not None:
        await db.delete(stream_config)
        stream_config = None

    await db.flush()
    await db.refresh(db_camera)

    if old_runtime_key and (old_source_path != source_path or stream_config is None):
        await _stop_producer_if_unused(db, old_runtime_key)

    new_runtime_key = _get_runtime_key(stream_config) if stream_config is not None else None
    runtime_requires_restart = (
        stream_config is not None
        and new_runtime_key is not None
        and old_runtime_key == new_runtime_key
        and not _is_uploaded_source_path(source_path)
        and (
            old_view_index != stream_config.view_index
            or old_is_fisheye != bool(stream_config.is_fisheye)
        )
    )
    if runtime_requires_restart:
        stop_producer_thread(new_runtime_key)

    if stream_config is not None and db_camera.enabled and not _is_uploaded_source_path(source_path):
        await _ensure_stream_running(db, stream_config)

    await _sync_runtime_state(db)

    return _build_camera_read(db_camera, stream_config)


@router.post("/api/cameras/stream-source")
@router.post("/api/cameras/rtsp-source")
async def create_stream_source(payload: StreamSourceCreateRequest, db: AsyncSession = Depends(get_db)):
    source_path = payload.source_path.strip()
    if not source_path:
        raise HTTPException(status_code=400, detail="Stream source_path is required.")

    status = "Online" if payload.enabled else "Disabled"
    new_cameras: list[CameraRead] = []

    if payload.enable_fisheye:
        runtime_key = _normalize_runtime_key(
            source_path,
            f"{source_path}#group={uuid.uuid4()}",
        )
        active_view_indices = sorted({
            int(idx)
            for idx in payload.selected_views
            if isinstance(idx, int) and 0 <= idx <= 7
        })
        if not active_view_indices:
            active_view_indices = list(range(8))

        angles = [0, 45, 90, 135, 180, 225, 270, 315]
        for idx in active_view_indices:
            camera, stream_config = await _create_camera_with_stream(
                db,
                name=f"{payload.name} - View {idx + 1} ({angles[idx]}°)",
                location=payload.location,
                camera_type=_infer_stream_camera_type(source_path, is_fisheye=True),
                status=status,
                mode=payload.mode,
                resolution=payload.resolution,
                fps=payload.fps,
                enabled=payload.enabled,
                source_path=source_path,
                runtime_key=runtime_key,
                view_index=idx,
                is_fisheye=True,
                detection_roi=payload.detection_roi,
            )
            new_cameras.append(_build_camera_read(camera, stream_config))

        if payload.enabled:
            start_producer_thread(runtime_key, source_path, True, active_view_indices)
    else:
        camera, stream_config = await _create_camera_with_stream(
            db,
            name=payload.name,
            location=payload.location,
            camera_type=_infer_stream_camera_type(source_path, is_fisheye=False),
            status=status,
            mode=payload.mode,
            resolution=payload.resolution,
            fps=payload.fps,
            enabled=payload.enabled,
            source_path=source_path,
            view_index=-1,
            is_fisheye=False,
            detection_roi=payload.detection_roi,
        )
        new_cameras.append(_build_camera_read(camera, stream_config))

        if payload.enabled:
            await _ensure_stream_running(db, stream_config)

    await _sync_runtime_state(db)

    return {
        "status": "success",
        "created_cameras": new_cameras,
    }


@router.post("/api/cameras/test-stream")
async def test_stream_connection(payload: StreamConnectionTestRequest):
    source_path = payload.source_path.strip()
    if not source_path:
        raise HTTPException(status_code=400, detail="source_path is required.")

    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(
            None,
            lambda: _probe_stream(
                source_path,
                enable_fisheye=bool(payload.enable_fisheye),
                selected_view=payload.selected_view,
            ),
        )
    except Exception as exc:
        return {
            "ok": False,
            "detail": f"Stream probe failed: {exc}",
        }


@router.post("/api/cameras/test-rtsp")
async def test_rtsp_connection(payload: StreamConnectionTestRequest):
    return await test_stream_connection(payload)


@router.post("/api/cameras/upload-preview")
async def preview_uploaded_video(
    file: UploadFile = File(...),
    enable_fisheye: bool = Form(False),
    selected_view: int = Form(0),
):
    suffix = os.path.splitext(file.filename or "")[1] or ".mp4"
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_path = temp_file.name
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                temp_file.write(chunk)

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: _probe_uploaded_video_file(
                temp_path,
                enable_fisheye=bool(enable_fisheye),
                selected_view=selected_view,
            ),
        )
        if not result.get("ok"):
            raise HTTPException(status_code=400, detail=result.get("detail") or "Unable to preview uploaded video.")
        metadata = await loop.run_in_executor(
            None,
            lambda: _probe_uploaded_video_metadata(temp_path),
        )
        result.update({
            "video_duration_seconds": metadata.get("duration_seconds"),
            "video_resolution": metadata.get("resolution"),
            "video_fps": metadata.get("fps"),
            "video_frame_width": metadata.get("frame_width"),
            "video_frame_height": metadata.get("frame_height"),
        })
        return result
    finally:
        try:
            await file.close()
        except Exception:
            pass
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass


@router.delete("/api/cameras/{camera_id}")
async def delete_camera(camera_id: str, db: AsyncSession = Depends(get_db)):
    # Capture runtime key(s) first so we can stop producer if this was the last camera in a group.
    stream_result = await db.execute(
        select(StreamConfig).where(StreamConfig.camera_id == camera_id)
    )
    stream_rows = stream_result.scalars().all()
    runtime_keys = {_get_runtime_key(row) for row in stream_rows if row.source_path}

    # Delete stream config first (cascade should handle it, but be explicit)
    await db.execute(
        sa_delete(StreamConfig).where(StreamConfig.camera_id == camera_id)
    )
    result = await db.execute(
        sa_delete(Camera).where(Camera.id == camera_id)
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Camera not found")

    # Stop producer for any runtime group that no longer has cameras bound to it.
    for runtime_key in runtime_keys:
        discard_pending_runtime_key(runtime_key)
        await _stop_producer_if_unused(db, runtime_key)

    await _sync_runtime_state(db)

    return {"status": "deleted"}


@router.get("/api/upload-sync-groups")
async def get_upload_sync_groups():
    return {
        "groups": list_sync_groups(),
    }


@router.post("/api/upload-sync-groups/{group_id}/start")
async def start_upload_sync_group(group_id: str):
    try:
        result = start_sync_group(group_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if result["started_sources"] <= 0:
        raise HTTPException(status_code=404, detail="No pending uploaded videos found for this sync group.")

    return {
        "status": "started",
        **result,
    }


@router.get("/api/upload-videos")
async def list_uploaded_videos(db: AsyncSession = Depends(get_db)):
    rows = await _get_uploaded_runtime_rows(db)
    runtime_groups: dict[str, list[tuple[Camera, StreamConfig]]] = {}
    for camera, stream_config in rows:
        runtime_groups.setdefault(_get_runtime_key(stream_config), []).append((camera, stream_config))

    camera_ids = [camera.id for camera, _ in rows]
    tags_map = await _derive_analysis_tags_by_camera(db, camera_ids)
    items = [
        _build_upload_runtime_payload(runtime_key, group_rows, tags_map)
        for runtime_key, group_rows in sorted(
            runtime_groups.items(),
            key=lambda item: item[1][0][1].source_path.lower(),
        )
    ]
    return {"items": items}


@router.put("/api/upload-videos")
async def update_uploaded_video(
    payload: UploadVideoUpdateRequest,
    db: AsyncSession = Depends(get_db),
):
    runtime_key = (payload.runtime_key or "").strip()
    if not runtime_key:
        raise HTTPException(status_code=400, detail="runtime_key is required.")

    rows = await _get_uploaded_runtime_rows(db, [runtime_key])
    if not rows:
        raise HTTPException(status_code=404, detail="Uploaded video source not found.")

    normalized_name = (payload.name or "").strip()
    if not normalized_name:
        raise HTTPException(status_code=400, detail="name is required.")

    normalized_location = (payload.location or "").strip()
    first_stream = rows[0][1]
    is_fisheye = bool(first_stream.is_fisheye)
    requested_is_fisheye = is_fisheye if payload.is_fisheye is None else bool(payload.is_fisheye)
    if requested_is_fisheye != is_fisheye:
        raise HTTPException(status_code=400, detail="Uploaded source fisheye mode cannot be changed after creation.")

    requested_view_index = -1
    if is_fisheye:
        requested_view_index = _normalize_fisheye_view_index(payload.view_index)
    elif payload.view_index is not None and int(payload.view_index) != -1:
        raise HTTPException(status_code=400, detail="Only fisheye uploaded sources support changing view_index.")

    was_running = is_producer_running(runtime_key)
    source_path = first_stream.source_path

    for camera, stream_config in rows:
        stream_config.view_index = requested_view_index if is_fisheye else -1
        camera.name = _build_uploaded_camera_name(
            normalized_name,
            int(stream_config.view_index if stream_config.view_index is not None else -1),
            is_fisheye,
        )
        camera.location = normalized_location
        stream_config.detection_roi = _normalize_detection_roi(payload.detection_roi)

    await db.flush()

    if was_running:
        stop_producer_thread(runtime_key)
        active_views = await _get_active_views_for_runtime(db, runtime_key, is_fisheye)
        start_producer_thread(runtime_key, source_path, is_fisheye, active_views)

    await _sync_runtime_state(db)

    camera_ids = [camera.id for camera, _ in rows]
    tags_map = await _derive_analysis_tags_by_camera(db, camera_ids)
    return {
        "status": "updated",
        "item": _build_upload_runtime_payload(runtime_key, rows, tags_map),
    }


@router.post("/api/upload-videos/start")
async def start_uploaded_videos(
    payload: UploadRuntimeActionRequest,
    db: AsyncSession = Depends(get_db),
):
    requested_runtime_keys = [
        str(runtime_key).strip()
        for runtime_key in (payload.runtime_keys or [])
        if str(runtime_key).strip()
    ]
    unique_runtime_keys = list(dict.fromkeys(requested_runtime_keys))
    if not unique_runtime_keys:
        raise HTTPException(status_code=400, detail="At least one runtime key is required.")

    rows = await _get_uploaded_runtime_rows(db, unique_runtime_keys)
    runtime_groups: dict[str, list[tuple[Camera, StreamConfig]]] = {}
    for camera, stream_config in rows:
        runtime_groups.setdefault(_get_runtime_key(stream_config), []).append((camera, stream_config))

    members_to_start: list[dict] = []
    for runtime_key in unique_runtime_keys:
        group_rows = runtime_groups.get(runtime_key)
        if not group_rows or is_producer_running(runtime_key):
            continue
        discard_pending_runtime_key(runtime_key)
        first_stream = group_rows[0][1]
        members_to_start.append(
            {
                "runtime_key": runtime_key,
                "source_path": first_stream.source_path,
                "is_fisheye": bool(first_stream.is_fisheye),
                "active_views": await _get_active_views_for_runtime(db, runtime_key, bool(first_stream.is_fisheye)),
            }
        )

    started_sources = _start_uploaded_runtime_members(members_to_start)
    return {
        "status": "started",
        "requested_sources": len(unique_runtime_keys),
        "started_sources": started_sources,
    }


@router.post("/api/upload-videos/stop")
async def stop_uploaded_videos(
    payload: UploadRuntimeActionRequest,
    db: AsyncSession = Depends(get_db),
):
    requested_runtime_keys = [
        str(runtime_key).strip()
        for runtime_key in (payload.runtime_keys or [])
        if str(runtime_key).strip()
    ]
    unique_runtime_keys = list(dict.fromkeys(requested_runtime_keys))
    if not unique_runtime_keys:
        raise HTTPException(status_code=400, detail="At least one runtime key is required.")

    rows = await _get_uploaded_runtime_rows(db, unique_runtime_keys)
    valid_runtime_keys = {
        _get_runtime_key(stream_config)
        for _, stream_config in rows
    }

    stopped_sources = 0
    for runtime_key in unique_runtime_keys:
        if runtime_key not in valid_runtime_keys:
            continue
        if stop_producer_thread(runtime_key):
            stopped_sources += 1

    return {
        "status": "stopped",
        "requested_sources": len(unique_runtime_keys),
        "stopped_sources": stopped_sources,
    }


@router.post("/api/upload-videos/delete")
async def delete_uploaded_videos(
    payload: UploadRuntimeActionRequest,
    db: AsyncSession = Depends(get_db),
):
    requested_runtime_keys = [
        str(runtime_key).strip()
        for runtime_key in (payload.runtime_keys or [])
        if str(runtime_key).strip()
    ]
    unique_runtime_keys = list(dict.fromkeys(requested_runtime_keys))
    if not unique_runtime_keys:
        raise HTTPException(status_code=400, detail="At least one runtime key is required.")

    rows = await _get_uploaded_runtime_rows(db, unique_runtime_keys)
    runtime_groups: dict[str, list[tuple[Camera, StreamConfig]]] = {}
    for camera, stream_config in rows:
        runtime_groups.setdefault(_get_runtime_key(stream_config), []).append((camera, stream_config))

    deleted_sources = 0
    deleted_camera_ids: list[str] = []
    source_paths_to_cleanup: set[str] = set()

    for runtime_key in unique_runtime_keys:
        group_rows = runtime_groups.get(runtime_key)
        if not group_rows:
            continue

        stop_producer_thread(runtime_key)
        discard_pending_runtime_key(runtime_key)

        deleted_sources += 1
        for camera, stream_config in group_rows:
            deleted_camera_ids.append(camera.id)
            if stream_config.source_path:
                source_paths_to_cleanup.add(stream_config.source_path)

    if deleted_camera_ids:
        await db.execute(
            sa_delete(StreamConfig).where(StreamConfig.camera_id.in_(deleted_camera_ids))
        )
        await db.execute(
            sa_delete(Camera).where(Camera.id.in_(deleted_camera_ids))
        )

    for source_path in source_paths_to_cleanup:
        result = await db.execute(
            select(StreamConfig.id).where(StreamConfig.source_path == source_path).limit(1)
        )
        if result.scalar_one_or_none() is not None:
            continue
        if os.path.exists(source_path):
            try:
                os.remove(source_path)
            except OSError:
                pass

    await _sync_runtime_state(db)

    return {
        "status": "deleted",
        "requested_sources": len(unique_runtime_keys),
        "deleted_sources": deleted_sources,
    }


@router.post("/api/upload-videos/preview")
async def preview_uploaded_runtime(
    payload: UploadPreviewRequest,
    db: AsyncSession = Depends(get_db),
):
    runtime_key = (payload.runtime_key or "").strip()
    if not runtime_key:
        raise HTTPException(status_code=400, detail="runtime_key is required.")

    camera_id = (payload.camera_id or "").strip()
    if camera_id:
        stream_config = await _get_uploaded_camera_stream(db, camera_id, runtime_key)
    else:
        stream_config = await _get_uploaded_runtime_stream(db, runtime_key)
    if stream_config is None:
        raise HTTPException(status_code=404, detail="Uploaded video source not found.")

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None,
        lambda: _probe_uploaded_video_file(
            stream_config.source_path,
            enable_fisheye=bool(stream_config.is_fisheye),
            selected_view=payload.selected_view if payload.selected_view is not None else stream_config.view_index,
        ),
    )
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("detail") or "Unable to preview uploaded video.")
    return result


@router.post("/api/upload_and_process")
async def upload_video(
    file: UploadFile = File(...),
    enable_fisheye: bool = Form(False),
    camera_name_prefix: str = Form("Camera"),
    location: str = Form(""),
    selected_views: str = Form(""),  # Comma separated indices, e.g. "0,2,4"
    detection_roi: str = Form(""),
    sync_start: bool = Form(False),
    sync_group_id: str = Form(""),
    db: AsyncSession = Depends(get_db),
):
    try:
        file_id = str(uuid.uuid4())[:8]
        filename = f"{file_id}_{file.filename}"
        input_path = os.path.join(UPLOAD_DIR, filename)

        # Stream file to disk in 1MB chunks to handle large files
        chunk_size = 1024 * 1024  # 1 MB
        with open(input_path, "wb") as buffer:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break
                buffer.write(chunk)
        print(f"[Upload] Saved {filename} ({os.path.getsize(input_path) / 1024 / 1024:.1f} MB)")

        new_cameras: list[CameraRead] = []
        upload_detection_roi = None
        if detection_roi.strip():
            try:
                upload_detection_roi = _normalize_detection_roi(json.loads(detection_roi))
            except json.JSONDecodeError as exc:
                raise HTTPException(status_code=400, detail=f"Invalid detection_roi JSON: {exc.msg}")

        active_view_indices = None
        if enable_fisheye and selected_views:
            try:
                active_view_indices = [int(x.strip()) for x in selected_views.split(",") if x.strip().isdigit()]
            except Exception:
                pass

        runtime_key = input_path
        if enable_fisheye:
            runtime_key = _normalize_runtime_key(
                input_path,
                f"{input_path}#group={uuid.uuid4()}",
            )

        upload_metadata = _probe_uploaded_video_metadata(input_path)
        upload_resolution = upload_metadata.get("resolution") or "640x360"
        upload_fps = int(round(float(upload_metadata.get("fps") or 30)))
        normalized_location = (location or "").strip() or "Uploaded Video"
        pending_count = 0

        # Helper to create camera + stream_config in DB
        async def create_cam(suffix: str, view_idx: int) -> CameraRead:
            cam_id = str(uuid.uuid4())

            db_camera = Camera(
                id=cam_id,
                name=f"{camera_name_prefix} - {suffix}" if suffix else camera_name_prefix,
                location=normalized_location,
                type="Fisheye" if enable_fisheye else "File",
                status="Ready",
                mode="Unassigned",
                ws_url=_default_ws_url(cam_id),
                resolution=upload_resolution,
                fps=upload_fps,
                enabled=True,
                image="",
            )
            db.add(db_camera)

            db_stream_config = StreamConfig(
                id=str(uuid.uuid4()),
                camera_id=cam_id,
                source_path=input_path,
                runtime_key=runtime_key,
                view_index=view_idx,
                is_fisheye=enable_fisheye,
                detection_roi=upload_detection_roi,
            )
            db.add(db_stream_config)

            await db.flush()
            await db.refresh(db_camera)
            return _build_camera_read(db_camera, db_stream_config)

        if enable_fisheye:
            # Only create cameras for selected views (no original fisheye view)
            angles = [0, 45, 90, 135, 180, 225, 270, 315]
            for i, angle in enumerate(angles):
                # Check if this view was selected
                if active_view_indices is not None and i not in active_view_indices:
                    continue
                new_cameras.append(await create_cam(f"View {i + 1} ({angle}°)", i))
        else:
            new_cameras.append(await create_cam("", -1))

        await _sync_runtime_state(db)

        return {
            "status": "success",
            "created_cameras": new_cameras,
            "sync_start": False,
            "sync_group_id": None,
            "pending_sources": pending_count,
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
