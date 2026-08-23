"""Train a *title* embedding model with EfficientNet-B0 + Sub-center ArcFace.

Same recipe as `train_cover_arcface.py` (GeM pool + sub-center ArcFace head)
but tuned for the long-aspect title bbox crop:

    title bbox crop (BGR, ~6:1 aspect)
        -> resize to 64x384
        -> EfficientNet-B0 backbone (ImageNet init)
        -> GeM -> BN -> Linear(1280, 256) -> BN
        -> L2 norm -> Sub-center ArcFace (k=3, m=0.30, s=32)

Data:
    - synthetic: rendered on the fly with `training/title_synth.render_one_rgb`
      (uses scripts/synth_titles' capsule + distractor + warp + JPEG recipe)
    - real: cropped title regions from `runs/real_titles/raw/*.png`
      (paired with `cover_real_train.json`-equivalent label file)

Usage:
    python -m training.train_title_arcface \
        --titles  D:/ocr/data/titles.json \
        --real    D:/copilot/maimai-cover/data/title_real_train.json \
        --out     D:/copilot/maimai-cover/runs/title_arcface_v1 \
        --epochs  20 --batch 96 --workers 6
"""
from __future__ import annotations

import argparse
import json
import math
import random
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms
from torchvision.models import efficientnet_b0, EfficientNet_B0_Weights

from .title_synth import render_one_rgb


# ---------- model ----------

class GeM(nn.Module):
    def __init__(self, p: float = 3.0, eps: float = 1e-6):
        super().__init__()
        self.p = nn.Parameter(torch.ones(1) * p)
        self.eps = eps

    def forward(self, x):
        return F.adaptive_avg_pool2d(x.clamp(min=self.eps).pow(self.p),
                                     1).pow(1.0 / self.p).flatten(1)


class TitleEmbedder(nn.Module):
    def __init__(self, embed_dim: int = 256, pretrained: bool = True):
        super().__init__()
        weights = EfficientNet_B0_Weights.IMAGENET1K_V1 if pretrained else None
        net = efficientnet_b0(weights=weights)
        self.features = net.features  # output: (B, 1280, H/32, W/32)
        self.feat_dim = 1280
        self.pool = GeM(p=3.0)
        self.bn1 = nn.BatchNorm1d(self.feat_dim)
        self.fc = nn.Linear(self.feat_dim, embed_dim, bias=False)
        self.bn2 = nn.BatchNorm1d(embed_dim)
        self.embed_dim = embed_dim

    def forward(self, x):
        x = self.features(x)
        x = self.pool(x)
        x = self.bn1(x)
        x = self.fc(x)
        x = self.bn2(x)
        return x


class SubCenterArcMargin(nn.Module):
    def __init__(self, embed_dim: int, num_classes: int, k: int = 3,
                 margin: float = 0.30, scale: float = 32.0):
        super().__init__()
        self.num_classes = num_classes
        self.k = k
        self.margin = margin
        self.scale = scale
        self.weight = nn.Parameter(torch.empty(num_classes * k, embed_dim))
        nn.init.normal_(self.weight, std=0.01)

    def forward(self, embeddings, labels=None):
        emb = F.normalize(embeddings, dim=1)
        w = F.normalize(self.weight, dim=1)
        cos_all = emb @ w.t()
        cos_all = cos_all.view(-1, self.num_classes, self.k)
        cos = cos_all.max(dim=2).values
        if labels is None:
            return cos * self.scale, cos
        sin = torch.sqrt(torch.clamp(1 - cos.pow(2), min=1e-7))
        cos_m = cos * math.cos(self.margin) - sin * math.sin(self.margin)
        cos_m = torch.where(cos > 0, cos_m, cos)
        one_hot = torch.zeros_like(cos)
        one_hot.scatter_(1, labels.view(-1, 1), 1)
        logits = (one_hot * cos_m + (1 - one_hot) * cos) * self.scale
        return logits, cos


# ---------- light photo aug for real samples ----------

def _light_real_aug(bgr: np.ndarray, rng: random.Random) -> np.ndarray:
    # tiny rotation
    if rng.random() < 0.5:
        h, w = bgr.shape[:2]
        ang = rng.uniform(-3.0, 3.0)
        M = cv2.getRotationMatrix2D((w / 2, h / 2), ang, 1.0)
        bgr = cv2.warpAffine(bgr, M, (w, h),
                             borderMode=cv2.BORDER_REPLICATE)
    # small crop jitter (±6% each side)
    if rng.random() < 0.7:
        h, w = bgr.shape[:2]
        cx1 = int(w * rng.uniform(0, 0.06))
        cy1 = int(h * rng.uniform(0, 0.06))
        cx2 = w - int(w * rng.uniform(0, 0.06))
        cy2 = h - int(h * rng.uniform(0, 0.06))
        bgr = bgr[cy1:cy2, cx1:cx2]
    # brightness
    if rng.random() < 0.5:
        delta = rng.uniform(-25, 25)
        bgr = np.clip(bgr.astype(np.int16) + int(delta), 0, 255).astype(np.uint8)
    # mild blur
    if rng.random() < 0.3:
        sigma = rng.uniform(0.3, 1.0)
        k = max(3, int(sigma * 4) | 1)
        bgr = cv2.GaussianBlur(bgr, (k, k), sigma)
    # JPEG roundtrip
    if rng.random() < 0.4:
        q = rng.randint(60, 92)
        ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, q])
        if ok:
            bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    return bgr


