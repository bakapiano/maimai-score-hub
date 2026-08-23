"""maimai screenshot version classifier wrapper.

Loads `models/maimai_version_classifier.pt` (MobileNetV3-Small, 5 classes)
and exposes a `predict(bgr) -> (label, prob)` helper.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from torchvision import transforms
from torchvision.models import mobilenet_v3_small


@dataclass
class VersionResult:
    label: str
    prob: float
    topk: list[tuple[str, float]]


class VersionClassifier:
    def __init__(
        self,
        ckpt_path: str | Path,
        device: str | torch.device = "cpu",
        img_size: int = 224,
    ):
        self.device = torch.device(device)
        ckpt = torch.load(Path(ckpt_path), map_location=self.device, weights_only=False)
        self.classes: list[str] = list(ckpt["class_names"])
        model = mobilenet_v3_small(weights=None)
        in_feat = model.classifier[-1].in_features
        model.classifier[-1] = nn.Linear(in_feat, len(self.classes))
        model.load_state_dict(ckpt["model_state_dict"])
        self.model = model.to(self.device).eval()
        self.tf = transforms.Compose([
            transforms.Resize((img_size, img_size)),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ])

    def predict(self, bgr: np.ndarray, topk: int = 3) -> VersionResult:
        pil = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
        x = self.tf(pil).unsqueeze(0).to(self.device)
        with torch.no_grad():
            logits = self.model(x)[0]
            probs = torch.softmax(logits, dim=0).cpu().numpy()
        order = np.argsort(probs)[::-1]
        top = [(self.classes[i], float(probs[i])) for i in order[:topk]]
        return VersionResult(label=top[0][0], prob=top[0][1], topk=top)
