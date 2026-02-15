#!/usr/bin/env python3
"""
Export Ultralytics .pt models to ONNX for C++ inference.

Example:
python3 scripts/export_models_to_onnx.py \
  --pose-pt backend/yolo26m-pose.pt \
  --cls-pt backend/best.pt \
  --out-dir backend/onnx
"""

from __future__ import annotations

import argparse
from pathlib import Path

from ultralytics import YOLO


def _resolve_export_path(result, fallback_path: Path) -> Path:
    if isinstance(result, str) and result:
        return Path(result).resolve()
    return fallback_path.resolve()


def _write_labels_file(model: YOLO, output_path: Path) -> None:
    names = model.names or {}
    if isinstance(names, dict):
        ordered = [names[k] for k in sorted(names.keys())]
    elif isinstance(names, list):
        ordered = names
    else:
        ordered = []
    output_path.write_text("\n".join(str(v) for v in ordered) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Export pose/classification .pt models to ONNX.")
    parser.add_argument("--pose-pt", required=True, help="Path to pose .pt model")
    parser.add_argument("--cls-pt", required=True, help="Path to classification .pt model")
    parser.add_argument("--out-dir", default="backend/onnx", help="Output directory for ONNX files")
    parser.add_argument("--pose-imgsz", type=int, default=1280, help="Pose export image size")
    parser.add_argument("--cls-imgsz", type=int, default=224, help="Classifier export image size")
    parser.add_argument("--opset", type=int, default=12, help="ONNX opset version")
    parser.add_argument("--no-simplify", action="store_true", help="Disable ONNX simplification")
    args = parser.parse_args()

    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    pose_pt = Path(args.pose_pt).resolve()
    cls_pt = Path(args.cls_pt).resolve()
    pose_onnx = out_dir / f"{pose_pt.stem}.onnx"
    cls_onnx = out_dir / f"{cls_pt.stem}.onnx"
    labels_txt = out_dir / f"{cls_pt.stem}.labels.txt"

    print(f"[Export] Loading pose model: {pose_pt}")
    pose_model = YOLO(str(pose_pt))
    pose_export = pose_model.export(
        format="onnx",
        imgsz=args.pose_imgsz,
        dynamic=False,
        simplify=not args.no_simplify,
        opset=args.opset,
    )
    pose_actual = _resolve_export_path(pose_export, pose_onnx)
    print(f"[Export] Pose ONNX: {pose_actual}")

    print(f"[Export] Loading classifier model: {cls_pt}")
    cls_model = YOLO(str(cls_pt))
    cls_export = cls_model.export(
        format="onnx",
        imgsz=args.cls_imgsz,
        dynamic=False,
        simplify=not args.no_simplify,
        opset=args.opset,
    )
    cls_actual = _resolve_export_path(cls_export, cls_onnx)
    print(f"[Export] Classifier ONNX: {cls_actual}")

    _write_labels_file(cls_model, labels_txt)
    print(f"[Export] Labels: {labels_txt}")

    print("\nSet these env vars before running backend:")
    print(f"  export USE_CPP_INFERENCE=true")
    print(f"  export CPP_POSE_MODEL={pose_actual}")
    print(f"  export CPP_DRESSCODE_MODEL={cls_actual}")
    print(f"  export CPP_DRESSCODE_LABELS={labels_txt}")


if __name__ == "__main__":
    main()

