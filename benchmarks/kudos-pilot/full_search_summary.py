"""One table of the full genki search (planner, keywords + vectors, ColBERT; 3 rounds of the 76 draft questions)
for every self-hosted model against text-embedding-3-large, from kudos-pilot-compare.ts's own comparison, so the
numbers are exactly the ones that script reports. Each side's rounds come from whichever run file holds it.

    python3 full_search_summary.py <run.json> [run.json ...]

Writes .data/full-search-report.md.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

from common import DATA, HERE, REPO


def compare(files, candidate):
    out = subprocess.run(
        ["npx", "tsx", "--conditions=source", "packages/eval/src/scripts/kudos-pilot-compare.ts", "compare", *files,
         "pgvector", candidate], cwd=REPO, capture_output=True, text=True, check=True).stdout
    first = out.split("As served:")[0] if "As served:" in out else out
    rows = {}
    for m in re.finditer(
            r"^\| (Recall@10|Recall@5|MRR|nDCG@10) \| ([\d.]+) \| ([\d.]+) \| ([+-]?[\d.]+) \| (.+?) \|$", first, re.M):
        rows.setdefault(m.group(1), m.groups()[1:])  # the first table is all 76 questions; the holdout one follows
    latency = re.search(r"pgvector, [^;]*? p50 (\d+) ms, p95 (\d+) ms\.", out)
    base_latency = re.search(r"Latency over every call: pgvector p50 (\d+) ms, p95 (\d+) ms", out)
    return rows, latency.groups() if latency else ("–", "–"), base_latency.groups() if base_latency else ("–", "–")


def main():
    files = [str(Path(f).resolve()) for f in sys.argv[1:]]
    held = {s for f in files for r in json.load(open(f))["rounds"] for s in r}
    keys = [m["key"] for m in json.loads((HERE / "models.json").read_text())["models"] if m["key"] in held]
    names = {m["key"]: m["hf"] for m in json.loads((HERE / "models.json").read_text())["models"]}
    lines = ["# Kudos pilot: the full genki search per embedding model\n",
             "Kunnskapsassistenten's retrieve-only service (planner, keywords + vectors with RRF, ColBERT) on each "
             "model's own database, 3 rounds of the 76 ka-kudos-draft questions, scored per document. Differences "
             "are against the same service on text-embedding-3-large@1536, paired bootstrap, 95% interval.\n",
             "| Model | Recall@10 | MRR | nDCG@10 | p50 per search | p95 |", "| --- | --- | --- | --- | --- | --- |"]
    base = None
    for key in keys:
        rows, latency, base_latency = compare(files, key)
        if base is None:
            base = (rows, base_latency)
            lines.append(f"| text-embedding-3-large | {rows['Recall@10'][0]} | {rows['MRR'][0]} | {rows['nDCG@10'][0]} | "
                         f"{int(base_latency[0]) / 1000:.1f} s | {int(base_latency[1]) / 1000:.1f} s |")
        cell = lambda m: f"{rows[m][1]} ({rows[m][2]}; {rows[m][3]})"
        lines.append(f"| {names[key]} | {cell('Recall@10')} | {cell('MRR')} | {cell('nDCG@10')} | "
                     f"{int(latency[0]) / 1000:.1f} s | {int(latency[1]) / 1000:.1f} s |")
    report = "\n".join(lines) + "\n"
    (DATA / "full-search-report.md").write_text(report)
    print(report)


if __name__ == "__main__":
    main()
