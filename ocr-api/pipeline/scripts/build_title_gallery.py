"""Build a per-title cosine gallery for the title ArcFace embedder.

For each title in titles.json:
    1. render N synthetic crops via training/title_synth.render_one_rgb
    2. add real crops from --real (if any) with --real-weight
    3. forward all through the embedder
    4. mean -> L2-norm -> store as the title's prototype
"""
from __future__ import annotations

import argparse
import json
import random
import time
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn.functional as F
from torchvision import transforms

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from training.train_title_arcface import TitleEmbedder  # noqa: E402
from training.title_synth import render_one_rgb  # noqa: E402


def _load_model(ckpt_path: str, device: torch.device):
    ck = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    embed_dim = ck.get("embed_dim", 256)
    img_h = ck.get("img_h", 64)
    img_w = ck.get("img_w", 384)
    classes = ck.get("classes")
    model = TitleEmbedder(embed_dim=embed_dim, pretrained=False).to(device).eval()
    model.load_state_dict(ck["model"])
    return model, classes, img_h, img_w, embed_dim


def _to_tensor(bgr: np.ndarray, img_h: int, img_w: int, device: torch.device):
    bgr = cv2.resize(bgr, (img_w, img_h), interpolation=cv2.INTER_AREA)
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    t = torch.from_numpy(rgb).permute(2, 0, 1).float() / 255.0
    norm = transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])
    return norm(t).unsqueeze(0).to(device)


@torch.no_grad()
def embed_batch(model, imgs: list[np.ndarray], img_h, img_w, device):
    if not imgs:
        return torch.zeros(0, model.embed_dim, device=device)
    batch = torch.cat([_to_tensor(im, img_h, img_w, device) for im in imgs], 0)
    emb = model(batch)
    emb = F.normalize(emb, dim=1)
    return emb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt",   required=True)
    ap.add_argument("--titles", required=True, help="titles.json")
    ap.add_argument("--real",   default=None, help="real manifest from build_real_title_manifest.py")
    ap.add_argument("--real-weight", type=float, default=2.0)
    ap.add_argument("--synth-per-class", type=int, default=8)
    ap.add_argument("--out",    required=True)
    ap.add_argument("--device", default="cuda")
    args = ap.parse_args()

    device = torch.device(args.device if torch.cuda.is_available() or args.device == "cpu" else "cpu")
    model, ck_classes, img_h, img_w, embed_dim = _load_model(args.ckpt, device)
    print(f"[gallery] embed_dim={embed_dim} img={img_h}x{img_w} ckpt_classes={len(ck_classes) if ck_classes else 0}")

    titles = json.loads(Path(args.titles).read_text(encoding="utf-8"))["titles"]
    titles = sorted(set(titles))
    print(f"[gallery] {len(titles)} titles")

    real_by_title: dict[str, list[str]] = {}
    if args.real and Path(args.real).is_file():
        recs = json.loads(Path(args.real).read_text(encoding="utf-8"))
        recs = recs.get("titles", recs) if isinstance(recs, dict) else recs
        for r in recs:
            real_by_title.setdefault(r["title"], []).append(r["path"])
        print(f"[gallery] +real: {sum(len(v) for v in real_by_title.values())} samples "
              f"across {len(real_by_title)} titles (weight={args.real_weight})")

    rng = random.Random(0)
    embeddings = np.zeros((len(titles), embed_dim), dtype=np.float32)
    t0 = time.time()
    real_titles_used = 0

    for ti, title in enumerate(titles):
        # synth side
        synth_imgs = [render_one_rgb(title, rng) for _ in range(args.synth_per_class)]
        synth_emb = embed_batch(model, synth_imgs, img_h, img_w, device)
        synth_mean = synth_emb.mean(dim=0)

        # real side
        real_paths = real_by_title.get(title, [])
        if real_paths:
            real_titles_used += 1
            real_imgs = []
            for p in real_paths:
                im = cv2.imread(p)
                if im is not None:
                    real_imgs.append(im)
            real_emb = embed_batch(model, real_imgs, img_h, img_w, device)
            real_mean = real_emb.mean(dim=0)
            proto = synth_mean + args.real_weight * real_mean
        else:
            proto = synth_mean

        proto = F.normalize(proto, dim=0)
        embeddings[ti] = proto.cpu().numpy()

        if (ti + 1) % 200 == 0:
            print(f"  [{ti+1}/{len(titles)}]", flush=True)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez(out, titles=np.array(titles, dtype=object), embeddings=embeddings)
    sz_kb = out.stat().st_size // 1024
    print(f"[done] {time.time()-t0:.1f}s -> {out} ({sz_kb} KB)")
    print(f"[gallery] {real_titles_used} titles got real-sample contribution")


if __name__ == "__main__":
    main()
