"""How hard Kudos documents are across the archive, and a test set of hard and easy documents from every era.

The page tests and the ingestion sample only hold documents from 2020 on. This draws documents at random from each
era of the KUDOS listing (back to before 2000), downloads them, classifies every page the way the ingestion checks
do (`../checks.py`, pdf_pages: text-layer characters and image cover give digital, scan+text, image-only or
blank), adds table and multi-column flags, and writes:

    .data/eras/pdf/<uuid>.pdf          the downloads, checked against the listing's sha256
    .data/eras/pages.jsonl             one row per page
    results/eras.md                    page kinds per era (shares weighted to the era's pages), tables, columns
    results/eras-sample.json           the drawn documents with their page counts per kind
    results/eras-test-set.json         per era 2 scanned, 1 table-heavy, 1 two-column and 2 easy documents

    python eras_sample.py <kudos-listing.jsonl> [--per-era 50] [--test-easy 2] [--select-only] [--seed 20261111]

Needs PyMuPDF (fitz). The listing is the one fetch_lists.py writes (GET /documents, every document).
"""
import argparse
import collections
import hashlib
import json
import random
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import fitz

HERE = Path(__file__).resolve().parent
DATA = HERE / ".data" / "eras"
RESULTS = HERE / "results"
ERAS = [("before 2000", 0, 1999), ("2000-2009", 2000, 2009), ("2010-2019", 2010, 2019), ("2020 on", 2020, 9999)]
USER_AGENT = "genki-ingestion-benchmark"
MAX_BYTES = 200 * 1024 * 1024
TEST_MAX_PAGES = 80


def era_of(year):
    return next(name for name, lo, hi in ERAS if lo <= year <= hi)


def primary_pdf(doc):
    for f in doc.get("files") or []:
        if f.get("is_primary") and (f.get("mimetype") or "").endswith("pdf"):
            return f
    return None


def draw(listing, per_era, seed, exclude):
    by_era = collections.defaultdict(list)
    for d in listing:
        f = primary_pdf(d)
        year = (d.get("publish_date") or "")[:4]
        if not f or not year.isdigit() or not f.get("pages") or d["uuid"] in exclude:
            continue
        by_era[era_of(int(year))].append(d)
    rng = random.Random(seed)
    sample, sizes = [], {}
    for name, _, _ in ERAS:
        docs = sorted(by_era[name], key=lambda d: d["uuid"])
        sizes[name] = {"documents": len(docs), "pages": sum(primary_pdf(d)["pages"] for d in docs)}
        for d in rng.sample(docs, min(per_era, len(docs))):
            f = primary_pdf(d)
            sample.append({"id": d["uuid"][:8], "uuid": d["uuid"], "era": name, "type": d["type"],
                           "publish_year": int(d["publish_date"][:4]), "pages_listed": f["pages"],
                           "size": f.get("size"), "sha256": f.get("sha256"), "pdf_url": f["url"]})
    return sample, sizes


