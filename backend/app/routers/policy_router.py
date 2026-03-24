"""
Dress Code Policy API

GET  /api/dresscode-policy  -- get the current policy (from DB)
PUT  /api/dresscode-policy  -- update the policy from the config panel
"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.database import get_db
from app.models.camera_model import Camera
from app.models.dresscode_policy import DressCodePolicy
from app.models.stream_config import StreamConfig
from app.schemas.dresscode_policy import DressCodePolicyRead, DressCodePolicyUpdate
from app.services.video_processor import update_policy

router = APIRouter()


async def _get_or_create_policy(db: AsyncSession) -> DressCodePolicy:
    """Get the single global policy row, creating it if it doesn't exist."""
    result = await db.execute(select(DressCodePolicy).limit(1))
    policy = result.scalar_one_or_none()
    if policy is None:
        policy = DressCodePolicy(
            enabled_camera_ids=[],
            restricted_labels=["shorts"],
            confidence_threshold=0.8,
            enabled=True,
            enable_pants_detection=True,
            enable_slipper_detection=False,
        )
        db.add(policy)
        await db.flush()
        await db.refresh(policy)
    return policy


async def _sync_policy_to_runtime(db: AsyncSession, policy: DressCodePolicy):
    """
    Resolve enabled_camera_ids -> per-source detection config and push
    the policy to the video processor runtime.

    Builds a mapping keyed by (runtime_key, view_key) so the same RTSP
    URL can back multiple independent producer groups.
    """
    # Maps: runtime_key -> set of view_keys that should run detection
    detection_map: dict[str, set[str]] = {}
    # Maps: (runtime_key, view_key) -> camera_id for DB event tagging
    camera_id_map: dict[tuple[str, str], str] = {}

    if policy.enabled and policy.enabled_camera_ids:
        result = await db.execute(
            select(StreamConfig).where(
                StreamConfig.camera_id.in_(policy.enabled_camera_ids)
            )
        )
        configs = result.scalars().all()
        for sc in configs:
            view_key = "original" if sc.view_index == -1 else f"partition_{sc.view_index}"
            runtime_key = sc.runtime_key or sc.source_path

            if runtime_key not in detection_map:
                detection_map[runtime_key] = set()
            detection_map[runtime_key].add(view_key)
            camera_id_map[(runtime_key, view_key)] = sc.camera_id

    update_policy({
        "enabled_camera_ids": policy.enabled_camera_ids or [],
        "restricted_labels": policy.restricted_labels or ["shorts"],
        "confidence_threshold": policy.confidence_threshold or 0.8,
        "enable_pants_detection": bool(policy.enable_pants_detection),
        "enable_slipper_detection": bool(policy.enable_slipper_detection),
        "detection_map": detection_map,
        "camera_id_map": {f"{k[0]}||{k[1]}": v for k, v in camera_id_map.items()},
    })


async def sync_policy_runtime_from_db(db: AsyncSession) -> DressCodePolicy:
    """
    Re-sync runtime policy and prune camera IDs that no longer exist.
    Camera deletion otherwise leaves stale runtime mappings in memory.
    """
    policy = await _get_or_create_policy(db)

    enabled_camera_ids = policy.enabled_camera_ids or []
    if enabled_camera_ids:
        result = await db.execute(
            select(Camera.id).where(Camera.id.in_(enabled_camera_ids))
        )
        valid_ids = set(result.scalars().all())
        filtered_ids = [camera_id for camera_id in enabled_camera_ids if camera_id in valid_ids]
        if filtered_ids != enabled_camera_ids:
            policy.enabled_camera_ids = filtered_ids
            await db.flush()
            await db.refresh(policy)

    await _sync_policy_to_runtime(db, policy)
    return policy


@router.get("/api/dresscode-policy", response_model=DressCodePolicyRead)
async def get_policy(db: AsyncSession = Depends(get_db)):
    policy = await _get_or_create_policy(db)
    return policy


@router.put("/api/dresscode-policy", response_model=DressCodePolicyRead)
async def update_policy_endpoint(
    update: DressCodePolicyUpdate,
    db: AsyncSession = Depends(get_db),
):
    policy = await _get_or_create_policy(db)

    # Apply partial updates
    if update.enabled_camera_ids is not None:
        policy.enabled_camera_ids = update.enabled_camera_ids
    if update.restricted_labels is not None:
        policy.restricted_labels = update.restricted_labels
    if update.confidence_threshold is not None:
        policy.confidence_threshold = update.confidence_threshold
    if update.enabled is not None:
        policy.enabled = update.enabled
    if update.enable_pants_detection is not None:
        policy.enable_pants_detection = update.enable_pants_detection
    if update.enable_slipper_detection is not None:
        policy.enable_slipper_detection = update.enable_slipper_detection

    await db.flush()
    await db.refresh(policy)

    return await sync_policy_runtime_from_db(db)
