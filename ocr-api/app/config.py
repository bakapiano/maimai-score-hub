from __future__ import annotations

import os
from dataclasses import dataclass


def _positive_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


@dataclass(frozen=True)
class Settings:
    mode: str = "fake"
    token: str = ""
    max_files: int = 20
    max_file_bytes: int = 8 * 1024 * 1024
    concurrency: int = 2
    pipeline_root: str = "/home/bakapiano/maimai-ocr"
    device: str = "cuda"

    @classmethod
    def from_env(cls) -> "Settings":
        mode = os.getenv("OCR_MODE", "fake").strip().lower()
        if mode not in {"fake", "real"}:
            raise ValueError("OCR_MODE must be fake or real")
        return cls(
            mode=mode,
            token=os.getenv("OCR_API_TOKEN", "").strip(),
            max_files=_positive_int("OCR_MAX_FILES", 20),
            max_file_bytes=_positive_int(
                "OCR_MAX_FILE_BYTES", 8 * 1024 * 1024
            ),
            concurrency=_positive_int("OCR_CONCURRENCY", 2),
            pipeline_root=os.getenv(
                "OCR_PIPELINE_ROOT", "/home/bakapiano/maimai-ocr"
            ).strip(),
            device=os.getenv("OCR_DEVICE", "cuda").strip(),
        )
