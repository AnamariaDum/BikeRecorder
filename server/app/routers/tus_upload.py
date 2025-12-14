"""
TUS Protocol implementation for resumable video uploads
Place this in: server/app/routers/tus_upload.py
"""
from fastapi import APIRouter, Request, Response, HTTPException, Depends, Header
from pathlib import Path
import os
import hashlib
from typing import Optional
from ..auth import get_current_user  # use auth.get_current_user from parent package

router = APIRouter(prefix="/tus", tags=["tus-upload"])

STORAGE_DIR = Path(os.getenv("BIKE_RECORDER_STORAGE_DIR", "./storage"))
TUS_VERSION = "1.0.0"
MAX_FILE_SIZE = 1024 * 1024 * 1024  # 1GB


def get_upload_path(upload_id: str) -> Path:
    """Get the file path for an upload ID"""
    return STORAGE_DIR / "uploads" / upload_id


def get_metadata_path(upload_id: str) -> Path:
    """Get the metadata file path for an upload ID"""
    return STORAGE_DIR / "uploads" / f"{upload_id}.metadata"


@router.options("/files")
async def tus_options_create():
    """TUS OPTIONS endpoint for upload creation"""
    return Response(
        status_code=204,
        headers={
            "Tus-Resumable": TUS_VERSION,
            "Tus-Version": TUS_VERSION,
            "Tus-Extension": "creation,creation-with-upload,termination",
            "Tus-Max-Size": str(MAX_FILE_SIZE),
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, HEAD, PATCH, OPTIONS",
            "Access-Control-Allow-Headers": "Upload-Length, Upload-Metadata, Tus-Resumable, Content-Type",
            "Access-Control-Expose-Headers": "Upload-Offset, Location, Upload-Length, Tus-Resumable",
        }
    )


@router.post("/files")
async def tus_create_upload(
    request: Request,
    upload_length: int = Header(..., alias="Upload-Length"),
    upload_metadata: Optional[str] = Header(None, alias="Upload-Metadata"),
    current_user = Depends(get_current_user),
):
    """
    TUS POST endpoint - Create a new upload
    Returns upload URL with unique ID
    """
    if upload_length > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large")
    
    # Generate unique upload ID
    upload_id = hashlib.sha256(
        f"{current_user.id}-{upload_length}-{upload_metadata}".encode()
    ).hexdigest()[:16]
    
    # Create storage directory
    upload_path = get_upload_path(upload_id)
    upload_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Store metadata
    metadata_path = get_metadata_path(upload_id)
    with open(metadata_path, 'w') as f:
        f.write(f"{upload_length}\n")
        if upload_metadata:
            f.write(upload_metadata)
    
    # Create empty file
    upload_path.touch()
    
    # Return upload URL
    upload_url = str(request.url).rstrip('/') + f"/{upload_id}"
    
    return Response(
        status_code=201,
        headers={
            "Tus-Resumable": TUS_VERSION,
            "Location": upload_url,
            "Upload-Offset": "0",
            "Access-Control-Expose-Headers": "Location, Upload-Offset",
        }
    )


@router.options("/files/{upload_id}")
async def tus_options_file(upload_id: str):
    """TUS OPTIONS endpoint for specific upload"""
    return Response(
        status_code=204,
        headers={
            "Tus-Resumable": TUS_VERSION,
            "Tus-Version": TUS_VERSION,
            "Tus-Extension": "creation,creation-with-upload,termination",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "HEAD, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Upload-Offset, Content-Type, Tus-Resumable",
            "Access-Control-Expose-Headers": "Upload-Offset, Upload-Length",
        }
    )


@router.head("/files/{upload_id}")
async def tus_check_offset(
    upload_id: str,
    current_user = Depends(get_current_user),
):
    """
    TUS HEAD endpoint - Check current upload offset
    """
    upload_path = get_upload_path(upload_id)
    metadata_path = get_metadata_path(upload_id)
    
    if not upload_path.exists() or not metadata_path.exists():
        raise HTTPException(status_code=404, detail="Upload not found")
    
    # Get current file size (offset)
    current_offset = upload_path.stat().st_size
    
    # Get expected total length from metadata
    with open(metadata_path, 'r') as f:
        upload_length = int(f.readline().strip())
    
    return Response(
        status_code=200,
        headers={
            "Tus-Resumable": TUS_VERSION,
            "Upload-Offset": str(current_offset),
            "Upload-Length": str(upload_length),
            "Cache-Control": "no-store",
            "Access-Control-Expose-Headers": "Upload-Offset, Upload-Length",
        }
    )


@router.patch("/files/{upload_id}")
async def tus_upload_chunk(
    upload_id: str,
    request: Request,
    upload_offset: int = Header(..., alias="Upload-Offset"),
    content_type: str = Header(..., alias="Content-Type"),
    current_user = Depends(get_current_user),
):
    """
    TUS PATCH endpoint - Upload a chunk of the file
    """
    upload_path = get_upload_path(upload_id)
    metadata_path = get_metadata_path(upload_id)
    
    if not upload_path.exists() or not metadata_path.exists():
        raise HTTPException(status_code=404, detail="Upload not found")
    
    # Verify content type
    if content_type != "application/offset+octet-stream":
        raise HTTPException(
            status_code=415,
            detail="Content-Type must be application/offset+octet-stream"
        )
    
    # Verify offset matches current file size
    current_size = upload_path.stat().st_size
    if current_size != upload_offset:
        raise HTTPException(
            status_code=409,
            detail=f"Upload offset mismatch. Expected {current_size}, got {upload_offset}"
        )
    
    # Read expected length from metadata
    with open(metadata_path, 'r') as f:
        expected_length = int(f.readline().strip())
    
    # Write chunk to file
    bytes_written = 0
    chunk_size = 1024 * 1024  # 1MB chunks
    
    with open(upload_path, 'ab') as f:
        async for chunk in request.stream():
            f.write(chunk)
            bytes_written += len(chunk)
    
    # Get new offset
    new_offset = upload_path.stat().st_size
    
    # Check if upload is complete
    if new_offset >= expected_length:
        # Move to final location (implement your own logic here)
        # For now, just mark as complete
        print(f"Upload {upload_id} complete: {new_offset} bytes")
    
    return Response(
        status_code=204,
        headers={
            "Tus-Resumable": TUS_VERSION,
            "Upload-Offset": str(new_offset),
            "Access-Control-Expose-Headers": "Upload-Offset",
        }
    )


@router.delete("/files/{upload_id}")
async def tus_delete_upload(
    upload_id: str,
    current_user = Depends(get_current_user),
):
    """
    TUS DELETE endpoint - Cancel and delete an upload
    """
    upload_path = get_upload_path(upload_id)
    metadata_path = get_metadata_path(upload_id)
    
    if upload_path.exists():
        upload_path.unlink()
    
    if metadata_path.exists():
        metadata_path.unlink()
    
    return Response(
        status_code=204,
        headers={
            "Tus-Resumable": TUS_VERSION,
        }
    )