# ---------- dataset ----------

@dataclass
class TitleItem:
    path: str
    title: str


class TitleDataset(Dataset):
    """Train: 50% real (if available) / 50% synth-on-the-fly. Val: clean synth per class."""

    def __init__(self, classes: list[str], real_items: list[TitleItem],
                 img_h: int = 64, img_w: int = 384, train: bool = True,
                 samples_per_class: int = 30, real_prob: float = 0.5,
                 seed: int = 0):
        from collections import defaultdict
        self.classes = classes
        self.cls_to_idx = {t: i for i, t in enumerate(classes)}
        self.real_items = real_items
        self.real_by_cls: dict[int, list[int]] = defaultdict(list)
        for i, it in enumerate(real_items):
            if it.title in self.cls_to_idx:
                self.real_by_cls[self.cls_to_idx[it.title]].append(i)
        self.real_classes = sorted(self.real_by_cls.keys())
        self.img_h, self.img_w = img_h, img_w
        self.train = train
        self.samples_per_class = samples_per_class
        self.real_prob = real_prob if self.real_classes else 0.0
        self._tf_norm = transforms.Normalize([0.485, 0.456, 0.406],
                                             [0.229, 0.224, 0.225])
        self._seed = seed

    def __len__(self):
        if self.train:
            return len(self.classes) * self.samples_per_class
        return len(self.classes)

    def _to_tensor(self, bgr: np.ndarray) -> torch.Tensor:
        bgr = cv2.resize(bgr, (self.img_w, self.img_h),
                         interpolation=cv2.INTER_AREA)
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        t = torch.from_numpy(rgb).permute(2, 0, 1).float() / 255.0
        return self._tf_norm(t)

    def __getitem__(self, i):
        if not self.train:
            cls = i % len(self.classes)
            rng = random.Random(self._seed + cls * 7919)
            img = render_one_rgb(self.classes[cls], rng)
            return self._to_tensor(img), cls

        rng = random.Random()
        use_real = self.real_prob > 0 and rng.random() < self.real_prob
        if use_real:
            cls = rng.choice(self.real_classes)
            idx = rng.choice(self.real_by_cls[cls])
            it = self.real_items[idx]
            img = cv2.imread(it.path)
            if img is None:
                # fall back to synth
                img = render_one_rgb(self.classes[cls], rng)
            else:
                img = _light_real_aug(img, rng)
        else:
            cls = i % len(self.classes)
            img = render_one_rgb(self.classes[cls], rng)
        return self._to_tensor(img), cls


# ---------- training ----------

