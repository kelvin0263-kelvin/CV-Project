# C++ Inference Migration Blueprint

## Goal
Move the **inference-heavy path** from Python to C++ while keeping the current FastAPI/DB/WebSocket APIs stable for the frontend.

This blueprint is tailored to the current backend code:
- `backend/app/services/video_processor.py`
- `backend/app/services/dresscode_detector.py`
- `backend/DefishVideoCV.py`
- `backend/app/services/people_counter.py`
- `backend/app/routers/camera_router.py`

## Current Pipeline (Source of Truth)
For each source stream:
1. Decode frame via OpenCV in Python (`video_processor.py`).
2. Optional fisheye dewarp (`DefishVideoCV.py`).
3. Pose + tracking via Ultralytics `YOLO(...).track(...)` using `backend/bytetrack_custom.yaml`.
4. Lower-body crop + dress-code classification (`dresscode_detector.py`).
5. Policy evaluation + snapshot write + violation queue.
6. People counting state machine (`people_counter.py`).
7. Encode JPEG + publish to `FRAME_BUFFERS` for WebSocket (`camera_router.py`).

## Recommended Migration Strategy
Use a **hybrid migration** first:
- Keep FastAPI routers, DB models, and WebSocket endpoint in Python.
- Replace only inference core with C++.
- Integrate C++ through a Python extension (`pybind11`) or a local service (gRPC/ZeroMQ).

Why: lowest rollout risk and zero frontend contract changes.

## Target Contracts (Must Stay Compatible)
### Detection entry schema (per person)
```json
{
  "track_id": 123,
  "person_bbox": [x1, y1, x2, y2],
  "label": "shorts",
  "confidence": 0.91,
  "lower_bbox": [x1, y1, x2, y2],
  "violation": false
}
```

### WebSocket payload (`/ws/{camera_id}`)
```json
{
  "image": "<base64-jpeg>",
  "fps": 24.8,
  "people_count": 5,
  "detections": [ ... ],
  "counting_data": { ... }
}
```

## Phase Plan
### Phase 0: Baseline and Freeze
Deliverables:
- Freeze model files currently used in production:
  - `backend/yolo26m-pose.pt`
  - `backend/best.pt`
- Capture baseline metrics on representative clips:
  - FPS per stream
  - detection count/frame
  - ID switch count (tracking)
  - dress-code confusion matrix
  - people counting deltas vs hand-labeled truth

Exit criteria:
- Baseline report saved and reproducible.

### Phase 1: Model Export + Parity Harness
Deliverables:
- Export models from `.pt` to:
  - ONNX (`pose.onnx`, `dresscode.onnx`)
  - Optional TensorRT engines for NVIDIA deployments.
- Add an offline parity harness that runs Python vs C++ candidate and compares:
  - bbox IoU
  - keypoint distance
  - class/confidence deltas
  - track consistency over time

Exit criteria:
- Per-frame detection parity within agreed tolerance.

### Phase 2: C++ Inference Core
Create `backend/cpp_inference/` with:
- `src/pose_detector.*` (ONNX Runtime or TensorRT)
- `src/classifier.*` (dress-code classifier)
- `src/tracker.*` (ByteTrack C++ implementation)
- `src/fisheye_processor.*` (port of `DefishVideoCV.py` map/remap path)
- `src/frame_encoder.*` (TurboJPEG/OpenCV encode)
- `src/pipeline.*` (orchestrates per-frame processing)

Mandatory behavior parity:
- Person-only filtering
- Same confidence/IoU thresholds as `video_processor.py`
- Same lower-body crop rules as `dresscode_detector.py`
- Same output coordinate space expected by Python scaling logic

Exit criteria:
- C++ core can process one stream end-to-end and emit JSON-serializable detection metadata.

### Phase 3: Python Integration (No API Break)
Option A (recommended first): `pybind11` extension
- Add `backend/app/services/cpp_bridge.py`.
- In `video_processor.py`, replace `run_detection_and_classify(...)` internals with C++ call.
- Keep policy, violation persistence, and people counting in Python initially.

Option B: local C++ sidecar service
- Python sends frames to service and receives detections/counting payloads.
- More isolation, but more moving parts.

Exit criteria:
- Existing `camera_router.py` WebSocket payload unchanged.
- Frontend works without modification.

### Phase 4: Move Counting Logic to C++ (Optional)
Port `people_counter.py` if needed for CPU savings.
- Keep JSON schema identical for `counting_data`.
- Validate edge cases: 2-zone disappear inference and door-buffer merge logic.

Exit criteria:
- Counting parity on challenging clips (occlusion, disappear/reappear near door).

### Phase 5: Production Hardening
Deliverables:
- Structured logs and health probes for inference runtime.
- Crash isolation per stream.
- Backpressure handling when streams exceed real-time.
- CI job running parity regression on fixed sample clips.

Exit criteria:
- Stable soak test (multi-hour, multi-stream) with no memory leak/drift.

## File-Level Change Map
Python changes:
- `backend/app/services/video_processor.py`
  - Replace Python Ultralytics calls with C++ bridge/service calls.
  - Keep output metadata shape unchanged.
- `backend/app/services/dresscode_detector.py`
  - Becomes fallback path or removed after full cutover.
- `backend/requirements.txt`
  - Potentially remove `ultralytics` once fully migrated.

New files:
- `backend/cpp_inference/CMakeLists.txt`
- `backend/cpp_inference/include/...`
- `backend/cpp_inference/src/...`
- `backend/app/services/cpp_bridge.py` (if using `pybind11`)

## Technical Decisions You Should Lock Early
1. Runtime backend:
   - ONNX Runtime (portable/easier) vs TensorRT (best NVIDIA performance).
2. Integration mode:
   - `pybind11` in-process (lower latency) vs sidecar service (better fault isolation).
3. Tracking:
   - ByteTrack C++ parity (recommended to match current `bytetrack_custom.yaml` intent).
4. GPU responsibility split:
   - Keep all pre/post in C++ to avoid Python<->C++ copies.

## Known Risks and Mitigations
1. Tracking mismatch after migration.
   - Mitigation: offline sequence parity tests and track-level metrics before rollout.
2. Crop/classification drift.
   - Mitigation: exact port of hip-keypoint crop rules from `dresscode_detector.py`.
3. Latency regression from IPC/frame copies.
   - Mitigation: prefer in-process binding first; if sidecar, use shared-memory transport.
4. Fisheye behavior drift.
   - Mitigation: reuse same remap generation math and test with saved frames.

## First Implementation Sprint (Suggested 1-2 Weeks)
1. Export both models and commit reproducible export script.
2. Build minimal C++ binary:
   - input: image frame
   - output: person boxes + keypoints + tracks
3. Add Python adapter in `video_processor.py` behind feature flag:
   - `USE_CPP_INFERENCE=true`
4. Run A/B test on same clips and log parity/performance deltas.

## Cutover Rule
Switch default to C++ only after:
- No frontend/API contract changes needed.
- Parity thresholds pass on your validation clips.
- Throughput target met at expected camera count.
