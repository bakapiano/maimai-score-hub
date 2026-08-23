"""Make `final` a Python package so you can do `from final.cover_pipeline import CoverPipeline`."""
from .cover_pipeline import CoverPipeline, CoverResult, CoverCandidate

__all__ = ["CoverPipeline", "CoverResult", "CoverCandidate"]