def download(row):
    path = DATA / "pdf" / f"{row['uuid']}.pdf"
    if path.exists():
        return row, "cached"
    if (row["size"] or 0) > MAX_BYTES:
        return row, "too large"
    for attempt in range(4):
        try:
            req = urllib.request.Request(row["pdf_url"], headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read()
            if row["sha256"] and hashlib.sha256(body).hexdigest() != row["sha256"]:
                return row, "sha256 mismatch"
            path.write_bytes(body)
            return row, "downloaded"
        except Exception as e:  # network resets happen on KUDOS; retry with backoff
            last = f"{type(e).__name__}"
            time.sleep(2 ** attempt)
    return row, f"failed ({last})"


def classify(path):
    """Per page: kind as in ../checks.py pdf_pages, plus tables found and two text columns."""
    out = []
    with fitz.open(path) as doc:
        for page in doc:
            area = page.rect.width * page.rect.height or 1
            chars = len(re.sub(r"\s", "", page.get_text("text")))
            cover = 0.0
            for info in page.get_image_info():
                r = fitz.Rect(info["bbox"]) & page.rect
                cover += r.width * r.height if not r.is_empty else 0
            cover = min(cover / area, 1.0)
            w = page.rect.width
            blocks = [b for b in page.get_text("blocks") if b[6] == 0 and len(b[4].strip()) >= 80]
            left = sum(1 for b in blocks if b[2] <= 0.55 * w)
            right = sum(1 for b in blocks if b[0] >= 0.45 * w)
            if cover >= 0.85:
                kind = "scan+text" if chars >= 50 else "image-only"
            else:
                kind = "digital" if chars >= 50 else "blank"
            tables = 0
            if kind == "digital":
                try:
                    tables = len(page.find_tables().tables)
                except Exception:
                    tables = 0
            out.append({"kind": kind, "chars": chars, "image_cover": round(cover, 2), "tables": tables,
                        "multi_column": left >= 2 and right >= 2})
    return out


def hardness(pages):
    n = max(len(pages), 1)
    scan = sum(p["kind"] in ("scan+text", "image-only") for p in pages) / n
    image_only = sum(p["kind"] == "image-only" for p in pages)
    table_pages = sum(p["tables"] > 0 for p in pages) / n
    columns = sum(p["multi_column"] for p in pages) / n
    reasons = []
    if image_only:
        reasons.append(f"{image_only} image-only pages")
    if scan >= 0.1:
        reasons.append(f"{scan:.0%} scanned pages")
    if table_pages >= 0.2:
        reasons.append(f"tables on {table_pages:.0%} of pages")
    if columns >= 0.3:
        reasons.append(f"two columns on {columns:.0%} of pages")
    easy = scan == 0 and table_pages < 0.05 and columns < 0.1
    return ("hard" if reasons else "easy" if easy else "medium"), reasons


def main():
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("listing", type=Path)
    a.add_argument("--per-era", type=int, default=50)
    a.add_argument("--test-easy", type=int, default=2)
    a.add_argument("--select-only", action="store_true", help="redo the test set from results/eras-sample.json")
    a.add_argument("--seed", type=int, default=20261111)
    a.add_argument("--draw-only", action="store_true", help="draw and print sizes, download nothing")
    args = a.parse_args()

    if args.select_only:
        saved = json.loads((RESULTS / "eras-sample.json").read_text())
        select(saved["documents"], args)
        return
    listing = [json.loads(line) for line in open(args.listing)]
    current = {d["uuid"] for d in json.load(open(HERE / "documents.json"))["documents"]}
    sample, sizes = draw(listing, args.per_era, args.seed, current)
    mb = sum(r["size"] or 0 for r in sample) / 1e6
    print(f"drew {len(sample)} documents ({sum(r['pages_listed'] for r in sample):,} pages, {mb:,.0f} MB)")
    if args.draw_only:
        for name, _, _ in ERAS:
            rows = [r for r in sample if r["era"] == name]
            print(f"  {name}: {len(rows)} drawn of {sizes[name]['documents']:,} documents, "
                  f"{sum(r['pages_listed'] for r in rows):,} pages, {sum(r['size'] or 0 for r in rows) / 1e6:,.0f} MB")
        return

    (DATA / "pdf").mkdir(parents=True, exist_ok=True)
    status = collections.Counter()
    with ThreadPoolExecutor(3) as pool:
        for row, s in pool.map(download, sample):
            row["download"] = s
            status[s.split(" (")[0]] += 1
    print("downloads:", dict(status))

    with open(DATA / "pages.jsonl", "w") as out:
        for row in sample:
            path = DATA / "pdf" / f"{row['uuid']}.pdf"
            if not path.exists():
                row["pages"] = None
                continue
            try:
                pages = classify(path)
            except Exception as e:
                row["pages"], row["error"] = None, type(e).__name__
                continue
            row["pages"] = len(pages)
            row["page_kinds"] = dict(collections.Counter(p["kind"] for p in pages))
            row["table_pages"] = sum(p["tables"] > 0 for p in pages)
            row["multi_column_pages"] = sum(p["multi_column"] for p in pages)
            row["class"], row["reasons"] = hardness(pages)
            for i, p in enumerate(pages, 1):
                out.write(json.dumps({"uuid": row["uuid"], "page": i, **p}) + "\n")
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "eras-sample.json").write_text(json.dumps({"seed": args.seed, "per_era": args.per_era,
                                                          "listing": str(args.listing.name), "eras": sizes,
                                                          "documents": sample}, indent=1, ensure_ascii=False) + "\n")
    report(sample, sizes, args)


