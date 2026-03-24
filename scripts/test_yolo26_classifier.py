import __main__
import argparse
import csv
import json
import sys
from collections import Counter
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_ROOT = PROJECT_ROOT / "scripts" / "dataset_output" / "dataset" / "test"
DEFAULT_OUTPUT_ROOT = PROJECT_ROOT / "scripts" / "prediction_runs" / "classify"
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run inference with a trained YOLO26 classification checkpoint on a folder "
            "of images and save the predictions to a chosen output directory."
        )
    )
    parser.add_argument(
        "--model",
        required=True,
        help="Path to the trained .pt checkpoint, for example best.pt.",
    )
    parser.add_argument(
        "--source",
        default=str(DEFAULT_SOURCE_ROOT),
        help="Image file or folder to classify. Recursive for folders.",
    )
    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUTPUT_ROOT / "test_predictions"),
        help="Output directory for annotated images, CSV, and summary.",
    )
    parser.add_argument(
        "--imgsz",
        type=int,
        default=224,
        help="Inference image size.",
    )
    parser.add_argument(
        "--device",
        default=None,
        help="Inference device. Examples: 0, cpu, mps. Default: auto.",
    )
    parser.add_argument(
        "--batch",
        type=int,
        default=32,
        help="Batch size for folder inference.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=0,
        help="Reserved for compatibility. Kept at 0 for Windows-safe runs.",
    )
    return parser.parse_args()


def resolve_path(path_arg: str) -> Path:
    path = Path(path_arg)
    if not path.is_absolute():
        path = (PROJECT_ROOT / path).resolve()
    return path


def find_images(source: Path) -> list[Path]:
    if source.is_file():
        return [source] if source.suffix.lower() in IMAGE_EXTENSIONS else []

    return sorted(
        path
        for path in source.rglob("*")
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    )


def ensure_custom_checkpoint_classes_loaded():
    sys.path.insert(0, str(PROJECT_ROOT))
    import scripts.train_yolo26_classifier as train_mod

    __main__.ResizePadSquare = train_mod.ResizePadSquare
    if getattr(train_mod, "SlipperClassificationDataset", None) is not None:
        __main__.SlipperClassificationDataset = train_mod.SlipperClassificationDataset
    if getattr(train_mod, "SlipperTrainer", None) is not None:
        __main__.SlipperTrainer = train_mod.SlipperTrainer
    if getattr(train_mod, "SlipperValidator", None) is not None:
        __main__.SlipperValidator = train_mod.SlipperValidator

    return train_mod


def chunked(items: list[Path], size: int):
    for index in range(0, len(items), size):
        yield items[index:index + size]


def safe_relative_path(path: Path, root: Path) -> Path:
    try:
        return path.relative_to(root)
    except ValueError:
        return Path(path.name)


def build_output_image_path(output_root: Path, index: int, image_path: Path, class_name: str, confidence: float) -> Path:
    safe_class = class_name.replace(" ", "_")
    safe_conf = f"{confidence:.3f}".replace(".", "_")
    dest = output_root / f"{index:05d}_{safe_class}_{safe_conf}_{image_path.name}"

    if not dest.exists():
        return dest

    stem = dest.stem
    suffix = dest.suffix
    counter = 1
    while True:
        candidate = dest.with_name(f"{stem}_{counter}{suffix}")
        if not candidate.exists():
            return candidate
        counter += 1


def infer_expected_label(image_path: Path, source_root: Path, class_names: set[str]) -> str | None:
    relative_parts = safe_relative_path(image_path, source_root).parts
    if not relative_parts:
        return None

    first_part = relative_parts[0]
    return first_part if first_part in class_names else None


