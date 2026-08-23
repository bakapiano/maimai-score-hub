from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import Settings
from .recognizer import Recognizer

LOGGER = logging.getLogger("ocr.catalog")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class CatalogScheduler:
    def __init__(self, settings: Settings, recognizer: Recognizer):
        self.settings = settings
        self.recognizer = recognizer
        self._task: asyncio.Task[None] | None = None
        self._status: dict[str, Any] = {
            "enabled": settings.catalog_enabled and settings.mode == "real",
            "running": False,
            "lastCheckAt": None,
            "lastSuccessAt": None,
            "lastError": None,
            "result": None,
        }

    def status(self) -> dict[str, Any]:
        return dict(self._status)

    async def start(self) -> None:
        if not self._status["enabled"] or self._task is not None:
            return
        self._task = asyncio.create_task(
            self._run_loop(), name="ocr-catalog-refresh"
        )

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    async def _run_loop(self) -> None:
        await asyncio.sleep(self.settings.catalog_initial_delay_seconds)
        while True:
            await self.refresh()
            await asyncio.sleep(self.settings.catalog_refresh_seconds)

    async def refresh(self) -> None:
        self._status.update(
            {"running": True, "lastCheckAt": _now_iso(), "lastError": None}
        )
        pipeline_root = Path(self.settings.pipeline_root).resolve()
        state_root = Path(self.settings.catalog_root).resolve()
        command = [
            sys.executable,
            str(pipeline_root / "catalog_refresh.py"),
            "--pipeline-root",
            str(pipeline_root),
            "--state-root",
            str(state_root),
            "--catalog-url",
            self.settings.catalog_url,
            "--cover-workers",
            str(self.settings.catalog_cover_workers),
            "--build-device",
            self.settings.catalog_build_device,
        ]
        environment = os.environ.copy()
        current_python_path = environment.get("PYTHONPATH", "")
        environment["PYTHONPATH"] = os.pathsep.join(
            item
            for item in (str(pipeline_root), current_python_path)
            if item
        )
        process: asyncio.subprocess.Process | None = None
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=environment,
            )
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=self.settings.catalog_refresh_timeout_seconds,
                )
            except TimeoutError as error:
                process.kill()
                await process.wait()
                raise RuntimeError("catalog refresh timed out") from error
            if process.returncode != 0:
                message = stderr.decode("utf-8", errors="replace").strip()
                raise RuntimeError(
                    f"catalog refresh exited {process.returncode}: {message[-1000:]}"
                )
            lines = [
                line
                for line in stdout.decode("utf-8", errors="replace").splitlines()
                if line.strip()
            ]
            result = json.loads(lines[-1])
            if result.get("galleryChanged"):
                reloader = getattr(self.recognizer, "reload_catalog", None)
                if callable(reloader):
                    await asyncio.to_thread(
                        reloader,
                        state_root
                        / "galleries"
                        / "cover_arcface_v2_gallery.npz",
                        state_root
                        / "galleries"
                        / "title_arcface_v1_gallery.npz",
                    )
            self._status.update(
                {
                    "lastSuccessAt": _now_iso(),
                    "lastError": None,
                    "result": result,
                }
            )
            LOGGER.info(
                "OCR catalog refresh completed: songs=%s titles=%s "
                "downloaded_covers=%s gallery_changed=%s",
                result.get("songs"),
                result.get("titles"),
                result.get("downloadedCovers"),
                result.get("galleryChanged"),
            )
        except asyncio.CancelledError:
            if process is not None and process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=10)
                except TimeoutError:
                    process.kill()
                    await process.wait()
            raise
        except Exception as error:
            self._status["lastError"] = str(error)
            LOGGER.exception("OCR catalog refresh failed")
        finally:
            self._status["running"] = False
