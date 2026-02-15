# C++ Inference Core (pybind11 + OpenCV DNN)

This folder contains the C++ inference backend used by `backend/app/services/cpp_bridge.py`.

Current implementation:
- Pose inference from ONNX (`yolo*-pose.onnx`) with OpenCV DNN.
- NMS + bbox/keypoint decode.
- IoU tracker for stable `track_id`.
- Lower-body crop parity with Python rules.
- Dress-code classification from ONNX + labels file.

## 1) Export `.pt` models to `.onnx`
From repo root:

```bash
python3 -m pip install ultralytics onnx onnxsim
python3 scripts/export_models_to_onnx.py \
  --pose-pt backend/yolo26m-pose.pt \
  --cls-pt backend/best.pt \
  --out-dir backend/onnx
```

This creates:
- `backend/onnx/<pose-stem>.onnx`
- `backend/onnx/<cls-stem>.onnx`
- `backend/onnx/<cls-stem>.labels.txt`

## 2) Build pybind11 extension
Required system deps:
- C++17 compiler
- CMake
- OpenCV dev libs (`core`, `imgproc`, `dnn`)
- Python dev headers
- pybind11

Build:

```bash
python3 -m pip install pybind11
cmake -S backend/cpp_inference -B backend/cpp_inference/build
cmake --build backend/cpp_inference/build -j
```

The module name is `cvui_cpp_inference`.
Point `PYTHONPATH` at the build output if needed.

## 3) Run backend with C++ inference
```bash
export USE_CPP_INFERENCE=true
export CPP_POSE_MODEL=backend/onnx/yolo26m-pose.onnx
export CPP_DRESSCODE_MODEL=backend/onnx/best.onnx
export CPP_DRESSCODE_LABELS=backend/onnx/best.labels.txt
export CPP_TRACKER_CONFIG=backend/bytetrack_custom.yaml
export CPP_DEVICE_ID=0
export CPP_POSE_IMGSZ=1280
export CPP_CLS_IMGSZ=224
export CPP_DET_CONF=0.30
export CPP_DET_IOU=0.50
export CPP_CLS_MIN_CONF=0.0
```

Keep `USE_CPP_INFERENCE` unset/false to use the original Python Ultralytics path.

## Notes
- FastAPI routers, DB models, and WebSocket schema are unchanged.
- Python path remains fallback if C++ module/model load fails.
- Tracker in C++ is IoU-based for now; if you want ByteTrack parity next, extend `src/inference_core.cpp`.
