# C++ Inference Core (pybind11 + ONNX Runtime)

This folder contains the C++ inference backend used by `backend/app/services/cpp_bridge.py`.

Current implementation:
- Pose inference from ONNX (`yolo*-pose.onnx`) with ONNX Runtime.
- NMS + bbox/keypoint decode.
- IoU tracker for stable `track_id`.
- Lower-body crop parity with Python rules.
- Dress-code classification from ONNX Runtime + labels file.

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
- OpenCV dev libs (`core`, `imgproc`)
- ONNX Runtime C++ dev package
- Python dev headers
- pybind11

Build:

```bash
python3 -m pip install pybind11
cmake -S backend/cpp_inference -B backend/cpp_inference/build
cmake --build backend/cpp_inference/build -j
```

Windows (vcpkg example):

```powershell
vcpkg install opencv:x64-windows onnxruntime:x64-windows pybind11:x64-windows
cmake -S backend/cpp_inference -B backend/cpp_inference/build `
  -A x64 `
  -DCMAKE_TOOLCHAIN_FILE="$env:USERPROFILE\vcpkg\scripts\buildsystems\vcpkg.cmake"
cmake --build backend/cpp_inference/build --config Release
```

The module name is `cvui_cpp_inference`.
Point `PYTHONPATH` at the build output if needed.

## 3) Run backend with C++ inference
```bash
export USE_CPP_INFERENCE=true
export CPP_ONNXRUNTIME_ROOT=D:/tools/onnxruntime-win-x64-gpu-1.18.0
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

On Windows, set `CPP_ONNXRUNTIME_ROOT` to the unpacked ONNX Runtime package root so
the Python bridge can preload the intended `onnxruntime.dll` before importing the
`cvui_cpp_inference` module.

Keep `USE_CPP_INFERENCE` unset/false to use the original Python Ultralytics path.

## Notes
- FastAPI routers, DB models, and WebSocket schema are unchanged.
- Python path remains fallback if C++ module/model load fails.
- Tracker in C++ is IoU-based for now; if you want ByteTrack parity next, extend `src/inference_core.cpp`.
