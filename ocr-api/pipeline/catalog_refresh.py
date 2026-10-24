from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import random
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

MUSIC_DATA_URL = "https://maimai.diving-fish.com/api/maimaidxprober/music_data"
DIVING_FISH_COVER_URL = "https://www.diving-fish.com/covers/{cover_id}.png"
LXNS_COVER_URL = "https://assets.lxns.net/maimai/jacket/{music_id}.png!webp"
USER_AGENT = "maimai-score-hub-ocr-catalog/1.0"
# RGB pixel hash of LXNS's HTTP-200 "暂时无法查看" image. Check pixels,
# not encoded bytes: download_cover normalizes both WebP and PNG to PNG.
PLACEHOLDER_PIXEL_HASHES = {
    "ad815884c537efe2c6cd3436e01b72df933ddb602b881fe116fba0ebb947644c",
}
PIPELINE_ROOT = Path(__file__).resolve().parent
if str(PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPELINE_ROOT))


@dataclass(frozen=True)
class CatalogPaths:
    pipeline_root: Path
    state_root: Path

    @property
    def bundled_data(self) -> Path:
        return self.pipeline_root / "data"

    @property
    def models(self) -> Path:
        return self.pipeline_root / "models"

    @property
    def covers(self) -> Path:
        return self.state_root / "covers"

    @property
    def galleries(self) -> Path:
        return self.state_root / "galleries"

    @property
    def music_data(self) -> Path:
        return self.state_root / "music_data.json"

    @property
    def titles(self) -> Path:
        return self.state_root / "titles.json"

    @property
    def cover_manifest(self) -> Path:
        return self.state_root / "cover_manifest.json"

    @property
    def cover_gallery(self) -> Path:
        return self.galleries / "cover_arcface_v2_gallery.npz"

    @property
    def title_gallery(self) -> Path:
        return self.galleries / "title_arcface_v1_gallery.npz"

    @property
    def status(self) -> Path:
        return self.state_root / "status.json"


@dataclass(frozen=True)
class CoverCacheResult:
    requested: int
    cached: int
    downloaded: int
    failed: int


@dataclass(frozen=True)
class RefreshResult:
    checkedAt: str
    durationMs: int
    source: str
    catalogChanged: bool
    galleryChanged: bool
    songs: int
    titles: int
    coverGalleryTitles: int
    titleGalleryTitles: int
    cachedCovers: int
    downloadedCovers: int
    failedCovers: int
    rebuiltCoverTitles: int
    removedCoverTitles: int
    removedTitleTitles: int


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_bytes(data)
    os.replace(temporary, path)


def _atomic_write_json(path: Path, payload: object) -> None:
    data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    _atomic_write_bytes(path, data)


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _fetch_json(url: str, timeout_seconds: float) -> Any:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=timeout_seconds) as response:
        return json.loads(response.read())


def normalize_songs(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, list):
        raise ValueError("music catalog must be a JSON array")
    songs: list[dict[str, Any]] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        music_id = str(item.get("id", "")).strip()
        title = item.get("title")
        if not music_id.isdigit() or not isinstance(title, str) or not title.strip():
            continue
        row = dict(item)
        row["id"] = music_id
        row["title"] = title.strip()
        songs.append(row)
    if not songs:
        raise ValueError("music catalog contains no valid songs")
    return songs


def build_title_index(songs: Iterable[dict[str, Any]]) -> dict[str, object]:
    titles: list[str] = []
    title_to_ids: dict[str, list[str]] = {}
    id_to_title: dict[str, str] = {}
    for song in songs:
        music_id = str(song["id"])
        title = str(song["title"])
        id_to_title[music_id] = title
        if title not in title_to_ids:
            titles.append(title)
            title_to_ids[title] = []
        title_to_ids[title].append(music_id)
    return {
        "titles": titles,
        "title_to_ids": title_to_ids,
        "id_to_title": id_to_title,
    }


