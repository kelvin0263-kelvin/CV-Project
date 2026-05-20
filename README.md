# Entrance-Analysis-System

Entrance-Analysis-System is a full-stack computer-vision monitoring dashboard for camera streams and uploaded videos. It combines a FastAPI backend, a Vite/React frontend, PostgreSQL persistence, WebSocket video streaming, and YOLO-based analysis for people counting, building occupancy, dress-code violations, and fall detection.

## Demo Video

[Watch Demo Video](https://drive.google.com/file/d/1gc7Vm0vKuzpe4zXajgKKWc-f1Y-wRE3h/view?usp=sharing)
## Features

- Authenticated monitoring dashboard with admin and staff users
- Live camera and uploaded-video sources with WebSocket frame delivery
- RTSP and network stream support
- Fisheye video splitting into selectable defished views
- Detection ROI configuration per source
- People counting rules with line-based in/out counts
- Cross-camera verification for primary and verifier camera pairs
- Building-level occupancy rollups, capacity limits, alerts, and history
- Dress-code policy management for pants and footwear classifiers
- Fall-detection configuration with sensitivity and inactivity timers
- Reporting views backed by persisted detection and counting snapshots
- Local video upload management, preview, synchronized starts, start/stop, and deletion
- Alembic-managed database migrations
- Windows deployment script with bundled Nginx reverse proxy
- Training and export helper scripts for classifier and pose-model workflows

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, Vite 7, React Router, Tailwind CSS, Recharts, lucide-react |
| Backend | FastAPI, Uvicorn, SQLAlchemy async, Alembic, Pydantic |
| Database | PostgreSQL via asyncpg; Supabase-compatible connection settings |
| Vision | Ultralytics YOLO, OpenCV, PyTurboJPEG, TensorRT optional |
| Streaming | WebSocket endpoints and Nginx proxying |
| Tooling | npm, Python venv, FFmpeg, Streamlit utility UI |

## Repository Structure

```text
.
+-- backend/
|   +-- main.py                    # FastAPI application entry point
|   +-- requirements.txt           # Python dependencies
|   +-- alembic/                   # Database migrations
|   +-- app/
|   |   +-- core/                  # Settings, database, video capture helpers
|   |   +-- models/                # SQLAlchemy models
|   |   +-- routers/               # API and WebSocket routes
|   |   +-- schemas/               # Pydantic schemas
|   |   +-- services/              # Auth, video processing, counting, detection
|   +-- best.pt                    # Dress-code classifier checkpoint
|   +-- slipper-cls-best.pt        # Slipper classifier checkpoint
|   +-- botsort_custom.yaml        # Tracker config
|   +-- bytetrack_custom.yaml      # Alternate tracker config
+-- frontend/
|   +-- src/                       # React app source
|   +-- package.json               # Frontend scripts and dependencies
|   +-- vite.config.js             # Vite proxy for /api and /ws
+-- scripts/                       # Dataset, training, testing, and export tools
+-- nginx-1.30.0/                  # Windows Nginx runtime and config
+-- start_deployment.ps1           # Windows build/start automation
+-- start_deployment.bat           # Convenience launcher
+-- stop_deployment.bat            # Stop Nginx and backend
```

## Prerequisites

Install these before running the project locally:

- Windows is the primary deployment target for the included scripts.
- Python 3.10+ with `venv`
- Node.js and npm
- PostgreSQL 16.x, or a PostgreSQL-compatible hosted database
- FFmpeg available on `PATH`
- Git
- Optional but recommended: NVIDIA GPU, CUDA-compatible PyTorch, TensorRT, and model `.engine` files for faster inference
- For the Windows deployment script: a PostgreSQL service named `postgresql-x64-16`, or adjust `$postgresServiceName` in `start_deployment.ps1`

Large runtime artifacts are intentionally ignored by Git. If you use TensorRT or alternate pose models, place them under `backend/` or configure paths with environment variables.

## Backend Configuration

Create `backend/.env`:

```env
DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/postgres
SECRET_KEY=change-this-in-production
JWT_ALGORITHM=HS256
JWT_EXPIRE_MINUTES=60

# Optional Supabase settings
SUPABASE_URL=
SUPABASE_KEY=
SUPABASE_SERVICE_KEY=

# Optional model overrides, relative to backend/ or absolute paths
POSE_MODEL_PATH=
DRESSCODE_MODEL_PATH=
SLIPPER_MODEL_PATH=

# Optional runtime tuning
DRESSCODE_MODEL_IMGSZ=160
SLIPPER_MODEL_IMGSZ=224
WS_MAX_FPS=30
UVICORN_RELOAD=false
```

If `POSE_MODEL_PATH` is not set, the backend prefers `backend/yolov8m-pose.engine` when present and falls back to `backend/yolov8m-pose.pt`. Dress-code models prefer matching `.engine` files when present and fall back to `best.pt` and `slipper-cls-best.pt`.

## Frontend Configuration

The frontend automatically uses the current browser origin in production. For a separate dev backend, create `frontend/.env`:

```env
VITE_API_URL=http://localhost:8000
VITE_WS_URL=http://localhost:8000
VITE_STREAM_AUTO_RECONNECT_MINUTES=30
```

The Vite dev server also proxies `/api` and `/ws` to `http://127.0.0.1:8000`.

## Local Development

### 1. Install backend dependencies

```powershell
cd backend
python -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```

For GPU inference, install the PyTorch build that matches your CUDA runtime before or after `requirements.txt`. The deployment script installs PyTorch CUDA 12.1 packages by default.

### 2. Run database migrations

```powershell
cd backend
.\venv\Scripts\Activate.ps1
alembic upgrade head
```

### 3. Start the backend

```powershell
cd backend
.\venv\Scripts\Activate.ps1
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Health check:

```powershell
Invoke-WebRequest http://localhost:8000/api/health
```

### 4. Start the frontend

```powershell
cd frontend
npm install
npm run dev
```

Open the Vite URL shown in the terminal, usually `http://localhost:5173`.

### 5. Sign in

The backend creates or falls back to a default admin account:

```text
Username: admin
Email: admin@gmail.com
Password: admin
```

Change this for any real deployment.

## Windows Deployment

The repository includes a Windows startup flow that installs dependencies when needed, runs migrations, builds the frontend, validates Nginx, starts the backend on port `8000`, starts or reloads Nginx on port `80`, and opens the browser.

```powershell
.\start_deployment.ps1
```

Or:

```cmd
start_deployment.bat
```

Stop services started by the deployment script:

```cmd
stop_deployment.bat
```

The deployed frontend is served at:

```text
http://localhost/
```

The backend remains available behind Nginx through `/api` and `/ws`.

## API Overview

Most API routes require a bearer token from `/api/auth/login`.

| Area | Routes |
| --- | --- |
| Health/Auth | `GET /api/health`, `POST /api/auth/login`, `GET/PUT /api/users/me` |
| User Admin | `GET/POST /api/users`, `PUT/DELETE /api/users/{user_id}` |
| Cameras | `GET/POST /api/cameras`, `PUT/DELETE /api/cameras/{camera_id}` |
| Streams | `POST /api/cameras/stream-source`, `POST /api/cameras/rtsp-source`, stream test and preview routes |
| WebSocket | `WS /ws/{camera_id}` |
| Uploads | `/api/upload-videos`, `/api/upload_and_process`, upload preview/start/stop/delete routes |
| Dress Code | `GET/PUT /api/dresscode-policy` |
| Detection Events | `GET /api/detection-events`, `GET /api/snapshots/{event_id}` |
| People Counting | `/api/people-counting-config/{camera_id}`, `/api/people-counting-history`, `/api/people-counting-summary` |
| Building Occupancy | `/api/building-counting-config`, `/api/building-counting-history`, `/api/building-occupancy-summary` |
| Fall Detection | `GET/PUT /api/fall-detection-config/{camera_id}` |

FastAPI also exposes interactive API documentation while the backend is running:

```text
http://localhost:8000/docs
```

## Utility Scripts

Run these from the repository root unless noted otherwise:

```powershell
# Open the Streamlit dataset generator UI
streamlit run scripts/dataset_ui.py --server.maxUploadSize 1024

# Prepare training crops from videos
python scripts/prepare_training_data.py --help

# Train the slipper/non-slipper classifier
python scripts/train_yolo26_classifier.py --help

# Test a classifier checkpoint
python scripts/test_yolo26_classifier.py --help

# Export an Ultralytics model to TensorRT or ONNX
python scripts/export_ultralytics_model.py --help
```

## Common Workflows

1. Add a camera or uploaded video in System Configuration.
2. Configure detection ROI if the full frame should not be analyzed.
3. Enable people counting and draw counting lines for each camera.
4. Optionally assign cameras to a building ID and set building capacity limits.
5. Configure dress-code policy and target cameras.
6. Configure fall-detection sensitivity and inactivity timer per camera.
7. Monitor live streams on the dashboard and review persisted alerts in Reporting.

## Generated Data

Runtime uploads and snapshots are stored under:

```text
temp_video_uploads/
temp_video_uploads/snapshots/
```

Training and prediction outputs are ignored by Git:

```text
training_data/
*_data/
scripts/dataset_output/
scripts/prediction_runs/
scripts/training_runs/
```

## Troubleshooting

- `ffmpeg` not found: install FFmpeg and ensure `ffmpeg.exe` is available on `PATH`.
- Database connection errors: verify `backend/.env` and run `alembic upgrade head`.
- PostgreSQL service not found in deployment script: install PostgreSQL 16.x or edit `$postgresServiceName` in `start_deployment.ps1`.
- Nginx cannot start: run `nginx-1.30.0\nginx.exe -t` from the Nginx directory and check `nginx-1.30.0\conf\nginx.conf`.
- Model load failures: confirm required `.pt` or `.engine` files exist under `backend/`, or set `POSE_MODEL_PATH`, `DRESSCODE_MODEL_PATH`, and `SLIPPER_MODEL_PATH`.
- TensorRT engine fails but `.pt` exists: the backend attempts to fall back to the PyTorch checkpoint.
- WebSocket frames do not load in dev: confirm the backend is running on port `8000` and that Vite is serving with the configured proxy.
- Large uploads fail through Nginx: `client_max_body_size` is set to `10G` in the bundled config; verify you are using that config and have disk space.

## Security Notes

- Replace `SECRET_KEY` before deployment.
- Change or disable the default `admin` / `admin` credentials.
- Restrict CORS and Nginx exposure before putting the app on a public network.
- Keep model checkpoints, uploaded videos, and generated snapshots out of public repositories unless they are explicitly approved for distribution.

## Development Checks

```powershell
# Frontend lint
cd frontend
npm run lint

# Frontend production build
npm run build

# Backend health after startup
Invoke-WebRequest http://localhost:8000/api/health
```

There is no dedicated test suite in the repository at the moment, so changes should be verified with lint/build, database migrations, and the relevant dashboard workflow.
