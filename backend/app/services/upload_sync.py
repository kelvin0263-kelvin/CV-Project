import threading
import time
from datetime import datetime

from app.services.video_processor import start_producer_thread


_sync_lock = threading.Lock()
_pending_sync_groups: dict[str, list[dict]] = {}


def register_pending_upload(
    group_id: str,
    *,
    runtime_key: str,
    source_path: str,
    is_fisheye: bool,
    active_views: list[int] | None,
    uploaded_video_start_time_override: datetime | None = None,
) -> int:
    """Register an uploaded source for later synchronized start."""
    normalized_group_id = group_id.strip()
    if not normalized_group_id:
        raise ValueError("sync group id is required")

    with _sync_lock:
        members = _pending_sync_groups.setdefault(normalized_group_id, [])
        members = [m for m in members if m["runtime_key"] != runtime_key]
        members.append({
            "runtime_key": runtime_key,
            "source_path": source_path,
            "is_fisheye": is_fisheye,
            "active_views": list(active_views) if active_views is not None else None,
            "uploaded_video_start_time_override": uploaded_video_start_time_override,
        })
        _pending_sync_groups[normalized_group_id] = members
        return len(members)


def list_sync_groups() -> list[dict]:
    """Return all pending synchronized upload groups."""
    with _sync_lock:
        return [
            {
                "group_id": group_id,
                "pending_sources": len(members),
            }
            for group_id, members in sorted(_pending_sync_groups.items())
        ]


def is_pending_runtime_key(runtime_key: str) -> bool:
    """True if a runtime key is still waiting in any sync group."""
    with _sync_lock:
        return any(
            member["runtime_key"] == runtime_key
            for members in _pending_sync_groups.values()
            for member in members
        )


def discard_pending_runtime_key(runtime_key: str):
    """Remove a runtime key from any pending sync group."""
    with _sync_lock:
        empty_groups = []
        for group_id, members in _pending_sync_groups.items():
            filtered = [member for member in members if member["runtime_key"] != runtime_key]
            _pending_sync_groups[group_id] = filtered
            if not filtered:
                empty_groups.append(group_id)
        for group_id in empty_groups:
            _pending_sync_groups.pop(group_id, None)


def pop_sync_group_members(group_id: str) -> tuple[str, list[dict]]:
    """Remove and return all pending members for a sync group."""
    normalized_group_id = group_id.strip()
    if not normalized_group_id:
        raise ValueError("sync group id is required")

    with _sync_lock:
        members = _pending_sync_groups.pop(normalized_group_id, [])

    return normalized_group_id, members


def start_sync_group(group_id: str) -> dict:
    """Start all pending uploads in a group as closely together as possible."""
    normalized_group_id, members = pop_sync_group_members(group_id)

    if not members:
        return {"group_id": normalized_group_id, "started_sources": 0}

    sync_state = {"started_at": None}
    if len(members) > 1:
        sync_barrier = threading.Barrier(
            len(members),
            action=lambda: sync_state.__setitem__("started_at", time.perf_counter()),
        )
    else:
        sync_barrier = None
        sync_state["started_at"] = time.perf_counter()

    for member in members:
        start_producer_thread(
            member["runtime_key"],
            member["source_path"],
            member["is_fisheye"],
            member["active_views"],
            sync_barrier=sync_barrier,
            sync_state=sync_state,
            uploaded_video_start_time_override=member.get("uploaded_video_start_time_override"),
        )

    return {
        "group_id": normalized_group_id,
        "started_sources": len(members),
    }
