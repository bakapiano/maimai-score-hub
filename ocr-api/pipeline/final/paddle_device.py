from __future__ import annotations


def paddle_device(device: str) -> str:
    """Translate the pipeline's torch-style CUDA name for PaddleX."""
    normalized = device.strip().lower()
    if normalized == "cuda":
        return "gpu:0"
    if normalized.startswith("cuda:"):
        return f"gpu:{normalized.split(':', 1)[1]}"
    return normalized
