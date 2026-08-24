"""Per-tag OCR + lightweight field post-processing.

Crops each anchor bbox (with a small padding), runs PaddleOCR rec-only
(`PP-OCRv5_server_rec`), then applies field-specific cleanup: number parsing,
regex validation, keyword matching for difficulty type, etc.

Why rec-only:
- The anchor YOLO already gives precise bboxes per field, so PaddleOCR's text
  detection is redundant (and was the slowest step in the full pipeline).
- The PP-OCRv5 server rec model handles maimai's stylised gold 3D
  "achievement_score" font correctly, which the smaller PP-OCRv4 mobile rec
  used by RapidOCR cannot.

Icon-type anchors (cover, mark, fc, fs, is_dx, touch) are NOT handled here;
the pipeline treats those separately.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from .paddle_device import paddle_device


class _NullPaddle:
    """Stand-in for paddleocr.TextRecognition when fallback is disabled or
    paddle init fails. Always returns no detections, so callers degrade
    gracefully to whatever the CRNN gave them."""
    def predict(self, *args, **kwargs):
        return []


# tags that are pure text and should be OCR'd.
# achievement_score uses the dedicated CRNN path inside ocr_tag() (with a
# PaddleOCR fallback), but the tag must still be in TEXT_TAGS so the pipeline
# loop in final/pipeline.py iterates it.
TEXT_TAGS: set[str] = {
    "achievement_score",
    # judge_detail / judge_detail_top OCR disabled for now — anchors still
    # detected, but no text recognition.
    # rating_detail uses dedicated CRNN (rating_crnn.onnx) trained on weak
    # PaddleOCR labels of the three version anchor datasets. Must still be in
    # TEXT_TAGS so the pipeline iterates it.
    "rating_detail",
}

# tags that are icons / images, never OCR'd
ICON_TAGS: set[str] = {
    "music_cover",
    "music_is_dx",
    "achievement_mark",
    "fc",
    "fs",
    "touch_2020_2021",
    "fc_fs_2020_2021",
    # 2022/23 + 2024/25 only: the maimai mascot avatar in the top-right.
    "mascot",
}


_DIFF_KEYWORDS = [
    ("REMASTER", ("RE",)),       # check first so RE doesn't get eaten by REM
    ("MASTER",   ("MAS",)),
    ("EXPERT",   ("EXP",)),
    ("ADVANCED", ("ADV",)),
    ("BASIC",    ("BAS",)),
]


@dataclass
class FieldResult:
    text: str                      # raw OCR text
    conf: float                    # rec_score from PaddleOCR
    value: Optional[object] = None # parsed value (int/float/tuple/str), None if parsing failed
    label: Optional[str] = None    # categorical label (e.g. MASTER) when applicable
    raw: dict = field(default_factory=dict)  # raw rec result dict


def _padded_crop(img: np.ndarray, xyxy, pad: int = 8) -> np.ndarray:
    H, W = img.shape[:2]
    x1, y1, x2, y2 = xyxy
    x1 = max(0, int(x1) - pad); y1 = max(0, int(y1) - pad)
    x2 = min(W, int(x2) + pad); y2 = min(H, int(y2) + pad)
    if x2 <= x1 + 2 or y2 <= y1 + 2:
        return img[0:0, 0:0]
    return img[y1:y2, x1:x2]


# ---- field parsers ----

def _parse_score(text: str) -> Optional[float]:
    m = re.search(r"(\d{1,3})\s*\.\s*(\d{4})", text)
    if not m:
        return None
    try:
        return float(f"{m.group(1)}.{m.group(2)}")
    except ValueError:
        return None


def _parse_diff_score(text: str) -> Optional[float]:
    s = text.replace(" ", "").replace("%", "")
    m = re.search(r"([+\-]?)\s*(\d+)\.(\d{4})", s)
    if not m:
        return None
    sign = -1.0 if m.group(1) == "-" else 1.0
    try:
        return sign * float(f"{m.group(2)}.{m.group(3)}")
    except ValueError:
        return None


def _parse_int(text: str) -> Optional[int]:
    s = re.sub(r"[^\d]", "", text)
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def _parse_combo(text: str) -> Optional[tuple[int, int]]:
    m = re.search(r"(\d+)\s*[/\\]\s*(\d+)", text)
    if m:
        try:
            return (int(m.group(1)), int(m.group(2)))
        except ValueError:
            pass
    nums = re.findall(r"\d+", text)
    if len(nums) >= 2:
        try:
            return (int(nums[0]), int(nums[-1]))
        except ValueError:
            return None
    return None


def _parse_diff_level(text: str) -> Optional[str]:
    m = re.search(r"\d{1,2}\+?", text.replace(" ", ""))
    return m.group(0) if m else None


def _match_diff_type(text: str) -> Optional[str]:
    upper = text.upper().replace(" ", "")
    for label, prefixes in _DIFF_KEYWORDS:
        for p in prefixes:
            if p in upper:
                return label
    return None


def _postprocess(tag: str, text: str) -> tuple[Optional[object], Optional[str]]:
    """Return (value, label) for a given tag based on the recognised text."""
    if tag == "achievement_score":
        return _parse_score(text), None
    if tag == "achievement_diff":
        return _parse_diff_score(text), None
    if tag == "dx_score":
        v = _parse_combo(text)
        if v is not None:
            return v, None
        return _parse_int(text), None
    if tag == "rating":
        return _parse_int(text), None
    if tag == "combo":
        return _parse_combo(text), None
    if tag == "music_diff_level":
        return _parse_diff_level(text), None
    if tag == "music_diff_type":
        lab = _match_diff_type(text)
        return lab, lab
    if tag in ("rating_detail", "judge_detail_top"):
        # Extract all integers; useful for downstream consumers that just want
        # the numeric breakdown (e.g. base/play rating, judgement counts).
        nums = [int(n) for n in re.findall(r"\d+", text)]
        return (nums or None), None
    # music_title, judge_detail: keep as-is
    return text.strip() or None, None


# Per-version rating cap. The rating_detail anchor frame on each version has
# a hard upper bound (in-game UI element doesn't render values above this).
# CRNN occasionally hallucinates an extra digit; we use the cap to detect
# that and fall back to Paddle. None = no cap known (don't filter).
_RATING_CAP: dict[str, int] = {
    "maimai_dx_2020_2021": 11000,
    "maimai_dx_2022_2023": 17000,
    "maimai_dx_2024_2025": 17000,
}


def _rating_cap_for_version(version: Optional[str]) -> Optional[int]:
    if not version:
        return None
    return _RATING_CAP.get(version)


class TagOCR:
    """PaddleOCR PP-OCRv5_server_rec wrapper, rec-only (no det)."""

    def __init__(
        self,
        model_name: str = "PP-OCRv5_server_rec",
        enable_mkldnn: bool = False,
        cpu_threads: int = 6,
        use_achievement_crnn: bool = True,
        achievement_crnn_path: Optional[str] = None,
        use_rating_crnn: bool = True,
        rating_crnn_path: Optional[str] = None,
        use_diff_crnn: bool = True,
        diff_crnn_path: Optional[str] = None,
        device: str = "cpu",
        disable_paddle_fallback: bool = False,
    ):
        # Lazy init: PaddleOCR is only the fallback when CRNN fails to parse.
        # In normal runs CRNN succeeds 100% of the time, so we save ~2s startup
        # + ~hundreds of MB by deferring TextRecognition() until first use.
        # When disable_paddle_fallback=True, we skip paddle entirely (the
        # cold-init cost on first fallback otherwise tail-latency-bombs the
        # bench by ~7s on a single image).
        self._paddle_kwargs = dict(model_name=model_name,
                                   enable_mkldnn=enable_mkldnn,
                                   cpu_threads=cpu_threads,
                                   device=paddle_device(
                                       os.getenv("OCR_PADDLE_DEVICE", device)
                                   ))
        self._disable_paddle = disable_paddle_fallback
        self.rec = _NullPaddle() if disable_paddle_fallback else None
        self.achv_crnn = None
        if use_achievement_crnn:
            try:
                from .achievement_recogniser import AchievementRecogniser
                self.achv_crnn = AchievementRecogniser(achievement_crnn_path, device=device)
            except Exception as e:
                # Fall back to paddle silently if onnx model missing or runtime fails.
                import warnings
                warnings.warn(f"achievement CRNN unavailable, falling back to PaddleOCR: {e}")
                self.achv_crnn = None
        self.rating_crnn = None
        if use_rating_crnn:
            try:
                from .rating_recogniser import RatingRecogniser
                self.rating_crnn = RatingRecogniser(rating_crnn_path, device=device)
            except Exception as e:
                import warnings
                warnings.warn(f"rating CRNN unavailable, falling back to PaddleOCR: {e}")
                self.rating_crnn = None
        self.diff_crnn = None
        if use_diff_crnn:
            try:
                from .achievement_diff_recogniser import AchievementDiffRecogniser
                self.diff_crnn = AchievementDiffRecogniser(diff_crnn_path, device=device)
            except Exception as e:
                import warnings
                warnings.warn(f"diff CRNN unavailable, falling back to PaddleOCR: {e}")
                self.diff_crnn = None

    def _ensure_paddle(self):
        if self.rec is None:
            try:
                from paddleocr import TextRecognition
                # enable_mkldnn=False avoids a oneDNN crash on this Paddle build:
                # NotImplementedError: ConvertPirAttribute2RuntimeAttribute not support
                self.rec = TextRecognition(**self._paddle_kwargs)
            except Exception as e:
                import warnings
                warnings.warn(f"PaddleOCR init failed, fallback disabled: {e}")
                self.rec = _NullPaddle()
        return self.rec

    def force_init_paddle(self):
        """Bypass disable_paddle_fallback flag — used by diff_type OCR fallback
        which always wants a real PaddleOCR session (lazy, ~7s cold start once)."""
        if isinstance(self.rec, _NullPaddle) or self.rec is None:
            try:
                from paddleocr import TextRecognition
                self.rec = TextRecognition(**self._paddle_kwargs)
            except Exception as e:
                import warnings
                warnings.warn(f"PaddleOCR force init failed: {e}")
                self.rec = _NullPaddle()
        return self.rec

    def _recognise(self, crop: np.ndarray) -> tuple[str, float, dict]:
        rec = self._ensure_paddle()
        results = list(rec.predict(crop))
        if not results:
            return "", 0.0, {}
        d = results[0].json.get("res", {}) or {}
        text = d.get("rec_text", "") or ""
        try:
            conf = float(d.get("rec_score", 0.0) or 0.0)
        except (TypeError, ValueError):
            conf = 0.0
        return text, conf, d

    def ocr_tag(self, img: np.ndarray, xyxy, tag: str, pad: int = 8,
                version: Optional[str] = None) -> FieldResult:
        crop = _padded_crop(img, xyxy, pad=pad)
        if crop.size == 0:
            return FieldResult(text="", conf=0.0)
        if tag == "rating_detail" and self.rating_crnn is not None:
            text, conf = self.rating_crnn.recognise(crop)
            value, label = _postprocess(tag, text)
            # Sanity-check the parsed rating against version-specific upper
            # bound. CRNN occasionally hallucinates an extra digit (e.g.
            # "11457" on a 2022/23 screen where the cap is 11000) — that
            # value is impossible, so fall back to PaddleOCR.
            #   2020/21 anchor frame: rating displayed as 0..11000
            #   2022/23 / 2024/25 anchor frame: rating displayed as 0..17000
            cap = _rating_cap_for_version(version)
            oor = (cap is not None and isinstance(value, list) and value
                   and max(value) > cap)
            if not oor:
                return FieldResult(text=text, conf=conf, value=value, label=label,
                                   raw={"engine": "rating_crnn"})
            # Out of range — try Paddle fallback.
            p_text, p_conf, p_raw = self._recognise(crop)
            p_value, p_label = _postprocess(tag, p_text)
            crnn_meta = {"text": text, "conf": conf, "value": value, "cap": cap}
            if isinstance(p_value, list) and p_value and max(p_value) <= cap:
                return FieldResult(
                    text=p_text, conf=p_conf, value=p_value, label=p_label,
                    raw={"engine": "paddle_fallback_oor", "crnn_oor": crnn_meta, **p_raw},
                )
            # Both engines out of range / failed — keep CRNN but mark.
            return FieldResult(
                text=text, conf=conf, value=value, label=label,
                raw={"engine": "rating_crnn", "fallback_failed": True,
                     "crnn_oor": crnn_meta,
                     "paddle": {"text": p_text, "conf": p_conf, "value": p_value}},
            )
        if tag == "achievement_diff" and self.diff_crnn is not None:
            text, conf = self.diff_crnn.recognise(crop)
            value, label = _postprocess(tag, text)
            if value is None or conf < 0.3:
                p_text, p_conf, p_raw = self._recognise(crop)
                p_value, p_label = _postprocess(tag, p_text)
                if p_value is not None:
                    return FieldResult(
                        text=p_text, conf=p_conf, value=p_value, label=p_label,
                        raw={"engine": "paddle_fallback", "crnn": {"text": text, "conf": conf}, **p_raw},
                    )
                return FieldResult(
                    text=text, conf=conf, value=value, label=label,
                    raw={"engine": "diff_crnn", "fallback_failed": True, "paddle": {"text": p_text, "conf": p_conf}},
                )
            return FieldResult(text=text, conf=conf, value=value, label=label, raw={"engine": "diff_crnn"})
        if tag == "achievement_score" and self.achv_crnn is not None:
            text, conf = self.achv_crnn.recognise(crop)
            value, label = _postprocess(tag, text)
            # Fall back to PaddleOCR if CRNN output doesn't parse as a valid
            # score, confidence is suspiciously low, or the parsed score is
            # out of range. maimai achievement maxes at 101.0000%; anything
            # above means the CRNN dropped/added a digit (e.g. "1003.5012"
            # for what should be "100.3501"). Treat that as a hard fail and
            # try Paddle. CRNN is faster + more accurate on the in-distribution
            # font; Paddle is the safety net for edge cases.
            oor = isinstance(value, (int, float)) and (value > 101.0 or value < 0.0)
            if value is None or conf < 0.3 or oor:
                p_text, p_conf, p_raw = self._recognise(crop)
                p_value, p_label = _postprocess(tag, p_text)
                p_in_range = isinstance(p_value, (int, float)) and 0.0 <= p_value <= 101.0
                if p_value is not None and p_in_range:
                    return FieldResult(
                        text=p_text, conf=p_conf, value=p_value, label=p_label,
                        raw={"engine": "paddle_fallback" if not oor else "paddle_fallback_oor",
                             "crnn": {"text": text, "conf": conf, "value": value},
                             **p_raw},
                    )
                # Neither parsed in-range; return whichever has higher conf, tagged.
                return FieldResult(
                    text=text, conf=conf, value=value, label=label,
                    raw={"engine": "crnn", "fallback_failed": True,
                         "crnn_oor": oor,
                         "paddle": {"text": p_text, "conf": p_conf, "value": p_value}},
                )
            return FieldResult(text=text, conf=conf, value=value, label=label, raw={"engine": "crnn"})
        text, conf, raw = self._recognise(crop)
        value, label = _postprocess(tag, text)
        return FieldResult(text=text, conf=conf, value=value, label=label, raw=raw)
