"""
Python bridge for the pybind11 C++ inference module.

This keeps FastAPI/DB/WebSocket code in Python while allowing inference
to move to C++ incrementally.
"""

from __future__ import annotations

import ctypes
import os
import sys
import threading
from typing import Any

_GLOBAL_CPP_RUN_LOCK = threading.Lock()


def _env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _find_cpp_module_dir(backend_root: str) -> str | None:
    configured = os.getenv("CPP_INFERENCE_MODULE_DIR", "").strip()
    candidates = []
    if configured:
        candidates.append(configured)

    candidates.extend(
        [
            os.path.join(backend_root, "cpp_inference", "build", "Release"),
            os.path.join(backend_root, "cpp_inference", "build", "RelWithDebInfo"),
            os.path.join(backend_root, "cpp_inference", "build", "Debug"),
            os.path.join(backend_root, "cpp_inference", "build"),
        ]
    )

    for candidate in candidates:
        if not candidate:
            continue
        if not os.path.isdir(candidate):
            continue
        for entry in os.listdir(candidate):
            if entry.startswith("cvui_cpp_inference") and entry.endswith(".pyd"):
                return candidate
    return None


def _find_onnxruntime_lib_dir(project_root: str) -> str | None:
    configured_root = os.getenv("CPP_ONNXRUNTIME_ROOT", "").strip() or os.getenv("ONNXRUNTIME_ROOT", "").strip()
    candidates = []
    if configured_root:
        candidates.extend(
            [
                os.path.join(configured_root, "lib"),
                os.path.join(configured_root, "lib64"),
                os.path.join(configured_root, "runtimes", "win-x64", "native"),
            ]
        )

    cmake_cache = os.path.join(project_root, "backend", "cpp_inference", "build", "CMakeCache.txt")
    if os.path.isfile(cmake_cache):
        try:
            with open(cmake_cache, "r", encoding="utf-8") as handle:
                for line in handle:
                    if line.startswith("ONNXRUNTIME_ROOT:"):
                        _, value = line.split("=", 1)
                        root = value.strip()
                        if root:
                            candidates.extend(
                                [
                                    os.path.join(root, "lib"),
                                    os.path.join(root, "lib64"),
                                    os.path.join(root, "runtimes", "win-x64", "native"),
                                ]
                            )
                        break
        except OSError:
            pass

    for candidate in candidates:
        if os.path.isfile(os.path.join(candidate, "onnxruntime.dll")):
            return candidate
    return None


def _prepare_windows_native_deps(project_root: str, backend_root: str) -> None:
    if os.name != "nt":
        return

    module_dir = _find_cpp_module_dir(backend_root)
    if module_dir:
        os.add_dll_directory(module_dir)
        if module_dir not in sys.path:
            sys.path.insert(0, module_dir)

    ort_lib_dir = _find_onnxruntime_lib_dir(project_root)
    if ort_lib_dir:
        os.add_dll_directory(ort_lib_dir)
        ort_dll = os.path.join(ort_lib_dir, "onnxruntime.dll")
        if os.path.isfile(ort_dll):
            ctypes.WinDLL(ort_dll)


def _resolve_repo_path(path_value: str, project_root: str, backend_root: str) -> str:
    if os.path.isabs(path_value):
        return path_value

    candidates = [
        os.path.normpath(os.path.join(project_root, path_value)),
        os.path.normpath(os.path.join(backend_root, path_value)),
    ]

    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate

    return candidates[0]


def _safe_int(value: Any) -> int | None:
    try:
        if value is None:
            return None
        return int(value)
    except Exception:
        return None


