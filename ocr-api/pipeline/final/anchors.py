"""YOLO anchors detector wrapper that routes by version.

Each version has a different YOLO model and a different (but partially
overlapping) class list. This module:

- lazy-loads each YOLO model on first use,
- runs detection at imgsz=960, conf=0.10 (matches the judge / tag pipelines),
- keeps only the highest-confidence box per class,
- returns a `dict[tag_name -> AnchorHit]`.

Optional ORT path: if `MAIMAI_ANCHORS_ONNX_DIR` env is set, each `.pt`
model is also paired with `<stem>.onnx` in that dir. The ORT path skips
the ultralytics predict wrapper (~3-5ms overhead) and runs custom
letterbox + decode + NMS in numpy.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from ultralytics import YOLO


@dataclass
class AnchorHit:
    name: str
    xyxy: tuple[float, float, float, float]   # x1, y1, x2, y2
    conf: float


# version label  ->  default anchors model file
DEFAULT_MODEL_PATHS: dict[str, str] = {
    "maimai_dx_2020_2021": r"D:\ocr\ocr\models\anchors_2021_final.pt",
    "maimai_dx_2022_2023": r"D:\ocr\ocr\models\anchors_2223_final.pt",
    "maimai_dx_2024_2025": r"D:\ocr\ocr\models\anchors_2425_final.pt",
}

# versions we currently don't have an anchors model for
UNSUPPORTED_VERSIONS = {"maimai_finale", "maimai_web_screenshot"}


def _letterbox(img: np.ndarray, new_shape: int = 960, color=(114, 114, 114)):
    """Match ultralytics letterbox: scale + pad to (new_shape, new_shape)."""
    h, w = img.shape[:2]
    r = min(new_shape / h, new_shape / w)
    nh, nw = int(round(h * r)), int(round(w * r))
    pad_w = new_shape - nw
    pad_h = new_shape - nh
    # ultralytics centers the pad
    top = pad_h // 2
    bottom = pad_h - top
    left = pad_w // 2
    right = pad_w - left
    if (h, w) != (nh, nw):
        img = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    img = cv2.copyMakeBorder(img, top, bottom, left, right,
                             cv2.BORDER_CONSTANT, value=color)
    return img, r, (left, top)


def _nms(xyxy: np.ndarray, scores: np.ndarray, iou_thr: float = 0.45) -> list[int]:
    """Pure numpy NMS. Returns kept indices in score-desc order."""
    if len(xyxy) == 0:
        return []
    x1, y1, x2, y2 = xyxy[:, 0], xyxy[:, 1], xyxy[:, 2], xyxy[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(x1[i], x1[rest])
        yy1 = np.maximum(y1[i], y1[rest])
        xx2 = np.minimum(x2[i], x2[rest])
        yy2 = np.minimum(y2[i], y2[rest])
        w = np.maximum(0.0, xx2 - xx1)
        h = np.maximum(0.0, yy2 - yy1)
        inter = w * h
        iou = inter / (areas[i] + areas[rest] - inter + 1e-9)
        order = rest[iou <= iou_thr]
    return keep


class _OrtYolo:
    """Minimal ORT YOLO11 detector matching ultralytics imgsz=960 path."""
    def __init__(self, onnx_path: str, names: dict[int, str], device: str,
                 imgsz: int = 960):
        import onnxruntime as ort
        provs = (["CUDAExecutionProvider", "CPUExecutionProvider"]
                 if str(device).startswith("cuda")
                 and "CUDAExecutionProvider" in ort.get_available_providers()
                 else ["CPUExecutionProvider"])
        # anchors is a SINGLE big session run serially (not in fanout) — give
        # it more cores than the 2-thread default used by fanout sessions.
        # MAIMAI_ANCHORS_INTRA_THREADS overrides; default = all cores on CPU.
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        if not str(device).startswith("cuda"):
            try:
                n = int(os.environ.get("MAIMAI_ANCHORS_INTRA_THREADS", "0"))
            except ValueError:
                n = 0
            try:
                inter = int(os.environ.get("MAIMAI_ANCHORS_INTER_THREADS", "1"))
            except ValueError:
                inter = 1
            if n > 0:
                so.intra_op_num_threads = n
                so.inter_op_num_threads = max(1, inter)
                if inter > 1:
                    so.execution_mode = ort.ExecutionMode.ORT_PARALLEL
                else:
                    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.sess = ort.InferenceSession(onnx_path, sess_options=so,
                                         providers=provs)
        self.input = self.sess.get_inputs()[0].name
        self.names = names
        self.imgsz = imgsz

    def predict(self, bgr: np.ndarray, conf: float, iou: float = 0.45,
                max_det: int = 30):
        H, W = bgr.shape[:2]
        img, r, (pad_l, pad_t) = _letterbox(bgr, self.imgsz)
        # BGR -> RGB, HWC -> CHW, /255 normalize, fp32
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        x = rgb.astype(np.float32, copy=False) * (1.0 / 255.0)
        x = np.transpose(x, (2, 0, 1))[None, ...]
        # Forward
        out = self.sess.run(None, {self.input: x})[0]
        # YOLO11 head: (1, 4 + nc, A) where A=imgsz/8^2 + ... (e.g. 18900 @ 960)
        # First 4 rows = cx, cy, w, h (in letterboxed pixels), rest = class scores (no objectness)
        out = out[0]                        # (4+nc, A)
        nc = out.shape[0] - 4
        boxes = out[:4]                     # (4, A) cx,cy,w,h
        cls_scores = out[4:]                # (nc, A)
        # max-class per anchor
        cls_id = cls_scores.argmax(axis=0)              # (A,)
        cls_conf = cls_scores.max(axis=0)               # (A,)
        keep_mask = cls_conf >= conf
        if not keep_mask.any():
            return []
        boxes = boxes[:, keep_mask]
        cls_id = cls_id[keep_mask]
        cls_conf = cls_conf[keep_mask]
        # cxcywh -> xyxy in letterbox space
        cx, cy, w, h = boxes[0], boxes[1], boxes[2], boxes[3]
        x1 = cx - w * 0.5
        y1 = cy - h * 0.5
        x2 = cx + w * 0.5
        y2 = cy + h * 0.5
        # un-letterbox: subtract pad, divide by scale
        x1 = (x1 - pad_l) / r
        y1 = (y1 - pad_t) / r
        x2 = (x2 - pad_l) / r
        y2 = (y2 - pad_t) / r
        # clip to image
        x1 = np.clip(x1, 0, W); y1 = np.clip(y1, 0, H)
        x2 = np.clip(x2, 0, W); y2 = np.clip(y2, 0, H)
        xyxy = np.stack([x1, y1, x2, y2], axis=1)
        # Class-aware NMS (match agnostic_nms=False in ultralytics call)
        kept_all = []
        for c in np.unique(cls_id):
            m = cls_id == c
            idxs_local = _nms(xyxy[m], cls_conf[m], iou_thr=iou)
            global_idxs = np.where(m)[0][idxs_local]
            kept_all.extend(global_idxs.tolist())
        if not kept_all:
            return []
        # keep top max_det by conf
        kept_all = sorted(kept_all, key=lambda i: -cls_conf[i])[:max_det]
        return [(self.names[int(cls_id[i])],
                 (float(xyxy[i, 0]), float(xyxy[i, 1]),
                  float(xyxy[i, 2]), float(xyxy[i, 3])),
                 float(cls_conf[i])) for i in kept_all]


class AnchorsRouter:
    def __init__(
        self,
        model_paths: Optional[dict[str, str]] = None,
        device: str = "cpu",
        imgsz: int = 960,
        conf: float = 0.10,
        half: Optional[bool] = None,
        onnx_dir: Optional[str] = None,
    ):
        self.model_paths = dict(model_paths or DEFAULT_MODEL_PATHS)
        self.device = device
        # 2026-05-02: 双屏拒识需要 per-class 实例数。detect() 每次更新这个字典，
        # 调用方（pipeline.py）读出后塞进 out["anchors_counts"]，watch.py 据此
        # 在 _layout_check 里判 multi_screen。下游不读则零成本。
        self._last_counts: dict[str, int] = {}
        env_imgsz = os.environ.get("MAIMAI_ANCHORS_IMGSZ")
        if env_imgsz:
            try:
                imgsz = int(env_imgsz)
            except ValueError:
                pass
        self.imgsz = imgsz
        self.conf = conf
        self.half = bool(half) if half is not None else False
        self._cache: dict[str, YOLO] = {}
        self._ort_cache: dict[str, _OrtYolo] = {}
        self.onnx_dir = onnx_dir or os.environ.get("MAIMAI_ANCHORS_ONNX_DIR")

    def _get(self, version: str) -> Optional[YOLO]:
        if version in UNSUPPORTED_VERSIONS:
            return None
        if version not in self.model_paths:
            return None
        if version not in self._cache:
            self._cache[version] = YOLO(self.model_paths[version])
        return self._cache[version]

    def _get_ort(self, version: str) -> Optional[_OrtYolo]:
        if not self.onnx_dir:
            return None
        if version in self._ort_cache:
            return self._ort_cache[version]
        pt = Path(self.model_paths.get(version, ""))
        if not pt.name:
            return None
        cand = Path(self.onnx_dir) / f"{pt.stem}.onnx"
        if not cand.is_file():
            return None
        # Need names — pull from the .pt model on first init
        torch_model = self._get(version)
        if torch_model is None:
            return None
        names = torch_model.names if isinstance(torch_model.names, dict) \
                else {i: n for i, n in enumerate(torch_model.names)}
        try:
            self._ort_cache[version] = _OrtYolo(str(cand), names,
                                                self.device, self.imgsz)
            print(f"[anchors] ORT enabled for {version}: {cand.name}")
        except Exception as e:
            print(f"[anchors] WARN ORT init failed for {version}: {e}")
            return None
        return self._ort_cache[version]

    def detect(self, bgr: np.ndarray, version: str) -> dict[str, AnchorHit]:
        # NOTE: ORT path is implemented but currently OFF by default.
        # Reasons (T1000, 2026-04-23):
        #   - my custom letterbox+NMS produces 2/100 differing outputs
        #     vs ultralytics (re_master/master flips, mascot drops),
        #   - no time win: 36ms (torch) → 44ms (ORT + numpy decode) on T1000
        # To re-enable for experimentation, set MAIMAI_ANCHORS_USE_ORT=1
        # alongside MAIMAI_ANCHORS_ONNX_DIR.
        if os.environ.get("MAIMAI_ANCHORS_USE_ORT") == "1":
            ort_m = self._get_ort(version)
            if ort_m is not None:
                hits = ort_m.predict(bgr, conf=self.conf, max_det=30)
                best: dict[str, AnchorHit] = {}
                counts: dict[str, int] = {}
                for name, xyxy, c in hits:
                    counts[name] = counts.get(name, 0) + 1
                    if name not in best or c > best[name].conf:
                        best[name] = AnchorHit(name=name, xyxy=xyxy, conf=c)
                self._last_counts = counts
                return best
        # torch (default, ultralytics-correct) path
        model = self._get(version)
        if model is None:
            self._last_counts = {}
            return {}
        result = model.predict(
            source=bgr, imgsz=self.imgsz, conf=self.conf,
            verbose=False, device=self.device, half=self.half,
            max_det=30, agnostic_nms=False,
        )[0]
        boxes = result.boxes
        if boxes is None or len(boxes) == 0:
            self._last_counts = {}
            return {}
        names = model.names if isinstance(model.names, dict) else {i: n for i, n in enumerate(model.names)}
        xyxys = boxes.xyxy.cpu().numpy()
        clss = boxes.cls.cpu().numpy().astype(int)
        confs = boxes.conf.cpu().numpy()
        best: dict[str, AnchorHit] = {}
        counts: dict[str, int] = {}
        for box, cid, c in zip(xyxys, clss, confs):
            name = names[int(cid)]
            counts[name] = counts.get(name, 0) + 1
            if name not in best or c > best[name].conf:
                best[name] = AnchorHit(
                    name=name,
                    xyxy=tuple(float(v) for v in box),
                    conf=float(c),
                )
        self._last_counts = counts
        return best
