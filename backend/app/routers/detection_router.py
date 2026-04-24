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
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func

from app.core.database import get_db, AsyncSessionLocal
from app.models.camera_model import Camera
from app.models.detection_event import DetectionEvent
from app.routers.auth_router import get_current_user
from app.schemas.detection_event import DetectionEventRead
from app.services.video_processor import drain_violation_queue

router = APIRouter(dependencies=[Depends(get_current_user)])

# Snapshot directory (same as video_processor.py)
BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROJECT_ROOT = os.path.dirname(BACKEND_ROOT)
SNAPSHOT_DIR = os.path.join(PROJECT_ROOT, "temp_video_uploads", "snapshots")


def _normalize_query_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


@router.get("/api/detection-events", response_model=list[DetectionEventRead])
async def list_detection_events(
    camera_id: Optional[str] = Query(None),
    event_type: Optional[str] = Query(None),
    start: datetime | None = Query(None),
    end: datetime | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    """List detection events with optional filters, newest first."""
    start = _normalize_query_datetime(start)
    end = _normalize_query_datetime(end)
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=400, detail="start must be earlier than or equal to end")

    effective_time = func.coalesce(DetectionEvent.processed_at, DetectionEvent.timestamp)
    query = select(DetectionEvent).order_by(desc(effective_time))

    if camera_id:
        query = query.where(DetectionEvent.camera_id == camera_id)
    if event_type:
        query = query.where(DetectionEvent.event_type == event_type)
    if start is not None:
        query = query.where(effective_time >= start)
    if end is not None:
        query = query.where(effective_time <= end)

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
_retry_buffer: list = []  # Events that failed to save -- retried next cycle
MAX_RETRY_BUFFER = 200   # Cap to prevent unbounded growth


async def violation_persistence_loop():
    """
    Runs as an asyncio background task. Periodically drains the
    violation queue populated by the video processor thread and
    writes events to the database.

    Failed events are kept in a retry buffer and retried on the
    next cycle. Events are saved one-by-one so a single bad event
    doesn't block the rest of the batch.
    """
    while True:
        await asyncio.sleep(0.5)  # Check every 2 seconds

        events = drain_violation_queue()

        # Prepend any events that failed last time
        if _retry_buffer:
            events = _retry_buffer[:] + events
            _retry_buffer.clear()

        if not events:
            continue

        saved = 0
        failed = 0

        for evt in events:
            camera_id = evt.get("camera_id")
            scope = evt.get("scope")
            if not camera_id and scope != "building":
                print(f"[DB] Skipping event {evt['id']}: no camera_id resolved")
                continue

            try:
                async with AsyncSessionLocal() as session:
                    camera_name = evt.get("camera_name")
                    if camera_id:
                        camera_row = await session.execute(
                            select(Camera.id, Camera.name).where(Camera.id == camera_id).limit(1)
                        )
                        camera_record = camera_row.first()
                        if camera_record is not None:
                            camera_id = camera_record.id
                            camera_name = camera_record.name
                        else:
                            camera_name = camera_name or camera_id

                    # Build details dict based on event type
                    event_type = evt.get("event_type", "Dress Code Violation")
                    if event_type == "Capacity Exceeded":
                        details = {
                            "scope": scope or "camera",
                            "building_id": evt.get("building_id"),
                            "occupancy": evt.get("occupancy"),
                            "max_capacity": evt.get("max_capacity"),
                        }
                    elif event_type == "Fall Detected":
                        details = {
                            "person_bbox": evt.get("person_bbox"),
                            "track_id": evt.get("track_id"),
                            "snapshot_path": evt.get("snapshot_path"),
                            "source_path": evt.get("source_path"),
                            "detection_sensitivity": evt.get("detection_sensitivity"),
                            "inactivity_timer_seconds": evt.get("inactivity_timer_seconds"),
                        }
                    else:
                        details = {
                            "label": evt.get("label"),
                            "confidence": evt.get("confidence"),
                            "classifications": evt.get("classifications"),
                            "matched_violations": evt.get("matched_violations"),
                            "lower_bbox": evt.get("lower_bbox"),
                            "slipper_bbox": evt.get("slipper_bbox"),
                            "person_bbox": evt.get("person_bbox"),
                            "track_id": evt.get("track_id"),
                            "snapshot_path": evt.get("snapshot_path"),
                            "source_path": evt.get("source_path"),
                        }

                    db_event_kwargs = {
                        "id": evt["id"],
                        "camera_id": camera_id,
                        "camera_name": camera_name,
                        "event_type": event_type,
                        "details": details,
                    }
                    if "timestamp" in evt:
                        db_event_kwargs["timestamp"] = evt.get("timestamp")
                    if "processed_at" in evt:
                        db_event_kwargs["processed_at"] = evt.get("processed_at")

                    db_event = DetectionEvent(
                        **db_event_kwargs,
                    )
                    session.add(db_event)
                    await session.commit()
                    saved += 1
            except Exception as e:
                failed += 1
                # Keep for retry (up to cap)
                if len(_retry_buffer) < MAX_RETRY_BUFFER:
                    _retry_buffer.append(evt)
                print(f"[DB] Failed to save event {evt['id']}: {e}")

        if saved:
            print(f"[DB] Saved {saved} violation event(s)")
        if failed:
            print(f"[DB] {failed} event(s) failed, {len(_retry_buffer)} in retry buffer")
