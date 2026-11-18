"""Summarise throughput.sh: per round (N workers), pages, wall time, pages per hour, CPU use, and cost per 1,000
pages at list price. Standard library only.

    python3 throughput.py <run folder> [--price 1.552]

Two clocks per round:
- round: containers started to all exited (model load and each worker's warm-up included), what a batch job pays;
- converting: the first timed document started to the last one ended (load and warm-up left out).
CPU use is the busy share of all vCPUs from /proc/stat over the converting window (iowait counts as idle). Cost and projections are list price x the round
clock; they are projections, not measurements.
Writes <run>/throughput/throughput.md and throughput.json.
"""
import argparse
import json
from pathlib import Path

PHASE1, KUDOS = 646_558, 3_141_333


def cpu_busy(csv, start, end):
    rows = []
    for line in csv.read_text().splitlines():
        parts = line.split()
        if len(parts) < 10 or parts[1] != "cpu":
            continue
        t, v = float(parts[0]), [int(x) for x in parts[2:]]
        idle = v[3] + v[4]                      # idle + iowait
        rows.append((t, sum(v[:8]) - idle, sum(v[:8])))
    # the samples that bracket the window: the last at or before start, the first at or after end
    before = [r for r in rows if r[0] <= start] or rows[:1]
    after = [r for r in rows if r[0] >= end] or rows[-1:]
    if not rows:
        return None
    a, b = before[-1], after[0]
    return (b[1] - a[1]) / (b[2] - a[2]) if b[2] > a[2] else None


def main():
    a = argparse.ArgumentParser()
    a.add_argument("run", type=Path)
    a.add_argument("--price", type=float, default=1.552, help="$/h list price of the VM")
    args = a.parse_args()
    base = args.run / "throughput"
    rounds = []
    for r in sorted(base.glob("n*/round.json"), key=lambda p: int(p.parent.name[1:])):
        info = json.loads(r.read_text())
        rows, workers, errors = [], [], 0
        for w in sorted(r.parent.glob("w*")):
            t = [json.loads(x) for x in (w / "timings.jsonl").read_text().splitlines()] if (w / "timings.jsonl").exists() else []
            errors += len(list(w.glob("*/error.txt")))
            rows += t
            if t:
                workers.append({"worker": w.name, "pages": sum(x["pages"] for x in t), "documents": len(t),
                                "converting_s": round(max(x["ended"] for x in t) - min(x["started"] for x in t), 1),
                                "finished_after_s": round(max(x["ended"] for x in t) - info["start"], 1)})
        pages = sum(x["pages"] for x in rows)
        round_s = info["end"] - info["start"]
        conv_s = max(x["ended"] for x in rows) - min(x["started"] for x in rows)
        busy = cpu_busy(r.parent / "cpu.csv", min(x["started"] for x in rows), max(x["ended"] for x in rows))
        per_hour = pages / round_s * 3600
        cost = args.price * round_s / 3600 / pages * 1000
        rounds.append({"workers": info["workers"], "threads_each": info["threads_each"], "cpus": info["cpus"],
                       "documents": len(rows), "pages": pages, "failed_documents": errors,
                       "failed_workers": info["failed_workers"], "round_s": round(round_s, 1),
                       "converting_s": round(conv_s, 1), "pages_per_hour_round": round(per_hour),
                       "pages_per_hour_converting": round(pages / conv_s * 3600),
                       "seconds_per_page_round": round(round_s / pages, 3),
                       "cpu_busy": round(busy, 3) if busy is not None else None,
                       "usd_per_1000_pages": round(cost, 3),
                       "phase1_usd": round(cost * PHASE1 / 1000), "phase1_vm_hours": round(PHASE1 / per_hour),
                       "kudos_usd": round(cost * KUDOS / 1000), "kudos_vm_hours": round(KUDOS / per_hour),
                       "workers_detail": workers})
    (base / "throughput.json").write_text(json.dumps({"price_per_hour": args.price, "rounds": rounds}, indent=1) + "\n")
    lines = ["# Throughput: docling-tess, documents split across N containers", "",
             f"List price ${args.price}/h. Round = containers started to all exited (load and warm-up included). "
             "Cost and projections are list price x round time: **projections**, not measurements.", "",
             "| Workers | Threads each | Docs | Pages | Failed docs | Round s | Pages/h (round) | Pages/h (converting) "
             "| CPU busy | $ / 1,000 pages | Phase 1 $ / VM-h | All KUDOS $ / VM-h | Workers finished (s after start) |",
             "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |"]
    for x in rounds:
        fin = ", ".join(str(round(w["finished_after_s"])) for w in x["workers_detail"])
        lines.append(f"| {x['workers']} | {x['threads_each']} | {x['documents']} | {x['pages']} | {x['failed_documents']} "
                     f"| {x['round_s']:.0f} | {x['pages_per_hour_round']:,} | {x['pages_per_hour_converting']:,} "
                     f"| {'' if x['cpu_busy'] is None else format(x['cpu_busy'], '.0%')} | {x['usd_per_1000_pages']:.3f} | {x['phase1_usd']:,} / {x['phase1_vm_hours']:,} "
                     f"| {x['kudos_usd']:,} / {x['kudos_vm_hours']:,} | {fin} |")
    (base / "throughput.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
