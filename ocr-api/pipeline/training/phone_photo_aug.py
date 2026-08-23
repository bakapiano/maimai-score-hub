"""Phone-photo augmentation for arcade screen captures.

Designed to mimic taking a photo of a maimai cabinet LCD with a phone:
  - perspective warp (camera tilt)
  - glare / specular highlights
  - color shift (auto white balance)
  - LCD moire / scanlines
  - JPEG re-compression
  - corner occlusion (badges, FC/AP overlays)
  - motion blur

Used by both training script and gallery TTA.
"""
from __future__ import annotations

import io
import math
import random

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter


# ---------------- geometric ----------------

def _perspective_coeffs(src, dst):
    matrix = []
    for (x, y), (X, Y) in zip(src, dst):
        matrix.append([X, Y, 1, 0, 0, 0, -x * X, -x * Y])
        matrix.append([0, 0, 0, X, Y, 1, -y * X, -y * Y])
    A = np.array(matrix, dtype=np.float64)
    B = np.array([c for pt in src for c in pt], dtype=np.float64)
    return list(np.linalg.solve(A, B))


def random_perspective(img: Image.Image, max_warp: float = 0.18) -> Image.Image:
    w, h = img.size
    dx, dy = max_warp * w, max_warp * h
    src = [(0, 0), (w, 0), (w, h), (0, h)]
    dst = [
        (random.uniform(-dx, dx), random.uniform(-dy, dy)),
        (w + random.uniform(-dx, dx), random.uniform(-dy, dy)),
        (w + random.uniform(-dx, dx), h + random.uniform(-dy, dy)),
        (random.uniform(-dx, dx), h + random.uniform(-dy, dy)),
    ]
    coeffs = _perspective_coeffs(dst, src)
    return img.transform((w, h), Image.PERSPECTIVE, coeffs,
                         resample=Image.BILINEAR, fillcolor=(0, 0, 0))


# ---------------- photometric ----------------

