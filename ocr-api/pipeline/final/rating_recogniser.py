"""ONNX CRNN inference for rating_detail crops.

Loads `models/rating_crnn.onnx` and exposes `recognise(crop) -> (text, conf)`.

Input: BGR or grayscale crop, letterboxed to 32x160 grayscale, normalized to [-1, 1].
Output: decoded digit string (3-5 digits) + geometric-mean confidence.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

import cv2
import numpy as np


_CHARSET = "0123456789"
_H, _W = 32, 160
_DEFAULT_ONNX = Path(__file__).resolve().parent.parent / "models" / "rating_crnn.onnx"


def _letterbox_gray(img: np.ndarray) -> np.ndarray:
    if img.ndim == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    ih, iw = img.shape[:2]
    s = min(_H / ih, _W / iw)
    nh, nw = max(1, int(round(ih * s))), max(1, int(round(iw * s)))
    rs = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
    pad_v = int(np.median(np.concatenate([rs[0], rs[-1]])))
    canvas = np.full((_H, _W), pad_v, dtype=np.uint8)
    yo = (_H - nh) // 2
    xo = (_W - nw) // 2
    canvas[yo:yo + nh, xo:xo + nw] = rs
    return canvas


def _preprocess(img: np.ndarray) -> np.ndarray:
    g = _letterbox_gray(img)
    x = g.astype(np.float32) / 255.0
    x = (x - 0.5) / 0.5
    return x[None, None, :, :]


def _decode_with_conf(logits: np.ndarray) -> tuple[str, float]:
    e = np.exp(logits - logits.max(axis=-1, keepdims=True))
    probs = e / e.sum(axis=-1, keepdims=True)
    pred = probs.argmax(axis=-1)
    chars = []
    confs = []
    prev = 0
    for t, v in enumerate(pred.tolist()):
        if v != 0 and v != prev:
            chars.append(_CHARSET[v - 1])
            confs.append(float(probs[t, v]))
        prev = v
    text = "".join(chars)
    conf = float(np.exp(np.mean(np.log(np.clip(confs, 1e-8, 1.0))))) if confs else 0.0
    return text, conf


class RatingRecogniser:
    """ONNX wrapper for the rating_detail CRNN."""

    def __init__(self, onnx_path: Optional[str | Path] = None,
                 providers: Optional[list[str]] = None,
                 device: str = "cpu"):
        import onnxruntime as ort
        path = Path(onnx_path) if onnx_path else _DEFAULT_ONNX
        if not path.exists():
            raise FileNotFoundError(f"rating CRNN onnx not found: {path}")
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

    def recognise(self, crop: np.ndarray) -> tuple[str, float]:
        if crop is None or crop.size == 0:
            return "", 0.0
        x = _preprocess(crop)
        logits = self.sess.run(None, {self.input_name: x})[0][0]
        return _decode_with_conf(logits)


__all__ = ["RatingRecogniser"]
