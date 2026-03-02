#!/usr/bin/env python3
"""
Simple Ultralytics exporter for pose + classification models.

Example:
python scripts/convert_pose_cls_to_onnx.py ^
  --pose-model backend/yolo26m-pose.pt ^
  --cls-model backend/best.pt ^
  --out-dir backend/onnx
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from ultralytics import YOLO


def write_labels_file(model: YOLO, output_path: Path) -> None:
    names = model.names or {}
    if isinstance(names, dict):
        ordered = [str(names[k]) for k in sorted(names.keys())]
    elif isinstance(names, list):
        ordered = [str(name) for name in names]
    else:
        ordered = []
    output_path.write_text("\n".join(ordered) + "\n", encoding="utf-8")


def export_to_onnx(
    model_path: Path,
    output_path: Path,
    imgsz: int,
    opset: int,
    simplify: bool,
) -> Path:
    print(f"[Export] Loading model: {model_path}")
    model = YOLO(str(model_path))

    export_result = model.export(
        format="onnx",
        imgsz=imgsz,
        dynamic=False,
        simplify=simplify,
        opset=opset,
    )

    actual_output = Path(export_result) if isinstance(export_result, str) else output_path
    actual_output = actual_output.resolve()
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if actual_output != output_path:
        shutil.move(str(actual_output), str(output_path))

    print(f"[Export] Saved ONNX: {output_path}")
    return output_path


def verify_onnx_model(onnx_path: Path, image: str | None) -> None:
    print(f"[Verify] Loading ONNX model: {onnx_path}")
    onnx_model = YOLO(str(onnx_path))
    if image:
        results = onnx_model(image)
        print(f"[Verify] Inference ok: results={len(results)} image={image}")
    else:
        print("[Verify] Load ok")


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert pose and classifier .pt models to ONNX.")
    parser.add_argument("--pose-model", required=True, help="Path to pose .pt model")
    parser.add_argument("--cls-model", required=True, help="Path to classification .pt model")
    parser.add_argument("--out-dir", default="backend/onnx", help="Directory for exported ONNX files")
    parser.add_argument("--pose-imgsz", type=int, default=1280, help="Pose export image size")
    parser.add_argument("--cls-imgsz", type=int, default=224, help="Classifier export image size")
    parser.add_argument("--opset", type=int, default=12, help="ONNX opset")
    parser.add_argument("--no-simplify", action="store_true", help="Disable ONNX simplification")
    parser.add_argument("--verify-image", help="Optional image path or URL for ONNX verification")
    parser.add_argument("--no-verify", action="store_true", help="Skip loading the exported ONNX files")
    args = parser.parse_args()

    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    pose_model_path = Path(args.pose_model).resolve()
    cls_model_path = Path(args.cls_model).resolve()

    pose_onnx_path = out_dir / f"{pose_model_path.stem}.onnx"
    cls_onnx_path = out_dir / f"{cls_model_path.stem}.onnx"
    cls_labels_path = out_dir / f"{cls_model_path.stem}.labels.txt"

    pose_onnx_path = export_to_onnx(
        model_path=pose_model_path,
        output_path=pose_onnx_path,
        imgsz=args.pose_imgsz,
        opset=args.opset,
        simplify=not args.no_simplify,
    )

    if not args.no_verify:
        verify_onnx_model(pose_onnx_path, args.verify_image)

    print(f"[Export] Loading classification model: {cls_model_path}")
    cls_model = YOLO(str(cls_model_path))
    cls_export_result = cls_model.export(
        format="onnx",
        imgsz=args.cls_imgsz,
        dynamic=False,
        simplify=not args.no_simplify,
        opset=args.opset,
    )

    actual_cls_output = Path(cls_export_result) if isinstance(cls_export_result, str) else cls_onnx_path
    actual_cls_output = actual_cls_output.resolve()
    cls_onnx_path = cls_onnx_path.resolve()
    if actual_cls_output != cls_onnx_path:
        shutil.move(str(actual_cls_output), str(cls_onnx_path))

    print(f"[Export] Saved ONNX: {cls_onnx_path}")
    write_labels_file(cls_model, cls_labels_path)
    print(f"[Export] Saved labels: {cls_labels_path}")

    if not args.no_verify:
        verify_onnx_model(cls_onnx_path, args.verify_image)

    print("\nBackend env values:")
    print("  USE_CPP_INFERENCE=true")
    print(f"  CPP_POSE_MODEL={pose_onnx_path}")
    print(f"  CPP_DRESSCODE_MODEL={cls_onnx_path}")
    print(f"  CPP_DRESSCODE_LABELS={cls_labels_path}")


if __name__ == "__main__":
    main()
