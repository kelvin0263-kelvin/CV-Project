import cv2
import sys
import os
import numpy as np
from ultralytics import YOLO
import argparse
from pathlib import Path

# Fix path to import backend modules
# Assuming script is in d:\CV-UI\scripts and backend is in d:\CV-UI\backend
current_dir = os.path.dirname(os.path.abspath(__file__))
backend_path = os.path.join(os.path.dirname(current_dir), 'backend')
sys.path.append(backend_path)

try:
    from DefishVideoCV import FisheyeMultiView
except ImportError:
    print("Error: Could not import DefishVideoCV. Make sure the script is in d:\\CV-UI\\scripts and backend is in d:\\CV-UI\\backend")
    sys.exit(1)

def ensure_dir(path):
    if not os.path.exists(path):
        os.makedirs(path)

def crop_with_padding(image, bbox, padding_percent=0.1):
    h, w = image.shape[:2]
    x1, y1, x2, y2 = bbox
    
    # Calculate padding
    width = x2 - x1
    height = y2 - y1
    pad_w = int(width * padding_percent)
    pad_h = int(height * padding_percent)
    
    # Apply padding with boundary checks
    nx1 = max(0, int(x1 - pad_w))
    ny1 = max(0, int(y1 - pad_h))
    nx2 = min(w, int(x2 + pad_w))
    ny2 = min(h, int(y2 + pad_h))
    
    return image[ny1:ny2, nx1:nx2], (nx1, ny1, nx2, ny2)

