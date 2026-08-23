"""Binary crop classifier (MobileNetV3-Small) for music_is_dx / touch / etc.

Loads a checkpoint produced by training/train_binary_crop.py, classifies a
BGR crop into {"neg", "pos"} with probability.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import torch
import torch.nn as nn
from torchvision import models, transforms


@dataclass
class BinaryResult:
    label: str          # "pos" | "neg"
    prob: float         # prob of predicted class
    pos_prob: float     # prob of "pos"


@dataclass
class MultiClassResult:
    label: str
    prob: float
    topk: list  # [(label, prob), ...]


_MEAN = [0.485, 0.456, 0.406]
_STD  = [0.229, 0.224, 0.225]
_MEAN_NP = np.array(_MEAN, dtype=np.float32).reshape(1, 1, 3)
_STD_NP  = np.array(_STD,  dtype=np.float32).reshape(1, 1, 3)


def _preproc_fast(bgr_crop: np.ndarray, size: int, grayscale: bool = False) -> np.ndarray:
    """BGR uint8 HWC -> normalized CHW float32, no PIL.

    grayscale=True: 转灰度但保 3 channel（兼容 ImageNet pretrained 3-ch 输入）。
    跟 train_diff_type_v5_gray 的 transforms.Grayscale(num_output_channels=3) 等价。
    """
    rgb = cv2.cvtColor(bgr_crop, cv2.COLOR_BGR2RGB)
    if rgb.shape[0] != size or rgb.shape[1] != size:
        rgb = cv2.resize(rgb, (size, size), interpolation=cv2.INTER_LINEAR)
    if grayscale:
        # ITU-R BT.601 luma weights, 跟 PIL Grayscale 一致
        gray = (rgb.astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32))
        rgb = np.stack([gray, gray, gray], axis=-1).astype(np.uint8)
    x = rgb.astype(np.float32) * (1.0 / 255.0)
    x = (x - _MEAN_NP) / _STD_NP
    return np.transpose(x, (2, 0, 1))


def _build_net(n_cls: int = 2) -> nn.Module:
    net = models.mobilenet_v3_small(weights=None)
    in_f = net.classifier[3].in_features
    net.classifier[3] = nn.Linear(in_f, n_cls)
    return net


def _try_init_ort(onnx_path: Optional[str], device: str):
    if not onnx_path:
        return None, None
    from pathlib import Path as _P
    if not _P(onnx_path).is_file():
        return None, None
    try:
        from .ort_helpers import make_session
        sess = make_session(str(onnx_path), device)
        return sess, sess.get_inputs()[0].name
    except Exception as e:
        print(f"[crop_cls] WARN ORT init failed for {onnx_path}: {e}")
        return None, None


class BinaryCropClassifier:
    def __init__(self, ckpt_path: str, device: str = "cpu",
                 onnx_path: Optional[str] = None):
        ckpt = torch.load(ckpt_path, map_location=device, weights_only=False)
        self.img = int(ckpt.get("img", 96))
        self.classes = ckpt.get("classes", ["neg", "pos"])
        self.grayscale = (ckpt.get("preprocess") == "grayscale")
        self.device = device
        self.net = _build_net(len(self.classes))
        self.net.load_state_dict(ckpt["state_dict"])
        self.net.eval().to(device)
        self.ort_sess, self.ort_input = _try_init_ort(onnx_path, device)

    @torch.no_grad()
    def predict(self, bgr_crop: np.ndarray) -> BinaryResult:
        if bgr_crop is None or bgr_crop.size == 0:
            return BinaryResult(label="neg", prob=0.0, pos_prob=0.0)
        x = _preproc_fast(bgr_crop, self.img, grayscale=self.grayscale)
        if self.ort_sess is not None:
            logits = self.ort_sess.run(None, {self.ort_input: x[None, ...]})[0][0]
            ex = np.exp(logits - logits.max())
            probs = ex / ex.sum()
        else:
            xt = torch.from_numpy(x).unsqueeze(0).to(self.device, non_blocking=True)
            logits = self.net(xt)
            probs = torch.softmax(logits, dim=1).cpu().numpy()[0]
        pos_prob = float(probs[1])
        idx = int(probs.argmax())
        return BinaryResult(label=self.classes[idx], prob=float(probs[idx]), pos_prob=pos_prob)

    def predict_xyxy(self, bgr: np.ndarray, xyxy) -> Optional[BinaryResult]:
        x1, y1, x2, y2 = [int(round(v)) for v in xyxy]
        H, W = bgr.shape[:2]
        x1 = max(0, x1); y1 = max(0, y1); x2 = min(W, x2); y2 = min(H, y2)
        if x2 <= x1 + 1 or y2 <= y1 + 1:
            return None
        return self.predict(bgr[y1:y2, x1:x2])


class MultiClassCropClassifier:
    """Same architecture as BinaryCropClassifier but exposes top-k labels."""
    def __init__(self, ckpt_path: str, device: str = "cpu",
                 onnx_path: Optional[str] = None):
        ckpt = torch.load(ckpt_path, map_location=device, weights_only=False)
        self.img = int(ckpt.get("img", 128))
        self.classes = ckpt.get("classes", [])
        # 2026-05-03 v5: ckpt 标记 preprocess="grayscale" 时输入转灰度。
        # 必须跟 trainer 的 transforms.Grayscale(num_output_channels=3) 对齐。
        self.grayscale = (ckpt.get("preprocess") == "grayscale")
        if not self.classes:
            raise ValueError(f"checkpoint at {ckpt_path} has no classes")
        self.device = device
        self.net = _build_net(len(self.classes))
        self.net.load_state_dict(ckpt["state_dict"])
        self.net.eval().to(device)
        self.ort_sess, self.ort_input = _try_init_ort(onnx_path, device)

    @torch.no_grad()
    def predict(self, bgr_crop: np.ndarray, topk: int = 3) -> MultiClassResult:
        if bgr_crop is None or bgr_crop.size == 0:
            return MultiClassResult(label=self.classes[0], prob=0.0, topk=[])
        x = _preproc_fast(bgr_crop, self.img, grayscale=self.grayscale)
        if self.ort_sess is not None:
            logits = self.ort_sess.run(None, {self.ort_input: x[None, ...]})[0][0]
            ex = np.exp(logits - logits.max())
            probs = ex / ex.sum()
        else:
            xt = torch.from_numpy(x).unsqueeze(0).to(self.device, non_blocking=True)
            logits = self.net(xt)
            probs = torch.softmax(logits, dim=1).cpu().numpy()[0]
        order = probs.argsort()[::-1]
        topk_list = [(self.classes[int(i)], float(probs[i])) for i in order[:topk]]
        return MultiClassResult(label=topk_list[0][0], prob=topk_list[0][1], topk=topk_list)

    def predict_xyxy(self, bgr: np.ndarray, xyxy, topk: int = 3) -> Optional[MultiClassResult]:
        x1, y1, x2, y2 = [int(round(v)) for v in xyxy]
        H, W = bgr.shape[:2]
        x1 = max(0, x1); y1 = max(0, y1); x2 = min(W, x2); y2 = min(H, y2)
        if x2 <= x1 + 1 or y2 <= y1 + 1:
            return None
        return self.predict(bgr[y1:y2, x1:x2], topk=topk)