def train(args):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"[train] device={device}")

    titles = json.loads(Path(args.titles).read_text(encoding="utf-8"))["titles"]
    classes = sorted(set(titles))
    print(f"[train] {len(classes)} title classes")

    real_items: list[TitleItem] = []
    if args.real and Path(args.real).is_file():
        recs = json.loads(Path(args.real).read_text(encoding="utf-8"))
        recs = recs.get("titles", recs) if isinstance(recs, dict) else recs
        cset = set(classes)
        kept = [TitleItem(r["path"], r["title"]) for r in recs
                if r["title"] in cset]
        print(f"[train] +{len(kept)} real samples (skipped {len(recs) - len(kept)} unknown)")
        real_items = kept

    train_ds = TitleDataset(classes, real_items,
                            img_h=args.img_h, img_w=args.img_w,
                            train=True,
                            samples_per_class=args.samples_per_class,
                            real_prob=args.real_prob)
    val_ds = TitleDataset(classes, [], img_h=args.img_h, img_w=args.img_w,
                          train=False, seed=42)

    train_loader = DataLoader(train_ds, batch_size=args.batch, shuffle=True,
                              num_workers=args.workers, pin_memory=True,
                              persistent_workers=args.workers > 0,
                              drop_last=True)
    val_loader = DataLoader(val_ds, batch_size=args.batch, shuffle=False,
                            num_workers=0, pin_memory=True)

    model = TitleEmbedder(embed_dim=args.embed_dim, pretrained=True).to(device)
    head = SubCenterArcMargin(embed_dim=args.embed_dim,
                              num_classes=len(classes),
                              k=args.sub_k, margin=args.margin,
                              scale=args.scale).to(device)

    if args.init_from:
        ck = torch.load(args.init_from, map_location="cpu")
        msd = ck.get("model") or ck.get("state_dict")
        if msd is not None:
            missing, unexpected = model.load_state_dict(msd, strict=False)
            print(f"[init] backbone <- {args.init_from}  "
                  f"missing={len(missing)} unexpected={len(unexpected)}")
        if "head" in ck and ck["head"]["weight"].shape == head.weight.shape:
            head.load_state_dict(ck["head"])
            print(f"[init] head    <- {args.init_from}")

    params = [
        {"params": model.parameters(), "lr": args.lr},
        {"params": head.parameters(),  "lr": args.lr * 5},
    ]
    opt = torch.optim.AdamW(params, weight_decay=args.weight_decay)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")

    out_dir = Path(args.out); out_dir.mkdir(parents=True, exist_ok=True)
    best_top1 = -1.0
    n_iter = len(train_loader)
    print(f"[train] {n_iter} iters/epoch", flush=True)

    for epoch in range(args.epochs):
        model.train(); head.train()
        t0 = time.time()
        running = {"loss": 0.0, "n": 0, "top1": 0}
        for it, (x, y) in enumerate(train_loader):
            x = x.to(device, non_blocking=True)
            y = y.to(device, non_blocking=True)
            opt.zero_grad(set_to_none=True)
            with torch.amp.autocast("cuda", enabled=device.type == "cuda"):
                emb = model(x)
                logits, cos = head(emb, y)
                loss = F.cross_entropy(logits, y)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()

            running["loss"] += loss.item() * y.size(0)
            running["n"]    += y.size(0)
            running["top1"] += (cos.argmax(1) == y).sum().item()
            if (it + 1) % 50 == 0 or it == 0:
                el = time.time() - t0
                eta = el / (it + 1) * (n_iter - it - 1)
                print(f"  [ep {epoch+1} it {it+1}/{n_iter}] "
                      f"loss={running['loss']/running['n']:.3f} "
                      f"top1={running['top1']/running['n']:.3f} "
                      f"({el:.0f}s elapsed, ~{eta:.0f}s left)", flush=True)

        sched.step()

        # val: pure synth, one per class
        model.eval(); head.eval()
        v_top1 = 0; v_n = 0
        with torch.no_grad():
            for x, y in val_loader:
                x = x.to(device, non_blocking=True)
                y = y.to(device, non_blocking=True)
                with torch.amp.autocast("cuda", enabled=device.type == "cuda"):
                    emb = model(x)
                    _, cos = head(emb, None)
                v_top1 += (cos.argmax(1) == y).sum().item()
                v_n    += y.size(0)
        v_acc = v_top1 / max(1, v_n)
        ep_t = time.time() - t0
        print(f"[ep {epoch+1:3d}/{args.epochs}] "
              f"loss={running['loss']/running['n']:.3f} "
              f"train_top1={running['top1']/running['n']:.3f} "
              f"val_top1={v_acc:.3f} ({ep_t:.0f}s)", flush=True)

        ckpt = {
            "model": model.state_dict(),
            "head":  head.state_dict(),
            "classes": classes,
            "img_h": args.img_h, "img_w": args.img_w,
            "embed_dim": args.embed_dim,
            "arch": "efficientnet_b0",
            "arcface_cfg": {"k": args.sub_k,
                            "margin": args.margin, "scale": args.scale},
            "epoch": epoch + 1,
            "val_top1": v_acc,
        }
        torch.save(ckpt, out_dir / "last.pt")
        if v_acc > best_top1:
            best_top1 = v_acc
            torch.save(ckpt, out_dir / "best.pt")
            print(f"[ep {epoch+1:3d}] -> saved best (val_top1={v_acc:.3f})", flush=True)

    print(f"[done] best val_top1={best_top1:.3f}; ckpts in {out_dir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--titles",   required=True)
    ap.add_argument("--real",     default=None)
    ap.add_argument("--out",      required=True)
    ap.add_argument("--epochs",   type=int, default=20)
    ap.add_argument("--batch",    type=int, default=96)
    ap.add_argument("--workers",  type=int, default=6)
    ap.add_argument("--img-h",    type=int, default=64)
    ap.add_argument("--img-w",    type=int, default=384)
    ap.add_argument("--embed-dim", type=int, default=256)
    ap.add_argument("--samples-per-class", type=int, default=20)
    ap.add_argument("--real-prob", type=float, default=0.5)
    ap.add_argument("--lr",         type=float, default=3e-4)
    ap.add_argument("--weight-decay", type=float, default=1e-4)
    ap.add_argument("--sub-k",      type=int, default=3)
    ap.add_argument("--margin",     type=float, default=0.30)
    ap.add_argument("--scale",      type=float, default=32.0)
    ap.add_argument("--init-from",  default=None)
    args = ap.parse_args()
    train(args)


if __name__ == "__main__":
    main()
