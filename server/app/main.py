from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import init_db
from .routers import auth, devices, files, segments, trips, uploads, users
from app.routers import tus_upload

def create_app() -> FastAPI:
    init_db()
    app = FastAPI(title="BikeRecorder API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz() -> dict[str, str]:
        return {"status": "ready"}

    app.include_router(auth.router)
    app.include_router(users.router)
    app.include_router(devices.router)
    app.include_router(trips.router)
    app.include_router(segments.router)
    app.include_router(uploads.router)
    app.include_router(files.router)
    app.include_router(tus_upload.router)

    return app


app = create_app()
