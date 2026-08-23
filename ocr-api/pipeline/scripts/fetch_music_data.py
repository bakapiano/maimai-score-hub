"""Fetch the canonical music_data.json from diving-fish.

This is the SINGLE source of truth for song metadata used by the OCR
pipeline (cover gallery → title, title classifier index, etc.).

Usage:
    python -m scripts.fetch_music_data           # writes data/music_data.json
    python -m scripts.fetch_music_data --check   # exits 1 if remote differs

Pair with `scripts/build_titles_index.py` to refresh `data/titles.json`
after the fetch.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

URL = "https://maimai.diving-fish.com/api/maimaidxprober/music_data"
ROOT = Path(__file__).resolve().parent.parent
DST = ROOT / "data" / "music_data.json"


def fetch() -> bytes:
    req = urllib.request.Request(URL, headers={"User-Agent": "maimai-ocr/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="exit 1 if remote differs from on-disk")
    args = ap.parse_args()

    data = fetch()
    # Validate it parses + has expected shape (list of dicts with id/title).
    parsed = json.loads(data)
    if not (isinstance(parsed, list) and parsed and "id" in parsed[0] and "title" in parsed[0]):
        print(f"ERROR: unexpected payload shape from {URL}", file=sys.stderr)
        return 2

    new_hash = hashlib.sha256(data).hexdigest()
    old_hash = (
        hashlib.sha256(DST.read_bytes()).hexdigest() if DST.exists() else None
    )

    if args.check:
        if old_hash != new_hash:
            print(f"DRIFT: local {old_hash} != remote {new_hash}", file=sys.stderr)
            return 1
        print(f"OK: {len(parsed)} songs, sha256={new_hash}")
        return 0

    DST.parent.mkdir(parents=True, exist_ok=True)
    DST.write_bytes(data)
    if old_hash == new_hash:
        print(f"unchanged: {len(parsed)} songs, sha256={new_hash}")
    else:
        print(f"updated  : {len(parsed)} songs")
        print(f"  was: {old_hash}")
        print(f"  now: {new_hash}")
    print(f"-> {DST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
