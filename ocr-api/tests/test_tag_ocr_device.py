from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "pipeline"
    / "final"
    / "paddle_device.py"
)
SPEC = importlib.util.spec_from_file_location("ocr_tag_ocr_device_test", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
paddle_device = MODULE.paddle_device


class PaddleDeviceTest(unittest.TestCase):
    def test_translates_torch_cuda_device_names(self) -> None:
        self.assertEqual(paddle_device("cuda"), "gpu:0")
        self.assertEqual(paddle_device("CUDA:2"), "gpu:2")

    def test_preserves_paddlex_device_names(self) -> None:
        self.assertEqual(paddle_device("cpu"), "cpu")
        self.assertEqual(paddle_device("gpu:1"), "gpu:1")


if __name__ == "__main__":
    unittest.main()
