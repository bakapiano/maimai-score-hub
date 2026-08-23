"""Build the unique-title index for the title classifier.

Reads `data/music_data.json` and emits `data/titles.json`:
{
  "titles": [<unique title strings>, ...],          # class index = position
  "title_to_ids": { title: [id, ...], ... },
  "id_to_title": { id: title, ... }
}
"""
from __future__ import annotations

import json
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "music_data.json"
DST = ROOT / "data" / "titles.json"


def main() -> None:
    songs = json.loads(SRC.read_text(encoding="utf-8"))

    title_to_ids: "OrderedDict[str, list[str]]" = OrderedDict()
    id_to_title: dict[str, str] = {}

    for s in songs:
        sid = str(s["id"])
        title = s["title"]
        id_to_title[sid] = title
        title_to_ids.setdefault(title, []).append(sid)

    titles = list(title_to_ids.keys())

    out = {
        "titles": titles,
        "title_to_ids": title_to_ids,
        "id_to_title": id_to_title,
    }
    DST.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"songs        : {len(songs)}")
    print(f"unique titles: {len(titles)}")
    print(f"collisions   : {sum(1 for v in title_to_ids.values() if len(v) > 1)}")
    print(f"-> {DST}")


if __name__ == "__main__":
    main()
