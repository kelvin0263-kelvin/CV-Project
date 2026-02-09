import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.database import engine, AsyncSessionLocal
from app.models.base import Base
from app.routers import camera_router
from app.routers import policy_router
from app.routers import detection_router
from app.routers import counting_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Create tables if they don't exist (dev convenience). In production use Alembic."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Sync dress code policy to runtime on startup
    try:
        async with AsyncSessionLocal() as db:
            policy = await policy_router._get_or_create_policy(db)
            await policy_router._sync_policy_to_runtime(db, policy)
            await db.commit()
            print("[Startup] Dress code policy synced to runtime")
    except Exception as e:
        print(f"[Startup] Warning: Could not sync policy: {e}")

    # Load people counting configs from DB into in-memory cache
    try:
        await counting_router.load_counting_configs_from_db()
    except Exception as e:
        print(f"[Startup] Warning: Could not load counting configs: {e}")

    # Start background task to persist violation events from the video producer
    task = asyncio.create_task(detection_router.violation_persistence_loop())

    # Start background task to persist counting snapshots
    snapshot_task = asyncio.create_task(counting_router.counting_snapshot_persistence_loop())

    yield

    # Cleanup
    task.cancel()
    snapshot_task.cancel()


# Initialize App
app = FastAPI(title="CV-UI Backend", version="1.0.0", lifespan=lifespan)

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
app.include_router(policy_router.router)
app.include_router(detection_router.router)
app.include_router(counting_router.router)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        timeout_keep_alive=300,  # Keep connections alive longer for large uploads
    )
