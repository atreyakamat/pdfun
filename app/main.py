import asyncio
import logging
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

import aiofiles
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.config import (
    APP_NAME,
    APP_VERSION,
    BASE_DIR,
    SESSIONS_DIR,
    HOST,
    PORT,
)
from app.cleanup import cleanup_daemon, get_disk_stats, delete_session
from app.pdf_service import (
    get_session_dir,
    get_session_output_dir,
    inspect_pdf,
    parse_page_ranges,
    split_all_pages,
    split_by_ranges,
    split_fixed_interval,
    split_cut_points,
    split_even_odd,
    split_by_bookmarks,
    merge_pdf_files,
    rotate_pdf_pages,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("pdfun")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start background cleanup task
    cleanup_task = asyncio.create_task(cleanup_daemon())
    logger.info(f"{APP_NAME} v{APP_VERSION} initialized successfully.")
    yield
    # Shutdown
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass
    logger.info(f"{APP_NAME} shut down gracefully.")


app = FastAPI(
    title=APP_NAME,
    version=APP_VERSION,
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

# Enable CORS for browser access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static and template directories
STATIC_DIR = BASE_DIR / "app" / "static"
TEMPLATES_DIR = BASE_DIR / "app" / "templates"

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# Pydantic models for split requests
class SplitRequest(BaseModel):
    session_id: str
    filename: str
    mode: str  # "all", "ranges", "interval", "cut_points", "selected", "even_odd", "bookmarks"
    ranges_str: Optional[str] = None
    merge_ranges: bool = False
    interval: Optional[int] = 1
    cut_points: Optional[List[int]] = None
    selected_pages: Optional[List[int]] = None


class RotateRequest(BaseModel):
    session_id: str
    filename: str
    angle: int = 90
    page_numbers: Optional[List[int]] = None


# Routes
@app.api_route("/", methods=["GET", "HEAD"], response_class=HTMLResponse)
async def serve_index():
    index_file = TEMPLATES_DIR / "index.html"
    if not index_file.exists():
        raise HTTPException(status_code=404, detail="index.html not found")
    async with aiofiles.open(index_file, "r") as f:
        content = await f.read()
    return HTMLResponse(content=content)


@app.get("/api/system-info")
async def system_info():
    """Return storage and system information."""
    stats = get_disk_stats()
    return {
        "app": APP_NAME,
        "version": APP_VERSION,
        "storage": stats,
        "limits": {
            "max_file_size": "Unlimited (Streaming chunk direct-to-disk)",
            "memory_usage": "Streamed buffer (1MB chunks)",
        }
    }


@app.post("/api/upload")
async def upload_pdf(file: UploadFile = File(...)):
    """
    Stream uploaded PDF directly to session disk storage.
    No file size limit is imposed: chunks of 1MB are streamed to disk.
    """
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    session_id = str(uuid.uuid4())
    session_dir = get_session_dir(session_id)
    dest_path = session_dir / file.filename

    try:
        # Stream file to disk in 1MB chunks to ensure zero memory exhaustion
        total_bytes = 0
        async with aiofiles.open(dest_path, "wb") as out_file:
            while chunk := await file.read(1024 * 1024):
                await out_file.write(chunk)
                total_bytes += len(chunk)

        # Inspect the PDF
        info = await asyncio.to_thread(inspect_pdf, dest_path)
        info["session_id"] = session_id
        return JSONResponse(content={
            "success": True,
            "session_id": session_id,
            "filename": file.filename,
            "filesize_bytes": total_bytes,
            "info": info,
        })
    except Exception as e:
        logger.error(f"Error handling upload: {e}")
        # Clean up session on error
        delete_session(session_id)
        raise HTTPException(status_code=500, detail=f"Failed to process PDF: {str(e)}")


@app.get("/api/session/{session_id}/source/{filename}")
async def get_source_pdf(session_id: str, filename: str):
    """Serve the original uploaded PDF for browser viewing / PDF.js rendering."""
    file_path = get_session_dir(session_id) / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Source file not found")
    return FileResponse(
        path=file_path,
        media_type="application/pdf",
        filename=filename,
        content_disposition_type="inline",
    )


@app.post("/api/split")
async def split_pdf_endpoint(req: SplitRequest):
    """
    Split the PDF in session_id according to the specified mode.
    Runs inside a threadpool so large PDFs don't block the async event loop.
    """
    session_dir = get_session_dir(req.session_id)
    input_path = session_dir / req.filename

    if not input_path.exists():
        raise HTTPException(status_code=404, detail="Source PDF file not found. Please upload again.")

    try:
        mode = req.mode.lower()
        if mode == "all":
            result = await asyncio.to_thread(split_all_pages, req.session_id, input_path)

        elif mode == "ranges":
            if not req.ranges_str:
                raise HTTPException(status_code=400, detail="Please specify page ranges (e.g. 1-3, 5-7).")
            # First inspect for total pages
            info = inspect_pdf(input_path)
            range_groups = parse_page_ranges(req.ranges_str, info["total_pages"])
            if not range_groups:
                raise HTTPException(status_code=400, detail="Invalid page ranges provided.")
            result = await asyncio.to_thread(
                split_by_ranges,
                req.session_id,
                input_path,
                range_groups,
                req.merge_ranges,
            )

        elif mode == "interval":
            interval = req.interval or 1
            result = await asyncio.to_thread(
                split_fixed_interval,
                req.session_id,
                input_path,
                interval,
            )

        elif mode == "cut_points":
            if not req.cut_points:
                raise HTTPException(status_code=400, detail="No cut points specified.")
            result = await asyncio.to_thread(
                split_cut_points,
                req.session_id,
                input_path,
                req.cut_points,
            )

        elif mode == "selected":
            if not req.selected_pages:
                raise HTTPException(status_code=400, detail="No pages selected for extraction.")
            info = inspect_pdf(input_path)
            # Convert 1-based to 0-based
            selected_indices = [
                p - 1 for p in req.selected_pages
                if 1 <= p <= info["total_pages"]
            ]
            if not selected_indices:
                raise HTTPException(status_code=400, detail="Selected pages are out of bounds.")
            if req.merge_ranges:
                range_groups = [selected_indices]
            else:
                range_groups = [[p] for p in selected_indices]

            result = await asyncio.to_thread(
                split_by_ranges,
                req.session_id,
                input_path,
                range_groups,
                req.merge_ranges,
            )

        elif mode == "even_odd":
            result = await asyncio.to_thread(split_even_odd, req.session_id, input_path)

        elif mode == "bookmarks":
            result = await asyncio.to_thread(split_by_bookmarks, req.session_id, input_path)

        else:
            raise HTTPException(status_code=400, detail=f"Unsupported split mode '{mode}'.")

        return JSONResponse(content={"success": True, "data": result})

    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.error(f"Error during split: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to split PDF: {str(e)}")


@app.post("/api/merge")
async def merge_pdfs_endpoint(files: List[UploadFile] = File(...)):
    """Upload and merge multiple PDF files into one."""
    if len(files) < 2:
        raise HTTPException(status_code=400, detail="Please upload at least 2 PDF files to merge.")

    session_id = str(uuid.uuid4())
    session_dir = get_session_dir(session_id)
    saved_paths = []

    try:
        for idx, file in enumerate(files):
            if not file.filename.lower().endswith(".pdf"):
                continue
            dest = session_dir / f"{idx:03d}_{file.filename}"
            async with aiofiles.open(dest, "wb") as out_file:
                while chunk := await file.read(1024 * 1024):
                    await out_file.write(chunk)
            saved_paths.append(dest)

        if not saved_paths:
            raise HTTPException(status_code=400, detail="No valid PDF files uploaded.")

        result = await asyncio.to_thread(merge_pdf_files, session_id, saved_paths, "pdfun_merged.pdf")
        return JSONResponse(content={"success": True, "data": result})

    except Exception as e:
        logger.error(f"Error during merge: {e}")
        delete_session(session_id)
        raise HTTPException(status_code=500, detail=f"Failed to merge PDFs: {str(e)}")


@app.post("/api/rotate")
async def rotate_pdf_endpoint(req: RotateRequest):
    """Rotate PDF pages."""
    session_dir = get_session_dir(req.session_id)
    input_path = session_dir / req.filename
    if not input_path.exists():
        raise HTTPException(status_code=404, detail="Source PDF file not found.")

    try:
        result = await asyncio.to_thread(
            rotate_pdf_pages,
            req.session_id,
            input_path,
            req.angle,
            req.page_numbers,
        )
        return JSONResponse(content={"success": True, "data": result})
    except Exception as e:
        logger.error(f"Error during rotation: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to rotate PDF: {str(e)}")


@app.get("/api/download/{session_id}/{filename}")
async def download_file(session_id: str, filename: str):
    """Download an output PDF or ZIP file."""
    file_path = get_session_output_dir(session_id) / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Requested file not found or expired.")

    media_type = "application/zip" if filename.endswith(".zip") else "application/pdf"
    return FileResponse(
        path=file_path,
        media_type=media_type,
        filename=filename,
        content_disposition_type="attachment",
    )


@app.get("/api/preview/{session_id}/{filename}")
async def preview_output_file(session_id: str, filename: str):
    """Preview a generated PDF inline in browser."""
    file_path = get_session_output_dir(session_id) / filename
    if not file_path.exists() or not filename.endswith(".pdf"):
        raise HTTPException(status_code=404, detail="Requested file not found.")

    return FileResponse(
        path=file_path,
        media_type="application/pdf",
        filename=filename,
        content_disposition_type="inline",
    )


@app.delete("/api/session/{session_id}")
async def delete_session_endpoint(session_id: str):
    """Explicitly delete session data from disk for user privacy."""
    success = delete_session(session_id)
    return JSONResponse(content={"success": success, "session_id": session_id})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=HOST, port=PORT, reload=True)
