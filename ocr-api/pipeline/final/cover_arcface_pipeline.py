"""End-to-end cover identification via embedding + cosine gallery.

Replaces the v1 1264-class softmax with:
    backbone (EfficientNet-B3 + GeM neck) -> 512-d embedding
    cosine vs gallery (per-title averaged + L2-normed)
    -> top-k titles

Gallery is built once by `scripts/build_cover_gallery.py` and lives in a
.npz file (titles + embeddings). Use `identify_path/identify` from the
existing pipeline as drop-in replacement.

Outputs `CoverResult` whose candidates are titles only — no music_id.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image
from torchvision import transforms
from torchvision.models import efficientnet_b3
from ultralytics import YOLO


# ---- model defs (must match training/train_cover_arcface.py) ----

class GeM(nn.Module):
    def __init__(self, p: float = 3.0, eps: float = 1e-6):
        super().__init__()
        self.p = nn.Parameter(torch.ones(1) * p)
        self.eps = eps
    def forward(self, x):
        return F.adaptive_avg_pool2d(x.clamp(min=self.eps).pow(self.p),
                                     1).pow(1.0 / self.p).flatten(1)


class CoverEmbedder(nn.Module):
    def __init__(self, embed_dim: int = 512):
        super().__init__()
        net = efficientnet_b3(weights=None)
        self.features = net.features
        self.feat_dim = 1536
        self.pool = GeM(p=3.0)
        self.bn1 = nn.BatchNorm1d(self.feat_dim)
        self.fc  = nn.Linear(self.feat_dim, embed_dim, bias=False)
        self.bn2 = nn.BatchNorm1d(embed_dim)
        self.embed_dim = embed_dim
    def forward(self, x):
        x = self.features(x); x = self.pool(x)
        x = self.bn1(x); x = self.fc(x); x = self.bn2(x)
        return x


# ---- result types ----

@dataclass
class CoverCandidate:
    title: str
    prob: float          # cosine similarity, mapped via softmax to [0,1]
    cosine: float        # raw cosine (-1..1)


@dataclass
class CoverResult:
    image_size: tuple[int, int]
    yolo_xyxy: tuple[float, float, float, float]
    yolo_conf: float
    crop_size: tuple[int, int]
    candidates: list[CoverCandidate] = field(default_factory=list)

    @property
    def top1(self) -> Optional[CoverCandidate]:
        return self.candidates[0] if self.candidates else None


# ---- helpers ----

def _padded_crop(img, xyxy, pad: float):
    H, W = img.shape[:2]
    x0, y0, x1, y1 = xyxy
    bw = x1 - x0; bh = y1 - y0
    cx = (x0 + x1) / 2; cy = (y0 + y1) / 2
    nbw = bw * (1 + 2 * pad); nbh = bh * (1 + 2 * pad)
    x0 = int(max(0, cx - nbw / 2)); x1 = int(min(W, cx + nbw / 2))
    y0 = int(max(0, cy - nbh / 2)); y1 = int(min(H, cy + nbh / 2))
    if x1 <= x0 + 4 or y1 <= y0 + 4:
        return None, None
    return img[y0:y1, x0:x1].copy(), (x0, y0, x1, y1)


def _load_embedder(ckpt_path: Path, device: torch.device):
    ckpt = torch.load(ckpt_path, map_location=device, weights_only=False)
    embed_dim = int(ckpt.get("embed_dim", 512))
    img_size  = int(ckpt.get("img_size", 300))
    classes   = ckpt.get("classes", [])
    model = CoverEmbedder(embed_dim=embed_dim).to(device).eval()
    model.load_state_dict(ckpt["model"], strict=True)
    tf = transforms.Compose([
        transforms.Resize((img_size, img_size)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    return model, classes, img_size, tf


def _load_gallery(npz_path: Path):
    z = np.load(npz_path, allow_pickle=True)
    titles = list(z["titles"])
    embs = z["embeddings"].astype(np.float32)         # (N, D), already L2-normed
    return titles, embs


# ---- pipeline ----

class CoverArcFacePipeline:
    def __init__(
        self,
        yolo_path: str | Path,
        ckpt_path: str | Path,
        gallery_path: str | Path,
        device: str | torch.device = "cpu",
        pad: float = 0.05,
        topk: int = 6,
        yolo_imgsz: int = 640,
        yolo_conf: float = 0.25,
        softmax_temp: float = 25.0,   # turn cosine into a peaked prob
        onnx_path: str | Path | None = None,  # if given, use ORT for embedder
    ):
        self.device = torch.device(device)
        self.yolo = YOLO(str(yolo_path))
        self.model, self.classes, self.img_size, self.tf = _load_embedder(Path(ckpt_path), self.device)
        gtitles, gembs = _load_gallery(Path(gallery_path))
        self.gallery_titles = gtitles
        self.gallery = torch.from_numpy(gembs).to(self.device)         # (N, D)
        self.gallery_np = gembs                                        # for ORT path
        self.pad = pad
        self.topk = topk
        self.yolo_imgsz = yolo_imgsz
        self.yolo_conf = yolo_conf
        self.softmax_temp = softmax_temp

        # Optional: ORT embedder. Falls back to torch on init failure.
        self.ort_sess = None
        if onnx_path and Path(onnx_path).is_file():
            try:
                from .ort_helpers import make_session
                self.ort_sess = make_session(str(onnx_path), str(self.device))
                self.ort_input = self.ort_sess.get_inputs()[0].name
                print(f"[cover] ORT enabled: {self.ort_sess.get_providers()}")
            except Exception as e:
                print(f"[cover] WARN: ORT init failed, fallback to torch: {e}")
                self.ort_sess = None

    def detect_cover_bbox(self, bgr: np.ndarray):
        result = self.yolo.predict(source=bgr, imgsz=self.yolo_imgsz,
                                   conf=self.yolo_conf, verbose=False,
                                   device=str(self.device),
                                   max_det=10)[0]
        boxes = result.boxes
        if boxes is None or len(boxes) == 0:
            return None
        xyxys = boxes.xyxy.cpu().numpy()
        confs = boxes.conf.cpu().numpy()
        order = np.argsort(-(xyxys[:, 2] - xyxys[:, 0]) * (xyxys[:, 3] - xyxys[:, 1]))
        return tuple(float(v) for v in xyxys[order[0]]), float(confs[order[0]])

    @torch.no_grad()
    def embed_crop(self, crop_bgr: np.ndarray) -> torch.Tensor:
        # Fast path: skip PIL, do everything in numpy + torch.
        rgb = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)
        if rgb.shape[0] != self.img_size or rgb.shape[1] != self.img_size:
            rgb = cv2.resize(rgb, (self.img_size, self.img_size),
                             interpolation=cv2.INTER_LINEAR)
        x = rgb.astype(np.float32) * (1.0 / 255.0)
        x = (x - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / \
            np.array([0.229, 0.224, 0.225], dtype=np.float32)
        x = np.transpose(x, (2, 0, 1))
        if self.ort_sess is not None:
            # ORT path: numpy in, numpy out, ~6.8x faster than torch on T1000
            xn = x[None, ...]                                          # (1,3,H,W)
            e = self.ort_sess.run(None, {self.ort_input: xn})[0][0]    # (D,)
            n = float(np.linalg.norm(e))
            if n > 0:
                e = e / n
            return torch.from_numpy(e).to(self.device, non_blocking=True)
        x = torch.from_numpy(x).unsqueeze(0).to(self.device, non_blocking=True)
        e = self.model(x)
        return F.normalize(e, dim=1)[0]                                # (D,)

    @torch.no_grad()
    def classify_crop(self, crop_bgr: np.ndarray, topk: int | None = None) -> list[CoverCandidate]:
        if topk is None: topk = self.topk
        e = self.embed_crop(crop_bgr)
        sims = self.gallery @ e                                        # (N,)
        probs = F.softmax(sims * self.softmax_temp, dim=0)
        # If multiple covers share a title we'd already have collapsed them in
        # gallery; assume gallery_titles is already 1:1 with rows.
        idx = torch.argsort(sims, descending=True)[:topk]
        return [CoverCandidate(title=self.gallery_titles[int(i)],
                               prob=float(probs[i]),
                               cosine=float(sims[i])) for i in idx]

    def identify(self, bgr: np.ndarray, topk: int | None = None) -> Optional[CoverResult]:
        if bgr is None: return None
        H, W = bgr.shape[:2]
        det = self.detect_cover_bbox(bgr)
        if det is None: return None
        raw_xyxy, conf = det
        crop, padded_xyxy = _padded_crop(bgr, raw_xyxy, self.pad)
        if crop is None: return None
        cands = self.classify_crop(crop, topk=topk)
        return CoverResult(
            image_size=(W, H),
            yolo_xyxy=tuple(float(v) for v in padded_xyxy),
            yolo_conf=conf,
            crop_size=(crop.shape[1], crop.shape[0]),
            candidates=cands,
        )

    def identify_path(self, path: str | Path, topk: int | None = None) -> Optional[CoverResult]:
        bgr = cv2.imread(str(path))
        if bgr is None: return None
        return self.identify(bgr, topk=topk)
