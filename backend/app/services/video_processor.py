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
print("[System] Loading YOLOv11-Pose Model...")
try:
    model = YOLO("yolo11m-pose.pt")  # Ensure yolo11m-pose.pt is downloaded
except Exception as e:
    print(f"[System] Warning: Failed to load YOLO model: {e}")
    model = None

def start_producer_thread(source_path: str, is_fisheye: bool, active_views: list = None):
    if source_path in ACTIVE_PRODUCERS:
        return # Already running
    
    ACTIVE_PRODUCERS[source_path] = True
    threading.Thread(target=video_producer, args=(source_path, is_fisheye, active_views), daemon=True).start()

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

    processor = None
    if is_fisheye:
         # Standard 8 views
         all_configs = [
            {'angle_z': 0,   'angle_up': 35, 'zoom': 80}, # View 0
            {'angle_z': 45,  'angle_up': 35, 'zoom': 80}, # View 1
            {'angle_z': 90,  'angle_up': 35, 'zoom': 80}, # View 2
            {'angle_z': 135, 'angle_up': 35, 'zoom': 80}, # View 3
            {'angle_z': 180, 'angle_up': 35, 'zoom': 80}, # View 4
            {'angle_z': 225, 'angle_up': 35, 'zoom': 80}, # View 5
            {'angle_z': 270, 'angle_up': 35, 'zoom': 80}, # View 6
            {'angle_z': 315, 'angle_up': 35, 'zoom': 80}, # View 7
        ]
         
         final_configs = []
         for i in range(8):
             if active_views is None or i in active_views:
                 final_configs.append(all_configs[i])
             else:
                 final_configs.append(None) # Skip this view
                 
         processor = FisheyeMultiView((height, width), final_configs, show_original=True)
    
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
        
        # --- Timing ---
        t0 = time.time()
        
        # --- Helper: Task for Parallel Encoding ---
        def process_and_encode_view(key, img):
            try:
                # Logic: Only apply YOLO on specific views
                target_views = ['partition_3'] # Only 135 degree
                
                # Note: YOLO inference itself is not thread-safe if sharing the same model instance simply.
                # Ideally, YOLO runs on main thread, but here we keep it simple or assume inference is fast/locked.
                # For safety/speed, let's keep YOLO sequentially on main thread mostly, 
                # BUT since run_yolo is here, let's move YOLO OUT of this parallel block if possible, 
                # OR assume checking logic is fast.
                # Actually, running YOLO in parallel threads with one model instance might cause issues or not speed up GPU.
                # Better Strategy: Run YOLO sequentially first if needed, THEN encode in parallel.
                
                img_2_process = img
                if key in target_views:
                     img_2_process = run_yolo(img) # This might still be the bottleneck if plot() is slow
                
                # CPU Intensive: Resize and Encode
                img_small = cv2.resize(img_2_process, (640, 360))
                _, buffer = cv2.imencode('.jpg', img_small, [cv2.IMWRITE_JPEG_QUALITY, 40])
                b64_str = base64.b64encode(buffer).decode('utf-8')
                return key, b64_str
            except Exception as e:
                print(f"Encoding error for {key}: {e}")
                return key, None

        if is_fisheye and processor:
            try:
                # 1. Fisheye Processing (CPU Bound - Single Core mostly unless OpenCV is optimized)
                processed_frames, _, _ = processor.process_frame(frame, overlay=True, view_id=None)
                t1 = time.time()
                
                # 2. Parallel Encoding (Utilize 64-core CPU)
                # We use a ThreadPool to resize and encode multiple views simultaneously.
                import concurrent.futures
                
                current_buffer = {}
                current_buffer['__meta__'] = { 'fps': round(current_real_fps, 1) }

                with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
                    # Submit all encoding tasks
                    future_to_key = {executor.submit(process_and_encode_view, k, v): k for k, v in processed_frames.items()}
                    
                    for future in concurrent.futures.as_completed(future_to_key):
                        key, result_b64 = future.result()
                        if result_b64:
                            current_buffer[key] = result_b64
                
                t2 = time.time()
                
                # Log performance
                if fps_frame_count % 30 == 0:
                    fisheye_time = (t1 - t0) * 1000
                    encoding_time = (t2 - t1) * 1000
                    total_time = (t2 - t0) * 1000
                    print(f"[Perf] Fisheye: {fisheye_time:.1f}ms | Par-Encode/YOLO: {encoding_time:.1f}ms | Total: {total_time:.1f}ms | FPS: {current_real_fps:.1f}")

            except Exception as e:
                print(f"[Producer] Error: {e}")
        else:
             # Normal video processing
             try:
                 # Encode Normal Frame
                 frame_detected = run_yolo(frame)
                 
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
