from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class UserRead(BaseModel):
    """Schema for reading a user (API response, no password)."""
    id: str
    username: Optional[str] = None
    email: Optional[str] = None
    role: str
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class UserCreate(BaseModel):
    """Schema for creating a user (register or admin add)."""
    username: str
    email: Optional[str] = None
    password: str
    role: str = "staff"


class UserUpdate(BaseModel):
    """Schema for partially updating a user."""
    username: Optional[str] = None
    email: Optional[str] = None
    current_password: Optional[str] = None
    password: Optional[str] = None
    role: Optional[str] = None


class LoginRequest(BaseModel):
    """Schema for login request (email or username)."""
    email: Optional[str] = None
    username: Optional[str] = None
    password: str


class LoginResponse(BaseModel):
    """Schema for login response."""
    access_token: str
    token_type: str = "bearer"
    user: UserRead