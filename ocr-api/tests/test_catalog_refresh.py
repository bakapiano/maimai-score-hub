from __future__ import annotations

import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

import numpy as np
from PIL import Image

from pipeline.catalog_refresh import (
    CatalogPaths,
    _valid_cached_cover,
    build_cover_manifest,
    build_title_index,
    download_cover,
    normalize_songs,
    refresh_catalog,
    sync_cover_cache,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"
PLACEHOLDER = base64.b64decode((FIXTURES / "lxns-unavailable.png.b64").read_text())


def image_bytes(color: str = "purple") -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (400, 400), color).save(output, format="PNG")
    return output.getvalue()


def write_gallery(path: Path, titles: list[str], embeddings: list[list[float]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(path, titles=np.array(titles, dtype=object),
             embeddings=np.array(embeddings, dtype=np.float32))


class CatalogRefreshTest(unittest.TestCase):
    def test_title_index_preserves_candidate_order_and_duplicate_ids(self) -> None:
        songs = normalize_songs(
            [
                {"id": 1, "title": "Song A"},
                {"id": 2, "title": "Song B"},
                {"id": 100001, "title": "Song A"},
            ]
        )

        index = build_title_index(songs)

        self.assertEqual(index["titles"], ["Song A", "Song B"])
        self.assertEqual(index["title_to_ids"]["Song A"], ["1", "100001"])
        self.assertEqual(index["id_to_title"]["2"], "Song B")

    def test_cover_cache_reuses_existing_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary)
            cached_cover = cache / "00123.png"
            cached_cover.write_bytes(image_bytes())

            def unexpected_fetch(_: str) -> bytes:
                raise AssertionError("cached cover should not be downloaded")

            result = sync_cover_cache(
                [{"id": "123", "title": "Song"}],
                cache,
                fetcher=unexpected_fetch,
            )

            self.assertEqual(result.cached, 1)
            self.assertEqual(result.downloaded, 0)
            self.assertEqual(result.failed, 0)

    def test_cover_cache_downloads_once_and_reuses_utage_base_cover(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary)
            calls: list[str] = []

            def fetch(cover_id: str) -> bytes:
                calls.append(cover_id)
                return image_bytes()

            songs = [
                {"id": "123", "title": "Song"},
                {"id": "100123", "title": "Song Utage"},
            ]
            first = sync_cover_cache(songs, cache, fetcher=fetch)
            second = sync_cover_cache(songs, cache, fetcher=fetch)
            manifest = build_cover_manifest(songs, cache)

            self.assertEqual(calls, ["123"])
            self.assertEqual(first.downloaded, 1)
            self.assertEqual(second.downloaded, 0)
            self.assertEqual(len(manifest["covers"]), 2)
            self.assertEqual(manifest["missing"], [])

    def test_rejects_real_lxns_placeholder_and_corrupt_cache(self) -> None:
        webp = io.BytesIO()
        Image.open(io.BytesIO(PLACEHOLDER)).save(webp, format="WEBP", lossless=True)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "11820.png"
            for data in (PLACEHOLDER, webp.getvalue(), b"not an image" * 100):
                with self.subTest(data_length=len(data)):
                    path.write_bytes(data)
                    self.assertFalse(_valid_cached_cover(path))
            path.write_bytes(image_bytes())
            self.assertTrue(_valid_cached_cover(path))

    def test_fallback_converts_dx_and_utage_ids_for_each_source(self) -> None:
        for music_id, fish_id, lxns_id in (
            ("11820", "11820", "1820"),
            ("123", "00123", "123"),
            ("111820", "11820", "1820"),
            ("100123", "00123", "123"),
        ):
            with self.subTest(music_id=music_id):
                urls = []

                def fetch(request, **kwargs):
                    urls.append(request.full_url)
                    if len(urls) == 1:
                        raise HTTPError(request.full_url, 404, "Not found", {}, None)
                    return io.BytesIO(image_bytes())

                with patch("pipeline.catalog_refresh.urlopen", side_effect=fetch):
                    self.assertEqual(download_cover(music_id), image_bytes())
                self.assertEqual(urls, [
                    f"https://www.diving-fish.com/covers/{fish_id}.png",
                    f"https://assets.lxns.net/maimai/jacket/{lxns_id}.png!webp",
                ])

    def test_downloader_skips_http_200_placeholder(self) -> None:
        with patch("pipeline.catalog_refresh.urlopen", side_effect=[
            io.BytesIO(PLACEHOLDER), io.BytesIO(image_bytes()),
        ]) as fetch:
            self.assertEqual(download_cover("11820"), image_bytes())
            self.assertEqual(fetch.call_count, 2)
        with patch("pipeline.catalog_refresh.urlopen", side_effect=[
            io.BytesIO(PLACEHOLDER), io.BytesIO(PLACEHOLDER),
        ]):
            with self.assertRaises(RuntimeError):
                download_cover("11820")

    def test_repairs_placeholder_cache_and_excludes_failed_repairs(self) -> None:
        songs = [{"id": "11820", "title": "Xaleid◆scopiX"}]
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary)
            path = cache / "11820.png"
            path.write_bytes(PLACEHOLDER)
            result = sync_cover_cache(songs, cache, fetcher=lambda _: PLACEHOLDER)
            self.assertEqual(result.failed, 1)
            self.assertEqual(result.cached, 0)
            self.assertEqual(build_cover_manifest(songs, cache)["covers"], [])
            result = sync_cover_cache(songs, cache, fetcher=lambda _: image_bytes())
            self.assertEqual(result.downloaded, 1)
            self.assertEqual(result.failed, 0)
            self.assertEqual(path.read_bytes(), image_bytes())


class GalleryRepairTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.paths = CatalogPaths(root / "pipeline", root / "catalog")
        self.paths.covers.mkdir(parents=True)
        self.songs = [
            {"id": "1", "title": "Seed"},
            {"id": "11820", "title": "Xaleid◆scopiX"},
        ]
        for name in ("cover_arcface_v2_gallery.npz", "title_arcface_v1_gallery.npz"):
            write_gallery(self.paths.models / name, ["Seed"], [[1, 0]])
            write_gallery(self.paths.galleries / name,
                          ["Seed", "Xaleid◆scopiX", "Xaleid◆scopiX (2)"],
                          [[1, 0], [-1, 0], [-1, 0]])
        (self.paths.covers / "00001.png").write_bytes(image_bytes("blue"))
        (self.paths.covers / "11820.png").write_bytes(PLACEHOLDER)
        self.fetch = self.enterContext(patch(
            "pipeline.catalog_refresh._fetch_json", return_value=self.songs))
        self.network = self.enterContext(patch(
            "pipeline.catalog_refresh.urlopen", side_effect=lambda *a, **k: io.BytesIO(image_bytes())))
        self.cover_builder = self.enterContext(patch(
            "pipeline.catalog_refresh._build_cover_additions",
            side_effect=lambda titles, *a, **k: {t: np.array([0, 1], dtype=np.float32) for t in titles}))
        self.title_builder = self.enterContext(patch(
            "pipeline.catalog_refresh._build_title_additions",
            side_effect=lambda titles, *a, **k: {t: np.array([0, 1], dtype=np.float32) for t in titles}))

    def test_migrates_legacy_gallery_preserves_seed_and_removes_obsolete_title(self) -> None:
        result = refresh_catalog(self.paths)
        self.assertTrue(result.galleryChanged)
        self.assertEqual(result.downloadedCovers, 1)
        self.assertEqual(self.cover_builder.call_args.args[0], ["Xaleid◆scopiX"])
        with np.load(self.paths.cover_gallery, allow_pickle=True) as gallery:
            self.assertEqual(list(gallery["titles"]), ["Seed", "Xaleid◆scopiX"])
            np.testing.assert_array_equal(gallery["embeddings"], [[1, 0], [0, 1]])
            self.assertIn("source_fingerprints", gallery)
        with np.load(self.paths.title_gallery, allow_pickle=True) as gallery:
            self.assertNotIn("Xaleid◆scopiX (2)", gallery["titles"])
        again = refresh_catalog(self.paths)
        self.assertFalse(again.galleryChanged)
        self.assertEqual(again.downloadedCovers, 0)
        self.assertEqual(self.cover_builder.call_count, 1)

    def test_rebuilds_existing_title_when_cover_content_changes(self) -> None:
        refresh_catalog(self.paths)
        (self.paths.covers / "11820.png").write_bytes(image_bytes("red"))
        self.cover_builder.reset_mock()
        result = refresh_catalog(self.paths)
        self.assertTrue(result.galleryChanged)
        self.assertEqual(self.cover_builder.call_args.args[0], ["Xaleid◆scopiX"])
        self.assertFalse(refresh_catalog(self.paths).galleryChanged)

    def test_changed_cover_build_failure_does_not_advance_saved_fingerprint(self) -> None:
        refresh_catalog(self.paths)
        saved = self.paths.cover_gallery.read_bytes()
        (self.paths.covers / "11820.png").write_bytes(image_bytes("red"))
        self.cover_builder.side_effect = RuntimeError("build interrupted")
        with self.assertRaisesRegex(RuntimeError, "build interrupted"):
            refresh_catalog(self.paths)
        self.assertEqual(self.paths.cover_gallery.read_bytes(), saved)
        self.cover_builder.side_effect = lambda titles, *a, **k: {
            t: np.array([0, 1], dtype=np.float32) for t in titles}
        self.assertTrue(refresh_catalog(self.paths).galleryChanged)

    def test_utage_dx_uses_same_cache_as_regular_dx(self) -> None:
        self.songs.append({"id": "111820", "title": "Utage"})
        result = refresh_catalog(self.paths)
        self.assertEqual(result.downloadedCovers, 1)
        manifest = json.loads(self.paths.cover_manifest.read_text())
        paths = [row["path"] for row in manifest["covers"] if row["id"] in {"11820", "111820"}]
        self.assertEqual(len(paths), 2)
        self.assertEqual(paths[0], paths[1])

    def test_retries_failed_build_even_after_cover_was_repaired(self) -> None:
        self.cover_builder.side_effect = RuntimeError("build interrupted")
        with self.assertRaisesRegex(RuntimeError, "build interrupted"):
            refresh_catalog(self.paths)
        self.assertEqual((self.paths.covers / "11820.png").read_bytes(), image_bytes())
        with np.load(self.paths.cover_gallery, allow_pickle=True) as gallery:
            self.assertNotIn("source_fingerprints", gallery)
        self.cover_builder.side_effect = lambda titles, *a, **k: {
            t: np.array([0, 1], dtype=np.float32) for t in titles}
        result = refresh_catalog(self.paths)
        self.assertTrue(result.galleryChanged)
        self.assertEqual(self.cover_builder.call_args.args[0], ["Xaleid◆scopiX"])

    def test_drops_poisoned_legacy_entry_if_download_still_fails(self) -> None:
        self.network.side_effect = OSError("upstream unavailable")
        result = refresh_catalog(self.paths)
        self.assertEqual(result.failedCovers, 1)
        with np.load(self.paths.cover_gallery, allow_pickle=True) as gallery:
            self.assertEqual(list(gallery["titles"]), ["Seed"])
        self.cover_builder.assert_not_called()

    def test_cached_catalog_does_not_prune_titles_on_network_failure(self) -> None:
        self.paths.music_data.write_text(json.dumps(self.songs))
        self.fetch.side_effect = OSError("catalog unavailable")
        result = refresh_catalog(self.paths)
        self.assertEqual(result.source, "cached")
        with np.load(self.paths.title_gallery, allow_pickle=True) as gallery:
            self.assertIn("Xaleid◆scopiX (2)", gallery["titles"])


if __name__ == "__main__":
    unittest.main()
