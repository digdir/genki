"""Step 1c: fetch the KUDOS text and the PDF for every sampled pair.

KUDOS text  -> .data/kudos/<uuid>.txt      (GET /documents/<uuid>/contents)
PDF         -> .data/pdf/<doc_num>.pdf     (sha256 checked against the pair)

Our chunks (.data/ours/<doc_num>.jsonl) came from the shared Typesense server, which genki no
longer configures (#690), so they can no longer be fetched; checks.py reads them from disk.

Files already on disk are kept, so a rerun only fetches what is missing.
"""
import hashlib
import json
import time

from common import DATA, KUDOS_API, SAMPLE, get


def main():
    sample = json.loads(SAMPLE.read_text())
    for d in ("kudos", "pdf"):
        (DATA / d).mkdir(parents=True, exist_ok=True)

    for n, s in enumerate(sample, 1):
        k = DATA / "kudos" / f'{s["uuid"]}.txt'
        if not k.exists():
            body = json.loads(get(f'{KUDOS_API}/{s["uuid"]}/contents', {"accept": "application/json"}))
            k.write_text(body.get("data") or "")
            time.sleep(0.5)
        p = DATA / "pdf" / f'{s["doc_num"]}.pdf'
        if not p.exists():
            blob = get(s["pdf_url"])
            if hashlib.sha256(blob).hexdigest() != s["sha256"]:
                print(f'  sha256 mismatch for {s["doc_num"]}: KUDOS replaced the file since pairing')
            p.write_bytes(blob)
            time.sleep(0.3)
        if n % 10 == 0:
            print(f"docs {n}/{len(sample)}")


if __name__ == "__main__":
    main()
