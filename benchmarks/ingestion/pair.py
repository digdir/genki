"""Step 1b: pair our indexed Kudos documents with KUDOS prod documents and draw the sample.

Pairs on the primary file's sha256, which also proves both sides hold the same file version.
Strata: document type x likely-scanned (PDF bytes per page). Hard cells are oversampled;
each sampled document carries a weight (stratum size / stratum sample) for corpus estimates.

Writes sample.json next to this script (committed, so reruns check the same documents) and
results/pairing-summary.json (committed).
"""
import collections
import json
import random

from common import DATA, RESULTS, SAMPLE

SAMPLE_SIZE = 150
SCAN_BYTES_PER_PAGE = 150_000
SEED = 20261020


def primary(files):
    p = [f for f in files if f.get("is_primary")]
    return p[0] if p else (files[0] if files else None)


def main():
    ours = [json.loads(l) for l in open(DATA / "ts-documents.jsonl") if l.strip()]
    kudos = list({d["uuid"]: d for d in (json.loads(l) for l in open(DATA / "kudos-listing.jsonl") if l.strip())}.values())

    by_sha = collections.defaultdict(list)
    for d in kudos:
        for f in d.get("files") or []:
            if f.get("sha256"):
                by_sha[f["sha256"]].append((d, f))

    stats = collections.Counter()
    pairs = []
    for o in ours:
        files = o.get("files") or []
        stats["ours"] += 1
        if len(files) != 1:
            stats["ours_multi_file_skipped"] += 1
            continue
        of = files[0]
        hits = by_sha.get(of.get("sha256"), [])
        if not hits:
            stats["no_kudos_file_with_same_sha256"] += 1
            continue
        if len(hits) > 1:
            stats["sha256_in_several_kudos_docs"] += 1
        kd, kf = hits[0]
        if primary(kd["files"]) is not kf:
            stats["matched_file_not_primary_in_kudos"] += 1
            continue
        if len(kd["files"]) > 1:
            stats["kudos_doc_has_attachments"] += 1
        stats["paired"] += 1
        pages = kf.get("pages") or of.get("pages")
        size = kf.get("size") or of.get("size")
        likely_scanned = (size or 0) / max(pages or 1, 1) >= SCAN_BYTES_PER_PAGE
        typ = o.get("type") or "?"
        pairs.append({
            "doc_num": o["doc_num"],
            "uuid": kd["uuid"],
            "type": typ,
            "title": o.get("title"),
            "publish_year": (o.get("publish_date") or "")[:4],
            "sha256": of["sha256"],
            "pages_meta": pages,
            "size": size,
            "pdf_url": kf["url"],
            "likely_scanned": likely_scanned,
            "stratum": f'{typ}|{"scan?" if likely_scanned else "digital?"}',
        })

    strata = collections.defaultdict(list)
    for p in pairs:
        strata[p["stratum"]].append(p)

    # Even share per type; within a type, half to the likely-scanned cell when it has enough.
    rng = random.Random(SEED)
    types = sorted({p["type"] for p in pairs})
    per_type = {t: SAMPLE_SIZE // len(types) for t in types}
    for t in types[: SAMPLE_SIZE - sum(per_type.values())]:
        per_type[t] += 1
    sample = []
    for t in types:
        scan = strata.get(f"{t}|scan?", [])
        dig = strata.get(f"{t}|digital?", [])
        n_scan = min(len(scan), per_type[t] // 2)
        n_dig = min(len(dig), per_type[t] - n_scan)
        n_scan = min(len(scan), per_type[t] - n_dig)
        for cell, n in ((scan, n_scan), (dig, n_dig)):
            picked = rng.sample(cell, n)
            for p in picked:
                p["weight"] = len(cell) / n
            sample += picked

    summary = {
        "pairing": dict(stats),
        "kudos_listed": len(kudos),
        "strata": {k: {"population": len(v), "sampled": sum(1 for s in sample if s["stratum"] == k)}
                   for k, v in sorted(strata.items())},
        "sample_size": len(sample),
        "sample_pages_total": sum(s["pages_meta"] or 0 for s in sample),
    }
    SAMPLE.write_text(json.dumps(sample, ensure_ascii=False, indent=2) + "\n")
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "pairing-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
