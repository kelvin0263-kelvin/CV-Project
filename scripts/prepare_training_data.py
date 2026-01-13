import cv2
import sys
import os
import numpy as np
from ultralytics import YOLO
from ultralytics.trackers.byte_tracker import BYTETracker
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

def _iou(box_a, box_b):
    """Axis-aligned IoU for (x1,y1,x2,y2)."""
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b

    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)

    inter_w = max(0, inter_x2 - inter_x1)
    inter_h = max(0, inter_y2 - inter_y1)
    inter = inter_w * inter_h
    if inter == 0:
        return 0.0

    area_a = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    area_b = max(0, bx2 - bx1) * max(0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0

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


class _DetResults:
    """Minimal adapter to feed numpy detections into Ultralytics BYTETracker."""

    def __init__(self, xyxy: np.ndarray, conf: np.ndarray, cls: np.ndarray):
        self.xyxy = xyxy.astype(np.float32)
        self.conf = conf.astype(np.float32)
        self.cls = cls.astype(np.float32)

    def __getitem__(self, idx):
        return _DetResults(self.xyxy[idx], self.conf[idx], self.cls[idx])

    def __len__(self):
        return len(self.xyxy)

    @property
    def xywh(self):
        # convert xyxy -> xywh(center-based)
        xywh = np.zeros_like(self.xyxy)
        xywh[:, 0] = (self.xyxy[:, 0] + self.xyxy[:, 2]) * 0.5
        xywh[:, 1] = (self.xyxy[:, 1] + self.xyxy[:, 3]) * 0.5
        xywh[:, 2] = (self.xyxy[:, 2] - self.xyxy[:, 0])
        xywh[:, 3] = (self.xyxy[:, 3] - self.xyxy[:, 1])
        return xywh

def process_video(video_path, output_base_dir):
    # Sampling / tracking controls
    frame_stride = 3          # process every Nth frame to cut volume (~25fps -> ~8fps)
    track_thresh = 0.4        # ByteTrack: high-score threshold
    match_thresh = 0.5        # ByteTrack: association threshold
    track_buffer = 90         # ByteTrack: buffer for lost tracks (longer persistence)
    track_save_gap = 10       # save once every N processed frames per track
    min_track_age = 2         # require a track to live N processed frames before saving
    iou_dedup_thresh = 0.6    # skip if highly overlapping with last-saved frame

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

    # ByteTrack tracker
    class _BTArgs:
        pass
    bt_args = _BTArgs()
    bt_args.track_high_thresh = track_thresh
    bt_args.track_low_thresh = 0.1
    bt_args.track_buffer = track_buffer
    bt_args.match_thresh = match_thresh
    bt_args.mot20 = False
    bt_args.fuse_score = False
    bt_args.new_track_thresh = 0.4

    tracker = BYTETracker(bt_args, frame_rate=int(cap.get(cv2.CAP_PROP_FPS) or 25))
    last_save_frame = {}
    track_first_frame = {}
    last_saved_boxes = []
    current_saved_boxes = []

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        frame_idx += 1
        # Frame skipping to reduce volume
        if frame_idx % frame_stride != 0:
            continue

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
            boxes_xyxy = r.boxes.xyxy.cpu().numpy()
            scores = r.boxes.conf.cpu().numpy() if r.boxes.conf is not None else np.zeros((len(boxes_xyxy),))
            classes = r.boxes.cls.cpu().numpy() if r.boxes.cls is not None else np.zeros((len(boxes_xyxy),))
            keypoints = r.keypoints.xy.cpu().numpy() if r.keypoints is not None else []

            det_results = _DetResults(boxes_xyxy, scores, classes)

            tracked = tracker.update(det_results, img=target_view)
            
            for i, track in enumerate(tracked):
                # BYTETracker returns ndarray rows: [x1, y1, x2, y2, track_id, score, cls]
                box_coords = tuple(map(float, track[:4]))
                track_id = int(track[4]) if len(track) > 4 else i

                # Track first-seen age gate
                if track_id not in track_first_frame:
                    track_first_frame[track_id] = frame_idx
                if (frame_idx - track_first_frame[track_id]) < min_track_age:
                    continue

                # Save throttle: only save per track every track_save_gap frames
                if track_id in last_save_frame and (frame_idx - last_save_frame[track_id]) < track_save_gap:
                    continue

                # Dedup vs last saved frame boxes
                if any(_iou(box_coords, b) > iou_dedup_thresh for b in last_saved_boxes):
                    continue

                # Find best matching detection for keypoints
                best_kp = None
                if boxes_xyxy.size > 0 and len(keypoints) > 0:
                    boxes_list = [tuple(map(float, b)) for b in boxes_xyxy]
                    ious = [_iou(box_coords, b) for b in boxes_list]
                    best_idx = int(np.argmax(ious))
                    if ious[best_idx] > 0.3:
                        best_kp = keypoints[best_idx]

                # crop full person output
                px1, py1, px2, py2 = box_coords
                person_img, (px1, py1, px2, py2) = crop_with_padding(
                    target_view,
                    (px1, py1, px2, py2),
                    padding_percent=0.05
                )
                
                # Save Full Body
                fname = f"frame_{frame_idx}_p{i}_t{track_id}.jpg"
                if person_img is not None and person_img.size > 0:
                    cv2.imwrite(os.path.join(dirs['full_body'], fname), person_img)
                    last_save_frame[track_id] = frame_idx
                    current_saved_boxes.append(box_coords)
                
                # Check Keypoints for parts (COCO format: 17 points)
                # 5,6: Shoulders | 11,12: Hips | 13,14: Knees | 15,16: Ankles
                if best_kp is not None:
                    kps = best_kp
                    
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

        # Update dedup memory
        if current_saved_boxes:
            last_saved_boxes = current_saved_boxes
        current_saved_boxes = []

    cap.release()
    print(f"\nDone! Processed {frame_idx} frames. Saved {saved_count} person instances.")
    print(f"Results saved in {output_base_dir}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Process Fisheye Video for MobileNet Training Data")
    parser.add_argument("video_path", help="Path to input video")
    parser.add_argument("--output", default="training_data", help="Output directory folder name")
    
    args = parser.parse_args()
    
    process_video(args.video_path, args.output)
