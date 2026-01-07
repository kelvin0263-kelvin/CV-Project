from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routers import camera_router

# Initialize App
app = FastAPI(title="CV-UI Backend", version="1.0.0")

# Input/Output Config (Optional: Check folders)
# BASE_DIR... UPLOAD_DIR... (Handled in router currently, ideally in config)

# --- CORS ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Include Routers ---
app.include_router(camera_router.router)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