def process_video(video_path, output_base_dir):
    # Setup Output Dirs
    dirs = {
        'full_body': os.path.join(output_base_dir, 'full_body'),
        'upper_body': os.path.join(output_base_dir, 'upper_body'),
        'lower_body': os.path.join(output_base_dir, 'lower_body'),
        'legs': os.path.join(output_base_dir, 'legs')
    }
    for d in dirs.values():
        ensure_dir(d)

    # Load Model (YOLO-Pose for keypoints)
    print("Loading YOLOv8m-Pose model...")
    model = YOLO("yolov8m-pose.pt")

    # Open Video
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"Error: Cannot open video {video_path}")
        return

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # Detect CUDA availability
    cuda_available = hasattr(cv2, "cuda") and cv2.cuda.getCudaEnabledDeviceCount() > 0
    if cuda_available:
        print("[System] CUDA detected: enabling GPU processing")
    else:
        print("[System] CUDA not available, using CPU pipeline")

    # Configure Defisher for 135 degrees
    # Based on previous code: {'angle_z': 135, 'angle_up': 35, 'zoom': 80}
    view_configs = [
        {'angle_z': 135, 'angle_up': 35, 'zoom': 80}
    ]
    
    # Initialize Processor
    # Note: FisheyeMultiView expects (height, width)
    # Use CUDA if available, but keep full resolution (no downscale) for training data
    processor = FisheyeMultiView(
        (height, width),
        view_configs,
        show_original=False,
        use_cuda=cuda_available,
        downscale_size=None  # Keep full resolution for training data
    )

    frame_idx = 0
    saved_count = 0

    print(f"Starting processing for {total_frames} frames...")

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        frame_idx += 1
        if frame_idx % 10 == 0:
            print(f"Processing frame {frame_idx}/{total_frames}...", end='\r')

        # 1. Defish -> Get 135 degree view
        # process_frame returns: processed_frames (dict), originals (dict), list_views
        # The key for the first view will likely be 'partition_0' since we only passed 1 config
        try:
            processed_frames, _, _ = processor.process_frame(frame, overlay=False, view_id=None)
            
            # Extract the 135-degree view
            # Since we only passed one config, it should be the first one. 
            # FisheyeMultiView usually names keys as 'partition_{index}'
            target_view = processed_frames.get('partition_0')
            
            if target_view is None:
                continue

        except Exception as e:
            print(f"Defish error frame {frame_idx}: {e}")
            continue

        # 2. Run YOLO Pose Detection
        # Using yolov8m-pose + imgsz=1280
        # Ensure device='0' is used to leverage GPU
        results = model(target_view, verbose=False, classes=[0], conf=0.5, imgsz=1280, device='0')

        for r in results:
            boxes = r.boxes.xyxy.cpu().numpy()
            keypoints = r.keypoints.xy.cpu().numpy() if r.keypoints is not None else []
            
            for i, box in enumerate(boxes):
                # crop full person output
                person_img, (px1, py1, px2, py2) = crop_with_padding(target_view, box, padding_percent=0.05)
                
                # Save Full Body
                fname = f"frame_{frame_idx}_p{i}.jpg"
                if person_img is not None and person_img.size > 0:
                    cv2.imwrite(os.path.join(dirs['full_body'], fname), person_img)
                
                # Check Keypoints for parts (COCO format: 17 points)
                # 5,6: Shoulders | 11,12: Hips | 13,14: Knees | 15,16: Ankles
                if len(keypoints) > i:
                    kps = keypoints[i]
                    
                    # Logic for splitting
                    # We need valid Y coordinates. If check confidence if possible, or just check non-zero.
                    
                    # Avg Y for Shoulders (Upper Limit of Upper Body, though usually Head is top of box)
                    shoulder_y = np.mean([kps[5][1], kps[6][1]]) if kps[5][1] > 0 and kps[6][1] > 0 else py1
                    
                    # Avg Y for Hips (Split Upper/Lower)
                    hip_y = np.mean([kps[11][1], kps[12][1]]) if kps[11][1] > 0 and kps[12][1] > 0 else None
                    
                    # Avg Y for Knees (Split Lower/Legs)
                    knee_y = np.mean([kps[13][1], kps[14][1]]) if kps[13][1] > 0 and kps[14][1] > 0 else None
                    
                    # Fallback logic if pose fails: use relative height of bbox
                    h_box = py2 - py1
                    if hip_y is None: hip_y = py1 + h_box * 0.45
                    if knee_y is None: knee_y = py1 + h_box * 0.75
                    
                    # Clamp values to current crop coordinates (global frame coords)
                    # Upper Body: Box Top -> Hip
                    if hip_y > py1:
                        upper_bbox = (px1, py1, px2, int(hip_y))
                        upper_img, _ = crop_with_padding(target_view, upper_bbox, 0)
                        if upper_img is not None and upper_img.size > 0 and upper_img.shape[0] >= 160:
                            cv2.imwrite(os.path.join(dirs['upper_body'], fname), upper_img)
                    
                    # Lower Body (Thighs/shorts): Hip -> Knee
                    if hip_y < py2 and knee_y > hip_y:
                        lower_bbox = (px1, int(hip_y), px2, int(knee_y))
                        lower_img, _ = crop_with_padding(target_view, lower_bbox, 0)
                        if lower_img is not None and lower_img.size > 0:
                            cv2.imwrite(os.path.join(dirs['lower_body'], fname), lower_img)
                    
                    # Legs (Knees -> Feet): Knee -> Box Bottom
                    if knee_y < py2:
                         legs_bbox = (px1, int(knee_y), px2, py2)
                         # Often allow 'legs' to be wider? No, keep box width.
                         legs_img, _ = crop_with_padding(target_view, legs_bbox, 0)
                         if legs_img is not None and legs_img.size > 0:
                             cv2.imwrite(os.path.join(dirs['legs'], fname), legs_img)

                saved_count += 1

    cap.release()
    print(f"\nDone! Processed {frame_idx} frames. Saved {saved_count} person instances.")
    print(f"Results saved in {output_base_dir}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Process Fisheye Video for MobileNet Training Data")
    parser.add_argument("video_path", help="Path to input video")
    parser.add_argument("--output", default="training_data", help="Output directory folder name")
    
    args = parser.parse_args()
    
    process_video(args.video_path, args.output)
