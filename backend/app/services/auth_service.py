"""
User / Auth business logic. Used by auth_router; no HTTP layer here.
All functions preserve existing behavior (same return values, same exceptions).
"""

import asyncio
import json
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List

import jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.models.user import User
from app.schemas.user import (
    LoginRequest,
    LoginResponse,
    UserCreate,
    UserRead,
    UserUpdate,
)

# ---------------------------------------------------------------------------
# Constants (same as router)
# ---------------------------------------------------------------------------
LOGIN_DB_TIMEOUT = 2
DEMO_USER_ID = "admin-no-db"
ALLOWED_ROLES = ("admin", "staff")
DEFAULT_ADMIN_USERNAME = "admin"
DEFAULT_ADMIN_EMAIL = "admin@gmail.com"
DEFAULT_ADMIN_PASSWORD = "admin"
LOCAL_USERS_PATH = Path(__file__).resolve().parent.parent / "data" / "users_local.json"
# Use PBKDF2 for new passwords to avoid bcrypt's 72-byte limit and backend
# compatibility issues, while still verifying legacy bcrypt hashes.
pwd_context = CryptContext(schemes=["pbkdf2_sha256", "bcrypt"], deprecated="auto")


# ---------------------------------------------------------------------------
# Password & JWT (same behavior as router)
# ---------------------------------------------------------------------------
def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(user_id: str) -> str:
    expire = datetime.utcnow() + timedelta(minutes=settings.JWT_EXPIRE_MINUTES)
    payload = {"sub": user_id, "exp": expire}
    return jwt.encode(
        payload,
        settings.SECRET_KEY,
        algorithm=settings.JWT_ALGORITHM,
    )


# ---------------------------------------------------------------------------
# User <-> UserRead (same as router _user_to_read / _demo_user)
# ---------------------------------------------------------------------------
def user_to_read(user: User) -> UserRead:
    return UserRead(
        id=user.id,
        username=user.username,
        email=user.email,
        role=user.role or "staff",
        created_at=user.created_at,
    )


def is_default_admin_user(user: User | Dict | None) -> bool:
    if user is None:
        return False
    if isinstance(user, dict):
        username = user.get("username")
        email = user.get("email")
    else:
        username = getattr(user, "username", None)
        email = getattr(user, "email", None)
    return (
        (username or "").strip().lower() == DEFAULT_ADMIN_USERNAME
        and (email or "").strip().lower() == DEFAULT_ADMIN_EMAIL
    )


def demo_user() -> User:
    return User(
        id=DEMO_USER_ID,
        username=DEFAULT_ADMIN_USERNAME,
        email=DEFAULT_ADMIN_EMAIL,
        password_hash=None,
        role="admin",
        created_at=datetime.utcnow(),
    )


