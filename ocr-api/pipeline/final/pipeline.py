"""End-to-end maimai score-screen OCR pipeline.

    bgr image
       ├── version classifier  -> version label
       ├── anchors YOLO (per version) -> {tag: bbox}
       ├── per-text-tag OCR     -> structured fields
       ├── icon tags            -> presence flag (placeholder)
       └── cover crop -> classifier -> top-k music_id

Usage:
    from final.pipeline import MaimaiPipeline
    pipe = MaimaiPipeline()                  # uses default model paths
    out = pipe.run_path("foo.jpg")           # dict
"""
from __future__ import annotations

import json
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

from .anchors import AnchorsRouter, UNSUPPORTED_VERSIONS
from .binary_crop_cls import BinaryCropClassifier, MultiClassCropClassifier
from .cover_arcface_pipeline import CoverArcFacePipeline, _padded_crop as _cover_padded_crop
from .tag_ocr import ICON_TAGS, TEXT_TAGS, TagOCR
from .title_arcface_pipeline import TitleArcFacePipeline
from .version_classifier import VersionClassifier
from .version_classifier_v2 import VersionClassifierV2


DEFAULT_VERSION_CKPT  = r"D:\ocr\ocr\models\maimai_version_classifier.pt"
DEFAULT_VERSION_V2_CKPT = r"D:\ocr\ocr\models\version_classifier_v2.pt"
DEFAULT_COVER_YOLO    = r"D:\ocr\ocr\models\cover_single_v5.pt"
DEFAULT_COVER_CKPT    = r"D:\ocr\ocr\models\cover_arcface_v2.pt"
DEFAULT_COVER_GALLERY = r"D:\ocr\ocr\models\cover_arcface_v2_gallery.npz"
DEFAULT_TITLE_CKPT    = r"D:\ocr\ocr\models\title_arcface_v1.pt"
DEFAULT_TITLE_GALLERY = r"D:\ocr\ocr\models\title_arcface_v1_gallery.npz"
DEFAULT_IS_DX_CKPT    = r"D:\ocr\ocr\models\music_is_dx_v1.pt"
DEFAULT_TOUCH_CKPT    = r"D:\ocr\ocr\models\touch_cls_v1.pt"
DEFAULT_DIFF_TYPE_CKPT = r"D:\ocr\ocr\models\music_diff_type_v1.pt"
DEFAULT_DIFF_TYPE_2020_CKPT = r"D:\ocr\ocr\models\music_diff_type_2020_v5.pt"
DEFAULT_DIFF_TYPE_2223_2425_CKPT = r"D:\ocr\ocr\models\music_diff_type_2223_2425_v5.pt"
DEFAULT_FC_FS_CKPT    = r"D:\ocr\ocr\models\fc_fs_v1.pt"
DEFAULT_FC_2223_2425_CKPT = r"D:\ocr\ocr\models\fc_2223_2425_v1.pt"


