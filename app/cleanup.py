import asyncio
import logging
import shutil
import time
from pathlib import Path
from typing import Dict, Any

from app.config import SESSIONS_DIR, SESSION_TTL_SECONDS, CLEANUP_INTERVAL_SECONDS

logger = logging.getLogger("pdfun.cleanup")


def get_disk_stats() -> Dict[str, Any]:
    """Return disk space statistics for the storage directory."""
    try:
        total, used, free = shutil.disk_usage(SESSIONS_DIR)
        active_sessions = sum(1 for p in SESSIONS_DIR.iterdir() if p.is_dir())
        return {
            "total_bytes": total,
            "used_bytes": used,
            "free_bytes": free,
            "total_gb": round(total / (1024**3), 2),
            "used_gb": round(used / (1024**3), 2),
            "free_gb": round(free / (1024**3), 2),
            "free_percent": round((free / total) * 100, 1) if total > 0 else 0,
            "active_sessions": active_sessions,
            "unlimited": True,
        }
    except Exception as e:
        logger.error(f"Error getting disk stats: {e}")
        return {
            "error": str(e),
            "unlimited": True,
            "active_sessions": 0,
        }


def clean_stale_sessions(ttl_seconds: int = SESSION_TTL_SECONDS) -> int:
    """Delete session folders older than ttl_seconds."""
    now = time.time()
    deleted_count = 0
    if not SESSIONS_DIR.exists():
        return 0

    for session_folder in SESSIONS_DIR.iterdir():
        if session_folder.is_dir():
            try:
                # Check folder modification time
                mtime = session_folder.stat().st_mtime
                if now - mtime > ttl_seconds:
                    shutil.rmtree(session_folder, ignore_errors=True)
                    deleted_count += 1
            except Exception as e:
                logger.warning(f"Failed to check/remove session {session_folder}: {e}")
    if deleted_count > 0:
        logger.info(f"Cleaned up {deleted_count} stale session(s).")
    return deleted_count


def delete_session(session_id: str) -> bool:
    """Manually delete a specific session directory."""
    session_dir = SESSIONS_DIR / session_id
    if session_dir.exists() and session_dir.is_dir():
        try:
            shutil.rmtree(session_dir, ignore_errors=True)
            return True
        except Exception as e:
            logger.error(f"Failed to delete session {session_id}: {e}")
            return False
    return False


async def cleanup_daemon():
    """Background task running periodically to clean stale sessions."""
    logger.info("Starting pdfun background session cleanup daemon...")
    while True:
        try:
            await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
            clean_stale_sessions()
        except asyncio.CancelledError:
            logger.info("Cleanup daemon cancelled.")
            break
        except Exception as e:
            logger.error(f"Error in cleanup daemon: {e}")
