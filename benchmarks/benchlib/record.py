"""The run record: what a benchmark run used, so it can be rerun and compared only with like.

A record holds the commit and whether the tree had uncommitted changes, hashes of the code, the
reference and the items, each side's settings, the seed and number of draws, Python and package
versions, and the time. require_comparable refuses records that differ in reference, items or shared
settings, as packages/eval/src/runner.ts refuses runs whose provenance differs.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import platform
import subprocess
from pathlib import Path
from typing import Dict, Iterable, Mapping, Optional, Sequence, Union

from benchlib import tables

SCHEMA = 1
COMPARED = ("reference", "items", "settings")

PathLike = Union[str, Path]


class Incomparable(ValueError):
    pass


def _files(paths: Iterable[PathLike]):
    for p in map(Path, paths):
        if p.is_dir():
            for f in sorted(p.rglob("*")):
                rel = f.relative_to(p.parent)
                if f.is_file() and not any(part.startswith(".") or part == "__pycache__" for part in rel.parts):
                    yield rel.as_posix(), f
        elif p.is_file():
            yield p.name, p
        else:
            raise FileNotFoundError(p)


def tree_hash(paths: Union[PathLike, Sequence[PathLike]]) -> str:
    """sha256 over the sorted relative paths and bytes of the files given, or under the folders given.
    File times don't count; a renamed file does."""
    if isinstance(paths, (str, Path)):
        paths = [paths]
    h = hashlib.sha256()
    for rel, f in sorted(_files(paths)):
        h.update(rel.encode() + b"\0")
        h.update(f.read_bytes())
        h.update(b"\0")
    return h.hexdigest()


def git(root: PathLike) -> Dict[str, object]:
    def run(*args):
        return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=True).stdout.strip()
    try:
        return {"commit": run("rev-parse", "HEAD"), "dirty": bool(run("status", "--porcelain"))}
    except (OSError, subprocess.CalledProcessError):
        return {"commit": None, "dirty": None}


def package_versions(names: Sequence[str]) -> Dict[str, Optional[str]]:
    from importlib import metadata
    out: Dict[str, Optional[str]] = {}
    for n in names:
        try:
            out[n] = metadata.version(n)
        except metadata.PackageNotFoundError:
            out[n] = None
    return out


def make(benchmark: str, *, root: PathLike, code: Sequence[PathLike], reference: Optional[Sequence[PathLike]],
         items: Sequence[PathLike], side: str, side_settings: Mapping[str, object],
         settings: Mapping[str, object], packages: Sequence[str] = ()) -> dict:
    """The record of one side's run: settings shared by every side go in settings, the side's own in
    side_settings. A run without a reference records none, and can't be compared with another."""
    return {
        "schema": SCHEMA,
        "benchmark": benchmark,
        "side": side,
        "time": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(),
        "git": git(root),
        "code": tree_hash(code),
        "reference": tree_hash(reference) if reference else None,
        "items": tree_hash(items),
        "settings": dict(settings),
        "side_settings": dict(side_settings),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "packages": package_versions(packages),
    }


def write(path: PathLike, record: dict) -> None:
    tables.write_json(Path(path), record)


def read(path: PathLike) -> dict:
    return json.loads(Path(path).read_text())


def require_comparable(records: Mapping[str, Mapping[str, object]], fields: Sequence[str] = COMPARED,
                       allow: Sequence[str] = ()) -> None:
    """Raises Incomparable unless every record has a reference hash and all agree on fields, except
    the ones named in allow."""
    if not records:
        raise Incomparable("no records")
    for name, r in records.items():
        if not r.get("reference"):
            raise Incomparable(f"{name} has no reference hash")
    first_name, first = next(iter(records.items()))
    for f in fields:
        if f in allow:
            continue
        for name, r in records.items():
            if r.get(f) != first.get(f):
                raise Incomparable(f"{name} and {first_name} differ in {f}")
