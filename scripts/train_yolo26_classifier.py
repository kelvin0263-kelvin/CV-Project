import argparse
import os
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATASET_ROOT = PROJECT_ROOT / "scripts" / "dataset_output" / "dataset"
DEFAULT_RUNS_ROOT = PROJECT_ROOT / "scripts" / "training_runs" / "classify"

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}

try:
    from ultralytics import YOLO
    from ultralytics.data.dataset import ClassificationDataset
    from ultralytics.models.yolo.classify import (
        ClassificationTrainer,
        ClassificationValidator,
    )
    import torch
    import torchvision.transforms as T
    from PIL import Image, ImageOps

    DEPENDENCIES_READY = True
except ImportError:
    YOLO = None
    ClassificationDataset = None
    ClassificationTrainer = None
    ClassificationValidator = None
    torch = None
    T = None
    Image = None
    ImageOps = None
    DEPENDENCIES_READY = False


class ResizePadSquare:
    """Resize while preserving the full image, then pad to a square canvas."""

    def __init__(self, size: int, fill: tuple[int, int, int] = (114, 114, 114)):
        self.size = size
        self.fill = fill
        self.resample = Image.Resampling.BILINEAR if hasattr(Image, "Resampling") else Image.BILINEAR

    def __call__(self, image: Image.Image) -> Image.Image:
        image = image.convert("RGB")
        width, height = image.size
        scale = self.size / max(width, height)
        new_width = max(1, int(round(width * scale)))
        new_height = max(1, int(round(height * scale)))
        resized = image.resize((new_width, new_height), self.resample)

        pad_left = (self.size - new_width) // 2
        pad_top = (self.size - new_height) // 2
        pad_right = self.size - new_width - pad_left
        pad_bottom = self.size - new_height - pad_top
        return ImageOps.expand(
            resized,
            border=(pad_left, pad_top, pad_right, pad_bottom),
            fill=self.fill,
        )


if DEPENDENCIES_READY:
    class SlipperClassificationDataset(ClassificationDataset):
        """Custom dataset that avoids crop-heavy square transforms."""

        def __init__(self, root: str, args_, augment: bool = False, prefix: str = ""):
            super().__init__(root, args_, augment, prefix)
            resize_pad = ResizePadSquare(args_.imgsz)

            train_transforms = T.Compose(
                [
                    resize_pad,
                    T.RandomHorizontalFlip(p=args_.fliplr),
                    T.ColorJitter(
                        brightness=0.12,
                        contrast=0.12,
                        saturation=0.12,
                        hue=0.02,
                    ),
                    T.ToTensor(),
                    T.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
                    T.RandomErasing(
                        p=args_.erasing,
                        scale=(0.02, 0.08),
                        ratio=(0.3, 3.3),
                        value="random",
                    ),
                ]
            )

            val_transforms = T.Compose(
                [
                    resize_pad,
                    T.ToTensor(),
                    T.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
                ]
            )

            self.torch_transforms = train_transforms if augment else val_transforms


    class SlipperTrainer(ClassificationTrainer):
        """Trainer that uses full-image resize-plus-padding for train and val."""

        def build_dataset(self, img_path: str, mode: str = "train", batch=None):
            return SlipperClassificationDataset(
                root=img_path,
                args_=self.args,
                augment=mode == "train",
                prefix=mode,
            )


    class SlipperValidator(ClassificationValidator):
        """Validator aligned with the custom training transforms."""

        def build_dataset(self, img_path: str, mode: str = "train"):
            return SlipperClassificationDataset(
                root=img_path,
                args_=self.args,
                augment=mode == "train",
                prefix=self.args.split,
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Train an Ultralytics YOLO26 classification model on the balanced "
            "slipper vs non_slipper dataset."
        )
    )
    parser.add_argument(
        "--data",
        default=str(DEFAULT_DATASET_ROOT),
        help=(
            "Path to the classification dataset root. The folder should contain "
            "train/ val/ test subfolders with one subfolder per class."
        ),
    )
    parser.add_argument(
        "--model",
        default="yolo26s-cls.pt",
        help=(
            "Model checkpoint or model name. For example: yolo26s-cls.pt. "
            "Ultralytics can auto-download official weights on first use."
        ),
    )
    parser.add_argument(
        "--epochs",
        type=int,
        default=100,
        help="Maximum training epochs. Early stopping is controlled by --patience.",
    )
    parser.add_argument(
        "--imgsz",
        type=int,
        default=224,
        help="Square input size used for padded resize transforms and training.",
    )
    parser.add_argument(
        "--batch",
        default="32",
        help=(
            "Batch size. Use an integer like 32, a float like 0.70 for auto memory "
            "fraction, or 'auto' to let Ultralytics estimate it."
        ),
    )
    parser.add_argument(
        "--device",
        default=None,
        help="Training device. Examples: 0, cpu, mps, -1. Default: auto-detect.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=4,
        help="Data loader workers. A modest default is safer on Windows.",
    )
    parser.add_argument(
        "--patience",
        type=int,
        default=15,
        help="Early stopping patience in epochs.",
    )
    parser.add_argument(
        "--project",
        default=str(DEFAULT_RUNS_ROOT),
        help="Directory where Ultralytics stores training runs.",
    )
    parser.add_argument(
        "--name",
        default="slipper_yolo26s_cls",
        help="Name of this training run inside the project directory.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for reproducible data order and training.",
    )
    parser.add_argument(
        "--dropout",
        type=float,
        default=0.20,
        help="Classification dropout. Slightly higher helps on small datasets.",
    )
    parser.add_argument(
        "--lr0",
        type=float,
        default=5e-4,
        help="Initial learning rate. Conservative default for small transfer-learning jobs.",
    )
    parser.add_argument(
        "--weight-decay",
        type=float,
        default=5e-4,
        help="Weight decay regularization.",
    )
    parser.add_argument(
        "--fliplr",
        type=float,
        default=0.5,
        help="Probability of horizontal flip augmentation.",
    )
    parser.add_argument(
        "--erasing",
        type=float,
        default=0.10,
        help="Random erasing probability. Kept mild to avoid hiding footwear cues.",
    )
    parser.add_argument(
        "--cache",
        default="disk",
        choices=["False", "ram", "disk"],
        help="Dataset cache mode. 'disk' avoids the current Ultralytics RAM-cache warning.",
    )
    parser.add_argument(
        "--exist-ok",
        action="store_true",
        help="Allow reusing an existing project/name run directory.",
    )
    parser.add_argument(
        "--run-test",
        action="store_true",
        help="Run a final evaluation on the test split after training.",
    )
    return parser.parse_args()


