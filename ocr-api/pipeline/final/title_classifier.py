"""MobileNetV3-Small title classifier wrapper.

Crops the `music_title` anchor box, binarizes (white-text on black) using the
same `binarize_title` + `letterbox` from `scripts/refine_title_crop.py` so the
input distribution matches training, then runs the trained classifier on the
48x512 grayscale tensor.

Returns top-K (title, prob). The pipeline can fuse this with the cover top-K
to disambiguate covers that share visual content (e.g. variant charts).
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torchvision.models import mobilenet_v3_small

# reuse the binarizer used during data prep
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.refine_title_crop import binarize_title, letterbox  # noqa: E402

H, W = 48, 512


@dataclass
class TitleCand:
    title: str
    prob: float


def _build_model(num_classes: int) -> nn.Module:
    m = mobilenet_v3_small(weights=None)
    old = m.features[0][0]
    new_conv = nn.Conv2d(1, old.out_channels, kernel_size=old.kernel_size,
                         stride=old.stride, padding=old.padding,
                         bias=old.bias is not None)
    m.features[0][0] = new_conv
    in_feat = m.classifier[-1].in_features
    m.classifier[-1] = nn.Linear(in_feat, num_classes)
    return m


def _padded_crop(bgr: np.ndarray, xyxy, pad_frac: float) -> Optional[np.ndarray]:
    h, w = bgr.shape[:2]
    x1, y1, x2, y2 = [float(v) for v in xyxy]
    bw, bh = max(1.0, x2 - x1), max(1.0, y2 - y1)
    px, py = bw * pad_frac, bh * pad_frac
    x1i = max(0, int(round(x1 - px)))
    y1i = max(0, int(round(y1 - py)))
    x2i = min(w, int(round(x2 + px)))
    y2i = min(h, int(round(y2 + py)))
    if x2i <= x1i or y2i <= y1i:
        return None
    return bgr[y1i:y2i, x1i:x2i]


class TitleClassifier:
    def __init__(self, ckpt_path: str, device: str = "cpu", pad_frac: float = 0.04):
        self.device = torch.device(device)
        ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
        self.classes: list[str] = ckpt["classes"]
        self.model = _build_model(len(self.classes))
        self.model.load_state_dict(ckpt["model"])
        self.model.to(self.device).eval()
        self.pad_frac = pad_frac

    @torch.no_grad()
    def classify_crop(self, bgr_crop: np.ndarray, topk: int = 3) -> list[TitleCand]:
        if bgr_crop is None or bgr_crop.size == 0:
            return []
        bw = binarize_title(bgr_crop)
        fitted = letterbox(bw, H, W)
        arr = (fitted.astype(np.float32) / 255.0 - 0.5) / 0.5
        x = torch.from_numpy(arr).unsqueeze(0).unsqueeze(0).to(self.device)
        logits = self.model(x)
        probs = F.softmax(logits, dim=1)[0]
        k = min(topk, probs.numel())
        top = torch.topk(probs, k)
        return [TitleCand(self.classes[int(i)], float(p))
                for p, i in zip(top.values.tolist(), top.indices.tolist())]

    def classify_anchor(self, bgr: np.ndarray, xyxy, topk: int = 3) -> list[TitleCand]:
        crop = _padded_crop(bgr, xyxy, self.pad_frac)
        if crop is None:
            return []
        return self.classify_crop(crop, topk=topk)
