"""
Marker PDF to Markdown Conversion API

A FastAPI service that converts PDF files to Markdown using the Marker library.
Supports caching, priority queues, and configurable worker pools.
"""

import asyncio
import hashlib
import os
from pathlib import Path
from typing import Optional
from dataclasses import dataclass

from fastapi import FastAPI, File, HTTPException, UploadFile, Query, Header, Depends
from fastapi.responses import JSONResponse, FileResponse
from marker.converters.pdf import PdfConverter
from marker.models import create_model_dict
from marker.config.parser import ConfigParser


app = FastAPI(
    title="Marker PDF to Markdown API",
    description="Convert PDF files to Markdown using the Marker library",
    version="2.0.0"
)

# Configuration
CACHE_DIR = Path(os.getenv("CACHE_DIR", "/cache"))
MARKER_WORKERS = int(os.getenv("MARKER_WORKERS", "2"))
API_KEY = os.getenv("MARKER_PDF_TO_MARKDOWN_API_KEY")

print(f"[STARTUP] Cache directory: {CACHE_DIR.absolute()}")
print(f"[STARTUP] Worker count: {MARKER_WORKERS}")

CACHE_DIR.mkdir(parents=True, exist_ok=True)

if not API_KEY:
    raise ValueError("MARKER_PDF_TO_MARKDOWN_API_KEY environment variable must be set")


@dataclass
class ConversionTask:
    """A PDF conversion task to be processed by workers."""
    pdf_path: Path
    pdf_content: bytes
    file_hash: str
    cache: bool
    future: asyncio.Future


# Queues for priority-based processing
priority_queue: asyncio.Queue[ConversionTask] = asyncio.Queue()
normal_queue: asyncio.Queue[ConversionTask] = asyncio.Queue()

# Event to signal workers to stop
shutdown_event = asyncio.Event()

# Marker converter (initialized lazily per worker to avoid sharing across threads)
converter: Optional[PdfConverter] = None


def create_converter() -> PdfConverter:
    """Create a Marker PDF converter instance."""
    config_dict = {
        "output_format": "markdown",
        "languages": "no,en",
        "disable_image_extraction": True,
        "paginate_output": True,
        "page_separator": "___PAGE_SEPARATOR___",
    }
    config_parser = ConfigParser(config_dict)
    return PdfConverter(
        config=config_parser.generate_config_dict(),
        artifact_dict=create_model_dict(),
        processor_list=config_parser.get_processors(),
        renderer=config_parser.get_renderer(),
        llm_service=config_parser.get_llm_service(),
    )


def verify_api_key(x_api_key: str = Header(..., description="API key for authentication")):
    """Verify the API key from request headers."""
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return x_api_key


def compute_file_hash(content: bytes) -> str:
    """Compute SHA256 hash of file content."""
    return hashlib.sha256(content).hexdigest()


def get_cached_result(file_hash: str) -> Optional[list[str]]:
    """Retrieve cached pages result if it exists."""
    import json
    cache_file = CACHE_DIR / f"{file_hash}.json"
    if cache_file.exists():
        return json.loads(cache_file.read_text(encoding="utf-8"))
    return None


def save_to_cache(file_hash: str, pdf_content: bytes, pages: list[str]) -> None:
    """Save PDF and pages to cache."""
    import json
    pdf_file = CACHE_DIR / f"{file_hash}.pdf"
    pdf_file.write_bytes(pdf_content)
    pages_file = CACHE_DIR / f"{file_hash}.json"
    pages_file.write_text(json.dumps(pages), encoding="utf-8")


PAGE_SEPARATOR = "___PAGE_SEPARATOR___"


def process_conversion(conv: PdfConverter, task: ConversionTask) -> list[str]:
    """Process a single PDF conversion (blocking). Returns list of page strings."""
    result = conv(str(task.pdf_path))
    # Split by page separator and return as list
    pages = result.markdown.split(PAGE_SEPARATOR)
    return pages


async def worker(worker_id: int):
    """
    Worker coroutine that processes conversion tasks.
    Always drains priority queue before processing normal queue.
    """
    print(f"[WORKER-{worker_id}] Starting")
    conv = create_converter()
    print(f"[WORKER-{worker_id}] Converter ready")

    while not shutdown_event.is_set():
        task: Optional[ConversionTask] = None

        # Try priority queue first (non-blocking)
        try:
            task = priority_queue.get_nowait()
            print(f"[WORKER-{worker_id}] Got priority task: {task.file_hash[:8]}...")
        except asyncio.QueueEmpty:
            pass

        # If no priority task, try normal queue (non-blocking)
        if task is None:
            try:
                task = normal_queue.get_nowait()
                print(f"[WORKER-{worker_id}] Got normal task: {task.file_hash[:8]}...")
            except asyncio.QueueEmpty:
                pass

        # If no tasks available, wait briefly then retry
        if task is None:
            await asyncio.sleep(0.1)
            continue

        try:
            # Run blocking conversion in thread pool
            loop = asyncio.get_event_loop()
            pages = await loop.run_in_executor(
                None, process_conversion, conv, task
            )

            # Cache if requested
            if task.cache:
                save_to_cache(task.file_hash, task.pdf_content, pages)

            # Signal completion
            task.future.set_result(pages)
            print(f"[WORKER-{worker_id}] Completed task: {task.file_hash[:8]}...")

        except Exception as e:
            print(f"[WORKER-{worker_id}] Error processing {task.file_hash[:8]}: {e}")
            task.future.set_exception(e)

        finally:
            # Clean up temp file if not caching
            if not task.cache and task.pdf_path.exists():
                task.pdf_path.unlink()

    print(f"[WORKER-{worker_id}] Shutting down")


