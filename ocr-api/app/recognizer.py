from __future__ import annotations

import re
import sys
import threading
import unicodedata
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import unquote

from .config import Settings
from .models import RecognitionItem, ScoreCandidate


class Recognizer(Protocol):
    def recognize(self, image_bytes: bytes, filename: str, index: int) -> RecognitionItem:
        ...


def parse_dx_score_text(text: str) -> int | None:
    normalized = unicodedata.normalize("NFKC", text)
    normalized = re.sub(r"[\s,]", "", normalized)
    match = re.search(r"(\d{1,5})[/\\](?:\d{1,5})", normalized)
    if match:
        return int(match.group(1))
    return None


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _field_value(raw: dict[str, Any], name: str) -> Any:
    field = (raw.get("fields") or {}).get(name)
    return field.get("value") if isinstance(field, dict) else None


def _field_text(raw: dict[str, Any], name: str) -> str | None:
    field = (raw.get("fields") or {}).get(name)
    if not isinstance(field, dict):
        return None
    value = field.get("text")
    return value if isinstance(value, str) and value else None


def _normalize_difficulty(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    key = re.sub(r"[^a-z]", "", value.casefold())
    return {
        "basic": "basic",
        "advanced": "advanced",
        "expert": "expert",
        "master": "master",
        "remaster": "remaster",
        "utage": "utage",
    }.get(key)


def _normalize_fc(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return {
        "fc": "fc",
        "fc_plus": "fcp",
        "fcp": "fcp",
        "ap": "ap",
        "ap_plus": "app",
        "app": "app",
    }.get(value.casefold())


def _candidate_rows(raw: dict[str, Any]) -> list[ScoreCandidate]:
    cover = ((raw.get("music") or {}).get("topk") or [])
    title = ((raw.get("title") or {}).get("topk") or [])
    ordered: list[tuple[str, dict[str, Any]]] = []
    cover_top = cover[0] if cover and isinstance(cover[0], dict) else None
    title_top = title[0] if title and isinstance(title[0], dict) else None
    if (
        cover_top
        and title_top
        and str(cover_top.get("title", "")).casefold()
        == str(title_top.get("title", "")).casefold()
    ):
        ordered.extend([("cover", cover_top), ("title", title_top)])
    for source, rows in (("cover", cover), ("title", title)):
        ordered.extend(
            (source, row) for row in rows if isinstance(row, dict)
        )

    merged: dict[str, dict[str, Any]] = {}
    sequence: list[str] = []
    for source, row in ordered:
        title_value = row.get("title")
        if not isinstance(title_value, str) or not title_value.strip():
            continue
        title_value = title_value.strip()
        key = title_value.casefold()
        if key not in merged:
            merged[key] = {
                "title": title_value,
                "confidence": None,
                "sources": [],
            }
            sequence.append(key)
        entry = merged[key]
        if source not in entry["sources"]:
            entry["sources"].append(source)
        probability = _number(row.get("prob"))
        if probability is not None:
            current = entry["confidence"]
            entry["confidence"] = (
                probability if current is None else max(current, probability)
            )
    return [ScoreCandidate(**merged[key]) for key in sequence[:3]]


class FakeRecognizer:
    def recognize(self, image_bytes: bytes, filename: str, index: int) -> RecognitionItem:
        del image_bytes
        key = filename.casefold()
        stem = Path(filename).stem
        if stem.casefold().startswith("title__"):
            title = unquote(stem[len("title__") :])
            is_dx = index % 2 == 1
            return RecognitionItem(
                index=index,
                filename=filename,
                status="ok",
                candidates=[
                    ScoreCandidate(
                        title=title,
                        confidence=0.99,
                        sources=["cover", "title"],
                    )
                ],
                achievement=100.0 - index,
                dxScore=1000 + index,
                difficulty="expert" if is_dx else "master",
                level="13" if is_dx else "14",
                isDx=is_dx,
            )
        if "metatron" in key or key.startswith("84d5cda3"):
            return RecognitionItem(
                index=index,
                filename=filename,
                status="ok",
                candidates=[
                    ScoreCandidate(
                        title="METATRON",
                        confidence=0.9999,
                        sources=["cover", "title"],
                    )
                ],
                achievement=100.8039,
                dxScore=2575,
                difficulty="master",
                level="14",
                isDx=False,
            )
        return RecognitionItem(
            index=index,
            filename=filename,
            status="ok",
            candidates=[
                ScoreCandidate(
                    title="PANDORA PARADOXXX",
                    confidence=0.985,
                    sources=["cover", "title"],
                )
            ],
            achievement=99.1234,
            dxScore=2600,
            difficulty="expert",
            level="13+",
            isDx=True,
            fc="fcp",
        )


class RealRecognizer:
    def __init__(self, settings: Settings):
        root = Path(settings.pipeline_root).resolve()
        launcher = root / "prod_run.py"
        sys.path.insert(0, str(root))
        if launcher.is_file():
            from prod_run import build_pipe  # type: ignore

            self._pipe = build_pipe(settings.device)
        elif (root / "final" / "pipeline.py").is_file():
            from final.pipeline import MaimaiPipeline  # type: ignore

            self._pipe = MaimaiPipeline(device=settings.device)
        else:
            raise FileNotFoundError(
                "OCR pipeline not found: expected prod_run.py or "
                f"final/pipeline.py under {root}"
            )
        self._paddle_lock = threading.Lock()
        self._paddle = self._pipe.tag_ocr.force_init_paddle()

    def _paddle_text(self, crop: Any) -> tuple[str, float]:
        with self._paddle_lock:
            rows = list(self._paddle.predict(crop))
        if not rows:
            return "", 0.0
        payload = getattr(rows[0], "json", {}) or {}
        result = payload.get("res", {}) if isinstance(payload, dict) else {}
        text = result.get("rec_text", "")
        score = result.get("rec_score", 0.0)
        return str(text or ""), float(score or 0.0)

    def _recognize_dx_score(self, image: Any, raw: dict[str, Any]) -> int | None:
        existing = _field_value(raw, "dx_score")
        if isinstance(existing, int):
            return existing
        if isinstance(existing, (tuple, list)) and existing:
            first = existing[0]
            if isinstance(first, int):
                return first

        hit = (raw.get("anchors") or {}).get("dx_score")
        if not isinstance(hit, dict) or not isinstance(hit.get("xyxy"), list):
            return None
        import numpy as np

        height, width = image.shape[:2]
        x1, y1, x2, y2 = (float(value) for value in hit["xyxy"])
        pad = 8
        left = max(0, int(x1) - pad)
        top = max(0, int(y1) - pad)
        right = min(width, int(x2) + pad)
        bottom = min(height, int(y2) + pad)
        crop = image[top:bottom, left:right]
        if not isinstance(crop, np.ndarray) or crop.size == 0:
            return None

        text, confidence = self._paddle_text(crop)
        value = parse_dx_score_text(text) if confidence >= 0.8 else None
        if value is not None:
            return value

        fallback_width = max(1, round(crop.shape[1] * 0.4))
        text, confidence = self._paddle_text(crop[:, :fallback_width])
        normalized = re.sub(r"[\s,]", "", text)
        if confidence < 0.8 or not re.fullmatch(r"\d{1,5}", normalized):
            return None
        return int(normalized)

    def recognize(self, image_bytes: bytes, filename: str, index: int) -> RecognitionItem:
        import cv2
        import numpy as np

        array = np.frombuffer(image_bytes, dtype=np.uint8)
        image = cv2.imdecode(array, cv2.IMREAD_COLOR)
        if image is None:
            return RecognitionItem(
                index=index,
                filename=filename,
                status="error",
                error="image decode failed",
            )
        raw = self._pipe.run(image)
        if raw.get("status") != "ok":
            return RecognitionItem(
                index=index,
                filename=filename,
                status="unrecognized",
                error=str(raw.get("status") or "unrecognized"),
            )

        candidates = _candidate_rows(raw)
        achievement = _number(_field_value(raw, "achievement_score"))
        difficulty = _normalize_difficulty(
            _field_value(raw, "music_diff_type")
            or _field_text(raw, "music_diff_type")
        )
        level_value = _field_value(raw, "music_diff_level")
        level = str(level_value) if level_value is not None else None
        icons = raw.get("icons") or {}
        dx_icon = icons.get("music_is_dx") or icons.get("touch_2020_2021") or {}
        is_dx = dx_icon.get("is_dx") if isinstance(dx_icon, dict) else None
        fc = _normalize_fc(
            _field_value(raw, "fc")
            or _field_value(raw, "fc_fs_2020_2021")
        )
        return RecognitionItem(
            index=index,
            filename=filename,
            status="ok" if candidates else "unrecognized",
            candidates=candidates,
            achievement=achievement,
            dxScore=self._recognize_dx_score(image, raw),
            difficulty=difficulty,
            level=level,
            isDx=is_dx if isinstance(is_dx, bool) else None,
            fc=fc,
            fs=None,
            error=None if candidates else "music candidate not found",
        )


def build_recognizer(settings: Settings) -> Recognizer:
    return RealRecognizer(settings) if settings.mode == "real" else FakeRecognizer()
