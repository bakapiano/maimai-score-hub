from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from pipeline.catalog_refresh import (
    build_cover_manifest,
    build_title_index,
    normalize_songs,
    sync_cover_cache,
)


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
            cached_cover.write_bytes(b"cached" * 64)

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
                return b"png" * 100

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


if __name__ == "__main__":
    unittest.main()
