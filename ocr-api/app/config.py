from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


DEFAULT_PIPELINE_ROOT = str(Path(__file__).resolve().parents[1] / "pipeline")


def _positive_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def _boolean(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    mode: str = "fake"
    token: str = ""
    max_files: int = 20
    max_file_bytes: int = 8 * 1024 * 1024
    concurrency: int = 2
    pipeline_root: str = DEFAULT_PIPELINE_ROOT
    device: str = "cuda"
    catalog_enabled: bool = False
    catalog_root: str = ""
    catalog_url: str = (
        "https://maimai.diving-fish.com/api/maimaidxprober/music_data"
    )
    catalog_refresh_seconds: int = 60 * 60
    catalog_refresh_timeout_seconds: int = 55 * 60
    catalog_initial_delay_seconds: int = 10
    catalog_cover_workers: int = 6
    catalog_build_device: str = "cpu"

    @classmethod
    def from_env(cls) -> "Settings":
        mode = os.getenv("OCR_MODE", "fake").strip().lower()
        if mode not in {"fake", "real"}:
            raise ValueError("OCR_MODE must be fake or real")
        pipeline_root = os.getenv(
            "OCR_PIPELINE_ROOT", DEFAULT_PIPELINE_ROOT
        ).strip()
        catalog_root = os.getenv("OCR_CATALOG_ROOT", "").strip()
        return cls(
            mode=mode,
            token=os.getenv("OCR_API_TOKEN", "").strip(),
            max_files=_positive_int("OCR_MAX_FILES", 20),
            max_file_bytes=_positive_int(
                "OCR_MAX_FILE_BYTES", 8 * 1024 * 1024
            ),
            concurrency=_positive_int("OCR_CONCURRENCY", 2),
            pipeline_root=pipeline_root,
            device=os.getenv("OCR_DEVICE", "cuda").strip(),
            catalog_enabled=_boolean("OCR_CATALOG_ENABLED", mode == "real"),
            catalog_root=catalog_root
            or str(Path(pipeline_root) / "runtime" / "catalog"),
            catalog_url=os.getenv(
                "OCR_CATALOG_URL",
                "https://maimai.diving-fish.com/api/maimaidxprober/music_data",
            ).strip(),
            catalog_refresh_seconds=_positive_int(
                "OCR_CATALOG_REFRESH_SECONDS", 60 * 60
            ),
            catalog_refresh_timeout_seconds=_positive_int(
                "OCR_CATALOG_REFRESH_TIMEOUT_SECONDS", 55 * 60
            ),
            catalog_initial_delay_seconds=_positive_int(
                "OCR_CATALOG_INITIAL_DELAY_SECONDS", 10
            ),
            catalog_cover_workers=_positive_int(
                "OCR_CATALOG_COVER_WORKERS", 6
            ),
            catalog_build_device=os.getenv(
                "OCR_CATALOG_BUILD_DEVICE", "cpu"
            ).strip(),
        )
