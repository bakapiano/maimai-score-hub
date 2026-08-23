"""End-to-end cover identification pipeline.

YOLO (cover_single) detects the cover bbox in a screenshot/photo, then a
MobileNetV3-Small classifier maps the crop to one of N (e.g. 1264) musicIds.

Designed to be embedded in the main flow:
    from final.cover_pipeline import CoverPipeline, CoverResult
    pipe = CoverPipeline(yolo_path, classifier_path, music_data_path)
    res = pipe.identify(bgr_image)            # CoverResult or None
    res = pipe.identify_path("foo.jpg")

Default config (matches what was validated):
    pad        = 0.05    # bbox padding ratio (peak top-1 acc)
    img_size   = 192     # comes from ckpt
    topk       = 6
    yolo_imgsz = 640
    yolo_conf  = 0.25
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from torchvision import transforms
from torchvision.models import mobilenet_v3_small
from ultralytics import YOLO


@dataclass
class CoverCandidate:
    music_id: str
    title: str
    prob: float


@dataclass
class CoverResult:
    image_size: tuple[int, int]                    # (W, H)
    yolo_xyxy: tuple[float, float, float, float]   # main cover bbox (after padding)
    yolo_conf: float
    crop_size: tuple[int, int]                     # (w, h) of fed crop
    candidates: list[CoverCandidate] = field(default_factory=list)

    @property
    def top1(self) -> Optional[CoverCandidate]:
        return self.candidates[0] if self.candidates else None


def _load_classifier(ckpt_path: Path, device: torch.device):
    ckpt = torch.load(ckpt_path, map_location=device, weights_only=False)
    classes = ckpt["classes"]
    img_size = int(ckpt.get("img_size", 192))
    model = mobilenet_v3_small(weights=None)
    in_feat = model.classifier[-1].in_features
    model.classifier[-1] = nn.Linear(in_feat, len(classes))
    model.load_state_dict(ckpt["model"])
    model = model.to(device).eval()
    tf = transforms.Compose([
        transforms.Resize((img_size, img_size)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    return model, classes, img_size, tf


def _load_titles(path: Optional[Path]) -> dict[str, str]:
    if not path:
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        m: dict[str, str] = {}
        for item in data:
            sid = str(item["id"])
            title = item.get("title", "")
            m[sid] = title
            m[sid.zfill(5)] = title
        return m
    except Exception:
        return {}


def _padded_crop(img, xyxy, pad: float) -> tuple[Optional[np.ndarray], Optional[tuple[int, int, int, int]]]:
    H, W = img.shape[:2]
    x0, y0, x1, y1 = xyxy
    bw = x1 - x0
    bh = y1 - y0
    cx = (x0 + x1) / 2
    cy = (y0 + y1) / 2
    nbw = bw * (1 + 2 * pad)
    nbh = bh * (1 + 2 * pad)
    x0 = int(max(0, cx - nbw / 2))
    x1 = int(min(W, cx + nbw / 2))
    y0 = int(max(0, cy - nbh / 2))
    y1 = int(min(H, cy + nbh / 2))
    if x1 <= x0 + 4 or y1 <= y0 + 4:
        return None, None
    return img[y0:y1, x0:x1].copy(), (x0, y0, x1, y1)


class CoverPipeline:
    def __init__(
        self,
        yolo_path: str | Path,
        classifier_path: str | Path,
        music_data_path: str | Path | None = None,
        device: str | torch.device = "cpu",
        pad: float = 0.05,
        topk: int = 6,
        yolo_imgsz: int = 640,
        yolo_conf: float = 0.25,
    ):
        self.device = torch.device(device)
        self.yolo = YOLO(str(yolo_path))
        self.model, self.classes, self.img_size, self.tf = _load_classifier(Path(classifier_path), self.device)
        self.id2title = _load_titles(Path(music_data_path)) if music_data_path else {}
        self.pad = pad
        self.topk = topk
        self.yolo_imgsz = yolo_imgsz
        self.yolo_conf = yolo_conf

    # ---- low-level helpers ----

    def detect_cover_bbox(self, bgr: np.ndarray) -> Optional[tuple[tuple[float, float, float, float], float]]:
        """Run YOLO and return the LARGEST detected bbox + its confidence."""
        result = self.yolo.predict(
            source=bgr, imgsz=self.yolo_imgsz, conf=self.yolo_conf,
            verbose=False, device=str(self.device),
        )[0]
        boxes = result.boxes
        if boxes is None or len(boxes) == 0:
            return None
        xyxys = boxes.xyxy.cpu().numpy()
        confs = boxes.conf.cpu().numpy()
        # main cover = largest area
        order = np.argsort(-(xyxys[:, 2] - xyxys[:, 0]) * (xyxys[:, 3] - xyxys[:, 1]))
        return tuple(float(v) for v in xyxys[order[0]]), float(confs[order[0]])

    def classify_crop(self, crop_bgr: np.ndarray, topk: int | None = None) -> list[CoverCandidate]:
        if topk is None:
            topk = self.topk
        pil = Image.fromarray(cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB))
        x = self.tf(pil).unsqueeze(0).to(self.device)
        with torch.no_grad():
            logits = self.model(x)[0]
            probs = torch.softmax(logits, dim=0).cpu().numpy()
        idx = np.argsort(probs)[::-1][:topk]
        return [CoverCandidate(self.classes[i], self.id2title.get(self.classes[i], ""), float(probs[i])) for i in idx]

    # ---- high-level ----

    def identify(self, bgr: np.ndarray, topk: int | None = None) -> Optional[CoverResult]:
        if bgr is None:
            return None
        H, W = bgr.shape[:2]
        det = self.detect_cover_bbox(bgr)
        if det is None:
            return None
        raw_xyxy, conf = det
        crop, padded_xyxy = _padded_crop(bgr, raw_xyxy, self.pad)
        if crop is None:
            return None
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
        if bgr is None:
            return None
        return self.identify(bgr, topk=topk)


# ---- CLI ----

def _main():
    import argparse, time
    ap = argparse.ArgumentParser(description="End-to-end cover identification.")
    ap.add_argument("input", help="image file or directory")
    ap.add_argument("--yolo", default=r"D:\ocr\models\cover_single_v5.pt")
    ap.add_argument("--ckpt", default=r"D:\ocr\models\cover_classifier_v1.pt")
    ap.add_argument("--music-data", default=r"D:\ocr\data\music_data.json")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--pad", type=float, default=0.05)
    ap.add_argument("--topk", type=int, default=3)
    ap.add_argument("--limit", type=int, default=0, help="cap on directory scan; 0=no cap")
    args = ap.parse_args()

    pipe = CoverPipeline(args.yolo, args.ckpt, args.music_data,
                         device=args.device, pad=args.pad, topk=args.topk)

    inp = Path(args.input)
    if inp.is_file():
        files = [inp]
    else:
        files = []
        for ext in ("*.jpg", "*.jpeg", "*.png"):
            files.extend(inp.rglob(ext))
        files.sort()
        if args.limit:
            files = files[: args.limit]

    print(f"[run] {len(files)} files, device={args.device}, pad={args.pad}, topk={args.topk}")
    times: list[float] = []
    for f in files:
        t0 = time.perf_counter()
        res = pipe.identify_path(f)
        dt = (time.perf_counter() - t0) * 1000
        times.append(dt)
        if res is None:
            print(f"  {f.name:<32}  NO_DETECTION  ({dt:.1f} ms)")
            continue
        cands = " | ".join(f"{c.music_id}({c.prob:.2f}){' '+c.title if c.title else ''}" for c in res.candidates)
        print(f"  {f.name:<32}  {dt:6.1f} ms  yconf={res.yolo_conf:.2f}  {cands}")
    if times:
        ts = np.array(times)
        print(f"\n[bench] n={len(ts)} mean={ts.mean():.1f}ms  p50={np.median(ts):.1f}ms  p95={np.quantile(ts,0.95):.1f}ms")


if __name__ == "__main__":
    _main()
