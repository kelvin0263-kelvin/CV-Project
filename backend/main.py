from fastapi import FastAPI, UploadFile, File, Form, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Optional
import shutil
import os
import cv2
import time
import uuid
import asyncio
import base64
import threading
from DefishVideoCV import FisheyeMultiView

app = FastAPI()

# --- Config & Directories ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "static", "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# --- Data Models ---
class CameraSource(BaseModel):
    id: str
    name: str
    location: str
    type: str 
    status: str
    mode: str
    ws_url: str
    resolution: str
    fps: int
    enabled: bool
    image: str

# --- Global State ---
CAMERAS_DB: List[CameraSource] = []
# STREAM_CONFIGS (Static Config): { camera_id: { 'source_path': str, 'view_index': int, 'parent_id': str } }
STREAM_CONFIGS: Dict[str, dict] = {}

# FRAME BUFFER (Dynamic): { source_path: { 'original': b64, 'partition_0': b64, ... } }
# This is shared between the Producer Thread and Consumer WebSockets
FRAME_BUFFERS: Dict[str, Dict[str, str]] = {}
ACTIVE_PRODUCERS: Dict[str, bool] = {} # To keep track of running threads

# --- CORS ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Producer Logic ---
def start_producer_thread(source_path: str, is_fisheye: bool):
    if source_path in ACTIVE_PRODUCERS:
        return # Already running
    
    ACTIVE_PRODUCERS[source_path] = True
    threading.Thread(target=video_producer, args=(source_path, is_fisheye), daemon=True).start()

def video_producer(source_path: str, is_fisheye: bool):
    print(f"[Producer] Starting loop for {source_path}")
    
    cap = cv2.VideoCapture(source_path)
    if not cap.isOpened():
        print(f"[Producer] Failed to open {source_path}")
        del ACTIVE_PRODUCERS[source_path]
        return

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    delay = 1.0 / fps

    processor = None
    if is_fisheye:
         view_configs = [
            {'angle_z': 0,   'angle_up': 35, 'zoom': 80},
            {'angle_z': 45,  'angle_up': 35, 'zoom': 80},
            {'angle_z': 90,  'angle_up': 35, 'zoom': 80},
            {'angle_z': 135, 'angle_up': 35, 'zoom': 80},
            {'angle_z': 180, 'angle_up': 35, 'zoom': 80},
            {'angle_z': 225, 'angle_up': 35, 'zoom': 80},
            {'angle_z': 270, 'angle_up': 35, 'zoom': 80},
            {'angle_z': 315, 'angle_up': 35, 'zoom': 80},
        ]
         processor = FisheyeMultiView((height, width), view_configs, show_original=True)
    
    # Init buffer for this source
    FRAME_BUFFERS[source_path] = {}
    
    # FPS Calculation Vars
    fps_start_time = time.time()
    fps_frame_count = 0
    current_real_fps = 0.0

    while True:
        loop_start = time.time()
        ret, frame = cap.read()
        
        if not ret:
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            continue
            
        # FPS Counter
        fps_frame_count += 1
        if (time.time() - fps_start_time) >= 1.0:
            current_real_fps = fps_frame_count / (time.time() - fps_start_time)
            fps_frame_count = 0
            fps_start_time = time.time()
            # print(f"FPS: {current_real_fps:.1f}")
        
        # --- Process ---
        current_buffer = {}
        # Store FPS in the buffer metadata (using a special key)
        current_buffer['__meta__'] = { 'fps': round(current_real_fps, 1) }
        
        if is_fisheye and processor:
            # Full processing (Produce all views at once)
            try:
                # view_id=None means process ALL views
                processed_frames, _, _ = processor.process_frame(frame, overlay=True, view_id=None)
                
                # Encode all to Base64
                for key, img in processed_frames.items():
                    # Resize for web
                    img_small = cv2.resize(img, (640, 360))
                    _, buffer = cv2.imencode('.jpg', img_small, [cv2.IMWRITE_JPEG_QUALITY, 40])
                    current_buffer[key] = base64.b64encode(buffer).decode('utf-8')
                    
            except Exception as e:
                print(f"[Producer] Error: {e}")
        else:
             # Normal video
             img_small = cv2.resize(frame, (640, 360))
             _, buffer = cv2.imencode('.jpg', img_small, [cv2.IMWRITE_JPEG_QUALITY, 40])
             current_buffer['original'] = base64.b64encode(buffer).decode('utf-8')
        
        # Update Global Buffer (Atomic assignment)
        FRAME_BUFFERS[source_path] = current_buffer
        
        # --- Timing Control ---
        # We want to maintain real-time speed.
        elapsed = time.time() - loop_start
        wait = delay - elapsed
        if wait > 0:
            time.sleep(wait)

# --- WebSocket ---
@app.websocket("/ws/{camera_id}")
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
            
            # Consumer limit (e.g. 20 FPS refresh rate for browser)
            # await asyncio.sleep(0.05) 
            await asyncio.sleep(0.04) # ~25FPS update to client
            
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"WS Error {camera_id}: {e}")

# --- Routes ---
@app.get("/api/cameras", response_model=List[CameraSource])
def get_cameras():
    return CAMERAS_DB

@app.post("/api/cameras")
def add_camera(camera: CameraSource):
    CAMERAS_DB.append(camera)
    return camera

@app.delete("/api/cameras/{camera_id}")
def delete_camera(camera_id: str):
    global CAMERAS_DB
    CAMERAS_DB = [c for c in CAMERAS_DB if c.id != camera_id]
    # We do NOT stop the producer thread here because other cameras might share the same source
    return {"status": "deleted"}

@app.post("/api/upload_and_process")
async def upload_video(
    file: UploadFile = File(...),
    enable_fisheye: bool = Form(False),
    camera_name_prefix: str = Form("Camera")
):
    try:
        file_id = str(uuid.uuid4())[:8]
        filename = f"{file_id}_{file.filename}"
        input_path = os.path.join(UPLOAD_DIR, filename)
        
        with open(input_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        new_cameras = []
        
        # Start the Producer Thread IMMEDIATELY
        start_producer_thread(input_path, enable_fisheye)
        
        # Helper
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
            for i in range(8):
                new_cameras.append(create_cam(f"View {i+1}", i))
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
