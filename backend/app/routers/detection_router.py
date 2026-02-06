"""
Detection Events API

GET  /api/detection-events          -- list violation events with filters
GET  /api/snapshots/{event_id}      -- serve snapshot evidence image

Also runs a background task to drain the violation queue from the video
processor thread and persist events to the database.
"""

import os
import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc

from app.core.database import get_db, AsyncSessionLocal
from app.models.detection_event import DetectionEvent
from app.schemas.detection_event import DetectionEventRead
from app.services.video_processor import drain_violation_queue

router = APIRouter()

# Snapshot directory (same as video_processor.py)
BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROJECT_ROOT = os.path.dirname(BACKEND_ROOT)
SNAPSHOT_DIR = os.path.join(PROJECT_ROOT, "temp_video_uploads", "snapshots")


@router.get("/api/detection-events", response_model=list[DetectionEventRead])
async def list_detection_events(
    camera_id: Optional[str] = Query(None),
    event_type: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """List detection events with optional filters, newest first."""
    query = select(DetectionEvent).order_by(desc(DetectionEvent.timestamp))

    if camera_id:
        query = query.where(DetectionEvent.camera_id == camera_id)
    if event_type:
        query = query.where(DetectionEvent.event_type == event_type)

    query = query.offset(offset).limit(limit)
    result = await db.execute(query)
    return result.scalars().all()


@router.get("/api/snapshots/{event_id}")
async def get_snapshot(event_id: str):
    """Serve a snapshot evidence image."""
    path = os.path.join(SNAPSHOT_DIR, f"{event_id}.jpg")
    if not os.path.exists(path):
        return {"error": "Snapshot not found"}
    return FileResponse(path, media_type="image/jpeg")


# ---------------------------------------------------------------------------
# Background task: drain violation queue and persist to DB
# ---------------------------------------------------------------------------
async def violation_persistence_loop():
    """
    Runs as an asyncio background task. Periodically drains the
    violation queue populated by the video processor thread and
    writes events to the database.
    """
    while True:
        await asyncio.sleep(2)  # Check every 2 seconds

        events = drain_violation_queue()
        if not events:
            continue

        try:
            async with AsyncSessionLocal() as session:
                for evt in events:
                    db_event = DetectionEvent(
                        id=evt["id"],
                        camera_id=_resolve_camera_id(evt.get("source_path"), evt.get("track_id")),
                        event_type=evt.get("event_type", "Dress Code Violation"),
                        details={
                            "label": evt.get("label"),
                            "confidence": evt.get("confidence"),
                            "person_bbox": evt.get("person_bbox"),
                            "track_id": evt.get("track_id"),
                            "snapshot_path": evt.get("snapshot_path"),
                            "source_path": evt.get("source_path"),
                        },
                    )
                    session.add(db_event)
                await session.commit()
                print(f"[DB] Saved {len(events)} violation event(s)")
        except Exception as e:
            print(f"[DB] Error saving violation events: {e}")


def _resolve_camera_id(source_path: str, track_id) -> str:
    """
    Best-effort resolve a camera_id from the source path.
    Since violations come from the video producer thread which doesn't
    know the camera_id directly, we use a placeholder.
    The frontend can cross-reference via the source_path in details.
    """
    # Return a generic identifier; camera_id will be refined when
    # we have per-camera policy with enabled_camera_ids
    return source_path or "unknown"