class CppInferenceBridge:
    """Thin adapter around `cvui_cpp_inference.InferenceCore`."""

    def __init__(
        self,
        pose_model_path: str = "yolo26m-pose.onnx",
        classifier_model_path: str = "best.onnx",
        class_names_path: str = "best.labels.txt",
        tracker_config_path: str = "backend/bytetrack_custom.yaml",
        device_id: int = 0,
        pose_imgsz: int = 1280,
        cls_imgsz: int = 224,
        det_conf: float = 0.30,
        det_iou: float = 0.50,
        cls_conf_min: float = 0.0,
        classification_interval_frames: int = 30,
    ):
        self.enabled = False
        self._module = None
        self._core = None
        self._lock = threading.Lock()
        self._classification_interval_frames = max(1, int(classification_interval_frames))
        self._serialize_globally = _env_flag("CPP_SERIALIZE_GLOBAL", default=False)

        backend_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        project_root = os.path.dirname(backend_root)

        try:
            _prepare_windows_native_deps(project_root, backend_root)
        except Exception as e:
            print(f"[CPP] Warning: failed to prepare native DLL search paths: {e}")

        pose_path = _resolve_repo_path(pose_model_path, project_root, backend_root)
        cls_path = _resolve_repo_path(classifier_model_path, project_root, backend_root)
        names_path = _resolve_repo_path(class_names_path, project_root, backend_root)
        tracker_path = _resolve_repo_path(tracker_config_path, project_root, backend_root)

        try:
            import cvui_cpp_inference as cpp_module  # type: ignore
        except Exception as e:
            print(f"[CPP] C++ module unavailable, staying on Python path: {e}")
            return

        try:
            self._module = cpp_module
            self._core = cpp_module.InferenceCore(
                pose_model_path=pose_path,
                classifier_model_path=cls_path,
                class_names_path=names_path,
                tracker_config_path=tracker_path,
                device_id=int(device_id),
                pose_imgsz=int(pose_imgsz),
                cls_imgsz=int(cls_imgsz),
                det_conf=float(det_conf),
                det_iou=float(det_iou),
                cls_conf_min=float(cls_conf_min),
            )
            self.enabled = True
            print("[CPP] C++ inference bridge initialized")
            print(f"[CPP] Pose model: {pose_path}")
            print(f"[CPP] Dress-code model: {cls_path}")
            print(f"[CPP] Class labels: {names_path}")
            print(f"[CPP] Tracker config: {tracker_path}")
            print(f"[CPP] Global native serialization: {'on' if self._serialize_globally else 'off'}")
            try:
                status = dict(self._core.health())
                print(f"[CPP] Pose execution provider: {status.get('pose_execution_provider', 'unknown')}")
                print(f"[CPP] Classifier execution provider: {status.get('classifier_execution_provider', 'unknown')}")
            except Exception:
                pass
        except Exception as e:
            print(f"[CPP] Failed to initialize C++ core, staying on Python path: {e}")

    def health(self) -> dict[str, Any]:
        if not self.enabled or self._core is None:
            return {"enabled": False}
        try:
            status = dict(self._core.health())
            status["enabled"] = True
            return status
        except Exception as e:
            return {"enabled": False, "error": str(e)}

    def run(
        self,
        image,
        frame_index: int,
        track_state: dict,
        skip_classification: bool = False,
    ) -> tuple[list[dict], int, dict]:
        """
        Run one frame through the C++ core and merge returned track-state updates.
        """
        if not self.enabled or self._core is None:
            return [], 0, track_state

        native_skip_classification = bool(skip_classification)
        if not native_skip_classification and self._classification_interval_frames > 1:
            native_skip_classification = (int(frame_index) % self._classification_interval_frames) != 0

        with self._lock:
            if self._serialize_globally:
                with _GLOBAL_CPP_RUN_LOCK:
                    result = self._core.run_frame(
                        image=image,
                        frame_index=int(frame_index),
                        skip_classification=native_skip_classification,
                    )
            else:
                result = self._core.run_frame(
                    image=image,
                    frame_index=int(frame_index),
                    skip_classification=native_skip_classification,
                )

        detections = result.get("detections", [])
        people_count = _safe_int(result.get("people_count", len(detections)))
        if people_count is None:
            people_count = len(detections)

        updates = result.get("track_state_updates", {})
        if isinstance(updates, dict):
            for key, value in updates.items():
                track_id = _safe_int(key)
                if track_id is None:
                    continue
                if track_id not in track_state:
                    track_state[track_id] = {}
                if isinstance(value, dict):
                    track_state[track_id].update(value)

        if native_skip_classification:
            for det in detections:
                track_id = _safe_int(det.get("track_id"))
                if track_id is None:
                    continue
                cached = track_state.get(track_id)
                if not isinstance(cached, dict):
                    continue
                if "label" in cached:
                    det["label"] = cached.get("label")
                    det["confidence"] = cached.get("confidence")
                    det["lower_bbox"] = cached.get("lower_bbox")

        return detections, people_count, track_state
