"""Step 1a: fetch what pairing needs. Run with no argument for both, or name the parts:
fetch_lists.py dictionaries listing

.data/kudos-listing.jsonl   every KUDOS prod document (GET /documents, 50 a page)
.data/dict/                 nb and nn Hunspell dictionaries, pinned LibreOffice commit

.data/ts-documents.jsonl, every Kudos document in our old search index, came from the shared
search server, which genki no longer configures (#690); pair.py reads it from disk.

/documents/search stops paging after 10,000 results, so the listing uses /documents. Each page
lands in .data/listing/<n>.json first, so a rerun resumes where it stopped. Two workers, each
pausing between requests, stay under the API's 180 requests a minute.
"""
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from common import DATA, DICTIONARIES, KUDOS_API, get

PAGE_DELAY_S = 0.5


def listing():
    pages = DATA / "listing"
    pages.mkdir(parents=True, exist_ok=True)
    first = json.loads(get(f"{KUDOS_API}?page=1&per_page=50", {"accept": "application/json"}))
    last = first["meta"]["last_page"]
    (pages / "1.json").write_text(json.dumps(first["data"]))

    def fetch(n):
        if (pages / f"{n}.json").exists():
            return
        body = json.loads(get(f"{KUDOS_API}?page={n}&per_page=50", {"accept": "application/json"}))
        (pages / f"{n}.json").write_text(json.dumps(body["data"]))
        if n % 100 == 0:
            print(f"listing page {n}/{last}")
        time.sleep(PAGE_DELAY_S)

    with ThreadPoolExecutor(2) as pool:
        list(pool.map(fetch, range(2, last + 1)))
    rows = [d for n in range(1, last + 1) for d in json.loads((pages / f"{n}.json").read_text())]
    (DATA / "kudos-listing.jsonl").write_text("".join(json.dumps(d, ensure_ascii=False) + "\n" for d in rows))
    print(f"listing: {len(rows)} documents, API says {first['meta']['total']}")


def dictionaries():
    d = DATA / "dict"
    d.mkdir(parents=True, exist_ok=True)
    for name in ("nb_NO.aff", "nb_NO.dic", "nn_NO.aff", "nn_NO.dic"):
        if not (d / name).exists():
            (d / name).write_bytes(get(f"{DICTIONARIES}/{name}"))
    print("dictionaries: nb, nn")


if __name__ == "__main__":
    DATA.mkdir(parents=True, exist_ok=True)
    parts = {"dictionaries": dictionaries, "listing": listing}
    for name in sys.argv[1:] or parts:
        parts[name]()