@app.on_event("startup")
async def startup():
    """Start worker tasks on application startup."""
    print(f"[STARTUP] Starting {MARKER_WORKERS} workers...")
    for i in range(MARKER_WORKERS):
        asyncio.create_task(worker(i))
    print("[STARTUP] Workers started")


@app.on_event("shutdown")
async def shutdown():
    """Signal workers to stop on application shutdown."""
    print("[SHUTDOWN] Signaling workers to stop...")
    shutdown_event.set()


@app.get("/")
async def root():
    """Health check endpoint."""
    return {
        "status": "ok",
        "service": "marker-pdf-to-markdown",
        "version": "2.0.0",
        "workers": MARKER_WORKERS,
    }


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "priority_queue_size": priority_queue.qsize(),
        "normal_queue_size": normal_queue.qsize(),
    }


@app.get("/up")
async def up():
    """Liveness check endpoint."""
    return {"status": "ok"}


@app.post("/api/v1/marker-pdf-to-markdown")
async def marker_pdf_to_markdown_v1(
    file: UploadFile = File(..., description="PDF file to convert"),
    cache: bool = Query(False, description="Enable caching of results"),
    priority: bool = Query(False, description="Prioritize this request"),
    api_key: str = Depends(verify_api_key),
):
    """
    Convert a PDF file to Markdown format.

    Args:
        file: PDF file to convert (multipart/form-data)
        cache: If True, cache the PDF and result for future requests
        priority: If True, process this request before non-priority requests

    Returns:
        JSON response with markdown content
    """
    # Validate file type
    if not file.content_type or "pdf" not in file.content_type.lower():
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(
                status_code=400,
                detail="Invalid file type. Only PDF files are accepted."
            )

    try:
        pdf_content = await file.read()

        if len(pdf_content) == 0:
            raise HTTPException(status_code=400, detail="Empty file provided.")

        file_hash = compute_file_hash(pdf_content)

        # Check cache first
        if cache:
            cached_result = get_cached_result(file_hash)
            if cached_result:
                return JSONResponse(content={
                    "success": True,
                    "pages": cached_result,
                    "cached": True,
                    "file_hash": file_hash,
                })

        # Save PDF temporarily for processing
        temp_pdf = CACHE_DIR / f"temp_{file_hash}.pdf"
        temp_pdf.write_bytes(pdf_content)

        # Create task with future for result
        loop = asyncio.get_event_loop()
        future = loop.create_future()

        task = ConversionTask(
            pdf_path=temp_pdf,
            pdf_content=pdf_content,
            file_hash=file_hash,
            cache=cache,
            future=future,
        )

        # Add to appropriate queue
        if priority:
            await priority_queue.put(task)
            print(f"[API] Queued priority task: {file_hash[:8]}...")
        else:
            await normal_queue.put(task)
            print(f"[API] Queued normal task: {file_hash[:8]}...")

        # Wait for result
        pages = await future

        return JSONResponse(content={
            "success": True,
            "pages": pages,
            "cached": False,
            "file_hash": file_hash if cache else None,
        })

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error converting PDF to Markdown: {str(e)}"
        )


@app.get("/api/v1/cache/{file_hash}")
async def get_cached_pages(file_hash: str, api_key: str = Depends(verify_api_key)):
    """Retrieve cached pages result by file hash."""
    cached_result = get_cached_result(file_hash)

    if cached_result:
        return JSONResponse(content={
            "success": True,
            "pages": cached_result,
            "file_hash": file_hash,
        })

    raise HTTPException(
        status_code=404,
        detail="No cached result found for this file hash."
    )


@app.get("/api/v1/cache/{file_hash}/pdf")
async def get_cached_pdf(file_hash: str, api_key: str = Depends(verify_api_key)):
    """Retrieve a cached PDF by file hash."""
    pdf_file = CACHE_DIR / f"{file_hash}.pdf"

    if pdf_file.exists():
        return FileResponse(
            path=pdf_file,
            media_type="application/pdf",
            filename=f"{file_hash}.pdf"
        )

    raise HTTPException(
        status_code=404,
        detail="No cached PDF found for this file hash."
    )


@app.delete("/api/v1/cache/{file_hash}")
async def delete_cache_entry(file_hash: str, api_key: str = Depends(verify_api_key)):
    """Delete a cached entry by file hash."""
    pdf_file = CACHE_DIR / f"{file_hash}.pdf"
    md_file = CACHE_DIR / f"{file_hash}.md"

    files_deleted = []

    if pdf_file.exists():
        pdf_file.unlink()
        files_deleted.append("pdf")

    if md_file.exists():
        md_file.unlink()
        files_deleted.append("markdown")

    if not files_deleted:
        raise HTTPException(
            status_code=404,
            detail="No cached files found for this file hash."
        )

    return JSONResponse(content={
        "success": True,
        "message": f"Deleted cached files: {', '.join(files_deleted)}",
        "file_hash": file_hash,
    })


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port, timeout_keep_alive=10800)
