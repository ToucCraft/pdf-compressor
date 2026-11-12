import asyncio
import os
import shutil
import tempfile
import time
import uuid
from pathlib import Path
from typing import List, Optional
from urllib.parse import quote

import fitz
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from compressor import (
    CompressionOptions,
    compress_pdf,
    merge_pdfs,
    render_page_preview_png,
)

app = FastAPI(
    title="PDF Compressor Pro",
    description="Unlimited local PDF compressor and merger",
    version="1.1.0",
)

# Storage directory for active jobs
STORAGE_DIR = Path(tempfile.gettempdir()) / "pdf_compressor_jobs"
STORAGE_DIR.mkdir(parents=True, exist_ok=True)

# In-memory registry of uploaded/compressed jobs
JOBS: dict[str, dict] = {}

CHUNK_SIZE = 1024 * 1024  # 1 MB streaming chunks for unlimited file sizes


def cleanup_old_jobs(max_age_sec: int = 3600 * 6):
    """Remove temporary job folders older than max_age_sec."""
    now = time.time()
    expired = [
        jid for jid, info in list(JOBS.items())
        if now - info.get("created_at", now) > max_age_sec
    ]
    for jid in expired:
        info = JOBS.pop(jid, None)
        if info and "job_dir" in info:
            shutil.rmtree(info["job_dir"], ignore_errors=True)


def inspect_pdf(pdf_path: str) -> dict:
    """Quickly inspect PDF page count and embedded image count."""
    doc = fitz.open(pdf_path)
    try:
        pages_count = len(doc)
        xrefs = set()
        for i in range(min(pages_count, 100)):
            for img in doc[i].get_images(full=True):
                xrefs.add(img[0])
        return {
            "pages_count": pages_count,
            "images_count": len(xrefs),
            "metadata": doc.metadata or {},
        }
    finally:
        doc.close()


def _rebuild_job_combined_pdf(job: dict):
    """Rebuild job['input_path'] from job['files'] list in order."""
    files = job["files"]
    combined_path = os.path.join(job["job_dir"], "original.pdf")
    if len(files) == 1:
        shutil.copyfile(files[0]["path"], combined_path)
    else:
        merge_pdfs([f["path"] for f in files], combined_path)

    job["input_path"] = combined_path
    job["original_size"] = sum(f["size"] for f in files)
    job["pages_count"] = sum(f["pages_count"] for f in files)
    job["images_count"] = sum(f["images_count"] for f in files)
    if len(files) == 1:
        job["filename"] = files[0]["filename"]
    else:
        stem = files[0]["filename"][:-4] if files[0]["filename"].lower().endswith(".pdf") else files[0]["filename"]
        job["filename"] = f"{stem}_merged_{len(files)}_files.pdf"


def _serialize_job_state(job: dict) -> dict:
    return {
        "job_id": job["job_id"],
        "filename": job["filename"],
        "original_size": job["original_size"],
        "pages_count": job["pages_count"],
        "images_count": job["images_count"],
        "files": [
            {
                "id": f["id"],
                "filename": f["filename"],
                "size": f["size"],
                "pages_count": f["pages_count"],
            }
            for f in job["files"]
        ],
    }


class CompressRequest(BaseModel):
    job_id: str
    method: str = "auto"                     # "auto", "smart", "rasterize", "merge_only"
    color_mode: str = "color"                # "color", "grayscale", "bw"
    quality: int = 75                        # 10..95
    dpi: int = 150                           # 36..300
    target_size_kb: Optional[float] = None   # None or > 0
    bw_threshold: int = 180                  # 50..240
    strip_metadata: bool = True
    strip_annotations: bool = False
    preserve_toc: bool = True


class QueueUpdateRequest(BaseModel):
    file_ids: List[str]


@app.post("/api/upload")
async def upload_pdf(
    file: UploadFile = File(...),
    job_id: Optional[str] = Query(None),
):
    """
    Stream-upload a PDF file of any size to local disk.
    If `job_id` is provided and exists, appends the file to the existing job's merge queue.
    """
    cleanup_old_jobs()

    filename = file.filename or "document.pdf"
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Please upload a valid PDF file (.pdf)")

    existing_job = JOBS.get(job_id) if job_id else None
    if existing_job:
        jid = existing_job["job_id"]
        job_dir = Path(existing_job["job_dir"])
    else:
        jid = uuid.uuid4().hex[:12]
        job_dir = STORAGE_DIR / jid
        job_dir.mkdir(parents=True, exist_ok=True)

    file_id = uuid.uuid4().hex[:8]
    part_path = job_dir / f"part_{file_id}.pdf"
    total_bytes = 0

    try:
        with open(part_path, "wb") as f:
            while True:
                chunk = await file.read(CHUNK_SIZE)
                if not chunk:
                    break
                f.write(chunk)
                total_bytes += len(chunk)
    except Exception as exc:
        if not existing_job:
            shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Failed to save uploaded file: {exc}")

    if total_bytes == 0:
        part_path.unlink(missing_ok=True)
        if not existing_job:
            shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="The uploaded file is empty")

    try:
        info = await asyncio.to_thread(inspect_pdf, str(part_path))
    except Exception as exc:
        part_path.unlink(missing_ok=True)
        if not existing_job:
            shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=f"Failed to read PDF file: {exc}")

    file_entry = {
        "id": file_id,
        "filename": filename,
        "path": str(part_path),
        "size": total_bytes,
        "pages_count": info["pages_count"],
        "images_count": info["images_count"],
    }

    if existing_job:
        existing_job["files"].append(file_entry)
        job = existing_job
    else:
        job = {
            "job_id": jid,
            "filename": filename,
            "job_dir": str(job_dir),
            "input_path": "",
            "output_path": None,
            "original_size": total_bytes,
            "pages_count": info["pages_count"],
            "images_count": info["images_count"],
            "files": [file_entry],
            "created_at": time.time(),
        }
        JOBS[jid] = job

    await asyncio.to_thread(_rebuild_job_combined_pdf, job)
    return _serialize_job_state(job)