class MaimaiPipeline:
    def __init__(
        self,
        version_ckpt: str = DEFAULT_VERSION_CKPT,
        cover_yolo: str = DEFAULT_COVER_YOLO,
        cover_ckpt: str = DEFAULT_COVER_CKPT,
        cover_gallery: str = DEFAULT_COVER_GALLERY,
        title_ckpt: Optional[str] = DEFAULT_TITLE_CKPT,
        title_gallery: Optional[str] = DEFAULT_TITLE_GALLERY,
        is_dx_ckpt: Optional[str] = DEFAULT_IS_DX_CKPT,
        touch_ckpt: Optional[str] = DEFAULT_TOUCH_CKPT,
        diff_type_ckpt: Optional[str] = DEFAULT_DIFF_TYPE_CKPT,
        diff_type_2020_ckpt: Optional[str] = DEFAULT_DIFF_TYPE_2020_CKPT,
        diff_type_2223_2425_ckpt: Optional[str] = DEFAULT_DIFF_TYPE_2223_2425_CKPT,
        fc_fs_ckpt: Optional[str] = DEFAULT_FC_FS_CKPT,
        fc_2223_2425_ckpt: Optional[str] = DEFAULT_FC_2223_2425_CKPT,
        device: str = "cpu",
        cover_pad: float = 0.05,
        cover_topk: int = 3,
        title_topk: int = 5,
    ):
        self.device = device
        self.version = VersionClassifier(version_ckpt, device=device)
        # If v2 ckpt is present, prefer it (EfficientNet-B0, 5 cls, val=1.0).
        if Path(DEFAULT_VERSION_V2_CKPT).is_file():
            try:
                self.version = VersionClassifierV2(DEFAULT_VERSION_V2_CKPT, device=device)
                print(f"[pipeline] using version_classifier_v2 ({len(self.version.classes)} classes)")
            except Exception as e:
                print(f"[pipeline] WARN: version_classifier_v2 failed to load, fallback to v1: {e}")
        self.anchors = AnchorsRouter(device=device)
        # On GPU we disable the paddle fallback: CRNN parses correctly ~99%+
        # of the time, and the lazy paddle init on the 1% that fails
        # tail-latency-bombs the run by ~7s on the first miss.
        # Disable paddle fallback unless explicitly enabled. The CRNN ORT
        # path covers ~99% of cases, and the 1% paddle-cold-start tail-bombs
        # latency by ~7s. Set MAIMAI_PADDLE_FALLBACK=1 to re-enable.
        disable_paddle = os.environ.get("MAIMAI_PADDLE_FALLBACK") != "1"
        self.tag_ocr = TagOCR(device=device,
                              disable_paddle_fallback=disable_paddle)
        self.cover = CoverArcFacePipeline(
            yolo_path=cover_yolo, ckpt_path=cover_ckpt, gallery_path=cover_gallery,
            device=device, pad=cover_pad, topk=cover_topk,
            onnx_path=os.environ.get("MAIMAI_COVER_ONNX") or None,
        )
        self.cover_pad = cover_pad
        self.cover_topk = cover_topk
        self.title_topk = title_topk
        self.title = None
        if title_ckpt and Path(title_ckpt).is_file() \
                and title_gallery and Path(title_gallery).is_file():
            try:
                self.title = TitleArcFacePipeline(
                    ckpt_path=title_ckpt, gallery_path=title_gallery,
                    device=device, topk=title_topk,
                    onnx_path=os.environ.get("MAIMAI_TITLE_ONNX") or None,
                )
            except Exception as e:
                print(f"[pipeline] WARN: title arcface failed to load: {e}")

        self.is_dx = None
        # Classifiers are tiny (mobilenet_v3_small @ 96/128). On GPU all 5
        # serialize on the same device. On CPU they parallelize via threadpool.
        # Env override: MAIMAI_CLS_DEVICE=cpu|cuda
        cls_device = os.environ.get("MAIMAI_CLS_DEVICE", device)
        # Optional ORT acceleration: each ckpt path can have a sibling .onnx,
        # picked up by env MAIMAI_CLS_ONNX_DIR. ORT-CUDA is ~6.8x faster than
        # torch on T1000 for these small mobilenets.
        cls_onnx_dir = os.environ.get("MAIMAI_CLS_ONNX_DIR")
        def _onnx_for(ckpt_path: Optional[str]) -> Optional[str]:
            if not (cls_onnx_dir and ckpt_path):
                return None
            stem = Path(ckpt_path).stem
            cand = Path(cls_onnx_dir) / f"{stem}.onnx"
            return str(cand) if cand.is_file() else None
        if is_dx_ckpt and Path(is_dx_ckpt).is_file():
            try:
                self.is_dx = BinaryCropClassifier(is_dx_ckpt, device=cls_device,
                                                  onnx_path=_onnx_for(is_dx_ckpt))
            except Exception as e:
                print(f"[pipeline] WARN: music_is_dx classifier failed to load: {e}")

        self.touch = None
        if touch_ckpt and Path(touch_ckpt).is_file():
            try:
                self.touch = BinaryCropClassifier(touch_ckpt, device=cls_device,
                                                  onnx_path=_onnx_for(touch_ckpt))
            except Exception as e:
                print(f"[pipeline] WARN: touch_2020_2021 classifier failed to load: {e}")

        # diff_type 现按版本路由：
        #   maimai_dx_2020_2021      → diff_type_2020 (5-class, 纯英文 banner)
        #   maimai_dx_2022_2023/2024_2025 → diff_type_2223_2425 (6-class, 含中文 + utage)
        # legacy diff_type_ckpt 留作 fallback（任一专版加载失败时仍有兜底）
        self.diff_type = None
        self.diff_type_2020 = None
        self.diff_type_2223_2425 = None
        if diff_type_ckpt and Path(diff_type_ckpt).is_file():
            try:
                self.diff_type = MultiClassCropClassifier(diff_type_ckpt, device=cls_device,
                                                          onnx_path=_onnx_for(diff_type_ckpt))
            except Exception as e:
                print(f"[pipeline] WARN: music_diff_type (legacy) classifier failed to load: {e}")
        if diff_type_2020_ckpt and Path(diff_type_2020_ckpt).is_file():
            try:
                self.diff_type_2020 = MultiClassCropClassifier(diff_type_2020_ckpt, device=cls_device,
                                                               onnx_path=_onnx_for(diff_type_2020_ckpt))
            except Exception as e:
                print(f"[pipeline] WARN: music_diff_type_2020 classifier failed to load: {e}")
        if diff_type_2223_2425_ckpt and Path(diff_type_2223_2425_ckpt).is_file():
            try:
                self.diff_type_2223_2425 = MultiClassCropClassifier(diff_type_2223_2425_ckpt, device=cls_device,
                                                                    onnx_path=_onnx_for(diff_type_2223_2425_ckpt))
            except Exception as e:
                print(f"[pipeline] WARN: music_diff_type_2223_2425 classifier failed to load: {e}")

        self.fc_fs = None
        if fc_fs_ckpt and Path(fc_fs_ckpt).is_file():
            try:
                self.fc_fs = MultiClassCropClassifier(fc_fs_ckpt, device=cls_device,
                                                      onnx_path=_onnx_for(fc_fs_ckpt))
            except Exception as e:
                print(f"[pipeline] WARN: fc_fs_2020_2021 classifier failed to load: {e}")

        self.fc_2223_2425 = None
        if fc_2223_2425_ckpt and Path(fc_2223_2425_ckpt).is_file():
            try:
                self.fc_2223_2425 = MultiClassCropClassifier(fc_2223_2425_ckpt, device=cls_device,
                                                             onnx_path=_onnx_for(fc_2223_2425_ckpt))
            except Exception as e:
                print(f"[pipeline] WARN: fc (2223+2425) classifier failed to load: {e}")

        # Reused thread pool for fan-out stages (cover+title, 5x classifiers).
        # On CUDA, kernel launches release the GIL so threading actually
        # overlaps. On CPU, threading still helps because torch ops release
        # the GIL too. Sized to max fan-out we use (5 classifiers).
        self._pool = ThreadPoolExecutor(max_workers=10, thread_name_prefix="maimai-pipe")

    # diff_type OCR fallback：低置信 case 走 PaddleOCR keyword match。
    # 关键字优先级：长 prefix 优先（"RE:MASTER" 在 "MASTER" 之前），避免子串
    # 重叠。中文同理。utage 列在最前避免 "宴会场" 被某些 case 错位。
    _DIFF_KW_PATTERNS = [
        ("utage",     ["UTAGE", "宴会场", "宴會場"]),
        ("re_master", ["REMASTER", "RE MASTER", "宗师", "宗師"]),
        ("master",    ["MASTER", "大师", "大師"]),
        ("expert",    ["EXPERT", "专家", "專家"]),
        ("advanced",  ["ADVANCED", "高级", "高級"]),
        ("basic",     ["BASIC", "初级", "初級"]),
    ]

    def _diff_type_ocr_fallback(self, bgr: np.ndarray, xyxy) -> Optional[str]:
        """OCR banner crop + keyword match → 5/6 类 label。失败返回 None。"""
        try:
            from .tag_ocr import _crop_padded
        except ImportError:
            _crop_padded = None
        try:
            x1, y1, x2, y2 = [int(round(v)) for v in xyxy]
            H, W = bgr.shape[:2]
            pad_x = max(8, int((x2 - x1) * 0.05))
            pad_y = max(4, int((y2 - y1) * 0.10))
            x1 = max(0, x1 - pad_x); y1 = max(0, y1 - pad_y)
            x2 = min(W, x2 + pad_x); y2 = min(H, y2 + pad_y)
            crop = bgr[y1:y2, x1:x2]
            if crop.size == 0:
                return None
            # 直接用 self.tag_ocr 的内部 PaddleOCR session（lazy init）。
            # 不走 ocr_tag() 因为它是 dispatch 给 achievement_score / rating_detail
            # 等专用 CRNN 的，music_title 这条只需要原始 paddle 文字。
            rec = self.tag_ocr.force_init_paddle()
            if rec is None:  # paddle disabled (NullPaddle stub) → 跳过
                return None
            res = rec.predict(crop)
            texts = []
            if res:
                for x in (res if isinstance(res, list) else [res]):
                    if isinstance(x, dict):
                        t = (x.get("rec_text") or x.get("text") or "").strip()
                        if t:
                            texts.append(t)
            if not texts:
                return None
            joined = " ".join(texts).upper()
            joined_norm = joined.replace(":", "").replace("·", "").replace(" ", "").replace("．", "")
            for cls, kws in self._DIFF_KW_PATTERNS:
                for kw in kws:
                    kw_norm = kw.upper().replace(":", "").replace("·", "").replace(" ", "")
                    if kw_norm in joined_norm:
                        return cls
            return None
        except Exception as e:
            print(f"[pipeline] diff_type OCR fallback failed: {e}")
            return None


    # ---- per-step helpers ----

    def _classify_cover_from_anchor(self, bgr: np.ndarray, xyxy) -> Optional[dict]:
        crop, _ = _cover_padded_crop(bgr, xyxy, self.cover_pad)
        if crop is None:
            return None
        cands = self.cover.classify_crop(crop, topk=self.cover_topk)
        if not cands:
            return None
        return {
            "top1": {"title": cands[0].title, "prob": cands[0].prob,
                     "cosine": cands[0].cosine},
            "topk": [
                {"title": c.title, "prob": c.prob, "cosine": c.cosine}
                for c in cands
            ],
        }

    # ---- main entry ----

    def run(self, bgr: np.ndarray, force_version: str | None = None) -> dict:
        import time
        H, W = bgr.shape[:2]
        out: dict = {"image_size": [W, H]}
        stages: dict[str, float] = {}

        # 1. version
        t = time.perf_counter()
        if force_version is not None:
            class _V:
                label = force_version
                prob = 1.0
                topk = [(force_version, 1.0)]
            v = _V()
        else:
            v = self.version.predict(bgr)
        stages["version"] = (time.perf_counter() - t) * 1000
        out["version"] = {"label": v.label, "prob": v.prob, "topk": v.topk, "forced": force_version is not None}

        if v.label in UNSUPPORTED_VERSIONS:
            out["status"] = "skipped_unsupported_version"
            out["stages_ms"] = stages
            return out

        # 2. anchors
        t = time.perf_counter()
        hits = self.anchors.detect(bgr, v.label)
        stages["anchors"] = (time.perf_counter() - t) * 1000
        out["anchors"] = {
            name: {"xyxy": list(h.xyxy), "conf": h.conf} for name, h in hits.items()
        }
        # 2026-05-02: 多实例计数（同一类被检出 ≥2 次）。watch.py 用来判双屏。
        out["anchors_counts"] = dict(getattr(self.anchors, "_last_counts", {}) or {})

        # 3 + 3b. cover & title in parallel — independent crops, both heavy
        # GPU forward, ~25ms savings on T1000 (cover=42ms || title=29ms).
        def _do_cover():
            music = None
            if "music_cover" in hits:
                music = self._classify_cover_from_anchor(bgr, hits["music_cover"].xyxy)
            if music is None:
                res = self.cover.identify(bgr, topk=self.cover_topk)
                if res is not None:
                    music = {
                        "top1": {"title": res.top1.title, "prob": res.top1.prob,
                                 "cosine": res.top1.cosine},
                        "topk": [{"title": c.title, "prob": c.prob, "cosine": c.cosine}
                                 for c in res.candidates],
                        "fallback": "cover_single_yolo",
                    }
            return music

        def _do_title():
            if self.title is None or "music_title" not in hits:
                return None
            return self.title.classify_anchor(bgr, hits["music_title"].xyxy,
                                              topk=self.title_topk)

        # ---------- Mega fan-out: cover, title, all OCR tags, all 5 classifiers
        # all submit at the same time and run in parallel via the shared pool.
        # Everything below anchors is independent (only consumes hit bboxes +
        # full-image bgr), so wall time is max(slowest path) instead of sum.
        t_fanout = time.perf_counter()

        f_cover = self._pool.submit(_do_cover)
        f_title = self._pool.submit(_do_title)

        # OCR fan-out
        only_tags_env = os.environ.get("MAIMAI_OCR_ONLY", "").strip()
        only_tags = {t.strip() for t in only_tags_env.split(",") if t.strip()} if only_tags_env else None
        ocr_jobs: dict[str, tuple] = {}  # name -> (future, t_submit)
        t_ocr_start = time.perf_counter()
        for name, hit in hits.items():
            if name not in TEXT_TAGS:
                continue
            if only_tags is not None and name not in only_tags:
                continue
            ts = time.perf_counter()
            ocr_jobs[name] = (
                self._pool.submit(self.tag_ocr.ocr_tag, bgr, hit.xyxy, name, 8, v.label),
                ts,
            )

        # Classifier fan-out — all 5 small mobilenet forwards.
        cls_jobs: dict[str, tuple] = {}  # job_name -> (future, anchor_name, kind)
        if self.is_dx is not None and "music_is_dx" in hits:
            cls_jobs["is_dx"] = (
                self._pool.submit(self.is_dx.predict_xyxy, bgr, hits["music_is_dx"].xyxy),
                "music_is_dx", "binary",
            )
        if self.touch is not None and "touch_2020_2021" in hits:
            cls_jobs["touch"] = (
                self._pool.submit(self.touch.predict_xyxy, bgr, hits["touch_2020_2021"].xyxy),
                "touch_2020_2021", "binary",
            )
        if "music_diff_type" in hits:
            # 按 version 选 diff_type 模型；专版加载失败回落到 legacy diff_type
            if v.label == "maimai_dx_2020_2021" and self.diff_type_2020 is not None:
                _diff_clf = self.diff_type_2020
            elif v.label in ("maimai_dx_2022_2023", "maimai_dx_2024_2025") and self.diff_type_2223_2425 is not None:
                _diff_clf = self.diff_type_2223_2425
            else:
                _diff_clf = self.diff_type
            if _diff_clf is not None:
                cls_jobs["diff_type"] = (
                    self._pool.submit(_diff_clf.predict_xyxy, bgr, hits["music_diff_type"].xyxy, 3),
                    "music_diff_type", "multi",
                )
        if self.fc_fs is not None and "fc_fs_2020_2021" in hits:
            cls_jobs["fc_fs"] = (
                self._pool.submit(self.fc_fs.predict_xyxy, bgr, hits["fc_fs_2020_2021"].xyxy, 3),
                "fc_fs_2020_2021", "multi",
            )
        if self.fc_2223_2425 is not None and "fc" in hits:
            cls_jobs["fc"] = (
                self._pool.submit(self.fc_2223_2425.predict_xyxy, bgr, hits["fc"].xyxy, 3),
                "fc", "multi",
            )

        # Collect cover + title.
        t_ct = time.perf_counter()
        music = f_cover.result()
        title_cands = f_title.result()
        stages["cover_title"] = (time.perf_counter() - t_ct) * 1000
        out["music"] = music

        # title pipeline output passthrough — fusion lives in renderer now.
        title_info = None
        if title_cands is not None:
            title_info = {
                "topk": [{"title": c.title, "prob": c.prob,
                          "cosine": getattr(c, "cosine", 0.0)}
                         for c in title_cands],
            }
            if title_cands:
                title_info["top1"] = title_info["topk"][0]
        out["title"] = title_info

        # 4. Collect OCR results.
        fields: dict[str, dict] = {}
        for name, (fut, ts) in ocr_jobs.items():
            f = fut.result()
            stages[f"ocr/{name}"] = (time.perf_counter() - ts) * 1000
            fields[name] = {
                "text": f.text,
                "conf": f.conf,
                "value": f.value,
                "label": f.label,
                "raw": f.raw,
            }
        stages["ocr"] = (time.perf_counter() - t_ocr_start) * 1000
        out["fields"] = fields

        # 5. Collect classifiers.
        t_cls = time.perf_counter()
        cls_results: dict[str, tuple] = {}
        for job_name, (fut, anchor_name, kind) in cls_jobs.items():
            res = fut.result()
            cls_results[job_name] = (res, anchor_name, kind)
        if cls_jobs:
            stages["classifiers"] = (time.perf_counter() - t_cls) * 1000
        stages["fanout"] = (time.perf_counter() - t_fanout) * 1000

        # 5. icon-tag presence (no template matching yet -> just detected=true)
        # Stitch in is_dx / touch results from cls_results.
        icons: dict[str, dict] = {}
        for name, hit in hits.items():
            if name in ICON_TAGS and name != "music_cover":
                entry = {"detected": True, "conf": hit.conf}
                if name == "music_is_dx" and "is_dx" in cls_results:
                    res, _, _ = cls_results["is_dx"]
                    if res is not None:
                        entry["is_dx"] = (res.label == "pos")
                        entry["pos_prob"] = res.pos_prob
                if name == "touch_2020_2021" and "touch" in cls_results:
                    res, _, _ = cls_results["touch"]
                    if res is not None:
                        entry["is_dx"] = (res.label == "pos")
                        entry["pos_prob"] = res.pos_prob
                icons[name] = entry
        out["icons"] = icons

        # 5b/5c/5d. Multi-class results -> fields.
        for job_name, field_name in (("diff_type", "music_diff_type"),
                                     ("fc_fs", "fc_fs_2020_2021"),
                                     ("fc", "fc")):
            if job_name not in cls_results:
                continue
            res, _, _ = cls_results[job_name]
            if res is None:
                continue
            fields[field_name] = {
                "text": res.label.upper(),
                "conf": res.prob,
                "value": res.label,
                "label": res.label,
                "raw": {"topk": [{"label": l, "prob": p} for l, p in res.topk]},
            }

        # 5e. diff_type OCR fallback: classifier 低置信时 (< 0.85) 调 PaddleOCR
        # 复检 banner 文字。banner 文字 BASIC / ADVANCED / EXPERT / MASTER /
        # Re:MASTER (+ 中文 初级/高级/专家/大师/宗师 + utage U·TA·GE/宴·会·场)
        # 高度可分，OCR 关键字唯一命中即覆盖 classifier 结果。
        DIFF_FALLBACK_THRESHOLD = 0.85
        if "music_diff_type" in fields and "music_diff_type" in hits:
            cur = fields["music_diff_type"]
            if (cur.get("conf") or 0) < DIFF_FALLBACK_THRESHOLD:
                ocr_label = self._diff_type_ocr_fallback(bgr, hits["music_diff_type"].xyxy)
                if ocr_label:
                    fields["music_diff_type"] = {
                        "text": ocr_label.upper(),
                        "conf": 0.99,  # OCR keyword match 视为高可信
                        "value": ocr_label,
                        "label": ocr_label,
                        "raw": {
                            "engine": "ocr_fallback",
                            "classifier": cur,  # 保留原分类器输出便于 debug
                        },
                    }

        out["fields"] = fields

        out["stages_ms"] = stages
        out["status"] = "ok"
        return out

    def run_path(self, path: str | Path, force_version: str | None = None) -> dict:
        bgr = cv2.imread(str(path))
        if bgr is None:
            return {"status": "read_failed", "path": str(path)}
        out = self.run(bgr, force_version=force_version)
        out["path"] = str(path)
        return out


