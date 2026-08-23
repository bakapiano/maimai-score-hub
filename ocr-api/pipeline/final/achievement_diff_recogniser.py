"""ONNX CRNN inference for achievement_diff crops (2020 style).

Loads `models/achievement_diff_crnn.onnx` (or .pt fallback) and exposes a
`recognise(crop)` that returns (text, confidence). Output is one of:
  - "99.6084%+0.2853%"  (best+sign+delta)
  - "99.6084%-0.1234%"
  - ""                  (low confidence / unparseable -> caller falls back)

Charset: "0123456789.+-%" (14 cls incl blank).
Input: gray, letterbox to (H=32, W=320), normalized [-1,1].
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

import cv2
import numpy as np


_CHARSET = "0123456789.+-%"
_H, _W = 48, 480
_DEFAULT_ONNX = Path(__file__).resolve().parent.parent / "models" / "achievement_diff_crnn.onnx"
_DEFAULT_PT   = Path(__file__).resolve().parent.parent / "models" / "achievement_diff_crnn.pt"

_FULL_RE = re.compile(r"^(\d{1,3}\.\d{4})%([+-])(\d{1,3}\.\d{4})%$")
_BEST_RE = re.compile(r"^(\d{1,3}\.\d{4})%$")


def _letterbox_bgr(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    ih, iw = img.shape[:2]
    s = min(_H / ih, _W / iw)
    nh, nw = max(1, int(round(ih * s))), max(1, int(round(iw * s)))
    rs = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
    border = np.concatenate([rs[0], rs[-1]], axis=0).reshape(-1, 3)
    pad_v = np.median(border, axis=0).astype(np.uint8)
    canvas = np.full((_H, _W, 3), pad_v, dtype=np.uint8)
    yo = (_H - nh) // 2
    xo = (_W - nw) // 2
    canvas[yo:yo + nh, xo:xo + nw] = rs
    return canvas


def _preprocess(img: np.ndarray) -> np.ndarray:
    bgr = _letterbox_bgr(img)
    x = bgr.astype(np.float32) / 255.0
    x = (x - 0.5) / 0.5
    # HWC -> CHW, add batch dim
    return x.transpose(2, 0, 1)[None, :, :, :]


def _decode_with_conf(logits: np.ndarray) -> tuple[str, float]:
    e = np.exp(logits - logits.max(axis=-1, keepdims=True))
    probs = e / e.sum(axis=-1, keepdims=True)
    pred = probs.argmax(axis=-1)
    chars = []; confs = []; prev = 0
    for t, v in enumerate(pred.tolist()):
        if v != 0 and v != prev:
            chars.append(_CHARSET[v - 1])
            confs.append(float(probs[t, v]))
        prev = v
    text = "".join(chars)
    conf = float(np.exp(np.mean(np.log(np.clip(confs, 1e-8, 1.0))))) if confs else 0.0
    return text, conf


def parse(text: str) -> Optional[dict]:
    """Parse decoded text into structured fields. Returns None if invalid."""
    m = _FULL_RE.match(text)
    if m:
        best, sign, delta = m.group(1), m.group(2), m.group(3)
        return {"kind": "full", "best": best, "sign": sign, "delta": delta,
                "text": text}
    m = _BEST_RE.match(text)
    if m:
        return {"kind": "best", "best": m.group(1), "text": text}
    return None


class AchievementDiffRecogniser:
    """ONNX wrapper for the achievement_diff CRNN. Falls back to torch .pt if
    onnx is missing."""

    def __init__(self, model_path: Optional[str | Path] = None,
                 providers: Optional[list[str]] = None,
                 device: str = "cpu"):
        self._is_torch = False
        path = Path(model_path) if model_path else _DEFAULT_ONNX
        if not path.exists():
            # try pt fallback
            pt = Path(model_path) if model_path and str(model_path).endswith(".pt") else _DEFAULT_PT
            if pt.exists():
                self._init_torch(pt)
                return
            raise FileNotFoundError(f"diff CRNN model not found at {path} or {pt}")
        if str(path).endswith(".pt"):
            self._init_torch(path)
            return
        import onnxruntime as ort
        if providers is None:
            if device.startswith("cuda") and "CUDAExecutionProvider" in ort.get_available_providers():
                providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
            else:
                providers = ["CPUExecutionProvider"]
        so = ort.SessionOptions()
        so.intra_op_num_threads = 1
        so.inter_op_num_threads = 1
        self.sess = ort.InferenceSession(str(path), sess_options=so, providers=providers)
        self.input_name = self.sess.get_inputs()[0].name

    def _init_torch(self, pt_path: Path):
        import torch
        from training.diff_crnn.model import DiffCRNN
        self._is_torch = True
        self._torch = torch
        self.model = DiffCRNN()
        ckpt = torch.load(pt_path, map_location="cpu", weights_only=False)
        sd = ckpt.get("model", ckpt)
        self.model.load_state_dict(sd)
        self.model.eval()

    def recognise(self, crop: np.ndarray) -> tuple[str, float]:
        if crop is None or crop.size == 0:
            return "", 0.0
        x = _preprocess(crop)
        if self._is_torch:
            with self._torch.no_grad():
                logits = self.model(self._torch.from_numpy(x)).numpy()[0]
        else:
            logits = self.sess.run(None, {self.input_name: x})[0][0]
        return _decode_with_conf(logits)


__all__ = ["AchievementDiffRecogniser", "parse"]
