"""Step 1c: fetch both texts and the PDF for every sampled pair.

KUDOS text  -> .data/kudos/<uuid>.txt      (GET /documents/<uuid>/contents)
Our chunks  -> .data/ours/<doc_num>.jsonl  (Typesense export, filtered on doc_num)
PDF         -> .data/pdf/<doc_num>.pdf     (sha256 checked against the pair)

Files already on disk are kept, so a rerun only fetches what is missing.
"""
import hashlib
import json
import time
import urllib.parse

from common import DATA, KUDOS_API, SAMPLE, TS_CHUNKS, get, setting


def main():
    sample = json.loads(SAMPLE.read_text())
    for d in ("kudos", "ours", "pdf"):
        (DATA / d).mkdir(parents=True, exist_ok=True)

    ts_url, ts_key = setting("TYPESENSE_URL"), setting("TYPESENSE_KEY")
    todo = [s["doc_num"] for s in sample if not (DATA / "ours" / f'{s["doc_num"]}.jsonl').exists()]
    for i in range(0, len(todo), 20):
        batch = todo[i : i + 20]
        q = urllib.parse.urlencode({
            "filter_by": f"doc_num:=[{','.join(batch)}]",
            "include_fields": "doc_num,chunk_index,content_markdown,metadata",
        })
        body = get(f"{ts_url}/collections/{TS_CHUNKS}/documents/export?{q}", {"X-TYPESENSE-API-KEY": ts_key})
        rows = [json.loads(l) for l in body.decode().splitlines() if l]
        for dn in batch:
            mine = sorted((r for r in rows if r["doc_num"] == dn), key=lambda r: r["chunk_index"])
            (DATA / "ours" / f"{dn}.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in mine))
        print(f"chunks {i + len(batch)}/{len(todo)}")

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