def _cover_music_id(music_id: str) -> str:
    numeric = int(music_id)
    # Utage adds 100000 to the underlying SD/DX ID; retain DX's 10000.
    return str(numeric % 100_000) if numeric >= 100_000 else str(numeric)


def _cover_filename(music_id: str) -> str:
    return f"{_cover_music_id(music_id).zfill(5)}.png"


def _decode_cover(data: bytes) -> Any:
    from PIL import Image

    if len(data) <= 256:
        raise ValueError("cover is too small")
    with Image.open(io.BytesIO(data)) as source:
        image = source.convert("RGB")
    if hashlib.sha256(image.tobytes()).hexdigest() in PLACEHOLDER_PIXEL_HASHES:
        raise ValueError("upstream returned a placeholder cover")
    return image


def _valid_cached_cover(path: Path) -> bool:
    try:
        _decode_cover(path.read_bytes())
        return True
    except (OSError, ValueError):
        return False


def download_cover(music_id: str, timeout_seconds: float = 20.0) -> bytes:
    cover_id = _cover_music_id(music_id)
    urls = (
        DIVING_FISH_COVER_URL.format(cover_id=cover_id.zfill(5)),
        # LXNS shares one jacket ID between SD and DX (11820 -> 1820).
        LXNS_COVER_URL.format(music_id=int(cover_id) % 10_000),
    )
    last_error: Exception | None = None
    for url in urls:
        try:
            request = Request(url, headers={"User-Agent": USER_AGENT})
            with urlopen(request, timeout=timeout_seconds) as response:
                source = response.read()
            image = _decode_cover(source)
            output = io.BytesIO()
            image.save(output, format="PNG")
            data = output.getvalue()
            if len(data) > 256:
                return data
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as error:
            last_error = error
    raise RuntimeError(f"cover download failed for {music_id}: {last_error}")


def sync_cover_cache(
    songs: Iterable[dict[str, Any]],
    cache_dir: Path,
    *,
    workers: int = 6,
    fetcher: Callable[[str], bytes] = download_cover,
) -> CoverCacheResult:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cover_ids = sorted({_cover_music_id(str(song["id"])) for song in songs})
    missing = [
        cover_id
        for cover_id in cover_ids
        if not _valid_cached_cover(cache_dir / _cover_filename(cover_id))
    ]
    downloaded = 0
    failed = 0

    def fetch_one(cover_id: str) -> bool:
        target = cache_dir / _cover_filename(cover_id)
        if _valid_cached_cover(target):
            return False
        data = fetcher(cover_id)
        _decode_cover(data)
        _atomic_write_bytes(target, data)
        return True

    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = {executor.submit(fetch_one, cover_id): cover_id for cover_id in missing}
        for future in as_completed(futures):
            try:
                downloaded += int(future.result())
            except Exception:
                failed += 1

    cached = sum(
        _valid_cached_cover(cache_dir / _cover_filename(cover_id))
        for cover_id in cover_ids
    )
    return CoverCacheResult(
        requested=len(cover_ids),
        cached=cached,
        downloaded=downloaded,
        failed=failed,
    )


def build_cover_manifest(
    songs: Iterable[dict[str, Any]],
    cache_dir: Path,
) -> dict[str, object]:
    entries: list[dict[str, str]] = []
    missing: list[dict[str, str]] = []
    classes: set[str] = set()
    seen_entries: set[tuple[str, str]] = set()
    file_hashes: dict[Path, str | None] = {}
    for song in songs:
        music_id = str(song["id"])
        title = str(song["title"])
        classes.add(title)
        path = cache_dir / _cover_filename(music_id)
        entry_key = (str(path), title)
        if path not in file_hashes:
            file_hashes[path] = (
                hashlib.sha256(path.read_bytes()).hexdigest()
                if _valid_cached_cover(path) else None
            )
        if file_hashes[path] is not None:
            if entry_key not in seen_entries:
                entries.append({
                    "path": str(path), "id": music_id, "title": title,
                    "sha256": file_hashes[path],
                })
                seen_entries.add(entry_key)
        else:
            missing.append({"id": music_id, "title": title})
    return {
        "covers": entries,
        "classes": sorted(classes),
        "missing": missing,
        "generatedAt": _now_iso(),
    }


