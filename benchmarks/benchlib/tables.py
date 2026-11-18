"""Report pieces: markdown tables, numbers with signs, a difference with its interval and verdict, the
glossary and the notes on time and cost, and JSON and CSV writers.

Everything returned or written goes through plain(), which refuses an em-dash (CONTRIBUTING.md: no
em-dashes in docs). Negative numbers use the minus sign, and a value that rounds to zero is never
shown as -0.0.
"""
from __future__ import annotations

import csv
import io
import json
from pathlib import Path
from typing import Iterable, Optional, Sequence, Tuple

EM_DASH = "—"
MINUS = "−"
MISSING = "n/a"
MARK = "✱"
NOTES_TITLE = "Notes: time and cost (not part of the ranking)"

# Standard terms; a benchmark adds its own after these
GLOSSARY = (
    ("Reference", "the known-right answers every side is measured against, made without looking at any "
                  "side's output."),
    ("Side", "one of the things compared: the current component, or a candidate for replacing it."),
    ("Paired difference", "both sides graded on exactly the same items, so the difference compares like "
                          "with like."),
    ("95% interval", "the range the difference would likely fall in with another sample of documents, from "
                     "resampling whole documents. If it leaves out zero, the difference is unlikely to be "
                     f"chance ({MARK})."),
    ("Margin", "how much worse a candidate may be and still replace the current side, set before the run."),
    ("Verdict", "better: the whole interval is above zero. Not worse: the whole interval is above minus "
                "the margin. Worse: the whole interval is below minus the margin. Inconclusive: none of "
                "these; more items are needed."),
    ("Detectable", "the smallest difference this sample would find with 80% power. A difference smaller "
                   "than this can hide in a sample this size."),
    ("Tier", "sides that the data can't tell apart, after correcting for comparing several pairs at once."),
)


def plain(text: str) -> str:
    if EM_DASH in text:
        raise ValueError(f"em-dash in report text: {text[:80]!r}")
    return text


def number(x: Optional[float], digits: int = 1, scale: float = 100.0) -> str:
    """x times scale, rounded; never "-0.0"."""
    if x is None:
        return MISSING
    s = f"{x * scale:.{digits}f}"
    if float(s) == 0:
        s = s.lstrip("-")
    return s.replace("-", MINUS)


def signed(x: Optional[float], digits: int = 1, scale: float = 100.0) -> str:
    if x is None:
        return MISSING
    s = number(x, digits, scale)
    return s if s.startswith(MINUS) or float(s.replace(MINUS, "-")) == 0 else "+" + s


def interval(low: float, high: float, digits: int = 1, scale: float = 100.0) -> str:
    return f"{signed(low, digits, scale)} to {signed(high, digits, scale)}"


def diff_cell(d, verdict: Optional[str] = None, digits: int = 1) -> str:
    """"+7.2 ✱ (+3.0 to +11.8)", then the verdict when one is given."""
    if d.unreliable:
        return "unreliable"
    mark = f" {MARK}" if d.significant else ""
    text = f"{signed(d.point, digits)}{mark} ({interval(d.low, d.high, digits)})"
    return plain(f"{text}, {verdict}" if verdict else text)


def table(header: Sequence[str], rows: Iterable[Sequence[object]], align: Optional[str] = None) -> str:
    """A markdown table; align is one letter per column, l or r."""
    align = align or "l" * len(header)
    lines = ["| " + " | ".join(header) + " |",
             "| " + " | ".join("---:" if a == "r" else "---" for a in align) + " |"]
    for r in rows:
        lines.append("| " + " | ".join(str(c) for c in r) + " |")
    return plain("\n".join(lines) + "\n")


def glossary(terms: Sequence[Tuple[str, str]], title: str = "Words used here") -> str:
    return plain(f"## {title}\n\n" + "\n".join(f"- **{t}**: {m}" for t, m in terms) + "\n")


def notes(lines: Sequence[str]) -> str:
    return plain(f"## {NOTES_TITLE}\n\n" + "\n".join(f"- {l}" for l in lines) + "\n")


def write_text(path: Path, text: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(plain(text))


def dumps(data, sort_keys: bool = True) -> str:
    return plain(json.dumps(data, indent=2, ensure_ascii=False, sort_keys=sort_keys) + "\n")


def write_json(path: Path, data, sort_keys: bool = True) -> None:
    write_text(path, dumps(data, sort_keys))


def write_jsonl(path: Path, rows: Iterable[dict]) -> None:
    write_text(path, "".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in rows))


def write_csv(path: Path, rows: Sequence[dict]) -> None:
    out = io.StringIO()
    if rows:
        w = csv.DictWriter(out, fieldnames=list(rows[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    write_text(path, out.getvalue())
