import threading
import cv2
import time
import base64
import sys
import os

# Ensure backend root is in path to import DefishVideoCV
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from DefishVideoCV import FisheyeMultiView
from app.core.globals import FRAME_BUFFERS, ACTIVE_PRODUCERS
from ultralytics import YOLO

# Initialize YOLO Model
print("[System] Loading YOLO Model...")
try:
    model = YOLO("yolov8n.pt")  # Ensure yolov8n.pt is in backend root
except Exception as e:
    print(f"[System] Warning: Failed to load YOLO model: {e}")
    model = None

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
        if source_path in ACTIVE_PRODUCERS:
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
        
        # --- Helper: Run Detection (Person Only, Conf > 0.5) ---
        def run_yolo(img):
            if model is None:
                return img
            try:
                # Run inference: classes=0 (person), conf=0.5
                # Run inference: classes=0 (person), conf=0.5
                # Ensure device='0' is used to leverage GPU
                results = model(img, classes=[0], conf=0.5, verbose=False, device='0')
                # Plot results
                annotated_frame = results[0].plot()
                return annotated_frame
            except Exception as e:
                return img

        # --- Process ---
        current_buffer = {}
        # Store FPS in the buffer metadata
        current_buffer['__meta__'] = { 'fps': round(current_real_fps, 1) }
        
        if is_fisheye and processor:
            try:
                # view_id=None means process ALL views
                processed_frames, _, _ = processor.process_frame(frame, overlay=True, view_id=None)
                
                # Encode all to Base64
                for key, img in processed_frames.items():
                    # Logic: Only apply YOLO on specific views
                    # key format is crucial. Assuming 'partition_3' is 135deg and 'partition_7' is 315deg
                    # Based on view_configs order:
                    # 0: 0deg, 1: 45deg, 2: 90deg, 3: 135deg, 4: 180deg, 5: 225deg, 6: 270deg, 7: 315deg
                    
                    target_views = ['partition_3', 'partition_7'] # 135 and 315
                    
                    if key in target_views:
                         # Temporarily disable YOLO to fix FPS
                         # img_2_process = run_yolo(img)
                         img_2_process = img
                    else:
                         img_2_process = img

                    # Resize for web optimization
                    img_small = cv2.resize(img_2_process, (640, 360))
                    _, buffer = cv2.imencode('.jpg', img_small, [cv2.IMWRITE_JPEG_QUALITY, 40])
                    current_buffer[key] = base64.b64encode(buffer).decode('utf-8')
                    
            except Exception as e:
                print(f"[Producer] Error: {e}")
        else:
             # Normal video processing
             try:
                 # Apply YOLO detection
                 # Temporarily disable YOLO to fix FPS
                 # frame_detected = run_yolo(frame)
                 frame_detected = frame
                 
                 img_small = cv2.resize(frame_detected, (640, 360))
                 _, buffer = cv2.imencode('.jpg', img_small, [cv2.IMWRITE_JPEG_QUALITY, 40])
                 current_buffer['original'] = base64.b64encode(buffer).decode('utf-8')
             except Exception as e:
                 print(f"[Producer] Normal video error: {e}")
        
        # Update Global Buffer (Atomic assignment)
        FRAME_BUFFERS[source_path] = current_buffer
        
        # --- Timing Control ---
        elapsed = time.time() - loop_start
        wait = delay - elapsed
        if wait > 0:
            time.sleep(wait)
