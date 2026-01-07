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
                    # Resize for web optimization
                    img_small = cv2.resize(img, (640, 360))
                    _, buffer = cv2.imencode('.jpg', img_small, [cv2.IMWRITE_JPEG_QUALITY, 40])
                    current_buffer[key] = base64.b64encode(buffer).decode('utf-8')
                    
            except Exception as e:
                print(f"[Producer] Error: {e}")
        else:
             # Normal video processing
             try:
                 img_small = cv2.resize(frame, (640, 360))
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
