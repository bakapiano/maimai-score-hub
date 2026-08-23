from __future__ import annotations

import asyncio
import hmac
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, Request, UploadFile

from .config import Settings
from .catalog import CatalogScheduler
from .models import BatchRecognitionResponse, RecognitionItem
from .recognizer import Recognizer, build_recognizer

ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}


def create_app(
    settings: Settings | None = None,
    recognizer: Recognizer | None = None,
) -> FastAPI:
    resolved_settings = settings or Settings.from_env()
    resolved_recognizer = recognizer or build_recognizer(resolved_settings)
    semaphore = asyncio.Semaphore(resolved_settings.concurrency)
    catalog = CatalogScheduler(resolved_settings, resolved_recognizer)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await catalog.start()
        try:
            yield
        finally:
            await catalog.stop()

    app = FastAPI(
        title="maimai Score Hub OCR API",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.catalog = catalog

    @app.get("/healthz")
    async def healthz() -> dict[str, object]:
        return {
            "status": "ok",
            "mode": resolved_settings.mode,
            "maxFiles": resolved_settings.max_files,
            "catalog": catalog.status(),
        }

    @app.post("/v1/recognize", response_model=BatchRecognitionResponse)
    async def recognize(
        request: Request,
        images: list[UploadFile] = File(...),
    ) -> BatchRecognitionResponse:
        if resolved_settings.token:
            expected = f"Bearer {resolved_settings.token}"
            actual = request.headers.get("Authorization", "")
            if not hmac.compare_digest(actual, expected):
                raise HTTPException(status_code=401, detail="invalid OCR API token")
        if not images or len(images) > resolved_settings.max_files:
            raise HTTPException(
                status_code=400,
                detail=f"images must contain 1..{resolved_settings.max_files} files",
            )

        payloads: list[tuple[int, str, bytes]] = []
        for index, image in enumerate(images):
            if image.content_type not in ALLOWED_IMAGE_TYPES:
                raise HTTPException(
                    status_code=415,
                    detail=f"unsupported image type: {image.content_type}",
                )
            body = await image.read(resolved_settings.max_file_bytes + 1)
            if not body:
                raise HTTPException(status_code=400, detail="empty image")
            if len(body) > resolved_settings.max_file_bytes:
                raise HTTPException(status_code=413, detail="image too large")
            payloads.append((index, image.filename or f"image-{index + 1}", body))

        async def run_one(index: int, filename: str, body: bytes) -> RecognitionItem:
            async with semaphore:
                try:
                    return await asyncio.to_thread(
                        resolved_recognizer.recognize,
                        body,
                        filename,
                        index,
                    )
                except Exception as error:  # keep one bad image from losing the batch
                    return RecognitionItem(
                        index=index,
                        filename=filename,
                        status="error",
                        error=str(error),
                    )

        results = await asyncio.gather(
            *(run_one(index, filename, body) for index, filename, body in payloads)
        )
        return BatchRecognitionResponse(results=list(results))

    return app


app = create_app()
