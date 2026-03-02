import argparse
import base64
import os
import sys
import time
from pathlib import Path

import cv2


def parse_args():
    parser = argparse.ArgumentParser(description="Profile C++ inference pipeline stages.")
    parser.add_argument("--video", required=True, help="Input video path")
    parser.add_argument("--frames", type=int, default=20, help="Number of frames to sample")
    parser.add_argument("--fisheye-views", type=int, default=0, help="Number of fisheye partitions to profile")
    parser.add_argument("--classify", action="store_true", help="Enable classification in run_frame")
    parser.add_argument("--classify-interval", type=int, default=30, help="Classification interval for C++ bridge")
    parser.add_argument("--module-dir", default="", help="Optional cpp module directory override")
    return parser.parse_args()


def load_frames(video_path: str, frame_limit: int):
    cap = cv2.VideoCapture(video_path)
    frames = []
    while len(frames) < frame_limit:
        ok, frame = cap.read()
        if not ok:
            break
        frames.append(frame)
    cap.release()
    if not frames:
        raise RuntimeError(f"failed to read frames from {video_path}")
    return frames


def make_bridge(classify_interval: int):
    from app.services.cpp_bridge import CppInferenceBridge

    bridge = CppInferenceBridge(
        pose_model_path="backend/onnx/yolo26m-pose.onnx",
        classifier_model_path="backend/onnx/best.onnx",
        class_names_path="backend/onnx/best.labels.txt",
        tracker_config_path="backend/bytetrack_custom.yaml",
        device_id=0,
        pose_imgsz=1280,
        cls_imgsz=224,
        det_conf=0.30,
        det_iou=0.50,
        cls_conf_min=0.0,
        classification_interval_frames=classify_interval,
    )
    if not bridge.enabled:
        raise RuntimeError("failed to initialize C++ inference bridge")
    return bridge


def make_fisheye_processor(frame):
    from DefishVideoCV import FisheyeMultiView

    configs = [
        {"angle_z": 0, "angle_up": 35, "zoom": 80},
        {"angle_z": 45, "angle_up": 35, "zoom": 80},
        {"angle_z": 90, "angle_up": 35, "zoom": 80},
        {"angle_z": 135, "angle_up": 35, "zoom": 80},
        None,
        None,
        None,
        None,
    ]
    return FisheyeMultiView(
        frame.shape[:2],
        configs,
        show_original=False,
        use_cuda=hasattr(cv2, "cuda") and cv2.cuda.getCudaEnabledDeviceCount() > 0,
        downscale_size=None,
    )


def encode_frame(img):
    img_small = cv2.resize(img, (640, 360), interpolation=cv2.INTER_AREA)
    try:
        from turbojpeg import TurboJPEG

        jpeg = TurboJPEG()
        buf = jpeg.encode(img_small, quality=40)
    except Exception:
        _, buf = cv2.imencode(".jpg", img_small, [cv2.IMWRITE_JPEG_QUALITY, 40])
    return base64.b64encode(buf).decode("utf-8")


def main():
    args = parse_args()
    project_root = Path(__file__).resolve().parents[1]
    backend_root = project_root / "backend"
    sys.path.insert(0, str(backend_root))

    if args.module_dir:
        os.environ["CPP_INFERENCE_MODULE_DIR"] = args.module_dir
    os.environ.setdefault("CPP_ONNXRUNTIME_ROOT", r"D:\tools\onnxruntime-win-x64-gpu-1.18.0")
    os.environ.setdefault("CPP_SERIALIZE_GLOBAL", "false")

    frames = load_frames(args.video, args.frames)
    bridge = make_bridge(args.classify_interval)
    print("health", bridge.health())

    if args.fisheye_views > 0:
        processor = make_fisheye_processor(frames[0])
        fisheye_total = 0.0
        infer_total = 0.0
        encode_total = 0.0
        partitions = 0
        state = {}

        for frame_index, frame in enumerate(frames):
            t0 = time.perf_counter()
            processed, _, _ = processor.process_frame(frame, overlay=True, view_id=None)
            t1 = time.perf_counter()
            fisheye_total += (t1 - t0)

            active = 0
            for key in sorted(processed.keys()):
                if not key.startswith("partition_"):
                    continue
                if active >= args.fisheye_views:
                    break
                active += 1
                t2 = time.perf_counter()
                bridge.run(processed[key], frame_index, state, skip_classification=not args.classify)
                t3 = time.perf_counter()
                encode_frame(processed[key])
                t4 = time.perf_counter()
                infer_total += (t3 - t2)
                encode_total += (t4 - t3)
                partitions += 1

        print(
            {
                "mode": "fisheye",
                "frames": len(frames),
                "partitions": partitions,
                "avg_fisheye_ms_per_frame": round(fisheye_total / len(frames) * 1000, 2),
                "avg_infer_ms_per_partition": round(infer_total / max(1, partitions) * 1000, 2),
                "avg_encode_ms_per_partition": round(encode_total / max(1, partitions) * 1000, 2),
            }
        )
        return

    infer_total = 0.0
    encode_total = 0.0
    state = {}
    for frame_index, frame in enumerate(frames):
        t0 = time.perf_counter()
        bridge.run(frame, frame_index, state, skip_classification=not args.classify)
        t1 = time.perf_counter()
        encode_frame(frame)
        t2 = time.perf_counter()
        infer_total += (t1 - t0)
        encode_total += (t2 - t1)

    print(
        {
            "mode": "normal",
            "frames": len(frames),
            "avg_infer_ms_per_frame": round(infer_total / len(frames) * 1000, 2),
            "avg_encode_ms_per_frame": round(encode_total / len(frames) * 1000, 2),
        }
    )


if __name__ == "__main__":
    main()
