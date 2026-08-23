from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.recognizer import FakeRecognizer, parse_dx_score_text


class PartiallyFailingRecognizer(FakeRecognizer):
    def recognize(self, image_bytes: bytes, filename: str, index: int):
        if index == 0:
            raise RuntimeError("broken image")
        return super().recognize(image_bytes, filename, index)


class OcrApiTest(unittest.TestCase):
    def setUp(self) -> None:
        settings = Settings(mode="fake", token="test-token", max_files=2)
        self.client = TestClient(create_app(settings, FakeRecognizer()))

    def test_health(self) -> None:
        response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["mode"], "fake")
        self.assertFalse(response.json()["catalog"]["enabled"])

    def test_batch_recognition_preserves_order(self) -> None:
        response = self.client.post(
            "/v1/recognize",
            headers={"Authorization": "Bearer test-token"},
            files=[
                ("images", ("metatron.jpg", b"first", "image/jpeg")),
                ("images", ("other.png", b"second", "image/png")),
            ],
        )
        self.assertEqual(response.status_code, 200)
        results = response.json()["results"]
        self.assertEqual([row["index"] for row in results], [0, 1])
        self.assertEqual(results[0]["candidates"][0]["title"], "METATRON")
        self.assertEqual(results[0]["dxScore"], 2575)
        self.assertEqual(results[1]["candidates"][0]["title"], "PANDORA PARADOXXX")

    def test_auth_and_limits(self) -> None:
        unauthorized = self.client.post(
            "/v1/recognize",
            files=[("images", ("one.jpg", b"x", "image/jpeg"))],
        )
        self.assertEqual(unauthorized.status_code, 401)
        too_many = self.client.post(
            "/v1/recognize",
            headers={"Authorization": "Bearer test-token"},
            files=[
                ("images", (f"{index}.jpg", b"x", "image/jpeg"))
                for index in range(3)
            ],
        )
        self.assertEqual(too_many.status_code, 400)

    def test_dx_score_parser_uses_value_before_slash(self) -> None:
        self.assertEqual(parse_dx_score_text("2575/277"), 2575)
        self.assertEqual(parse_dx_score_text("2,575 ／ 2,775 +20"), 2575)
        self.assertIsNone(parse_dx_score_text("25752775"))

    def test_one_failure_keeps_other_batch_results(self) -> None:
        client = TestClient(
            create_app(Settings(mode="fake"), PartiallyFailingRecognizer())
        )
        response = client.post(
            "/v1/recognize",
            files=[
                ("images", ("bad.jpg", b"bad", "image/jpeg")),
                ("images", ("good.jpg", b"good", "image/jpeg")),
            ],
        )
        self.assertEqual(response.status_code, 200)
        results = response.json()["results"]
        self.assertEqual(results[0]["status"], "error")
        self.assertEqual(results[1]["status"], "ok")

    def test_dynamic_fake_title_supports_catalog_driven_e2e(self) -> None:
        item = FakeRecognizer().recognize(
            b"image", "title__My%20Song.png", 0
        )
        self.assertEqual(item.candidates[0].title, "My Song")


if __name__ == "__main__":
    unittest.main()
