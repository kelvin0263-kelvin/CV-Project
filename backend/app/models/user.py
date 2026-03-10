from sqlalchemy import Column, String, DateTime, func
from app.models.base import Base


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True)
    username = Column(String(80), unique=True, nullable=True, index=True)
    email = Column(String(320), nullable=True, unique=True)
    password_hash = Column(String(255), nullable=True)
    role = Column(String(50), nullable=False, default="staff")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    def __repr__(self) -> str:
        return f"<User(id={self.id!r}, username={self.username!r})>"