def resolve_path(path_arg: str) -> Path:
    path = Path(path_arg)
    if not path.is_absolute():
        path = (PROJECT_ROOT / path).resolve()
    return path


def resolve_model_reference(model_arg: str) -> str:
    model_path = Path(model_arg)
    if model_path.is_absolute():
        return str(model_path)

    local_candidate = (PROJECT_ROOT / model_path).resolve()
    if local_candidate.exists():
        return str(local_candidate)

    return model_arg


def parse_batch_arg(raw_batch: str):
    if raw_batch.lower() == "auto":
        return "auto"

    try:
        parsed = float(raw_batch)
    except ValueError as exc:
        raise ValueError(
            "--batch must be 'auto', an integer like 32, or a float like 0.70."
        ) from exc

    if parsed.is_integer():
        return int(parsed)
    return parsed


def choose_device_and_batch(device_arg: str | None, batch_arg, torch_module):
    if device_arg is None:
        device = 0 if torch_module.cuda.is_available() else "cpu"
    else:
        device = device_arg

    if batch_arg == "auto":
        batch = -1 if device != "cpu" else 16
    else:
        batch = batch_arg

    return device, batch


def list_images(folder: Path) -> list[Path]:
    if not folder.exists():
        return []
    return [
        path
        for path in folder.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    ]


def inspect_dataset(dataset_root: Path) -> dict[str, dict[str, int]]:
    summary: dict[str, dict[str, int]] = {}

    for split in ("train", "val", "test"):
        split_dir = dataset_root / split
        if not split_dir.exists():
            continue

        class_counts: dict[str, int] = {}
        for class_dir in sorted([p for p in split_dir.iterdir() if p.is_dir()]):
            class_counts[class_dir.name] = len(list_images(class_dir))
        summary[split] = class_counts

    return summary


