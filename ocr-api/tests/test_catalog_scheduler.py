from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from app.catalog import CatalogScheduler
from app.config import Settings


class CatalogReloadTest(unittest.IsolatedAsyncioTestCase):
    async def test_failed_hot_reload_retries_without_another_gallery_change(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            reloader = Mock(side_effect=[RuntimeError("reload failed"), None])
            scheduler = CatalogScheduler(
                Settings(catalog_root=temporary),
                SimpleNamespace(reload_catalog=reloader),
            )
            process = SimpleNamespace(returncode=0, communicate=AsyncMock(side_effect=[
                (json.dumps({"galleryChanged": True}).encode(), b""),
                (json.dumps({"galleryChanged": False}).encode(), b""),
            ]))
            with patch("app.catalog.asyncio.create_subprocess_exec", return_value=process):
                with self.assertLogs("ocr.catalog", level="ERROR"):
                    await scheduler.refresh()
                self.assertIn("reload failed", scheduler.status()["lastError"])
                await scheduler.refresh()
            self.assertEqual(reloader.call_count, 2)
            self.assertIsNone(scheduler.status()["lastError"])

    async def test_detects_disk_publish_even_when_refresh_reports_no_change(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            reloader = Mock()
            scheduler = CatalogScheduler(
                Settings(catalog_root=temporary),
                SimpleNamespace(reload_catalog=reloader),
            )
            gallery = Path(temporary) / "galleries" / "cover_arcface_v2_gallery.npz"
            gallery.parent.mkdir()
            gallery.write_bytes(b"published by a previous interrupted refresh")
            process = SimpleNamespace(returncode=0, communicate=AsyncMock(
                return_value=(b'{"galleryChanged": false}', b"")))
            with patch("app.catalog.asyncio.create_subprocess_exec", return_value=process):
                await scheduler.refresh()
                await scheduler.refresh()
            reloader.assert_called_once()
