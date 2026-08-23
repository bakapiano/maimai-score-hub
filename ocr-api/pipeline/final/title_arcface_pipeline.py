"""Title ArcFace inference pipeline.

Mirrors `final/cover_arcface_pipeline.py` but for the title bbox crop:

    title bbox crop (BGR) -> resize to (img_h, img_w) -> EfficientNet-B0+GeM
        -> embedding -> cosine vs gallery -> top-k titles

API mirrors `final/title_classifier.TitleClassifier`:
    classify_anchor(bgr, xyxy, topk) -> list[TitleCand]
so it can be drop-in swapped in `final/pipeline.py`.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from torchvision import transforms

from training.train_title_arcface import TitleEmbedder


@dataclass
class TitleCand:
    title: str
    prob: float
    cosine: float = 0.0


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


def _load_gallery(path: Path):
    z = np.load(path, allow_pickle=True)
    titles = list(z["titles"])
    embs = np.asarray(z["embeddings"], dtype=np.float32)
    norms = np.linalg.norm(embs, axis=1, keepdims=True) + 1e-8
    embs = embs / norms
    return titles, embs


class TitleArcFacePipeline:
    def __init__(self, ckpt_path: str, gallery_path: str,
                 device: str = "cpu", pad_frac: float = 0.04,
                 topk: int = 5, softmax_tau: float = 25.0,
                 onnx_path: Optional[str] = None):
        self.device = torch.device(device)
        ck = torch.load(ckpt_path, map_location="cpu", weights_only=False)
        self.embed_dim = ck.get("embed_dim", 256)
        self.img_h = ck.get("img_h", 64)
        self.img_w = ck.get("img_w", 384)
        self.classes: list[str] = ck.get("classes", [])
        self.model = TitleEmbedder(embed_dim=self.embed_dim, pretrained=False)
        self.model.load_state_dict(ck["model"])
        self.model.to(self.device).eval()
        self.pad_frac = pad_frac
        self.topk = topk
        self.softmax_tau = softmax_tau

        gtitles, gembs = _load_gallery(Path(gallery_path))
        self.gallery_titles = gtitles
        self.gallery_emb = torch.from_numpy(gembs).to(self.device)
        self.gallery_np = gembs  # for ORT path

        self._norm = transforms.Normalize([0.485, 0.456, 0.406],
                                          [0.229, 0.224, 0.225])

        # Optional ORT acceleration; mirrors cover_arcface_pipeline.
        self.ort_sess = None
        self.ort_input = None
        if onnx_path and Path(onnx_path).is_file():
            try:
                from .ort_helpers import make_session
                self.ort_sess = make_session(str(onnx_path), str(self.device))
                self.ort_input = self.ort_sess.get_inputs()[0].name
                print(f"[title] ORT enabled: {self.ort_sess.get_providers()}")
            except Exception as e:
                print(f"[title] WARN: ORT init failed, fallback to torch: {e}")
                self.ort_sess = None

    def _to_tensor(self, bgr: np.ndarray) -> torch.Tensor:
        bgr = cv2.resize(bgr, (self.img_w, self.img_h),
                         interpolation=cv2.INTER_AREA)
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        t = torch.from_numpy(rgb).permute(2, 0, 1).float() / 255.0
        return self._norm(t).unsqueeze(0).to(self.device)

    def _preproc_np(self, bgr_crop: np.ndarray) -> np.ndarray:
        """Fast path used by ORT branch — pure numpy + cv2, no PIL/torch."""
        bgr = cv2.resize(bgr_crop, (self.img_w, self.img_h),
                         interpolation=cv2.INTER_AREA)
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        x = rgb.astype(np.float32) * (1.0 / 255.0)
        x = (x - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / \
            np.array([0.229, 0.224, 0.225], dtype=np.float32)
        return np.transpose(x, (2, 0, 1))[None, ...]  # (1,3,H,W)

    @torch.no_grad()
    def classify_crop(self, bgr_crop: np.ndarray,
                      topk: int | None = None) -> list[TitleCand]:
        if bgr_crop is None or bgr_crop.size == 0:
            return []
        if self.ort_sess is not None:
            xn = self._preproc_np(bgr_crop)
            e = self.ort_sess.run(None, {self.ort_input: xn})[0][0]  # (D,)
            n = float(np.linalg.norm(e))
            if n > 0:
                e = e / n
            emb_t = torch.from_numpy(e).to(self.device, non_blocking=True)
            cos = self.gallery_emb @ emb_t  # (N,)
        else:
            x = self._to_tensor(bgr_crop)
            emb = self.model(x)
            emb = F.normalize(emb, dim=1)
            cos = (emb @ self.gallery_emb.t())[0]
        probs = F.softmax(cos * self.softmax_tau, dim=0)
        k = topk or self.topk
        k = min(k, cos.numel())
        top = torch.topk(probs, k)
        return [TitleCand(self.gallery_titles[int(i)],
                          float(p), float(cos[int(i)]))
                for p, i in zip(top.values.tolist(), top.indices.tolist())]

    def classify_anchor(self, bgr: np.ndarray, xyxy,
                        topk: int | None = None) -> list[TitleCand]:
        crop = _padded_crop(bgr, xyxy, self.pad_frac)
        if crop is None:
            return []
        return self.classify_crop(crop, topk=topk)
