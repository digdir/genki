"""Turn the index and scale benchmark (.data/index-bench.jsonl from bench_index.py) into tables, and project its
measured sizes and build times to 10, 25 and 50 million vectors. Measured and projected numbers are kept apart:
projections assume size grows linearly and HNSW build time as N log N from the measured points, on this Mac.

    .data/embed-venv/bin/python bench_report.py

Writes .data/index-report.md and .data/index-summary.csv.
"""
import csv
import json
import math

from common import DATA

GB = 1024 ** 3


def load():
    rows = [json.loads(line) for line in (DATA / "index-bench.jsonl").read_text().splitlines() if line.strip()]
    return [r for r in rows if r.get("step") != "data"]


def setting(r):
    return " / ".join(s.replace("set ", "") for s in r.get("settings", []) if "iterative" not in s)


def main():
    rows = load()
    sizes = sorted({r["size"] for r in rows if "size" in r})
    lines = ["# Kudos pilot: pgvector index and scale benchmark\n",
             "pgvector 0.8.2 (Azure's version) in Docker on an M3 Pro (11 cores, 28 GB for Docker), halfvec(1536) "
             "vectors of text-embedding-3-large: DBpedia's 1M set with the pilot's 20,248 Kudos pages mixed in. "
             "Recall@10 is against exact search. Kudos queries are the 676 pilot questions; DBpedia queries are 500 "
             "held-out DBpedia vectors. Iterative scans on, as genki runs them. Latency is one client, measured from "
             "Python, so it includes the round trip.\n"]

    lines.append("## Build, size and exact search\n")
    lines.append("| Rows | Index | Memory / workers | Build (s) | Index size (GB) | Notice |")
    lines.append("| --- | --- | --- | --- | --- | --- |")
    for r in rows:
        if r.get("step") == "build":
            notice = "graph outgrew memory" if r.get("notices") else ""
            lines.append(f"| {r['size']:,} | {r['index']} | {r['memory']} / {r['workers']} | {r['seconds']} | "
                         f"{r['index_bytes'] / GB:.2f} | {notice} |")
    for r in rows:
        if r.get("step") == "load":
            lines.append(f"| {r['size']:,} | (table, with TOAST) | – | load {r['seconds']} | "
                         f"{r['table_with_toast_bytes'] / GB:.2f} | |")
        if r.get("index") == "none (exact)":
            lines.append(f"| {r['size']:,} | no index: exact search p50 {r['p50_ms']} ms, p95 {r['p95_ms']} ms | | | | |")
    lines.append("")

    lines.append("## Recall and latency\n")
    lines.append("| Rows | Index | Setting | Recall@10 Kudos | Recall@10 DBpedia | p50 ms | p95 ms | Rows returned |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
    measured = [r for r in rows if "recall_at_10" in r and r.get("index") != "none (exact)" and "settings" in r]
    number = lambda s: int(s.rsplit("=", 1)[-1]) if "=" in s and s.rsplit("=", 1)[-1].strip().isdigit() else 0
    keys = sorted({(r["size"], r["index"], setting(r)) for r in measured},
                  key=lambda k: (k[0], k[1], number(k[2])))
    summary = []
    for size, index, s in keys:
        pair = {r["queries"]: r for r in measured if (r["size"], r["index"], setting(r)) == (size, index, s)}
        k, d = pair.get("kudos", {}), pair.get("dbpedia", {})
        lines.append(f"| {size:,} | {index} | {s} | {k.get('recall_at_10', '–')} | {d.get('recall_at_10', '–')} | "
                     f"{d.get('p50_ms', k.get('p50_ms', '–'))} | {d.get('p95_ms', k.get('p95_ms', '–'))} | "
                     f"{d.get('returned_mean', '–')} |")
        summary.append({"rows": size, "index": index, "setting": s, "recall_kudos": k.get("recall_at_10"),
                        "recall_dbpedia": d.get("recall_at_10"), "p50_ms": d.get("p50_ms"), "p95_ms": d.get("p95_ms")})
    for r in rows:
        if "qps" in r:
            lines.append(f"| {r['size']:,} | {r['index']} | {setting(r)}, {r['clients']} clients | | | "
                         f"{r['qps']} queries/s | | |")
    lines.append("")

    writes = [r for r in rows if r.get("step") == "write"]
    if writes:
        lines.append("## Nightly-sync style write on the HNSW index\n")
        for r in writes:
            after = next((x for x in rows if x.get("index") == "hnsw m16 efc64 after write"), {})
            lines.append(f"{r['size']:,} rows: {r['inserted']:,} inserted at {r['insert_rows_per_second']} rows/s "
                         f"({r['insert_seconds']} s), {r['deleted']:,} deleted ({r['delete_seconds']} s), VACUUM "
                         f"{r['vacuum_seconds']} s; DBpedia recall@10 afterwards about {after.get('recall_at_10', '–')} "
                         f"(approximate: inserted rows left out of both sides).\n")

    # Projections from the measured HNSW builds with room to spare (memory 8 GB, 4 workers)
    builds = [r for r in rows if r.get("step") == "build" and r["index"] == "hnsw m16 efc64" and r["memory"] == "8GB"]
    if len(builds) >= 2:
        per_vector = builds[-1]["index_bytes"] / builds[-1]["size"]
        table = next(r for r in rows if r.get("step") == "load" and r["size"] == builds[-1]["size"])
        table_per_vector = table["table_with_toast_bytes"] / table["size"]
        # least squares through the origin: seconds = a * N log2 N
        a = (sum(b["seconds"] * b["size"] * math.log2(b["size"]) for b in builds)
             / sum((b["size"] * math.log2(b["size"])) ** 2 for b in builds))
        lines.append("## Projected to Kudos scale (not measured)\n")
        lines.append(f"From the measured {builds[-1]['size']:,}-row point: HNSW index {per_vector:,.0f} bytes per "
                     f"vector, table with TOAST {table_per_vector:,.0f} bytes per vector (vectors only: genki's rows "
                     "also hold the text, about 2.3 KB, and its full-text data, about 2.0 KB). Build time fitted as "
                     f"{a:.2e} × N log2 N seconds on this Mac with 8 GB of build memory and 4 workers.\n")
        lines.append("| Vectors | Dims | HNSW index (GB) | Vector table (GB) | HNSW build, room to spare (h) |")
        lines.append("| --- | --- | --- | --- | --- |")
        for n in (1_000_000, 2_700_000, 10_000_000, 25_000_000, 50_000_000):
            for dims in (1536, 1024, 768):
                scale = (2 * dims + 8) / (2 * 1536 + 8)
                lines.append(f"| {n:,} | {dims} | {n * per_vector * scale / GB:,.1f} | "
                             f"{n * table_per_vector * scale / GB:,.1f} | "
                             f"{a * n * math.log2(n) * scale / 3600:,.1f} |")
        lines.append("")
        lines.append("2.7M is full Kudos at one vector per page (67 pages per document). A build whose graph does not "
                     "fit in maintenance_work_mem (Azure allows about 2 GB) slows down sharply; see the 2 GB rows "
                     "above for how much at the sizes measured.\n")

    report = "\n".join(lines) + "\n"
    (DATA / "index-report.md").write_text(report)
    if summary:
        with open(DATA / "index-summary.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(summary[0]))
            w.writeheader()
            w.writerows(summary)
    print(report)


if __name__ == "__main__":
    main()
