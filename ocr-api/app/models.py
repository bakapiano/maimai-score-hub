from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


Difficulty = Literal[
    "basic",
    "advanced",
    "expert",
    "master",
    "remaster",
    "utage",
]
FcStatus = Literal["fc", "fcp", "ap", "app"]
FsStatus = Literal["fs", "fsp", "fdx", "fdxp"]


class ScoreCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str
    confidence: float | None = None
    sources: list[Literal["cover", "title"]] = Field(default_factory=list)


class RecognitionItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int
    filename: str
    status: Literal["ok", "unrecognized", "error"]
    candidates: list[ScoreCandidate] = Field(default_factory=list)
    achievement: float | None = None
    dxScore: int | None = None
    difficulty: Difficulty | None = None
    level: str | None = None
    isDx: bool | None = None
    fc: FcStatus | None = None
    fs: FsStatus | None = None
    error: str | None = None


class BatchRecognitionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    results: list[RecognitionItem]
