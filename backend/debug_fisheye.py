import cv2
import numpy as np
import sys
import os

# Mock dependencies to run standalone
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from DefishVideoCV import FisheyeMultiView

def test_fisheye_generation():
    print("--- Starting Fisheye Debug ---")
    
    # 1. Create a dummy black frame (HD)
    height, width = 1080, 1920
    dummy_frame = np.zeros((height, width, 3), dtype=np.uint8)
    
    # Draw a circle to simulate fisheye content
    cv2.circle(dummy_frame, (width//2, height//2), 400, (255, 255, 255), -1)
    
    # 2. Define the config (Same as used in main.py)
    view_configs = [
        {'angle_z': 0,   'angle_up': 35, 'zoom': 80},
        {'angle_z': 45,  'angle_up': 35, 'zoom': 80},
        {'angle_z': 90,  'angle_up': 35, 'zoom': 80}, # View 3
        {'angle_z': 135, 'angle_up': 35, 'zoom': 80}, # View 4
        {'angle_z': 180, 'angle_up': 35, 'zoom': 80}, # View 5
        {'angle_z': 225, 'angle_up': 35, 'zoom': 80},
        {'angle_z': 270, 'angle_up': 35, 'zoom': 80},
        {'angle_z': 315, 'angle_up': 35, 'zoom': 80},
    ]
    
    print(f"Initializing FisheyeMultiView with {len(view_configs)} views...")
    
    try:
        processor = FisheyeMultiView(
            fisheye_frame_shape=dummy_frame.shape, 
            view_configs=view_configs, 
            show_original=True
        )
    except Exception as e:
        print(f"CRITICAL ERROR during Initialization: {e}")
        return

    # 3. Check Dewarp Maps
    print("\n--- Checking Dewarp Maps ---")
    for i, m in enumerate(processor.dewarp_maps):
        status = "OK" if m is not None else "FAILED (None)"
        print(f"View {i+1} (Angle {view_configs[i]['angle_z']}°): Map Generation {status}")

    # 4. Process a frame
    print("\n--- Processing Frame ---")
    try:
        processed_frames, _, _ = processor.process_frame(dummy_frame, overlay=True)
        print(f"Processed Frames Keys: {list(processed_frames.keys())}")
        
        expected_keys = ['original'] + [f"partition_{i}" for i in range(8)]
        missing = [k for k in expected_keys if k not in processed_frames]
        
        if missing:
            print(f"MISSING VIEWS: {missing}")
        else:
            print("All views generated successfully in output dict.")
            
    except Exception as e:
        print(f"Error during processing: {e}")

if __name__ == "__main__":
    test_fisheye_generation()
