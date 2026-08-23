"""maimai screenshot version classifier wrapper v2 (EfficientNet-B0).

Drop-in replacement for `final.version_classifier.VersionClassifier`. Loads
ckpt produced by `training/train_version_v2.py` which has:
    {"class_names": [...], "model_state_dict": ..., "arch": "efficientnet_b0", "img": 256}
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from torchvision import transforms
from torchvision.models import efficientnet_b0


@dataclass
class VersionResult:
    label: str
    prob: float
    topk: list[tuple[str, float]]


class VersionClassifierV2:
    def __init__(
        self,
        ckpt_path: str | Path,
        device: str | torch.device = "cpu",
        img_size: int | None = None,
        onnx_path: str | Path | None = None,
    ):
        self.device = torch.device(device)
        ckpt = torch.load(Path(ckpt_path), map_location=self.device, weights_only=False)
        self.classes: list[str] = list(ckpt["class_names"])
        size = int(img_size or ckpt.get("img", 256))
        self._size = size
        model = efficientnet_b0(weights=None)
        in_feat = model.classifier[1].in_features
        model.classifier[1] = nn.Linear(in_feat, len(self.classes))
        model.load_state_dict(ckpt["model_state_dict"])
        self.model = model.to(self.device).eval()
        # match val_tf in training: short side ~ size*1.14, then center-crop size
        self.tf = transforms.Compose([
            transforms.Resize(int(size * 1.14)),
            transforms.CenterCrop(size),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ])
        # Optional ORT path.
        self.ort_sess = None
        self.ort_input = None
        if onnx_path and Path(onnx_path).is_file():
            try:
                from .ort_helpers import make_session_options, make_providers
                import onnxruntime as ort
                # version is a single serial step (not in fanout) — use more
                # threads. MAIMAI_VERSION_INTRA_THREADS overrides; default 4.
                so = make_session_options(str(self.device),
                                          threads_env="MAIMAI_VERSION_INTRA_THREADS",
                                          default_threads=4)
                provs = make_providers(str(self.device))
                self.ort_sess = ort.InferenceSession(str(onnx_path),
                                                     sess_options=so,
                                                     providers=provs)
                self.ort_input = self.ort_sess.get_inputs()[0].name
            except Exception as e:
                print(f"[version_v2] WARN ORT init failed: {e}")
                self.ort_sess = None

    def predict(self, bgr: np.ndarray, topk: int = 3) -> VersionResult:
        # Fast preprocess: cv2 resize (short-side) + center crop, no PIL.
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        h, w = rgb.shape[:2]
        target_short = int(self._size * 1.14)
        if h < w:
            new_h = target_short
            new_w = int(round(w * target_short / h))
        else:
            new_w = target_short
            new_h = int(round(h * target_short / w))
        rgb = cv2.resize(rgb, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
        sz = self._size
        y0 = max(0, (new_h - sz) // 2)
        x0 = max(0, (new_w - sz) // 2)
        rgb = rgb[y0:y0 + sz, x0:x0 + sz]
        x = rgb.astype(np.float32) * (1.0 / 255.0)
        x = (x - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / \
            np.array([0.229, 0.224, 0.225], dtype=np.float32)
        x = np.transpose(x, (2, 0, 1))
        if self.ort_sess is not None:
            logits = self.ort_sess.run(None, {self.ort_input: x[None, ...]})[0][0]
            ex = np.exp(logits - logits.max())
            probs = ex / ex.sum()
        else:
            x = torch.from_numpy(x).unsqueeze(0).to(self.device, non_blocking=True)
            with torch.no_grad():
                logits = self.model(x)[0]
                probs = torch.softmax(logits, dim=0).cpu().numpy()
        order = np.argsort(probs)[::-1]
        top = [(self.classes[i], float(probs[i])) for i in order[:topk]]
        return VersionResult(label=top[0][0], prob=top[0][1], topk=top)