def _load_gallery(path: Path) -> tuple[list[str], Any]:
    import numpy as np

    with np.load(path, allow_pickle=True) as data:
        titles = [str(title) for title in data["titles"]]
        embeddings = data["embeddings"].astype(np.float32)
    return titles, embeddings


def _load_cover_fingerprints(path: Path) -> dict[str, str] | None:
    import numpy as np

    with np.load(path, allow_pickle=True) as data:
        if "source_fingerprints" not in data:
            return None
        return json.loads(str(data["source_fingerprints"].item()))


def _manifest_fingerprints(manifest: dict[str, Any]) -> dict[str, str]:
    by_title: dict[str, set[str]] = {}
    for entry in manifest["covers"]:
        by_title.setdefault(entry["title"], set()).add(entry["sha256"])
    return {
        title: hashlib.sha256("\n".join(sorted(hashes)).encode()).hexdigest()
        for title, hashes in by_title.items()
    }


def _stage_gallery(
    path: Path,
    titles: list[str],
    embeddings: Any,
    *,
    source_fingerprints: dict[str, str] | None = None,
) -> Path:
    import numpy as np

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("wb") as output:
        np.savez(
            output,
            titles=np.array(titles, dtype=object),
            embeddings=embeddings,
            **({"source_fingerprints": json.dumps(source_fingerprints, sort_keys=True)}
               if source_fingerprints is not None else {}),
        )
    return temporary


def _merge_gallery(
    existing_titles: list[str],
    existing_embeddings: Any,
    additions: dict[str, Any],
) -> tuple[list[str], Any]:
    import numpy as np

    by_title = {
        title: existing_embeddings[index]
        for index, title in enumerate(existing_titles)
    }
    by_title.update(additions)
    titles = sorted(by_title)
    embeddings = (
        np.stack([by_title[title] for title in titles]).astype(np.float32)
        if titles else np.empty((0, existing_embeddings.shape[1]), dtype=np.float32)
    )
    return titles, embeddings


def _build_cover_additions(
    missing_titles: list[str],
    manifest: dict[str, object],
    paths: CatalogPaths,
    *,
    device: str,
    tta: int,
) -> dict[str, Any]:
    import numpy as np
    import torch
    import torch.nn.functional as functional
    from PIL import Image

    from final.cover_arcface_pipeline import _load_embedder
    from scripts.build_cover_gallery import embed_one

    wanted = set(missing_titles)
    by_title: dict[str, list[str]] = {}
    for entry in manifest["covers"]:  # type: ignore[index]
        title = str(entry["title"])
        if title in wanted:
            by_title.setdefault(title, []).append(str(entry["path"]))

    resolved_device = torch.device(device)
    model, _, _, transform = _load_embedder(
        paths.models / "cover_arcface_v2.pt",
        resolved_device,
    )
    additions: dict[str, Any] = {}
    for title in missing_titles:
        samples = []
        for source_path in by_title.get(title, []):
            image = Image.open(source_path).convert("RGB")
            samples.append(
                embed_one(
                    model,
                    transform,
                    image,
                    resolved_device,
                    n_tta=max(1, tta),
                )
            )
        if samples:
            embedding = np.mean(np.stack(samples), axis=0)
            embedding = functional.normalize(
                torch.from_numpy(embedding), dim=0
            ).numpy()
            additions[title] = embedding.astype(np.float32)
    return additions


