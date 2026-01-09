from fastapi import APIRouter, UploadFile, File, Form, HTTPException, WebSocket, WebSocketDisconnect
from typing import List
import uuid
import shutil
import os
import asyncio

from app.models.camera import CameraSource
from app.core.globals import CAMERAS_DB, STREAM_CONFIGS, FRAME_BUFFERS
from app.services.video_processor import start_producer_thread

router = APIRouter()

# Directories (Should ideally be in config)
BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UPLOAD_DIR = os.path.join(BASE_DIR, "static", "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# --- WebSocket Endpoint ---
@router.websocket("/ws/{camera_id}")
async def websocket_endpoint(websocket: WebSocket, camera_id: str):
    await websocket.accept()
    
    config = STREAM_CONFIGS.get(camera_id)
    if not config:
        await websocket.close()
        return

    source_path = config['source_path']
    view_index = config.get('view_index', -1)
    
    # Map view_index to buffer key
    target_key = 'original'
    if view_index != -1:
        target_key = f"partition_{view_index}"
        
    try:
        while True:
            # Simply fetch latest frame from global buffer
            if source_path in FRAME_BUFFERS:
                frames = FRAME_BUFFERS[source_path]
                if target_key in frames:
                    b64_data = frames[target_key]
                    
                    # Extract FPS from meta
                    fps = 0
                    if '__meta__' in frames:
                        fps = frames['__meta__'].get('fps', 0)
                        
                    await websocket.send_json({"image": b64_data, "fps": fps})
            
            # Consumer limit (~25FPS update to client)
            await asyncio.sleep(0.04) 
            
    except WebSocketDisconnect:
        pass

# --- HTTP API Endpoints ---

@router.get("/api/cameras", response_model=List[CameraSource])
def get_cameras():
    return CAMERAS_DB

@router.post("/api/cameras")
def add_camera(camera: CameraSource):
    CAMERAS_DB.append(camera)
    return camera

@router.delete("/api/cameras/{camera_id}")
def delete_camera(camera_id: str):
    # We maintain a global reference to the list, so we must modify it carefully
    # Ideally should use a Service for DB operations
    global CAMERAS_DB
    # Find index to remove
    ids_to_remove = [i for i, c in enumerate(CAMERAS_DB) if c.id == camera_id]
    for idx in reversed(ids_to_remove):
        CAMERAS_DB.pop(idx)
        
    # We do NOT stop the producer thread here because other cameras might share the same source
    return {"status": "deleted"}

@router.post("/api/upload_and_process")
async def upload_video(
    file: UploadFile = File(...),
    enable_fisheye: bool = Form(False),
    camera_name_prefix: str = Form("Camera"),
    selected_views: str = Form("") # Comma separated indices, e.g. "0,2,4"
):
    try:
        file_id = str(uuid.uuid4())[:8]
        filename = f"{file_id}_{file.filename}"
        input_path = os.path.join(UPLOAD_DIR, filename)
        
        with open(input_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        new_cameras = []
        
        active_view_indices = None
        if enable_fisheye and selected_views:
             try:
                active_view_indices = [int(x.strip()) for x in selected_views.split(",") if x.strip().isdigit()]
             except:
                pass
        
        # Start the Producer Thread IMMEDIATELY
        start_producer_thread(input_path, enable_fisheye, active_view_indices)
        
        # Helper to create camera objects
        def create_cam(suffix, view_idx):
            cam_id = str(uuid.uuid4())
            STREAM_CONFIGS[cam_id] = {
                'source_path': input_path,
                'view_index': view_idx
            }
            return CameraSource(
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
                image=""
            )

        if enable_fisheye:
            new_cameras.append(create_cam("Original", -1))
            # Define angles corresponding to the 8 views
            angles = [0, 45, 90, 135, 180, 225, 270, 315]
            for i, angle in enumerate(angles):
                # Check if this view was selected
                if active_view_indices is not None and i not in active_view_indices:
                    continue
                    
                new_cameras.append(create_cam(f"View {i+1} ({angle}°)", i))
        else:
             new_cameras.append(create_cam("", -1))
             
        CAMERAS_DB.extend(new_cameras)

        return {
            "status": "success",
            "created_cameras": new_cameras
        }

    except Exception as e:
        print(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
