"""Put the PDFs of documents.json in one folder as <doc_num>.pdf, each checked against its sha256.

    python3 fetch.py <folder> [--from <folder of <doc_num>.pdf>]

With --from, files are copied from a local folder (the ingestion benchmark's .data/pdf); otherwise they are
downloaded from KUDOS. A file already in place with the right hash is kept. Standard library only.
"""
import argparse
import os
import hashlib
import json
import shutil
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main():
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("out", type=Path)
    a.add_argument("--from", dest="source", type=Path)
    args = a.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    # DOCUMENTS (run.sh) names another list in this folder, for example documents-run2.json
    documents = json.loads((HERE / os.environ.get("DOCUMENTS", "documents.json")).read_text())["documents"]
    failed = 0
    for d in documents:
        target = args.out / f"{d['doc_num']}.pdf"
        if target.exists() and sha256(target) == d["sha256"]:
            continue
        partial = target.with_suffix(".part")
        if args.source:
            shutil.copyfile(args.source / f"{d['doc_num']}.pdf", partial)
        else:
            request = urllib.request.Request(d["pdf_url"], headers={"User-Agent": "genki-ingestion-benchmark"})
            with urllib.request.urlopen(request, timeout=300) as response, open(partial, "wb") as f:
                shutil.copyfileobj(response, f)
        if sha256(partial) != d["sha256"]:
            partial.unlink()
            print(f"{d['doc_num']}: sha256 does not match documents.json", file=sys.stderr)
            failed += 1
            continue
        partial.rename(target)
        print(f"{d['doc_num']}: {d['pages']} pages")
    if failed:
        raise SystemExit(f"{failed} documents failed")


if __name__ == "__main__":
    main()