def _build_title_additions(
    missing_titles: list[str],
    paths: CatalogPaths,
    *,
    device: str,
    samples_per_title: int,
) -> dict[str, Any]:
    import torch
    import torch.nn.functional as functional

    from scripts.build_title_gallery import _load_model, embed_batch
    from training.title_synth import render_one_rgb

    resolved_device = torch.device(device)
    model, _, image_height, image_width, _ = _load_model(
        str(paths.models / "title_arcface_v1.pt"),
        resolved_device,
    )
    additions: dict[str, Any] = {}
    for title in missing_titles:
        seed = int.from_bytes(hashlib.sha256(title.encode("utf-8")).digest()[:8])
        random_source = random.Random(seed)
        images = [
            render_one_rgb(title, random_source)
            for _ in range(max(1, samples_per_title))
        ]
        embeddings = embed_batch(
            model,
            images,
            image_height,
            image_width,
            resolved_device,
        )
        prototype = functional.normalize(embeddings.mean(dim=0), dim=0)
        additions[title] = prototype.cpu().numpy()
    return additions


def ensure_seed_galleries(paths: CatalogPaths) -> None:
    paths.galleries.mkdir(parents=True, exist_ok=True)
    seeds = (
        (paths.models / "cover_arcface_v2_gallery.npz", paths.cover_gallery),
        (paths.models / "title_arcface_v1_gallery.npz", paths.title_gallery),
    )
    for source, destination in seeds:
        if not destination.exists():
            shutil.copy2(source, destination)