def validate_dataset(dataset_root: Path) -> dict[str, dict[str, int]]:
    if not dataset_root.exists():
        raise FileNotFoundError(f"Dataset root not found: {dataset_root}")

    summary = inspect_dataset(dataset_root)
    required_splits = {"train", "val"}
    missing_splits = sorted(required_splits - set(summary))
    if missing_splits:
        raise FileNotFoundError(
            f"Dataset is missing required split folders: {', '.join(missing_splits)}"
        )

    train_classes = set(summary["train"])
    val_classes = set(summary["val"])
    if not train_classes or len(train_classes) < 2:
        raise ValueError(
            "Training split must contain at least two class folders."
        )
    if train_classes != val_classes:
        raise ValueError(
            "Train and val class folders do not match. "
            f"train={sorted(train_classes)}, val={sorted(val_classes)}"
        )

    for split, class_counts in summary.items():
        for class_name, count in class_counts.items():
            if count == 0:
                raise ValueError(
                    f"Split '{split}' has an empty class folder: {class_name}"
                )

    return summary


def format_summary(summary: dict[str, dict[str, int]]) -> str:
    lines = []
    for split in ("train", "val", "test"):
        if split not in summary:
            continue
        counts = summary[split]
        total = sum(counts.values())
        pieces = ", ".join(f"{name}={count}" for name, count in sorted(counts.items()))
        lines.append(f"  {split}: total={total} ({pieces})")
    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    dataset_root = resolve_path(args.data)
    project_root = resolve_path(args.project)
    model_reference = resolve_model_reference(args.model)

    if not DEPENDENCIES_READY:
        print(
            "Ultralytics is not installed in this environment. "
            "Install torch, torchvision, and ultralytics first.",
            file=sys.stderr,
        )
        return 1

    try:
        summary = validate_dataset(dataset_root)
    except (FileNotFoundError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    batch_arg = parse_batch_arg(args.batch)
    device, batch = choose_device_and_batch(args.device, batch_arg, torch)

    cache_value: bool | str
    if args.cache == "False":
        cache_value = False
    else:
        cache_value = args.cache

    os.makedirs(project_root, exist_ok=True)

    train_kwargs = {
        "data": str(dataset_root),
        "epochs": max(1, args.epochs),
        "imgsz": max(32, args.imgsz),
        "batch": batch,
        "device": device,
        "workers": max(0, args.workers),
        "project": str(project_root),
        "name": args.name,
        "exist_ok": args.exist_ok,
        "patience": max(1, args.patience),
        "optimizer": "AdamW",
        "lr0": args.lr0,
        "cos_lr": True,
        "dropout": max(0.0, min(0.9, args.dropout)),
        "weight_decay": args.weight_decay,
        "seed": args.seed,
        "deterministic": True,
        "cache": cache_value,
        "amp": True,
        "pretrained": True,
        "fliplr": max(0.0, min(1.0, args.fliplr)),
        "flipud": 0.0,
        "erasing": max(0.0, min(1.0, args.erasing)),
        "verbose": True,
        "plots": True,
    }

    print(f"Dataset root: {dataset_root}")
    print("Dataset summary:")
    print(format_summary(summary))
    print(f"Model reference: {model_reference}")
    print(f"Training device: {device}")
    print(f"Batch setting: {batch}")
    print(f"Training outputs: {project_root / args.name}")
    print("Training arguments:")
    for key, value in train_kwargs.items():
        print(f"  {key}: {value}")

    model = YOLO(model_reference)
    results = model.train(trainer=SlipperTrainer, **train_kwargs)

    best_path = project_root / args.name / "weights" / "best.pt"
    print(f"Training complete. Best weights expected at: {best_path}")

    if args.run_test:
        if not (dataset_root / "test").exists():
            print("Skipping test evaluation because the dataset has no test split.")
            return 0

        if not best_path.exists():
            print(
                "Skipping test evaluation because best.pt was not found at the expected location.",
                file=sys.stderr,
            )
            return 1

        print("Running final evaluation on the test split...")
        best_model = YOLO(str(best_path))
        metrics = best_model.val(
            data=str(dataset_root),
            imgsz=max(32, args.imgsz),
            batch=batch if isinstance(batch, int) and batch > 0 else 16,
            device=device,
            split="test",
            validator=SlipperValidator,
        )
        top1 = getattr(metrics, "top1", None)
        top5 = getattr(metrics, "top5", None)
        print(f"Test metrics: top1={top1}, top5={top5}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
