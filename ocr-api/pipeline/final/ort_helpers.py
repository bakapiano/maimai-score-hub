"""Shared ORT init helpers.

Centralizes SessionOptions so CPU mode can cap intra-op threads (so 5-6
parallel sessions in the pipeline don't all try to grab every core and
thrash). Set MAIMAI_ORT_INTRA_THREADS to override (default 2 on CPU).
"""
from __future__ import annotations

import os
from typing import Optional


def make_session_options(device: str, threads_env: str = "MAIMAI_ORT_INTRA_THREADS",
                         default_threads: int = 2):
    import onnxruntime as ort
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    if not str(device).startswith("cuda"):
        try:
            n = int(os.environ.get(threads_env, str(default_threads)))
        except ValueError:
            n = default_threads
        if n > 0:
            so.intra_op_num_threads = n
            so.inter_op_num_threads = 1
            so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    return so


def make_providers(device: str):
    import onnxruntime as ort
    if (str(device).startswith("cuda")
            and "CUDAExecutionProvider" in ort.get_available_providers()):
        cuda_opts = {}
        if os.environ.get("MAIMAI_ORT_CUDA_GRAPH") == "1":
            cuda_opts["enable_cuda_graph"] = "1"
        return [("CUDAExecutionProvider", cuda_opts), "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


def make_session(onnx_path: str, device: str):
    """Build an InferenceSession with consistent options."""
    import onnxruntime as ort
    so = make_session_options(device)
    provs = make_providers(device)
    return ort.InferenceSession(onnx_path, sess_options=so, providers=provs)