def add_glare(img: Image.Image, p: float = 0.5) -> Image.Image:
    if random.random() > p:
        return img
    w, h = img.size
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    cx = random.randint(-w // 4, w + w // 4)
    cy = random.randint(-h // 4, h + h // 4)
    r = random.randint(w // 3, w)
    alpha = random.randint(40, 140)
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, alpha))
    overlay = overlay.filter(ImageFilter.GaussianBlur(r // 2))
    return Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")


def color_jitter(img: Image.Image) -> Image.Image:
    if random.random() < 0.8:
        img = ImageEnhance.Brightness(img).enhance(random.uniform(0.65, 1.35))
    if random.random() < 0.8:
        img = ImageEnhance.Contrast(img).enhance(random.uniform(0.7, 1.3))
    if random.random() < 0.7:
        img = ImageEnhance.Color(img).enhance(random.uniform(0.6, 1.4))
    if random.random() < 0.5:
        # white balance shift
        arr = np.asarray(img, dtype=np.float32)
        gain = np.array([random.uniform(0.85, 1.15) for _ in range(3)], dtype=np.float32)
        arr = np.clip(arr * gain, 0, 255).astype(np.uint8)
        img = Image.fromarray(arr)
    return img


def add_moire(img: Image.Image, p: float = 0.45) -> Image.Image:
    """Simulate phone-camera-on-LCD moire: superimpose a faint sinusoidal grating."""
    if random.random() > p:
        return img
    w, h = img.size
    arr = np.asarray(img, dtype=np.float32)
    # random frequency / orientation
    freq = random.uniform(0.05, 0.35)              # cycles per pixel
    theta = random.uniform(0, math.pi)
    amp = random.uniform(6, 22)                    # 0-255 range
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    pat = amp * np.sin(2 * math.pi * freq * (xx * math.cos(theta) + yy * math.sin(theta)))
    # apply mostly to one channel for color fringing
    ch = random.randint(0, 2)
    arr[..., ch] = np.clip(arr[..., ch] + pat, 0, 255)
    if random.random() < 0.5:
        ch2 = (ch + 1) % 3
        arr[..., ch2] = np.clip(arr[..., ch2] - 0.5 * pat, 0, 255)
    return Image.fromarray(arr.astype(np.uint8))


def add_scanlines(img: Image.Image, p: float = 0.25) -> Image.Image:
    if random.random() > p:
        return img
    arr = np.asarray(img, dtype=np.float32)
    h = arr.shape[0]
    period = random.randint(2, 4)
    mask = np.ones(h, dtype=np.float32)
    mask[::period] *= random.uniform(0.85, 0.97)
    arr *= mask[:, None, None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def jpeg_recompress(img: Image.Image, p: float = 0.7) -> Image.Image:
    if random.random() > p:
        return img
    q = random.randint(45, 92)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=q)
    buf.seek(0)
    return Image.open(buf).convert("RGB")


def motion_blur(img: Image.Image, p: float = 0.2) -> Image.Image:
    if random.random() > p:
        return img
    radius = random.uniform(0.3, 1.5)
    return img.filter(ImageFilter.GaussianBlur(radius))


def add_occlusion(img: Image.Image, p: float = 0.5) -> Image.Image:
    """Drop random colored boxes near corners to mimic FC/FS/AP/difficulty badges."""
    if random.random() > p:
        return img
    w, h = img.size
    n = random.randint(1, 3)
    overlay = img.convert("RGBA")
    draw = ImageDraw.Draw(overlay)
    for _ in range(n):
        bw = int(w * random.uniform(0.12, 0.32))
        bh = int(h * random.uniform(0.08, 0.22))
        corner = random.randint(0, 3)
        if corner == 0:    # TL
            x0, y0 = 0, 0
        elif corner == 1:  # TR
            x0, y0 = w - bw, 0
        elif corner == 2:  # BL
            x0, y0 = 0, h - bh
        else:              # BR
            x0, y0 = w - bw, h - bh
        # random nudge
        x0 += random.randint(-5, 5); y0 += random.randint(-5, 5)
        color = (random.randint(0, 255), random.randint(0, 255),
                 random.randint(0, 255), random.randint(160, 240))
        draw.rectangle([x0, y0, x0 + bw, y0 + bh], fill=color)
    return overlay.convert("RGB")


# ---------------- orchestrator ----------------

# difficulty band colors (BASIC/ADV/EXP/MAS/RE:MAS/UTAGE) — slightly desaturated
DIFF_COLORS = [
    (50, 160, 80),    # green BASIC
    (210, 140, 40),   # orange ADV
    (200, 60, 60),    # red EXP
    (155, 70, 180),   # purple MAS
    (220, 220, 220),  # white RE:MAS
    (200, 60, 200),   # magenta UTAGE
    (60, 60, 60),     # dark grey (no border / dim)
    (90, 110, 140),   # bluish (FES/season frame)
]


def add_color_border(cover: Image.Image, color, thickness_ratio: float) -> Image.Image:
    w, h = cover.size
    t = max(1, int(min(w, h) * thickness_ratio))
    bordered = Image.new("RGB", (w, h), color)
    inner = cover.resize((w - 2 * t, h - 2 * t), Image.BILINEAR)
    bordered.paste(inner, (t, t))
    return bordered


def composite_into_template(cover: Image.Image, template: Image.Image,
                            bbox_in_tpl, border_p: float = 0.55):
    """Paste cover into a UI-template's bbox region; return (composed, bbox).

    bbox returned is the bbox coords *in the composed image* (== bbox_in_tpl).
    """
    if random.random() < border_p:
        cover = add_color_border(cover,
                                 random.choice(DIFF_COLORS),
                                 thickness_ratio=random.uniform(0.012, 0.030))
    x1, y1, x2, y2 = bbox_in_tpl
    bw, bh = x2 - x1, y2 - y1
    # tiny in-bbox shrink/expand to mimic imperfect fill
    pad = random.uniform(-0.02, 0.03)
    pw, ph = max(8, int(bw * (1 - pad * 2))), max(8, int(bh * (1 - pad * 2)))
    cover_r = cover.resize((pw, ph), Image.BILINEAR)
    out = template.copy()
    ox = x1 + (bw - pw) // 2
    oy = y1 + (bh - ph) // 2
    out.paste(cover_r, (ox, oy))
    return out, (x1, y1, x2, y2)


def recrop_with_jitter(img: Image.Image, bbox,
                       pad_lo: float = -0.04, pad_hi: float = 0.10):
    x1, y1, x2, y2 = bbox
    bw, bh = x2 - x1, y2 - y1
    px = int(bw * random.uniform(pad_lo, pad_hi))
    py = int(bh * random.uniform(pad_lo, pad_hi))
    cx1 = max(0, x1 - px)
    cy1 = max(0, y1 - py)
    cx2 = min(img.width, x2 + px)
    cy2 = min(img.height, y2 + py)
    return img.crop((cx1, cy1, cx2, cy2))


def phone_photo_augment(img: Image.Image, strength: str = "train",
                        ui_template=None) -> Image.Image:
    """Heavy augmentation pipeline. `strength` in {"train", "tta"}.

    If `ui_template=(tpl_img, bbox)` is provided, the pipeline FIRST pastes the
    cover into the template's bbox (with optional colored border), re-crops with
    random padding (so the result shows surrounding real maimai UI pixels),
    then continues with the regular phone-photo aug — but with `add_occlusion`
    suppressed because the UI already provides natural occlusion / clutter.
    """
    if strength == "tta":
        # mild — used only for gallery TTA
        img = color_jitter(img)
        img = jpeg_recompress(img, p=0.4)
        return img

    if ui_template is not None:
        tpl_img, tpl_bbox = ui_template
        composed, bbox = composite_into_template(cover=img, template=tpl_img,
                                                 bbox_in_tpl=tpl_bbox)
        img = recrop_with_jitter(composed, bbox)
        # gentler perspective (UI already adds context distortion)
        img = random_perspective(img, max_warp=0.08)
        img = color_jitter(img)
        # natural occlusion is in the crop already — only rare extra badges
        img = add_occlusion(img, p=0.15)
        img = add_glare(img, p=0.40)
        img = add_moire(img, p=0.35)
        img = add_scanlines(img, p=0.18)
        img = motion_blur(img, p=0.18)
        img = jpeg_recompress(img, p=0.75)
        return img

    img = random_perspective(img, max_warp=0.16)
    img = color_jitter(img)
    img = add_occlusion(img, p=0.55)
    img = add_glare(img, p=0.45)
    img = add_moire(img, p=0.40)
    img = add_scanlines(img, p=0.20)
    img = motion_blur(img, p=0.18)
    img = jpeg_recompress(img, p=0.75)
    return img


# ---------------- ui template loader ----------------

class UITemplatePack:
    """Lazy-loaded UI template pool. Pass to dataset to pick random templates."""

    def __init__(self, root):
        from pathlib import Path as _P
        import json as _json
        root = _P(root)
        self.root = root
        manifest = _json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        self.entries = manifest
        self._cache: dict = {}
        # bound cache size
        self._cache_max = 128

    def __len__(self):
        return len(self.entries)

    def sample(self, rng=None):
        rng = rng or random
        e = rng.choice(self.entries)
        key = e["file"]
        if key in self._cache:
            tpl = self._cache[key]
        else:
            tpl = Image.open(self.root / key).convert("RGB")
            if len(self._cache) >= self._cache_max:
                # drop a random entry
                self._cache.pop(next(iter(self._cache)))
            self._cache[key] = tpl
        return tpl, tuple(e["bbox"])
