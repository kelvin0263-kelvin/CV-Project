"""
Python bridge for the pybind11 C++ inference module.

This keeps FastAPI/DB/WebSocket code in Python while allowing inference
to move to C++ incrementally.
"""

from __future__ import annotations

import os
import threading
from typing import Any


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
    ):
        self.enabled = False
        self._module = None
        self._core = None
        self._lock = threading.Lock()

        backend_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        project_root = os.path.dirname(backend_root)

        pose_path = pose_model_path
        cls_path = classifier_model_path
        names_path = class_names_path
        tracker_path = tracker_config_path

        if not os.path.isabs(pose_path):
            pose_path = os.path.join(backend_root, pose_path)
        if not os.path.isabs(cls_path):
            cls_path = os.path.join(backend_root, cls_path)
        if not os.path.isabs(names_path):
            names_path = os.path.join(backend_root, names_path)
        if not os.path.isabs(tracker_path):
            tracker_path = os.path.join(project_root, tracker_path)

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

        with self._lock:
            result = self._core.run_frame(
                image=image,
                frame_index=int(frame_index),
                skip_classification=bool(skip_classification),
            )

        detections = result.get("detections", [])
        people_count = int(result.get("people_count", len(detections)))

        updates = result.get("track_state_updates", {})
        if isinstance(updates, dict):
            for key, value in updates.items():
                try:
                    track_id = int(key)
                except Exception:
                    continue
                if track_id not in track_state:
                    track_state[track_id] = {}
                if isinstance(value, dict):
                    track_state[track_id].update(value)

        return detections, people_count, track_state
