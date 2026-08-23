from __future__ import annotations

import hashlib
import os
import unittest
from pathlib import Path

from app.config import Settings
from app.recognizer import RealRecognizer

FIXTURES = Path(__file__).resolve().parent / "fixtures"
BASELINE_IMAGE = FIXTURES / "84D5CDA37085D5A296BAF14B27C348BD.jpg"
BASELINE_SHA256 = "69f97b1c04320bcfe6a960c1b4766407cfa2528831bda919cde0d1e9d07c0f9d"
RUN_REAL_MODEL_TESTS = os.getenv("OCR_RUN_REAL_MODEL_TESTS") == "1"


class RealPipelineFixtureTest(unittest.TestCase):
    def test_baseline_image_hash(self) -> None:
        digest = hashlib.sha256(BASELINE_IMAGE.read_bytes()).hexdigest()
        self.assertEqual(digest, BASELINE_SHA256)


@unittest.skipUnless(
    RUN_REAL_MODEL_TESTS,
    "set OCR_RUN_REAL_MODEL_TESTS=1 to run the production model regression",
)
class RealPipelineRegressionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        pipeline_root = Path(__file__).resolve().parents[1] / "pipeline"
        cls.recognizer = RealRecognizer(
            Settings(
                mode="real",
                pipeline_root=str(pipeline_root),
                device=os.getenv("OCR_REAL_TEST_DEVICE", "cpu"),
                catalog_enabled=False,
                catalog_root=str(FIXTURES / "_catalog_disabled"),
            )
        )

    def test_metatron_baseline_result(self) -> None:
        result = self.recognizer.recognize(
            BASELINE_IMAGE.read_bytes(),
            BASELINE_IMAGE.name,
            0,
        )

        self.assertEqual(result.status, "ok")
        self.assertGreaterEqual(len(result.candidates), 1)
        self.assertEqual(result.candidates[0].title, "METATRON")
        self.assertEqual(result.candidates[0].sources, ["cover", "title"])
        self.assertAlmostEqual(result.achievement or 0, 100.8039, places=4)
        self.assertEqual(result.dxScore, 2575)
        self.assertEqual(result.difficulty, "master")
        self.assertFalse(result.isDx)
        self.assertIsNone(result.fc)
        self.assertIsNone(result.fs)


if __name__ == "__main__":
    unittest.main()
