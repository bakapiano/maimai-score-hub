"""Synthetic title-crop renderer for the title ArcFace embedder.

Mirrors `scripts/synth_titles.py` (capsule + distractors + warp + JPEG noise)
but **returns BGR uint8** (no binarization, no letterbox to grayscale) so
downstream ArcFace training sees the same color/anti-aliased pixels the real
phone-photo crops have.

Used at training time inside the dataloader (rendered on the fly per sample,
no disk staging) and at gallery-build time.
"""
from __future__ import annotations

import os
import random
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

CANVAS_H, CANVAS_W = 220, 1400  # render at high res, downsample at end

FONT_POOL = [
    os.environ.get("OCR_TITLE_FONT", ""),
    r"C:\Windows\Fonts\YuGothB.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\YuGothM.ttc",
    r"C:\Windows\Fonts\meiryob.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    "/usr/share/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
FONT_POOL = [f for f in FONT_POOL if f and Path(f).exists()]

DISTRACTOR_POOL = [
    "Lv 14", "Lv 13+", "Lv 12+", "Lv 11", "Lv 10+", "Lv 15",
    "MASTER", "EXPERT", "ADVANCED", "BASIC", "Re:MASTER",
    "DX", "STD", "[即]", "[協]", "[宴]",
    "FULL COMBO", "ALL PERFECT", "FS+", "AP+",
    "Player", "Rank S+", "S+",
]

_CAPSULE_PALETTE = [
    (15, 15, 15), (40, 30, 20), (50, 28, 20), (35, 25, 60),
    (28, 25, 30), (60, 40, 30),
]
_BG_PALETTE = [
    (60, 50, 80), (80, 60, 50), (40, 60, 80),
    (90, 70, 60), (30, 30, 30),
]

_FONT_CACHE: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def _font(path: str, size: int) -> ImageFont.FreeTypeFont:
    key = (path, size)
    if key not in _FONT_CACHE:
        _FONT_CACHE[key] = ImageFont.truetype(path, size)
    return _FONT_CACHE[key]


def _render_text_rgba(text: str, font: ImageFont.FreeTypeFont,
                      color=(255, 255, 255)) -> np.ndarray:
    dummy = Image.new("RGBA", (1, 1))
    bbox = ImageDraw.Draw(dummy).textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pad = 4
    img = Image.new("RGBA", (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.text((pad - bbox[0], pad - bbox[1]), text,
           fill=color + (255,), font=font)
    return np.array(img)


def _paste_rgba(canvas_bgr: np.ndarray, rgba: np.ndarray, x: int, y: int) -> None:
    H, W = canvas_bgr.shape[:2]
    h, w = rgba.shape[:2]
    if w <= 0 or h <= 0:
        return
    x1 = max(0, x); y1 = max(0, y)
    x2 = min(W, x + w); y2 = min(H, y + h)
    if x2 <= x1 or y2 <= y1:
        return
    rx1, ry1 = x1 - x, y1 - y
    sub = rgba[ry1:ry1 + (y2 - y1), rx1:rx1 + (x2 - x1)]
    bgr = sub[..., 2::-1]
    a = sub[..., 3:4].astype(np.float32) / 255.0
    canvas_bgr[y1:y2, x1:x2] = (
        bgr.astype(np.float32) * a +
        canvas_bgr[y1:y2, x1:x2].astype(np.float32) * (1 - a)
    ).astype(np.uint8)


def _jitter(c: int, rng: random.Random, amp: int = 12) -> int:
    return max(0, min(255, c + rng.randint(-amp, amp)))


def _perspective_warp(bgr: np.ndarray, rng: random.Random,
                      max_skew: float = 0.05) -> np.ndarray:
    h, w = bgr.shape[:2]
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    j = lambda: rng.uniform(-max_skew, max_skew)
    dst = np.float32([
        [j() * w, j() * h],
        [w + j() * w, j() * h],
        [w + j() * w, h + j() * h],
        [j() * w, h + j() * h],
    ])
    M = cv2.getPerspectiveTransform(src, dst)
    return cv2.warpPerspective(bgr, M, (w, h),
                               borderMode=cv2.BORDER_REPLICATE)


def render_one_rgb(title: str, rng: random.Random) -> np.ndarray:
    """Render one synthetic title crop -> BGR uint8 (variable HxW, ~CANVAS_H * scale)."""
    if not FONT_POOL:
        raise RuntimeError("no title-rendering font is available")
    canvas = np.zeros((CANVAS_H, CANVAS_W, 3), dtype=np.uint8)
    bg = tuple(_jitter(c, rng) for c in rng.choice(_BG_PALETTE))
    canvas[:] = bg

    # cover-art bleed blobs
    for _ in range(rng.randint(0, 3)):
        cx = rng.randint(0, CANVAS_W)
        cy = rng.randint(0, CANVAS_H)
        rad = rng.randint(40, 200)
        col = tuple(rng.randint(20, 120) for _ in range(3))
        cv2.circle(canvas, (cx, cy), rad, col, -1)

    # main capsule
    cap_h = rng.randint(70, 110)
    cap_w = rng.randint(int(CANVAS_W * 0.55), int(CANVAS_W * 0.85))
    cap_x = (CANVAS_W - cap_w) // 2 + rng.randint(-40, 40)
    cap_y = (CANVAS_H - cap_h) // 2 + rng.randint(-15, 15)
    cap_color = tuple(_jitter(c, rng, 12) for c in rng.choice(_CAPSULE_PALETTE))
    cv2.rectangle(canvas, (cap_x, cap_y),
                  (cap_x + cap_w, cap_y + cap_h), cap_color, -1)

    # title text — pick max font size that fits
    font_path = rng.choice(FONT_POOL)
    target_h = int(cap_h * rng.uniform(0.55, 0.78))
    font_size = target_h
    font = _font(font_path, font_size)
    for _ in range(8):
        try:
            tw = font.getbbox(title)[2] - font.getbbox(title)[0]
        except Exception:
            return canvas  # last-resort fallback
        if tw <= cap_w * 0.92 or font_size <= 12:
            break
        font_size = int(font_size * 0.85)
        font = _font(font_path, font_size)

    text_rgba = _render_text_rgba(title, font, (255, 255, 255))
    th2, tw2 = text_rgba.shape[:2]
    tx = cap_x + (cap_w - tw2) // 2 + rng.randint(-6, 6)
    ty = cap_y + (cap_h - th2) // 2 + rng.randint(-4, 4)
    _paste_rgba(canvas, text_rgba, tx, ty)

    # distractors above
    if rng.random() < 0.7:
        d_text = rng.choice(DISTRACTOR_POOL)
        d_font = _font(rng.choice(FONT_POOL), rng.randint(28, 44))
        d_rgba = _render_text_rgba(d_text, d_font, (255, 255, 255))
        dh, dw = d_rgba.shape[:2]
        dx = cap_x + rng.randint(0, max(1, cap_w - dw))
        dy = max(0, cap_y - dh - rng.randint(2, 12))
        _paste_rgba(canvas, d_rgba, dx, dy)

    # distractors below
    if rng.random() < 0.5:
        d_text = rng.choice(DISTRACTOR_POOL)
        d_font = _font(rng.choice(FONT_POOL), rng.randint(24, 38))
        d_rgba = _render_text_rgba(d_text, d_font, (255, 255, 255))
        dh, dw = d_rgba.shape[:2]
        dx = cap_x + rng.randint(0, max(1, cap_w - dw))
        dy = min(CANVAS_H - dh, cap_y + cap_h + rng.randint(2, 14))
        _paste_rgba(canvas, d_rgba, dx, dy)

    # side icons
    for _ in range(rng.randint(0, 2)):
        if rng.random() < 0.5:
            x = rng.randint(2, 20)
        else:
            x = rng.randint(CANVAS_W - 30, CANVAS_W - 5)
        y = rng.randint(cap_y, cap_y + cap_h)
        cv2.rectangle(canvas, (x, y),
                      (x + rng.randint(8, 18), y + rng.randint(8, 18)),
                      (240, 240, 240), -1)

    canvas = _perspective_warp(canvas, rng, max_skew=0.05)

    if rng.random() < 0.5:
        sigma = rng.uniform(0.3, 1.2)
        k = max(3, int(sigma * 4) | 1)
        canvas = cv2.GaussianBlur(canvas, (k, k), sigma)
    if rng.random() < 0.5:
        noise = np.random.normal(0, rng.uniform(2, 8),
                                 canvas.shape).astype(np.int16)
        canvas = np.clip(canvas.astype(np.int16) + noise,
                         0, 255).astype(np.uint8)

    if rng.random() < 0.6:
        q = rng.randint(55, 92)
        ok, buf = cv2.imencode(".jpg", canvas, [cv2.IMWRITE_JPEG_QUALITY, q])
        if ok:
            canvas = cv2.imdecode(buf, cv2.IMREAD_COLOR)

    # downsample to a real-crop-ish size
    scale = rng.uniform(0.45, 0.7)
    nh = max(40, int(CANVAS_H * scale))
    nw = max(200, int(CANVAS_W * scale))
    canvas = cv2.resize(canvas, (nw, nh), interpolation=cv2.INTER_AREA)
    return canvas


def render_clean_rgb(title: str, rng: random.Random | None = None) -> np.ndarray:
    """Single deterministic clean render (no warp/noise/JPEG) for gallery seed."""
    if rng is None:
        rng = random.Random(hash(title) & 0xFFFFFFFF)
    canvas = np.zeros((CANVAS_H, CANVAS_W, 3), dtype=np.uint8)
    canvas[:] = (28, 25, 30)
    cap_h = 95
    cap_w = int(CANVAS_W * 0.75)
    cap_x = (CANVAS_W - cap_w) // 2
    cap_y = (CANVAS_H - cap_h) // 2
    cv2.rectangle(canvas, (cap_x, cap_y),
                  (cap_x + cap_w, cap_y + cap_h), (15, 15, 15), -1)
    font_path = FONT_POOL[0]
    font_size = int(cap_h * 0.7)
    font = _font(font_path, font_size)
    for _ in range(8):
        tw = font.getbbox(title)[2] - font.getbbox(title)[0]
        if tw <= cap_w * 0.92 or font_size <= 12:
            break
        font_size = int(font_size * 0.85)
        font = _font(font_path, font_size)
    text_rgba = _render_text_rgba(title, font, (255, 255, 255))
    th2, tw2 = text_rgba.shape[:2]
    tx = cap_x + (cap_w - tw2) // 2
    ty = cap_y + (cap_h - th2) // 2
    _paste_rgba(canvas, text_rgba, tx, ty)
    return cv2.resize(canvas, (CANVAS_W // 2, CANVAS_H // 2),
                      interpolation=cv2.INTER_AREA)
