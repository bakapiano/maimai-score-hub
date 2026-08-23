"""Build the cover gallery (per-title averaged L2-normed embeddings).

Reads the trained ArcFace checkpoint + cover manifest, runs the embedder over
every reference cover (with light TTA), averages multiple covers per title,
L2-normalizes, and saves to a single .npz that the inference pipeline loads.

Usage:
    python scripts/build_cover_gallery.py \
        --ckpt     D:/copilot/maimai-cover/runs/arcface_v1/best.pt \
        --manifest D:/ocr/ocr/data/cover_manifest.json \
        --out      D:/ocr/ocr/models/cover_gallery_v1.npz \
        --device   cuda --tta 4
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from final.cover_arcface_pipeline import _load_embedder
from training.phone_photo_aug import phone_photo_augment


@torch.no_grad()
def embed_one(model, tf, img: Image.Image, device, n_tta: int = 1) -> np.ndarray:
    crops = [img] + [phone_photo_augment(img, "tta") for _ in range(max(0, n_tta - 1))]
    xs = torch.stack([tf(c) for c in crops]).to(device)
    e = model(xs)
    e = F.normalize(e, dim=1).mean(dim=0)
    e = F.normalize(e, dim=0)
    return e.cpu().numpy().astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--real", default="", help="optional cover_real_train.json with real cover crops")
    ap.add_argument("--real-weight", type=float, default=2.0,
                    help="weight per real embedding when mixing with synthetic (synth weight=1)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--tta", type=int, default=4, help="forward passes per cover (1 = no aug)")
    args = ap.parse_args()

    device = torch.device(args.device)
    model, ckpt_classes, img_size, tf = _load_embedder(Path(args.ckpt), device)
    print(f"[gallery] embed_dim={model.embed_dim} img_size={img_size} classes_in_ckpt={len(ckpt_classes)}")

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    by_title: dict[str, list[str]] = defaultdict(list)
    for c in manifest["covers"]:
        by_title[c["title"]].append(c["path"])

    real_by_title: dict[str, list[str]] = defaultdict(list)
    if args.real:
        real = json.loads(Path(args.real).read_text(encoding="utf-8"))
        recs = real.get("covers", real) if isinstance(real, dict) else real
        for r in recs:
            real_by_title[r["title"]].append(r["path"])
        print(f"[gallery] +real: {len(recs)} samples across {len(real_by_title)} titles "
              f"(weight={args.real_weight})")

    titles = sorted(by_title.keys())
    print(f"[gallery] {len(titles)} titles, {sum(len(v) for v in by_title.values())} synth files")

    embs = np.zeros((len(titles), model.embed_dim), dtype=np.float32)
    n_with_real = 0
    t0 = time.perf_counter()
    for i, t in enumerate(titles):
        weighted = []
        weights = []
        for p in by_title[t]:
            img = Image.open(p).convert("RGB")
            weighted.append(embed_one(model, tf, img, device, n_tta=args.tta))
            weights.append(1.0)
        for p in real_by_title.get(t, []):
            try:
                img = Image.open(p).convert("RGB")
            except Exception:
                continue
            weighted.append(embed_one(model, tf, img, device, n_tta=1))
            weights.append(args.real_weight)
        if not weighted:
            continue
        if real_by_title.get(t):
            n_with_real += 1
        wsum = sum(weights)
        e = sum(w * v for w, v in zip(weights, weighted)) / wsum
        e = e / max(np.linalg.norm(e), 1e-8)
        embs[i] = e
        if (i + 1) % 200 == 0:
            print(f"  [{i+1}/{len(titles)}]")

    np.savez(args.out, titles=np.array(titles, dtype=object), embeddings=embs)
    print(f"[done] {time.perf_counter()-t0:.1f}s -> {args.out} ({Path(args.out).stat().st_size//1024} KB)")
    print(f"[gallery] {n_with_real} titles got real-sample contribution")


if __name__ == "__main__":
    main()
