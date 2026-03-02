from __future__ import annotations

import argparse
import ctypes
import os
import sys
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO


def parse_args() -> argparse.Namespace:
    project_root = Path(__file__).resolve().parents[1]
    backend_root = project_root / "backend"
    return argparse.ArgumentParser(description="Compare Python YOLO pose detections with C++ ONNX detections.").parse_args(
        []
    )


def build_parser() -> argparse.ArgumentParser:
    project_root = Path(__file__).resolve().parents[1]
    backend_root = project_root / "backend"
    parser = argparse.ArgumentParser(description="Compare Python YOLO pose detections with C++ ONNX detections.")
    parser.add_argument("--video", type=Path, required=True, help="Input video path.")
    parser.add_argument("--frame", type=int, default=1, help="1-based frame index.")
    parser.add_argument("--python-model", type=Path, default=backend_root / "yolo26m-pose.pt")
    parser.add_argument("--cpp-module-dir", type=Path, default=backend_root / "cpp_inference" / "build" / "Release")
    parser.add_argument("--onnxruntime-root", type=Path, default=Path(r"D:\tools\onnxruntime-win-x64-gpu-1.18.0"))
    parser.add_argument("--pose-onnx", type=Path, default=backend_root / "onnx" / "yolo26m-pose.onnx")
    parser.add_argument("--cls-onnx", type=Path, default=backend_root / "onnx" / "best.onnx")
    parser.add_argument("--labels", type=Path, default=backend_root / "onnx" / "best.labels.txt")
    parser.add_argument("--tracker-config", type=Path, default=backend_root / "bytetrack_custom.yaml")
    parser.add_argument("--conf", type=float, default=0.30)
    parser.add_argument("--imgsz", type=int, default=1280)
    parser.add_argument("--output", type=Path, default=project_root / "temp_video_uploads" / "compare_cpp_python_pose.jpg")
    return parser


def read_frame(video_path: Path, frame_index: int) -> np.ndarray:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"failed to open video: {video_path}")
    target = max(1, frame_index)
    current = 0
    frame = None
    while current < target:
        ok, frame = cap.read()
        if not ok:
            raise RuntimeError(f"failed to read frame {frame_index} from {video_path}")
        current += 1
    cap.release()
    return frame


def to_xyxy_list(boxes: np.ndarray) -> list[list[float]]:
    out: list[list[float]] = []
    for row in boxes:
        out.append([float(v) for v in row.tolist()])
    return out


def load_cpp_module(module_dir: Path, onnxruntime_root: Path):
    module_dir = module_dir.resolve()
    onnxruntime_root = onnxruntime_root.resolve()
    if os.name == "nt":
        os.add_dll_directory(str(module_dir))
        os.add_dll_directory(str(onnxruntime_root / "lib"))
        ctypes.WinDLL(str(onnxruntime_root / "lib" / "onnxruntime.dll"))
    sys.path.insert(0, str(module_dir))
    import cvui_cpp_inference as cpp_module  # type: ignore

    return cpp_module


def run_python_detector(model_path: Path, frame: np.ndarray, conf: float, imgsz: int) -> list[list[float]]:
    model = YOLO(str(model_path))
    results = model.predict(frame, conf=conf, imgsz=imgsz, classes=[0], verbose=False, device="0")
    if not results:
        return []
    boxes = results[0].boxes.xyxy.cpu().numpy() if results[0].boxes is not None else np.empty((0, 4))
    return to_xyxy_list(boxes)


def run_cpp_detector(cpp_module, frame: np.ndarray, pose_onnx: Path, cls_onnx: Path, labels: Path, tracker_config: Path,
                     conf: float, imgsz: int) -> list[list[float]]:
    core = cpp_module.InferenceCore(
        str(pose_onnx),
        str(cls_onnx),
        str(labels),
        str(tracker_config),
        0,
        imgsz,
        224,
        conf,
        0.50,
        0.0,
    )
    result = core.run_frame(frame, 1, True)
    detections = result.get("detections", [])
    return [[float(v) for v in det["person_bbox"]] for det in detections]


def bbox_iou(a: list[float], b: list[float]) -> float:
    x1 = max(a[0], b[0])
    y1 = max(a[1], b[1])
    x2 = min(a[2], b[2])
    y2 = min(a[3], b[3])
    iw = max(0.0, x2 - x1)
    ih = max(0.0, y2 - y1)
    inter = iw * ih
    if inter <= 0.0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    denom = area_a + area_b - inter
    return 0.0 if denom <= 0.0 else inter / denom


def print_comparison(python_boxes: list[list[float]], cpp_boxes: list[list[float]]) -> None:
    print(f"python_boxes={len(python_boxes)} cpp_boxes={len(cpp_boxes)}")
    for idx, box in enumerate(python_boxes):
        print(f"python[{idx}] = {[round(v, 1) for v in box]}")
    for idx, box in enumerate(cpp_boxes):
        print(f"cpp[{idx}] = {[round(v, 1) for v in box]}")

    if not python_boxes or not cpp_boxes:
        return

    print("best IoU per python box:")
    for idx, box in enumerate(python_boxes):
        best_iou = 0.0
        best_j = -1
        for jdx, other in enumerate(cpp_boxes):
            score = bbox_iou(box, other)
            if score > best_iou:
                best_iou = score
                best_j = jdx
        print(f"  python[{idx}] -> cpp[{best_j}] IoU={best_iou:.3f}")


def draw_boxes(frame: np.ndarray, boxes: list[list[float]], color: tuple[int, int, int], prefix: str) -> np.ndarray:
    canvas = frame.copy()
    for idx, box in enumerate(boxes):
        x1, y1, x2, y2 = [int(round(v)) for v in box]
        cv2.rectangle(canvas, (x1, y1), (x2, y2), color, 2)
        cv2.putText(canvas, f"{prefix}{idx}", (x1, max(20, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
    return canvas


def save_visual(frame: np.ndarray, python_boxes: list[list[float]], cpp_boxes: list[list[float]], output_path: Path) -> None:
    left = draw_boxes(frame, python_boxes, (0, 255, 0), "py")
    right = draw_boxes(frame, cpp_boxes, (0, 0, 255), "cpp")
    side_by_side = np.hstack([left, right])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_path), side_by_side)
    print(f"saved visual to {output_path}")


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    frame = read_frame(args.video, args.frame)
    python_boxes = run_python_detector(args.python_model, frame, args.conf, args.imgsz)
    cpp_module = load_cpp_module(args.cpp_module_dir, args.onnxruntime_root)
    cpp_boxes = run_cpp_detector(
        cpp_module,
        frame,
        args.pose_onnx,
        args.cls_onnx,
        args.labels,
        args.tracker_config,
        args.conf,
        args.imgsz,
    )

    print_comparison(python_boxes, cpp_boxes)
    save_visual(frame, python_boxes, cpp_boxes, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
