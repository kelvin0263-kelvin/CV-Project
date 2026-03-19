import argparse
import os
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = PROJECT_ROOT / "backend"
DEFAULT_MODEL_PATH = BACKEND_ROOT / "yolo26n-pose.pt"
DEFAULT_EXPORT_DIR = BACKEND_ROOT / "exports"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Export an Ultralytics YOLO model to TensorRT engine or ONNX. "
            "This follows the Ultralytics export flow described in the official docs."
        )
    )
    parser.add_argument(
        "--model",
        default=str(DEFAULT_MODEL_PATH),
        help="Path to the .pt model file. Default: backend/yolo26n-pose.pt",
    )
    parser.add_argument(
        "--format",
        default="engine",
        choices=["engine", "onnx"],
        help="Export format. Use 'engine' for TensorRT or 'onnx' for ONNX.",
    )
    parser.add_argument(
        "--imgsz",
        nargs="+",
        type=int,
        default=[736],
        help="Image size. One value for square, or two values for height width.",
    )
    parser.add_argument(
        "--device",
        default=None,
        help="Export device. For TensorRT, this is usually '0'.",
    )
    parser.add_argument(
        "--batch",
        type=int,
        default=1,
        help="Static export batch size.",
    )
    parser.add_argument(
        "--half",
        action="store_true",
        help="Use FP16 export when supported.",
    )
    parser.add_argument(
        "--int8",
        action="store_true",
        help="Use INT8 export when supported. TensorRT INT8 usually needs calibration data.",
    )
    parser.add_argument(
        "--dynamic",
        action="store_true",
        help="Enable dynamic input shapes when supported.",
    )
    parser.add_argument(
        "--workspace",
        type=float,
        default=None,
        help="TensorRT workspace size in GB.",
    )
    parser.add_argument(
        "--opset",
        type=int,
        default=None,
        help="ONNX opset version.",
    )
    parser.add_argument(
        "--simplify",
        action="store_true",
        help="Simplify ONNX graph after export.",
    )
    parser.add_argument(
        "--data",
        default=None,
        help="Dataset YAML path for INT8 calibration when required.",
    )
    parser.add_argument(
        "--project",
        default=str(DEFAULT_EXPORT_DIR),
        help="Output project directory for Ultralytics export artifacts.",
    )
    parser.add_argument(
        "--name",
        default=None,
        help="Optional export run name. Defaults to '<model-stem>_<format>'.",
    )
    return parser.parse_args()


def normalize_imgsz(values: list[int]) -> int | tuple[int, int]:
    if len(values) == 1:
        return values[0]
    if len(values) == 2:
        return values[0], values[1]
    raise ValueError("--imgsz accepts either one value or two values.")


def resolve_model_path(model_arg: str) -> Path:
    model_path = Path(model_arg)
    if not model_path.is_absolute():
        model_path = (PROJECT_ROOT / model_path).resolve()
    return model_path


def main() -> int:
    args = parse_args()
    model_path = resolve_model_path(args.model)

    if not model_path.exists():
        print(f"Model not found: {model_path}", file=sys.stderr)
        return 1

    try:
        from ultralytics import YOLO
    except ImportError:
        print(
            "Ultralytics is not installed in this environment. "
            "Install backend dependencies first, then rerun this script.",
            file=sys.stderr,
        )
        return 1

    export_name = args.name or f"{model_path.stem}_{args.format}"
    export_project = Path(args.project)
    if not export_project.is_absolute():
        export_project = (PROJECT_ROOT / export_project).resolve()
    os.makedirs(export_project, exist_ok=True)

    export_kwargs = {
        "format": args.format,
        "imgsz": normalize_imgsz(args.imgsz),
        "batch": max(1, args.batch),
        "project": str(export_project),
        "name": export_name,
    }

    if args.device is not None:
        export_kwargs["device"] = args.device
    elif args.format == "engine":
        export_kwargs["device"] = 0

    if args.half:
        export_kwargs["half"] = True
    if args.int8:
        export_kwargs["int8"] = True
    if args.dynamic:
        export_kwargs["dynamic"] = True
    if args.workspace is not None:
        export_kwargs["workspace"] = args.workspace
    if args.opset is not None:
        export_kwargs["opset"] = args.opset
    if args.simplify:
        export_kwargs["simplify"] = True
    if args.data:
        export_kwargs["data"] = args.data

    print(f"Loading model: {model_path}")
    print(f"Export kwargs: {export_kwargs}")

    model = YOLO(str(model_path))
    result = model.export(**export_kwargs)
    print(f"Export complete: {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
