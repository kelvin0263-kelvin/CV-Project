from fastapi import APIRouter, UploadFile, File, Form, HTTPException, WebSocket, WebSocketDisconnect, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete as sa_delete
from typing import List
import uuid
import os
import asyncio

from app.models.camera_model import Camera
from app.models.stream_config import StreamConfig
from app.schemas.camera import CameraCreate, CameraRead
from app.core.database import get_db, AsyncSessionLocal
from app.core.globals import FRAME_BUFFERS
from app.services.video_processor import start_producer_thread

router = APIRouter()

# Directories
# We place uploads OUTSIDE the backend directory to prevent uvicorn auto-reload from triggering
# when a new file is written. This prevents in-memory state from being wiped.
BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROJECT_ROOT = os.path.dirname(BACKEND_ROOT)  # Go up one level to CV-UI/
UPLOAD_DIR = os.path.join(PROJECT_ROOT, "temp_video_uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


# --- WebSocket Endpoint ---
@router.websocket("/ws/{camera_id}")
async def websocket_endpoint(websocket: WebSocket, camera_id: str):
    await websocket.accept()
    print(f"[WS] Connection accepted for {camera_id}")

    # Look up stream config from the database
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(StreamConfig).where(StreamConfig.camera_id == camera_id)
        )
        config_row = result.scalar_one_or_none()

    if not config_row:
        print(f"[WS] Error: No config found for {camera_id}.")
        await websocket.close()
        return

    print(f"[WS] Config found for {camera_id}: source={config_row.source_path}, view={config_row.view_index}")

    source_path = config_row.source_path
    view_index = config_row.view_index

    # Map view_index to buffer key
    target_key = 'original'
    if view_index != -1:
        target_key = f"partition_{view_index}"

    try:
        while True:
            # Fetch latest frame + metadata from global buffer
            if source_path in FRAME_BUFFERS:
                frames = FRAME_BUFFERS[source_path]
                if target_key in frames:
                    b64_data = frames[target_key]

                    # Extract metadata
                    meta = frames.get('__meta__', {})
                    fps = meta.get('fps', 0)
                    people_count = meta.get('people_count', 0)

                    # Get detections for this specific view
                    all_detections = meta.get('detections', {})
                    view_detections = all_detections.get(target_key, [])

                    await websocket.send_json({
                        "image": b64_data,
                        "fps": fps,
                        "people_count": people_count,
                        "detections": view_detections,
                    })

            # Consumer limit (~25FPS update to client)
            await asyncio.sleep(0.04)

    except WebSocketDisconnect:
        pass


# --- HTTP API Endpoints ---

@router.get("/api/cameras", response_model=List[CameraRead])
async def get_cameras(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Camera))
    cameras = result.scalars().all()
    return cameras


@router.post("/api/cameras", response_model=CameraRead)
async def add_camera(camera: CameraCreate, db: AsyncSession = Depends(get_db)):
    db_camera = Camera(
        id=camera.id or str(uuid.uuid4()),
        name=camera.name,
        location=camera.location,
        type=camera.type,
        status=camera.status,
        mode=camera.mode,
        ws_url=camera.ws_url,
        resolution=camera.resolution,
        fps=camera.fps,
        enabled=camera.enabled,
        image=camera.image,
    )
    db.add(db_camera)
    await db.flush()
    await db.refresh(db_camera)
    return db_camera


@router.delete("/api/cameras/{camera_id}")
async def delete_camera(camera_id: str, db: AsyncSession = Depends(get_db)):
    # Delete stream config first (cascade should handle it, but be explicit)
    await db.execute(
        sa_delete(StreamConfig).where(StreamConfig.camera_id == camera_id)
    )
    result = await db.execute(
        sa_delete(Camera).where(Camera.id == camera_id)
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Camera not found")
    return {"status": "deleted"}


@router.post("/api/upload_and_process")
async def upload_video(
    file: UploadFile = File(...),
    enable_fisheye: bool = Form(False),
    camera_name_prefix: str = Form("Camera"),
    selected_views: str = Form(""),  # Comma separated indices, e.g. "0,2,4"
    db: AsyncSession = Depends(get_db),
):
    try:
        file_id = str(uuid.uuid4())[:8]
        filename = f"{file_id}_{file.filename}"
        input_path = os.path.join(UPLOAD_DIR, filename)

        # Stream file to disk in 1MB chunks to handle large files
        CHUNK_SIZE = 1024 * 1024  # 1 MB
        with open(input_path, "wb") as buffer:
            while True:
                chunk = await file.read(CHUNK_SIZE)
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

        # Start the Producer Thread IMMEDIATELY
        start_producer_thread(input_path, enable_fisheye, active_view_indices)

        # Helper to create camera + stream_config in DB
        async def create_cam(suffix: str, view_idx: int) -> CameraRead:
            cam_id = str(uuid.uuid4())

            db_camera = Camera(
                id=cam_id,
                name=f"{camera_name_prefix} - {suffix}" if suffix else camera_name_prefix,
                location="Uploaded Video",
                type="Fisheye" if enable_fisheye else "File",
                status="Online",
                mode="People Counting",
                ws_url=f"ws://localhost:8000/ws/{cam_id}",
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
                view_index=view_idx,
                is_fisheye=enable_fisheye,
            )
            db.add(db_stream_config)

            await db.flush()
            await db.refresh(db_camera)
            return CameraRead.model_validate(db_camera)

        if enable_fisheye:
            new_cameras.append(await create_cam("Original", -1))
            # Define angles corresponding to the 8 views
            angles = [0, 45, 90, 135, 180, 225, 270, 315]
            for i, angle in enumerate(angles):
                # Check if this view was selected
                if active_view_indices is not None and i not in active_view_indices:
                    continue
                new_cameras.append(await create_cam(f"View {i+1} ({angle}°)", i))
        else:
            new_cameras.append(await create_cam("", -1))

        return {
            "status": "success",
            "created_cameras": new_cameras,
        }

    except Exception as e:
        print(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
