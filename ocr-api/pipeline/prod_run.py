"""Deploy launcher for MaimaiPipeline.

Resolves all model paths from `<repo>/models/` (i.e. next to this script),
overriding the Windows-hardcoded defaults baked into final/pipeline.py.
Use this as the entry point on Linux/T1000 hosts.

Usage:
    python prod_run.py <image_or_dir> [--device cuda|cpu] [--limit N] [--json-out f.jsonl]
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent
MODELS = Path(os.environ.get("OCR_MODELS_ROOT", REPO / "models")).resolve()
os.environ.setdefault("MAIMAI_MODELS_DIR", str(MODELS))
os.environ.setdefault("MAIMAI_COVER_ONNX", str(MODELS / "cover_arcface_v2.onnx"))
os.environ.setdefault("MAIMAI_TITLE_ONNX", str(MODELS / "title_arcface_v1.onnx"))
os.environ.setdefault("MAIMAI_CLS_ONNX_DIR", str(MODELS))

# Make `final.*` / `training.*` / `scripts.*` importable.
import sys
sys.path.insert(0, str(REPO))

from final.pipeline import MaimaiPipeline, _format_summary  # noqa: E402
from final.version_classifier_v2 import VersionClassifierV2  # noqa: E402
from final.anchors import AnchorsRouter  # noqa: E402


def build_pipe(device: str) -> MaimaiPipeline:
    # Pre-patch the AnchorsRouter default paths in-process so MaimaiPipeline's
    # constructor (which calls AnchorsRouter() with no args) picks them up.
    import final.anchors as _anchors_mod
    _anchors_mod.DEFAULT_MODEL_PATHS = {
        "maimai_dx_2020_2021": str(MODELS / "anchors_2021_final.pt"),
        "maimai_dx_2022_2023": str(MODELS / "anchors_2223_final.pt"),
        "maimai_dx_2024_2025": str(MODELS / "anchors_2425_final.pt"),
    }
    pipe = MaimaiPipeline(
        version_ckpt=str(MODELS / "maimai_version_classifier.pt"),
        cover_yolo=str(MODELS / "cover_single_v5.pt"),
        cover_ckpt=str(MODELS / "cover_arcface_v2.pt"),
        cover_gallery=os.environ.get(
            "OCR_COVER_GALLERY_PATH",
            str(MODELS / "cover_arcface_v2_gallery.npz"),
        ),
        title_ckpt=str(MODELS / "title_arcface_v1.pt"),
        title_gallery=os.environ.get(
            "OCR_TITLE_GALLERY_PATH",
            str(MODELS / "title_arcface_v1_gallery.npz"),
        ),
        is_dx_ckpt=str(MODELS / "music_is_dx_v1.pt"),
        touch_ckpt=str(MODELS / "touch_cls_v1.pt"),
        diff_type_ckpt=str(MODELS / "music_diff_type_v1.pt"),
        diff_type_2020_ckpt=str(MODELS / "music_diff_type_2020_v5.pt"),
        diff_type_2223_2425_ckpt=str(MODELS / "music_diff_type_2223_2425_v5.pt"),
        fc_fs_ckpt=str(MODELS / "fc_fs_v1.pt"),
        fc_2223_2425_ckpt=str(MODELS / "fc_2223_2425_v1.pt"),
        device=device,
    )
    # Force v2 version classifier (pipeline.py only auto-loads it from a
    # Windows path, which won't exist on Linux).
    v2 = MODELS / "version_classifier_v2.pt"
    if v2.is_file():
        try:
            v2_onnx = MODELS / "version_classifier_v2.onnx"
            pipe.version = VersionClassifierV2(
                str(v2), device=device,
                onnx_path=str(v2_onnx) if v2_onnx.is_file() else None,
            )
            print(f"[prod_run] using version_classifier_v2 ({len(pipe.version.classes)} classes)"
                  + (" [ORT]" if pipe.version.ort_sess is not None else ""))
        except Exception as e:
            print(f"[prod_run] WARN: v2 version classifier failed: {e}")
    return pipe


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--json-out", default=None)
    ap.add_argument("--warmup", type=int, default=2,
                    help="run N warmup images before timing (excluded from stats)")
    args = ap.parse_args()

    pipe = build_pipe(args.device)

    inp = Path(args.input)
    if inp.is_file():
        files = [inp]
    else:
        files = sorted([p for p in inp.rglob("*")
                        if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}])
        if args.limit:
            files = files[: args.limit]
    print(f"[run] {len(files)} files device={args.device}")

    # warmup
    for f in files[: args.warmup]:
        pipe.run_path(f)

    times: list[float] = []
    rows: list[dict] = []
    stage_acc: dict[str, list[float]] = {}
    for f in files:
        t0 = time.perf_counter()
        out = pipe.run_path(f)
        dt = (time.perf_counter() - t0) * 1000
        times.append(dt)
        rows.append(out)
        for k, v in (out.get("stages_ms") or {}).items():
            stage_acc.setdefault(k, []).append(v)
        print(f"  {f.name:<40} {dt:6.0f}ms  {_format_summary(out)}")

    if times:
        ts = np.array(times)
        print(f"\n[bench device={args.device}] n={len(ts)} "
              f"mean={ts.mean():.0f}ms p50={np.median(ts):.0f}ms "
              f"p95={np.quantile(ts, 0.95):.0f}ms total={ts.sum()/1000:.1f}s")
        if stage_acc:
            print("[stages mean]", " ".join(
                f"{k}={np.mean(v):.0f}ms" for k, v in stage_acc.items()))

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fp:
            for r in rows:
                fp.write(json.dumps(r, ensure_ascii=False, default=str) + "\n")
        print(f"[json] -> {args.json_out}")


if __name__ == "__main__":
    main()