def refresh_catalog(
    paths: CatalogPaths,
    *,
    catalog_url: str = MUSIC_DATA_URL,
    timeout_seconds: float = 30.0,
    cover_workers: int = 6,
    build_device: str = "cpu",
    cover_tta: int = 1,
    title_samples: int = 8,
) -> RefreshResult:
    started_at = time.monotonic()
    paths.state_root.mkdir(parents=True, exist_ok=True)
    ensure_seed_galleries(paths)

    source = "remote"
    try:
        songs = normalize_songs(_fetch_json(catalog_url, timeout_seconds))
    except Exception:
        source = "cached"
        fallback = paths.music_data
        if not fallback.exists():
            fallback = paths.bundled_data / "music_data.json"
            source = "bundled"
        songs = normalize_songs(_read_json(fallback))

    encoded_catalog = json.dumps(
        songs,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    previous_hash = (
        hashlib.sha256(paths.music_data.read_bytes()).hexdigest()
        if paths.music_data.exists()
        else None
    )
    next_hash = hashlib.sha256(encoded_catalog).hexdigest()
    catalog_changed = previous_hash != next_hash
    _atomic_write_bytes(paths.music_data, encoded_catalog)

    title_index = build_title_index(songs)
    _atomic_write_json(paths.titles, title_index)
    desired_titles = [str(title) for title in title_index["titles"]]  # type: ignore[index]

    cover_cache = sync_cover_cache(
        songs,
        paths.covers,
        workers=cover_workers,
    )
    manifest = build_cover_manifest(songs, paths.covers)
    _atomic_write_json(paths.cover_manifest, manifest)

    cover_titles, cover_embeddings = _load_gallery(paths.cover_gallery)
    title_titles, title_embeddings = _load_gallery(paths.title_gallery)
    desired_fingerprints = _manifest_fingerprints(manifest)
    stored_fingerprints = _load_cover_fingerprints(paths.cover_gallery)
    seed_titles = set(_load_gallery(paths.models / "cover_arcface_v2_gallery.npz")[0])
    if stored_fingerprints is None:
        # Legacy runtime additions may encode placeholders even when the cache
        # has since been repaired. Rebuild ALL untracked additions, preserving
        # the trusted bundled prototypes (which include real training crops).
        cover_fingerprints = {
            title: desired_fingerprints[title]
            for title in cover_titles
            if title in seed_titles and title in desired_fingerprints
        }
    else:
        cover_fingerprints = dict(stored_fingerprints)
    missing_cover_titles = sorted(
        title for title, fingerprint in desired_fingerprints.items()
        if title not in cover_titles or cover_fingerprints.get(title) != fingerprint
    )
    missing_title_titles = sorted(set(desired_titles) - set(title_titles))

    # Only an authoritative remote catalog may retire old/renamed labels.
    desired_set = set(desired_titles)
    removed_cover_titles = {
        title for title in cover_titles
        if (source == "remote" and title not in desired_set)
        or (title in desired_set and title not in desired_fingerprints
            and title not in seed_titles)
    }
    removed_title_titles = (
        set(title_titles) - desired_set if source == "remote" else set()
    )

    cover_additions = (
        _build_cover_additions(
            missing_cover_titles,
            manifest,
            paths,
            device=build_device,
            tta=cover_tta,
        )
        if missing_cover_titles
        else {}
    )
    title_additions = (
        _build_title_additions(
            missing_title_titles,
            paths,
            device=build_device,
            samples_per_title=title_samples,
        )
        if missing_title_titles
        else {}
    )
    next_fingerprints = {
        title: fingerprint for title, fingerprint in cover_fingerprints.items()
        if title not in removed_cover_titles
    }
    next_fingerprints.update({
        title: desired_fingerprints[title] for title in cover_additions
    })
    gallery_changed = bool(
        cover_additions or title_additions or removed_cover_titles or removed_title_titles
    )
    if gallery_changed or stored_fingerprints != next_fingerprints:
        cover_indices = [i for i, t in enumerate(cover_titles) if t not in removed_cover_titles]
        title_indices = [i for i, t in enumerate(title_titles) if t not in removed_title_titles]
        merged_cover_titles, merged_cover_embeddings = _merge_gallery(
            [cover_titles[i] for i in cover_indices],
            cover_embeddings[cover_indices],
            cover_additions,
        )
        merged_title_titles, merged_title_embeddings = _merge_gallery(
            [title_titles[i] for i in title_indices],
            title_embeddings[title_indices],
            title_additions,
        )
        staged_cover = _stage_gallery(
            paths.cover_gallery,
            merged_cover_titles,
            merged_cover_embeddings,
            source_fingerprints=next_fingerprints,
        )
        staged_title = _stage_gallery(
            paths.title_gallery,
            merged_title_titles,
            merged_title_embeddings,
        )
        os.replace(staged_cover, paths.cover_gallery)
        os.replace(staged_title, paths.title_gallery)
        cover_titles = merged_cover_titles
        title_titles = merged_title_titles

    result = RefreshResult(
        checkedAt=_now_iso(),
        durationMs=round((time.monotonic() - started_at) * 1000),
        source=source,
        catalogChanged=catalog_changed,
        galleryChanged=gallery_changed,
        songs=len(songs),
        titles=len(desired_titles),
        coverGalleryTitles=len(cover_titles),
        titleGalleryTitles=len(title_titles),
        cachedCovers=cover_cache.cached,
        downloadedCovers=cover_cache.downloaded,
        failedCovers=cover_cache.failed,
        rebuiltCoverTitles=len(cover_additions),
        removedCoverTitles=len(removed_cover_titles),
        removedTitleTitles=len(removed_title_titles),
    )
    _atomic_write_json(paths.status, asdict(result))
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Refresh OCR music galleries")
    parser.add_argument("--pipeline-root", required=True)
    parser.add_argument("--state-root", required=True)
    parser.add_argument("--catalog-url", default=MUSIC_DATA_URL)
    parser.add_argument("--timeout-seconds", type=float, default=30.0)
    parser.add_argument("--cover-workers", type=int, default=6)
    parser.add_argument("--build-device", default="cpu")
    parser.add_argument("--cover-tta", type=int, default=1)
    parser.add_argument("--title-samples", type=int, default=8)
    arguments = parser.parse_args()
    result = refresh_catalog(
        CatalogPaths(
            pipeline_root=Path(arguments.pipeline_root).resolve(),
            state_root=Path(arguments.state_root).resolve(),
        ),
        catalog_url=arguments.catalog_url,
        timeout_seconds=arguments.timeout_seconds,
        cover_workers=arguments.cover_workers,
        build_device=arguments.build_device,
        cover_tta=arguments.cover_tta,
        title_samples=arguments.title_samples,
    )
    print(json.dumps(asdict(result), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
