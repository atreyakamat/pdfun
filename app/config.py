import os
from pathlib import Path

# Base directories
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
SESSIONS_DIR = DATA_DIR / "sessions"

# Ensure storage directories exist
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

# App configuration
APP_NAME = "pdfun"
APP_VERSION = "1.0.0"

# Storage & Cleanup settings
# Zero artificial file size limit (0 = unlimited)
MAX_FILE_SIZE_BYTES = 0  # 0 indicates streaming with no limit
SESSION_TTL_SECONDS = int(os.getenv("SESSION_TTL_SECONDS", 2 * 3600))  # 2 hours
CLEANUP_INTERVAL_SECONDS = int(os.getenv("CLEANUP_INTERVAL_SECONDS", 900))  # 15 minutes

# Server configuration
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", 8080))
