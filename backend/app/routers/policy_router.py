"""
Dress Code Policy API

GET  /api/dresscode-policy        -- get the current policy (from DB)
PUT  /api/dresscode-policy        -- update the policy from the config panel
GET  /api/debug/policy            -- inspect the in-memory runtime policy
"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.database import get_db
from app.models.dresscode_policy import DressCodePolicy
from app.models.stream_config import StreamConfig
from app.schemas.dresscode_policy import DressCodePolicyRead, DressCodePolicyUpdate
from app.services.video_processor import update_policy, get_policy as get_runtime_policy

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
        )
        db.add(policy)
        await db.flush()
        await db.refresh(policy)
    return policy


async def _sync_policy_to_runtime(db: AsyncSession, policy: DressCodePolicy):
    """
    Resolve enabled_camera_ids -> view partition keys and push
    the policy to the video processor runtime.
    """
    detection_views = []
    view_to_camera_id = {}  # maps view key -> camera_id for violation tagging

    if policy.enabled and policy.enabled_camera_ids:
        # Look up which view_index each enabled camera maps to
        result = await db.execute(
            select(StreamConfig).where(
                StreamConfig.camera_id.in_(policy.enabled_camera_ids)
            )
        )
        configs = result.scalars().all()
        for sc in configs:
            if sc.view_index == -1:
                view_key = "original"
            else:
                view_key = f"partition_{sc.view_index}"
            detection_views.append(view_key)
            view_to_camera_id[view_key] = sc.camera_id

    # If no views resolved, keep default
    if not detection_views:
        detection_views = ["partition_3"]

    update_policy({
        "enabled_camera_ids": policy.enabled_camera_ids or [],
        "restricted_labels": policy.restricted_labels or ["shorts"],
        "confidence_threshold": policy.confidence_threshold or 0.8,
        "detection_views": detection_views,
        "view_to_camera_id": view_to_camera_id,
    })


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

    await db.flush()
    await db.refresh(policy)

    # Push updated policy to the video processor runtime
    await _sync_policy_to_runtime(db, policy)

    return policy


@router.get("/api/debug/policy")
async def debug_runtime_policy():
    """
    Return the current in-memory policy dict used by the video processor.
    Useful for diagnosing why violations are or aren't being flagged.
    """
    return get_runtime_policy()
