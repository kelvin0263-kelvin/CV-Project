import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env from backend root
env_path = Path(__file__).resolve().parent.parent.parent / ".env"
# Prefer the current backend/.env values even if an older DATABASE_URL is still
# present in the shell environment from a previous run.
load_dotenv(dotenv_path=env_path, override=True)


class Settings:
    """Application settings loaded from environment variables."""

    DATABASE_URL: str = os.getenv(
        "DATABASE_URL",
        "postgresql+asyncpg://postgres:postgres@localhost:5432/postgres",
    )
    SUPABASE_URL: str = os.getenv("SUPABASE_URL", "")
    SUPABASE_KEY: str = os.getenv("SUPABASE_KEY", "")
    SUPABASE_SERVICE_KEY: str = os.getenv("SUPABASE_SERVICE_KEY", "")
    SECRET_KEY: str = os.getenv("SECRET_KEY", "dev-secret-key-change-me")
    JWT_ALGORITHM: str = os.getenv("JWT_ALGORITHM", "HS256")
    JWT_EXPIRE_MINUTES: int = int(os.getenv("JWT_EXPIRE_MINUTES", "60"))


settings = Settings()
