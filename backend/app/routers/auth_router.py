from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.user import User
from app.schemas.user import UserRead, UserCreate, UserUpdate, LoginRequest, LoginResponse
from app.services import auth_service

router = APIRouter()
# Re-export for main.py lifespan (default admin creation)
hash_password = auth_service.hash_password
security = HTTPBearer(auto_error=False)


async def get_current_user(
    db: AsyncSession = Depends(get_db),
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> User:
    if not credentials or not credentials.credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return await auth_service.get_user_by_token(credentials.credentials, db)


@router.get("/api/health")
async def health():
    return {"ok": True}


# ---------------------------------------------------------------------------
# Login (public)
# ---------------------------------------------------------------------------
@router.post("/api/auth/login", response_model=LoginResponse)
async def login(body: LoginRequest):
    return await auth_service.login(body)


# ---------------------------------------------------------------------------
# Current user (protected)
# ---------------------------------------------------------------------------
@router.get("/api/users/me", response_model=UserRead)
async def get_me(current_user: User = Depends(get_current_user)):
    return auth_service.user_to_read(current_user)


@router.put("/api/users/me", response_model=UserRead)
async def update_me(
    body: UserUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await auth_service.update_me(body, db, current_user)


# ---------------------------------------------------------------------------
# User list and CRUD (protected)
# ---------------------------------------------------------------------------
@router.get("/api/users", response_model=list[UserRead])
async def list_users(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    auth_service.ensure_admin(current_user)
    return await auth_service.list_users(db)


@router.post("/api/users", response_model=UserRead)
async def create_user(
    body: UserCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    auth_service.ensure_admin(current_user)
    return await auth_service.create_user(body, db)


@router.put("/api/users/{user_id}", response_model=UserRead)
async def update_user(
    user_id: str,
    body: UserUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    auth_service.ensure_admin(current_user)
    return await auth_service.update_user(user_id, body, db)


@router.delete("/api/users/{user_id}")
async def delete_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    auth_service.ensure_admin(current_user)
    return await auth_service.delete_user(user_id, current_user.id, db)