def _format_summary(out: dict) -> str:
    """One-line-ish summary for CLI."""
    if out.get("status") != "ok":
        return f"[{out.get('status')}] version={out.get('version', {}).get('label', '?')}"
    v = out["version"]
    music = out.get("music") or {}
    top1 = (music.get("top1") or {})
    f = out.get("fields", {})

    def g(tag, key="value"):
        d = f.get(tag) or {}
        v = d.get(key)
        if v is None:
            v = d.get("text", "")
        return v

    bits = [
        f"v={v['label']}({v['prob']:.2f})",
        f"music=({top1.get('prob', 0):.2f}) {top1.get('title', '')}",
        f"diff={g('music_diff_type')}/{g('music_diff_level')}",
        f"score={g('achievement_score')}",
        f"dx={g('dx_score')}",
        f"combo={g('combo')}",
        f"rating={g('rating')}",
        f"icons={','.join(out.get('icons', {}).keys())}",
    ]
    return " | ".join(str(b) for b in bits)


def _main():
    import argparse, time
    ap = argparse.ArgumentParser(description="maimai score-screen end-to-end OCR.")
    ap.add_argument("input", help="image file or directory")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--json-out", default=None, help="if set, dump full results to this file (jsonl)")
    args = ap.parse_args()

    pipe = MaimaiPipeline(device=args.device)

    inp = Path(args.input)
    if inp.is_file():
        files = [inp]
    else:
        files = sorted([p for p in inp.rglob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}])
        if args.limit:
            files = files[: args.limit]

    print(f"[run] {len(files)} files, device={args.device}")
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
        st = out.get("stages_ms") or {}
        st_str = " ".join(f"{k}={v:.0f}" for k, v in st.items())
        print(f"  {f.name:<40} {dt:6.0f}ms  [{st_str}]  {_format_summary(out)}")
    if times:
        ts = np.array(times)
        print(f"\n[bench] n={len(ts)} mean={ts.mean():.0f}ms p50={np.median(ts):.0f}ms p95={np.quantile(ts, 0.95):.0f}ms")
        if stage_acc:
            print("[stages mean]", " ".join(f"{k}={np.mean(v):.0f}ms" for k, v in stage_acc.items()))
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fp:
            for r in rows:
                fp.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"[json] -> {args.json_out}")


if __name__ == "__main__":
    _main()