def report(sample, sizes, args):
    lines = ["# Page kinds across the KUDOS archive", "",
             f"{args.per_era} documents drawn at random per era from the KUDOS listing (seed {args.seed}), every page "
             "classified as in `../checks.py`. Shares are of pages, weighted to each era's pages in the listing "
             "(within an era every drawn document counts by its pages). `eras_sample.py` made this file.", "",
             "| Era | Documents in KUDOS | Pages in KUDOS | Classified | Digital | Scan + text | Image-only | Blank "
             "| Pages with tables | Two-column pages | Hard / medium / easy documents |",
             "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |"]
    total = collections.Counter()
    for name, _, _ in ERAS:
        rows = [r for r in sample if r["era"] == name and r.get("pages")]
        n = sum(r["pages"] for r in rows) or 1
        k = collections.Counter()
        for r in rows:
            k.update(r["page_kinds"])
        t = sum(r["table_pages"] for r in rows)
        c = sum(r["multi_column_pages"] for r in rows)
        cls = collections.Counter(r["class"] for r in rows)
        share = lambda x: f"{100 * x / n:.1f}%"
        lines.append(f"| {name} | {sizes[name]['documents']:,} | {sizes[name]['pages']:,} | {len(rows)} docs, {n:,} p "
                     f"| {share(k['digital'])} | {share(k['scan+text'])} | {share(k['image-only'])} | {share(k['blank'])} "
                     f"| {share(t)} | {share(c)} | {cls['hard']} / {cls['medium']} / {cls['easy']} |")
        w = sizes[name]["pages"] / n
        for kind in ("digital", "scan+text", "image-only", "blank"):
            total[kind] += k[kind] * w
    tw = sum(total.values()) or 1
    lines += ["", "Whole archive, weighted by era: " + ", ".join(f"{kind} {100 * total[kind] / tw:.1f}%"
                                                                for kind in ("digital", "scan+text", "image-only", "blank")) + ".",
              "", "Hard: any image-only page, 10% or more scanned pages, tables on 20% or more of pages, or two columns "
              "on 30% or more. Easy: no scanned pages, tables on under 5% and two columns on under 10% of pages. "
              "Tables are found by PyMuPDF on digital pages only, so tables on scans are not counted.",
              "", "Failed or skipped downloads: " + json.dumps(dict(collections.Counter(
                  r.get("download", "?").split(" (")[0] for r in sample if not r.get("pages")))) + "."]
    (RESULTS / "eras.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))

    select(sample, args)


# Hard documents per era, by what makes them hard; then easy ones
HARD = [("scanned", 2, lambda r: bool(r["page_kinds"].get("image-only")) or
                              (r["page_kinds"].get("scan+text", 0) + r["page_kinds"].get("image-only", 0)) / r["pages"] >= 0.1),
        ("tables", 1, lambda r: r["table_pages"] / r["pages"] >= 0.2),
        ("two columns", 1, lambda r: r["multi_column_pages"] / r["pages"] >= 0.3)]


def select(sample, args):
    rng = random.Random(args.seed + 1)
    test, taken = [], set()
    keys = ("id", "uuid", "era", "type", "publish_year", "pages", "sha256", "size", "pdf_url", "page_kinds",
            "table_pages", "multi_column_pages", "reasons")
    for name, _, _ in ERAS:
        rows = sorted((r for r in sample if r["era"] == name and r.get("pages") and r["pages"] <= TEST_MAX_PAGES),
                      key=lambda r: r["uuid"])
        picks = [(why, n, test_) for why, n, test_ in HARD] + [("easy", args.test_easy, lambda r: r["class"] == "easy")]
        for why, n, test_ in picks:
            pool = [r for r in rows if r["uuid"] not in taken and test_(r)]
            for r in rng.sample(pool, min(n, len(pool))):
                taken.add(r["uuid"])
                test.append({**{k: r[k] for k in keys}, "class": "easy" if why == "easy" else "hard", "picked_for": why})
    (RESULTS / "eras-test-set.json").write_text(json.dumps(
        {"note": f"per era: 2 scanned, 1 table-heavy, 1 two-column (hard) and {args.test_easy} easy documents, at most "
                 f"{TEST_MAX_PAGES} pages, from the era sample; no page tests exist for them yet",
         "documents": test}, indent=1, ensure_ascii=False) + "\n")
    print(f"test set: {len(test)} documents, {sum(r['pages'] for r in test):,} pages")
    for r in test:
        print(f"  {r['era']:11s} {r['picked_for']:11s} {r['id']} {r['type']:28s} {r['publish_year']} {r['pages']:3d} p  "
              f"{', '.join(r['reasons']) or 'all digital'}")


if __name__ == "__main__":
    sys.exit(main())
