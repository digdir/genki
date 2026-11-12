"""Shared by convert_docling.py, convert_mineru.py and convert_marker.py. Each runs with one parser (its own
container or venv) and the standard library, converts whole documents, and writes:

<out>/<doc_num>/native.json.gz   the parser's own structured output, as it comes (no images): the record to
                                 normalise again or rechunk from without converting again
<out>/<doc_num>/markdown.md      the parser's own Markdown, for reading
<out>/<doc_num>/error.txt        instead, when the parser failed on the document
<out>/timings.jsonl              seconds per document and per page
<out>/meta.json                  parser, versions, settings, device, machine, and the load and warm-up times

Before timing, the parser converts the smallest document once (the warm-up), so model downloads, weight loading
and kernel compilation are not counted in the first document. A document with a native.json.gz is skipped, so a
stopped run resumes where it stopped.
"""
import argparse
import gzip
import json
import os
import platform
import shutil
import subprocess
import time
import traceback
from pathlib import Path

DOCUMENTS = Path(__file__).resolve().parent.parent / "documents.json"


def arguments(devices):
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("pdfs", type=Path, help="folder of <doc_num>.pdf (fetch.py)")
    a.add_argument("out", type=Path, help="this parser's output folder")
    a.add_argument("--device", default="auto", choices=devices)
    a.add_argument("--only", nargs="*", help="doc_nums to convert, for a trial run")
    a.add_argument("--documents", type=Path, default=DOCUMENTS)
    return a.parse_args()


def _run(*command):
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def machine():
    """What ran it. HOST_LABEL names the host for the report (for example azure-NC4as_T4_v3-swedencentral)."""
    cpu = _run("sysctl", "-n", "machdep.cpu.brand_string")
    if not cpu and Path("/proc/cpuinfo").exists():
        cpu = next((line.split(":", 1)[1].strip() for line in Path("/proc/cpuinfo").read_text().splitlines()
                    if line.startswith("model name")), "")
    memory = ""
    if Path("/proc/meminfo").exists():
        memory = Path("/proc/meminfo").read_text().splitlines()[0].split(":", 1)[1].strip()
    gpus = []
    if shutil.which("nvidia-smi"):
        query = _run("nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader")
        gpus = [line.strip() for line in query.splitlines() if line.strip()]
    return {"host_label": os.environ.get("HOST_LABEL", ""), "system": platform.system(),
            "machine": platform.machine(), "cpu": cpu or platform.processor(), "cpus": os.cpu_count(),
            "memory": memory or _run("sysctl", "-n", "hw.memsize"), "gpus": gpus,
            "python": platform.python_version()}


def torch_device():
    try:
        import torch
    except ImportError:
        return {}
    info = {"torch": torch.__version__, "cuda_available": torch.cuda.is_available()}
    if torch.cuda.is_available():
        info["cuda"] = torch.version.cuda
        info["cuda_device"] = torch.cuda.get_device_name(0)
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        info["mps_available"] = True
    return info


def documents(args):
    listed = json.loads(args.documents.read_text())["documents"]
    if args.only:
        listed = [d for d in listed if d["doc_num"] in set(args.only)]
    return listed


def run(load, convert, args, meta):
    """load() -> converter, timed once; convert(converter, pdf) -> (native dict, markdown)."""
    args.out.mkdir(parents=True, exist_ok=True)
    listed = documents(args)
    started = time.monotonic()
    converter = load()
    meta = {**meta, "device_requested": args.device, "load_seconds": round(time.monotonic() - started, 1)}

    smallest = min(listed, key=lambda d: d["pages"])
    started = time.monotonic()
    convert(converter, args.pdfs / f"{smallest['doc_num']}.pdf")
    meta["warmup"] = {"doc_num": smallest["doc_num"], "seconds": round(time.monotonic() - started, 1)}
    meta.update(torch_device())
    meta["machine"] = machine()
    (args.out / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n")

    todo = [d for d in listed if not (args.out / d["doc_num"] / "native.json.gz").exists()]
    for i, d in enumerate(todo, 1):
        folder = args.out / d["doc_num"]
        folder.mkdir(exist_ok=True)
        started = time.monotonic()
        wall_start = time.time()
        try:
            native, markdown = convert(converter, args.pdfs / f"{d['doc_num']}.pdf")
        except Exception:
            (folder / "error.txt").write_text(traceback.format_exc())
            print(f"[{i}/{len(todo)}] {d['doc_num']}: failed", flush=True)
            continue
        seconds = time.monotonic() - started
        with gzip.open(folder / "native.json.gz", "wt", encoding="utf-8") as f:
            json.dump(native, f, ensure_ascii=False)
        (folder / "markdown.md").write_text(markdown)
        (folder / "error.txt").unlink(missing_ok=True)
        with open(args.out / "timings.jsonl", "a") as f:
            f.write(json.dumps({"doc_num": d["doc_num"], "pages": d["pages"], "seconds": round(seconds, 2),
                                "seconds_per_page": round(seconds / d["pages"], 3),
                                "started": round(wall_start, 2), "ended": round(time.time(), 2)}) + "\n")
        print(f"[{i}/{len(todo)}] {d['doc_num']}: {d['pages']} pages in {seconds:.1f} s", flush=True)