@app.post("/api/queue/{job_id}")
async def update_job_queue(job_id: str, req: QueueUpdateRequest):
    """Reorder or remove files in an active job's merge queue."""
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    by_id = {f["id"]: f for f in job["files"]}
    new_files = [by_id[fid] for fid in req.file_ids if fid in by_id]
    if not new_files:
        raise HTTPException(status_code=400, detail="At least one PDF file must remain in the queue")

    # Clean up removed part files
    kept_ids = {f["id"] for f in new_files}
    for f in job["files"]:
        if f["id"] not in kept_ids:
            try:
                os.remove(f["path"])
            except OSError:
                pass

    job["files"] = new_files
    await asyncio.to_thread(_rebuild_job_combined_pdf, job)
    return _serialize_job_state(job)


@app.post("/api/compress")
async def compress_job(req: CompressRequest):
    """
    Compress or losslessly merge an already-uploaded PDF job.
    """
    job = JOBS.get(req.job_id)
    if not job or not os.path.exists(job["input_path"]):
        raise HTTPException(status_code=404, detail="File session not found. Please upload the file again.")

    output_path = os.path.join(job["job_dir"], "compressed.pdf")

    valid_methods = ("auto", "smart", "rasterize", "merge_only")
    options = CompressionOptions(
        method=req.method if req.method in valid_methods else "auto",
        color_mode=req.color_mode if req.color_mode in ("color", "grayscale", "bw") else "color",
        quality=max(10, min(95, req.quality)),
        dpi=max(36, min(300, req.dpi)),
        target_size_kb=req.target_size_kb if (req.target_size_kb and req.target_size_kb > 0) else None,
        bw_threshold=max(30, min(245, req.bw_threshold)),
        strip_metadata=req.strip_metadata,
        strip_annotations=req.strip_annotations,
        preserve_toc=req.preserve_toc,
    )

    try:
        result = await asyncio.to_thread(
            compress_pdf,
            job["input_path"],
            output_path,
            options,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"PDF processing failed: {exc}")

    job["output_path"] = output_path
    job["last_result"] = result.to_dict()

    return {
        "job_id": req.job_id,
        "filename": job["filename"],
        **result.to_dict(),
    }


@app.get("/api/preview/{job_id}")
async def preview_page(
    job_id: str,
    variant: str = Query("original", pattern="^(original|compressed)$"),
    page: int = Query(0, ge=0),
    dpi: int = Query(110, ge=50, le=200),
):
    """Render a page preview PNG for either original or compressed PDF."""
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="File not found")

    target_pdf = job["input_path"] if variant == "original" else job.get("output_path")
    if not target_pdf or not os.path.exists(target_pdf):
        raise HTTPException(status_code=404, detail="Processed version is not generated yet")

    try:
        png_bytes, total_pages = await asyncio.to_thread(
            render_page_preview_png, target_pdf, page, dpi
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to render page preview: {exc}")

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={
            "Cache-Control": "no-store",
            "X-Total-Pages": str(total_pages),
        },
    )


@app.get("/api/download/{job_id}")
async def download_compressed(job_id: str):
    """Download the processed PDF file."""
    job = JOBS.get(job_id)
    if not job or not job.get("output_path") or not os.path.exists(job["output_path"]):
        raise HTTPException(status_code=404, detail="Processed file not found")

    orig_name = job["filename"]
    stem = orig_name[:-4] if orig_name.lower().endswith(".pdf") else orig_name
    suffix = "" if stem.endswith("_merged") else "_processed"
    download_name = f"{stem}{suffix}.pdf"
    encoded_name = quote(download_name)

    return FileResponse(
        path=job["output_path"],
        media_type="application/pdf",
        filename=download_name,
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}"
        },
    )


@app.delete("/api/job/{job_id}")
async def delete_job(job_id: str):
    """Delete a job and clean up its temporary files."""
    job = JOBS.pop(job_id, None)
    if job and "job_dir" in job:
        shutil.rmtree(job["job_dir"], ignore_errors=True)
    return {"status": "deleted"}


# Mount static frontend files
STATIC_DIR = Path(__file__).parent / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
