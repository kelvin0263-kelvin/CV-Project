from sqlalchemy import Column, String, DateTime, func
from app.models.base import Base


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True)  # Maps to Supabase Auth UUID
    email = Column(String(320), nullable=False, unique=True)
    role = Column(String(50), nullable=False, default="viewer")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    def __repr__(self) -> str:
        return f"<User(id={self.id!r}, email={self.email!r})>"