def annotate_and_save_image(image_path: Path, dest_path: Path, label_text: str) -> None:
    from PIL import Image, ImageDraw, ImageFont

    image = Image.open(image_path).convert("RGB")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default()

    left = 10
    top = 10
    padding_x = 8
    padding_y = 6

    bbox = draw.textbbox((left, top), label_text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    rect = (
        left - padding_x,
        top - padding_y,
        left + text_w + padding_x,
        top + text_h + padding_y,
    )

    draw.rounded_rectangle(rect, radius=8, fill=(0, 0, 0))
    draw.text((left, top), label_text, fill=(255, 255, 255), font=font)
    image.save(dest_path)


def main() -> int:
    args = parse_args()
    model_path = resolve_path(args.model)
    source_path = resolve_path(args.source)
    output_root = resolve_path(args.output)

    if not model_path.exists():
        print(f"Model not found: {model_path}", file=sys.stderr)
        return 1
    if not source_path.exists():
        print(f"Source path not found: {source_path}", file=sys.stderr)
        return 1

    image_paths = find_images(source_path)
    if not image_paths:
        print(f"No supported images found under: {source_path}", file=sys.stderr)
        return 1

    ensure_custom_checkpoint_classes_loaded()

    try:
        from ultralytics import YOLO
        import torch
    except ImportError:
        print(
            "Ultralytics or torch is not installed in this environment.",
            file=sys.stderr,
        )
        return 1

    device = args.device if args.device is not None else (0 if torch.cuda.is_available() else "cpu")
    output_root.mkdir(parents=True, exist_ok=True)

    print(f"Model: {model_path}")
    print(f"Source: {source_path}")
    print(f"Images found: {len(image_paths)}")
    print(f"Output: {output_root}")
    print(f"Device: {device}")

    model = YOLO(str(model_path))
    class_names_map = model.names
    class_names = [class_names_map[i] for i in sorted(class_names_map)]
    class_name_set = set(class_names)

    csv_path = output_root / "predictions.csv"
    summary_path = output_root / "summary.json"
    counts = Counter()
    correct = 0
    labeled = 0
    rows = []
    annotated_count = 0

    for batch_paths in chunked(image_paths, max(1, args.batch)):
        results = model.predict(
            source=[str(path) for path in batch_paths],
            imgsz=args.imgsz,
            device=device,
            batch=min(args.batch, len(batch_paths)),
            verbose=False,
        )

        for result in results:
            image_path = Path(result.path).resolve()
            probs = result.probs
            top1_index = int(probs.top1)
            predicted_class = class_names_map[top1_index]
            confidence = float(probs.top1conf)
            counts[predicted_class] += 1
            annotated_count += 1

            expected_label = infer_expected_label(image_path, source_path, class_name_set)
            is_correct = None
            if expected_label is not None:
                labeled += 1
                is_correct = expected_label == predicted_class
                if is_correct:
                    correct += 1

            dest_path = build_output_image_path(
                output_root=output_root,
                index=annotated_count,
                image_path=image_path,
                class_name=predicted_class,
                confidence=confidence,
            )
            annotate_and_save_image(
                image_path=image_path,
                dest_path=dest_path,
                label_text=f"{predicted_class} {confidence:.3f}",
            )

            row = {
                "source_path": str(image_path),
                "predicted_class": predicted_class,
                "confidence": round(confidence, 6),
                "expected_label": expected_label or "",
                "is_correct": "" if is_correct is None else str(is_correct),
                "output_image": str(dest_path),
            }

            prob_values = probs.data.tolist()
            for index, class_name in enumerate(class_names):
                row[f"prob_{class_name}"] = round(float(prob_values[index]), 6)

            rows.append(row)

    fieldnames = [
        "source_path",
        "predicted_class",
        "confidence",
        "expected_label",
        "is_correct",
        "output_image",
        *[f"prob_{class_name}" for class_name in class_names],
    ]

    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    summary = {
        "model": str(model_path),
        "source": str(source_path),
        "output": str(output_root),
        "images_found": len(image_paths),
        "annotated_images_written": annotated_count,
        "class_counts": dict(sorted(counts.items())),
        "labeled_images_detected": labeled,
        "accuracy_if_labeled": (correct / labeled) if labeled else None,
        "csv": str(csv_path),
    }

    with summary_path.open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)

    print("Prediction complete.")
    print(f"CSV: {csv_path}")
    print(f"Summary: {summary_path}")
    if labeled:
        print(f"Labeled accuracy over detected class-folder structure: {correct}/{labeled} = {correct / labeled:.4f}")
    print("Prediction counts:")
    for class_name, count in sorted(counts.items()):
        print(f"  {class_name}: {count}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