def _load_local_users() -> List[Dict]:
    try:
        if not LOCAL_USERS_PATH.exists():
            return []
        data = json.loads(LOCAL_USERS_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_local_users(users: List[Dict]) -> None:
    try:
        LOCAL_USERS_PATH.parent.mkdir(parents=True, exist_ok=True)
        LOCAL_USERS_PATH.write_text(json.dumps(users, default=str, indent=2), encoding="utf-8")
    except Exception:
        pass


def _userdict_to_read(data: Dict) -> UserRead:
    return UserRead(
        id=str(data.get("id")),
        username=data.get("username"),
        email=data.get("email"),
        role=str(data.get("role") or "staff"),
        created_at=_parse_local_created_at(data.get("created_at")),
    )


def _parse_local_created_at(value) -> datetime | None:
    if not value:
        return None
    try:
        text = str(value)
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        return datetime.fromisoformat(text)
    except Exception:
        return None


def _userdict_to_model(data: Dict) -> User:
    return User(
        id=str(data.get("id")),
        username=data.get("username"),
        email=data.get("email"),
        password_hash=data.get("password_hash"),
        role=str(data.get("role") or "staff"),
        created_at=_parse_local_created_at(data.get("created_at")) or datetime.utcnow(),
    )


def _find_local_user_index(users: List[Dict], *, user_id: str | None = None, identifier: str | None = None) -> int | None:
    normalized_identifier = (identifier or "").strip().lower()
    search_by_email = "@" in normalized_identifier

    for index, user in enumerate(users):
        if user_id is not None and str(user.get("id")) == str(user_id):
            return index
        if normalized_identifier:
            candidate = user.get("email") if search_by_email else user.get("username")
            if (candidate or "").strip().lower() == normalized_identifier:
                return index
    return None


def _find_local_user_by_id(user_id: str) -> Dict | None:
    users = _load_local_users()
    index = _find_local_user_index(users, user_id=user_id)
    return users[index] if index is not None else None


def _find_local_user_by_identifier(identifier: str) -> Dict | None:
    users = _load_local_users()
    index = _find_local_user_index(users, identifier=identifier)
    return users[index] if index is not None else None


def _verify_local_password(user_data: Dict, password: str) -> bool:
    password_hash = user_data.get("password_hash")
    if not password_hash:
        return False
    try:
        return verify_password(password, password_hash)
    except Exception:
        return False


def _build_local_login_response(user_data: Dict) -> LoginResponse:
    return LoginResponse(
        access_token=create_access_token(str(user_data.get("id"))),
        token_type="bearer",
        user=_userdict_to_read(user_data),
    )


def _update_local_user_record(user_id: str, body: UserUpdate, *, verify_current_password: bool = False) -> Dict | None:
    from fastapi import HTTPException

    users = _load_local_users()
    index = _find_local_user_index(users, user_id=user_id)
    if index is None:
        return None

    record = dict(users[index])

    if body.username is not None:
        normalized_username = body.username.strip().lower()
        for idx, user in enumerate(users):
            if idx == index:
                continue
            if (user.get("username") or "").strip().lower() == normalized_username:
                raise HTTPException(status_code=400, detail="Username already exists")
        record["username"] = body.username

    if body.email is not None:
        record["email"] = body.email

    if body.password is not None and body.password.strip():
        if verify_current_password and record.get("password_hash"):
            if not _verify_local_password(record, body.current_password or ""):
                raise HTTPException(status_code=400, detail="Current password is incorrect")
        record["password_hash"] = hash_password(body.password)

    if body.role is not None:
        if body.role not in ALLOWED_ROLES:
            raise HTTPException(status_code=400, detail=f"Role must be one of: {', '.join(ALLOWED_ROLES)}")
        record["role"] = body.role

    if not record.get("created_at"):
        record["created_at"] = datetime.utcnow().isoformat()

    users[index] = record
    _save_local_users(users)
    return record


def _delete_local_user_record(user_id: str) -> bool:
    users = _load_local_users()
    index = _find_local_user_index(users, user_id=user_id)
    if index is None:
        return False
    users.pop(index)
    _save_local_users(users)
    return True


async def _rollback_quietly(db: AsyncSession) -> None:
    try:
        await db.rollback()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Auth: get user by token (for get_current_user dependency)
# ---------------------------------------------------------------------------
async def get_user_by_token(token: str, db: AsyncSession) -> User:
    from fastapi import HTTPException

    try:
        payload = jwt.decode(
            token,
            settings.SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
        )
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    if user_id == DEMO_USER_ID:
        return demo_user()
    try:
        result = await db.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
    except Exception:
        await _rollback_quietly(db)
        local_user = _find_local_user_by_id(user_id)
        if local_user is not None:
            return _userdict_to_model(local_user)
        raise HTTPException(status_code=503, detail="Database unavailable")
    if not user:
        local_user = _find_local_user_by_id(user_id)
        if local_user is not None:
            return _userdict_to_model(local_user)
        raise HTTPException(status_code=401, detail="User not found")
    return user


def ensure_admin(user: User) -> None:
    from fastapi import HTTPException

    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")


async def ensure_default_admin(db: AsyncSession) -> bool:
    result = await db.execute(
        select(User).where(
            (User.username == DEFAULT_ADMIN_USERNAME) | (User.email == DEFAULT_ADMIN_EMAIL)
        )
    )
    user = result.scalar_one_or_none()
    if user is not None:
        changed = False
        if not user.username:
            user.username = DEFAULT_ADMIN_USERNAME
            changed = True
        if not user.email:
            user.email = DEFAULT_ADMIN_EMAIL
            changed = True
        if user.role != "admin":
            user.role = "admin"
            changed = True
        if not user.password_hash:
            user.password_hash = hash_password(DEFAULT_ADMIN_PASSWORD)
            changed = True
        if changed:
            await db.flush()
        return changed

    db.add(
        User(
            id=str(uuid.uuid4()),
            username=DEFAULT_ADMIN_USERNAME,
            email=DEFAULT_ADMIN_EMAIL,
            password_hash=hash_password(DEFAULT_ADMIN_PASSWORD),
            role="admin",
        )
    )
    await db.flush()
    return True


# ---------------------------------------------------------------------------
# Login (same logic as router login)
# ---------------------------------------------------------------------------
async def login(body: LoginRequest) -> LoginResponse:
    from fastapi import HTTPException

    identifier = (body.email or body.username or "").strip()
    if identifier in (DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_EMAIL) and body.password == DEFAULT_ADMIN_PASSWORD:
        async def _admin_from_db():
            async with AsyncSessionLocal() as db:
                result = await db.execute(
                    select(User).where(
                        (User.username == DEFAULT_ADMIN_USERNAME) | (User.email == DEFAULT_ADMIN_EMAIL)
                    )
                )
                user = result.scalar_one_or_none()
                if user and user.password_hash and verify_password(body.password, user.password_hash):
                    return ("db", user)
                return ("demo", None)

        try:
            outcome = await asyncio.wait_for(_admin_from_db(), timeout=LOGIN_DB_TIMEOUT)
        except (asyncio.TimeoutError, Exception):
            outcome = ("demo", None)

        if outcome[0] == "db":
            return LoginResponse(
                access_token=create_access_token(outcome[1].id),
                token_type="bearer",
                user=user_to_read(outcome[1]),
            )
        return LoginResponse(
            access_token=create_access_token(DEMO_USER_ID),
            token_type="bearer",
            user=user_to_read(demo_user()),
        )
    if not identifier:
        raise HTTPException(status_code=400, detail="Email or username is required")

    async def _normal_login():
        db_error = None
        async with AsyncSessionLocal() as db:
            stmt = (
                select(User).where(User.email == identifier)
                if "@" in identifier
                else select(User).where(User.username == identifier)
            )
            try:
                result = await db.execute(stmt)
                user = result.scalar_one_or_none()
            except Exception as exc:
                db_error = exc
                user = None
            else:
                if user and user.password_hash and verify_password(body.password, user.password_hash):
                    return LoginResponse(
                        access_token=create_access_token(user.id),
                        token_type="bearer",
                        user=user_to_read(user),
                    )

        local_user = _find_local_user_by_identifier(identifier)
        if local_user:
            if _verify_local_password(local_user, body.password):
                return _build_local_login_response(local_user)
            if not local_user.get("password_hash"):
                raise HTTPException(
                    status_code=400,
                    detail="This local user was created before password support. Recreate the user or reset its password.",
                )
            raise HTTPException(status_code=401, detail="Invalid username or password")
        if db_error is not None:
            raise HTTPException(status_code=503, detail="Database unavailable.")
        raise HTTPException(status_code=401, detail="Invalid username or password")

    try:
        return await asyncio.wait_for(_normal_login(), timeout=LOGIN_DB_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Login timed out.")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=503, detail="Database unavailable.")


# ---------------------------------------------------------------------------
# Current user: update me (same as router update_me)
# ---------------------------------------------------------------------------
async def update_me(body: UserUpdate, db: AsyncSession, current_user: User) -> UserRead:
    from fastapi import HTTPException

    if is_default_admin_user(current_user):
        raise HTTPException(status_code=400, detail="Default admin user cannot be modified")
    local_user = _find_local_user_by_id(current_user.id)
    if local_user is not None:
        updated_local_user = _update_local_user_record(
            current_user.id,
            body,
            verify_current_password=True,
        )
        return _userdict_to_read(updated_local_user)
    if body.password is not None and body.password.strip():
        if current_user.password_hash and not verify_password(body.current_password or "", current_user.password_hash):
            raise HTTPException(status_code=400, detail="Current password is incorrect")
        current_user.password_hash = hash_password(body.password)
    if body.username is not None:
        current_user.username = body.username
    if body.email is not None:
        current_user.email = body.email
    await db.flush()
    await db.refresh(current_user)
    return user_to_read(current_user)


# ---------------------------------------------------------------------------
# User list (same as router list_users)
# ---------------------------------------------------------------------------
async def list_users(db: AsyncSession) -> list[UserRead]:
    users_out: list[UserRead] = []
    try:
        result = await db.execute(select(User).order_by(User.created_at.desc()))
        users = result.scalars().all()
        if users:
            users_out = [user_to_read(u) for u in users]
    except Exception:
        await _rollback_quietly(db)
        pass
    local_users = _load_local_users()
    if local_users:
        existing_ids = {str(getattr(user, "id", "")) for user in users_out}
        existing_usernames = {
            (getattr(user, "username", "") or "").strip().lower()
            for user in users_out
            if getattr(user, "username", None)
        }
        for local_user in local_users:
            local_id = str(local_user.get("id"))
            local_username = (local_user.get("username") or "").strip().lower()
            if local_id in existing_ids or (local_username and local_username in existing_usernames):
                continue
            users_out.append(_userdict_to_read(local_user))
    has_admin = any(is_default_admin_user(u) for u in users_out)
    if not has_admin:
        users_out.insert(0, user_to_read(demo_user()))
    return users_out


# ---------------------------------------------------------------------------
# Create user (same as router create_user)
# ---------------------------------------------------------------------------
async def create_user(body: UserCreate, db: AsyncSession) -> UserRead:
    from fastapi import HTTPException

    if body.role not in ALLOWED_ROLES:
        raise HTTPException(status_code=400, detail=f"Role must be one of: {', '.join(ALLOWED_ROLES)}")
    try:
        existing = await db.execute(select(User).where(User.username == body.username))
        if existing.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="Username already exists")
        user = User(
            id=str(uuid.uuid4()),
            username=body.username,
            email=body.email or None,
            password_hash=hash_password(body.password),
            role=body.role,
        )
        db.add(user)
        await db.flush()
        await db.refresh(user)
        return user_to_read(user)
    except HTTPException:
        raise
    except Exception:
        # Database unavailable or username exists – fall back to local JSON
        await _rollback_quietly(db)
        users = _load_local_users()
        if any((u.get("username") or "").strip().lower() == body.username.strip().lower() for u in users):
            raise HTTPException(status_code=400, detail="Username already exists")
        new_user = {
            "id": str(uuid.uuid4()),
            "username": body.username,
            "email": body.email or None,
            "password_hash": hash_password(body.password),
            "role": body.role,
            "created_at": datetime.utcnow().isoformat(),
        }
        users.append(new_user)
        _save_local_users(users)
        return _userdict_to_read(new_user)


# ---------------------------------------------------------------------------
# Update user by id (same as router update_user)
# ---------------------------------------------------------------------------
async def update_user(user_id: str, body: UserUpdate, db: AsyncSession) -> UserRead:
    from fastapi import HTTPException

    try:
        result = await db.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
    except Exception:
        await _rollback_quietly(db)
        user = None

    if user is not None:
        if is_default_admin_user(user):
            raise HTTPException(status_code=400, detail="Default admin user cannot be modified")
        if body.username is not None:
            user.username = body.username
        if body.email is not None:
            user.email = body.email
        if body.password is not None and body.password.strip():
            user.password_hash = hash_password(body.password)
        if body.role is not None:
            if body.role not in ALLOWED_ROLES:
                raise HTTPException(status_code=400, detail=f"Role must be one of: {', '.join(ALLOWED_ROLES)}")
            user.role = body.role
        await db.flush()
        await db.refresh(user)
        return user_to_read(user)

    local_user = _find_local_user_by_id(user_id)
    if local_user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if is_default_admin_user(local_user):
        raise HTTPException(status_code=400, detail="Default admin user cannot be modified")
    updated_local_user = _update_local_user_record(user_id, body)
    return _userdict_to_read(updated_local_user)


# ---------------------------------------------------------------------------
# Delete user (same as router delete_user)
# ---------------------------------------------------------------------------
async def delete_user(user_id: str, current_user_id: str, db: AsyncSession) -> dict:
    from fastapi import HTTPException

    if user_id == current_user_id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    try:
        result = await db.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
    except Exception:
        await _rollback_quietly(db)
        user = None

    if user is not None:
        if is_default_admin_user(user):
            raise HTTPException(status_code=400, detail="Default admin user cannot be deleted")
        await db.delete(user)
        await db.flush()
        return {"ok": True}

    local_user = _find_local_user_by_id(user_id)
    if local_user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if is_default_admin_user(local_user):
        raise HTTPException(status_code=400, detail="Default admin user cannot be deleted")
    _delete_local_user_record(user_id)
    return {"ok": True}
