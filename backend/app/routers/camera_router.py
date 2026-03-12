from fastapi import APIRouter, UploadFile, File, Form, HTTPException, WebSocket, WebSocketDisconnect, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete as sa_delete
from typing import List
import uuid
import os
import asyncio
import cv2

from pydantic import BaseModel

from app.core.video_capture import is_rtsp_source, open_video_capture
from app.models.camera_model import Camera
from app.models.dresscode_policy import DressCodePolicy
from app.models.fall_detection_config import FallDetectionConfig
from app.models.people_counting_config import PeopleCountingConfig
from app.models.stream_config import StreamConfig
from app.schemas.camera import CameraCreate, CameraRead
from app.core.database import get_db, AsyncSessionLocal
from app.core.globals import FRAME_BUFFERS
from app.services.video_processor import start_producer_thread, stop_producer_thread
from app.services.upload_sync import (
    discard_pending_runtime_key,
    is_pending_runtime_key,
    list_sync_groups,
    register_pending_upload,
    start_sync_group,
)
from app.routers.policy_router import sync_policy_runtime_from_db
from app.routers.counting_router import sync_counting_runtime_from_db

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


def _infer_stream_camera_type(source_path: str, *, is_fisheye: bool = False) -> str:
    if is_rtsp_source(source_path):
        return "RTSP Fisheye" if is_fisheye else "RTSP"
    return "Network Stream Fisheye" if is_fisheye else "Network Stream"


def _default_ws_url(camera_id: str) -> str:
    return f"ws://localhost:8000/ws/{camera_id}"


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
    await sync_policy_runtime_from_db(db)
    await sync_counting_runtime_from_db(db)


def _build_camera_read(
    camera: Camera,
    stream_config: StreamConfig | None = None,
    analysis_tags: list[str] | None = None,
) -> CameraRead:
    return CameraRead(
        id=camera.id,
        name=camera.name,
        location=camera.location,
        type=camera.type,
        status=camera.status,
        mode=camera.mode,
        ws_url=camera.ws_url or _default_ws_url(camera.id),
        resolution=camera.resolution,
        fps=camera.fps,
        enabled=camera.enabled,
        image=camera.image,
        source_path=stream_config.source_path if stream_config is not None else None,
        view_index=stream_config.view_index if stream_config is not None else -1,
        is_fisheye=bool(stream_config.is_fisheye) if stream_config is not None else False,
        analysis_tags=analysis_tags or [],
    )


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


async def _ensure_stream_running(session: AsyncSession, stream_config: StreamConfig):
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
    )
    session.add(stream_config)

    await session.flush()
    await session.refresh(camera)
    return camera, stream_config


def _open_probe_capture(source_path: str) -> cv2.VideoCapture:
    return open_video_capture(source_path)


def _probe_stream(source_path: str) -> dict:
    cap = _open_probe_capture(source_path)
    try:
        if not cap.isOpened():
            return {"ok": False, "detail": "Unable to open stream."}

        ok, frame = cap.read()
        if not ok or frame is None:
            return {"ok": False, "detail": "Connected, but no frame was received."}

        height, width = frame.shape[:2]
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        return {
            "ok": True,
            "detail": "Stream connection successful.",
            "resolution": f"{width}x{height}",
            "fps": round(float(fps), 1),
            "stream_kind": "rtsp" if is_rtsp_source(source_path) else "network",
        }
    finally:
        cap.release()


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
        )
        db.add(stream_config)
        await db.flush()

    await db.refresh(db_camera)

    if stream_config is not None and db_camera.enabled:
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

    source_path = (camera.source_path or "").strip() or None
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
            )
            db.add(stream_config)
        else:
            stream_config.source_path = source_path
            if not camera.is_fisheye or not stream_config.runtime_key:
                stream_config.runtime_key = _normalize_runtime_key(source_path)
            stream_config.view_index = camera.view_index
            stream_config.is_fisheye = camera.is_fisheye
    elif stream_config is not None:
        await db.delete(stream_config)
        stream_config = None

    await db.flush()
    await db.refresh(db_camera)

    if old_runtime_key and (old_source_path != source_path or stream_config is None):
        await _stop_producer_if_unused(db, old_runtime_key)

    if stream_config is not None and db_camera.enabled:
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
        return await loop.run_in_executor(None, _probe_stream, source_path)
    except Exception as exc:
        return {
            "ok": False,
            "detail": f"Stream probe failed: {exc}",
        }


@router.post("/api/cameras/test-rtsp")
async def test_rtsp_connection(payload: StreamConnectionTestRequest):
    return await test_stream_connection(payload)


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


@router.post("/api/upload_and_process")
async def upload_video(
    file: UploadFile = File(...),
    enable_fisheye: bool = Form(False),
    camera_name_prefix: str = Form("Camera"),
    selected_views: str = Form(""),  # Comma separated indices, e.g. "0,2,4"
    sync_start: bool = Form(False),
    sync_group_id: str = Form(""),
    db: AsyncSession = Depends(get_db),
):
    try:
        if sync_start and not sync_group_id.strip():
            raise HTTPException(status_code=400, detail="sync_group_id is required when sync_start is enabled.")

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

        if sync_start:
            pending_count = register_pending_upload(
                sync_group_id,
                runtime_key=runtime_key,
                source_path=input_path,
                is_fisheye=enable_fisheye,
                active_views=active_view_indices,
            )
        else:
            pending_count = 0
            # Start the Producer Thread IMMEDIATELY
            start_producer_thread(runtime_key, input_path, enable_fisheye, active_view_indices)

        # Helper to create camera + stream_config in DB
        async def create_cam(suffix: str, view_idx: int) -> CameraRead:
            cam_id = str(uuid.uuid4())

            db_camera = Camera(
                id=cam_id,
                name=f"{camera_name_prefix} - {suffix}" if suffix else camera_name_prefix,
                location="Uploaded Video",
                type="Fisheye" if enable_fisheye else "File",
                status="Pending Sync Start" if sync_start else "Online",
                mode="Unassigned",
                ws_url=_default_ws_url(cam_id),
                resolution="640x360",
                fps=30,
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

        return {
            "status": "success",
            "created_cameras": new_cameras,
            "sync_start": sync_start,
            "sync_group_id": sync_group_id.strip() if sync_start else None,
            "pending_sources": pending_count,
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
