"""Check the reference's test files: the scoring tool's own rules, plus ours.

    validate.py                                  # every test file
    validate.py reference/tests/<page_id>.json ...

Our rules: test ids start with the page id and are unique across the reference; a page with no tests says
why under "skipped"; every text arg has a language tag on its test (nob, nno or eng, ...).
"""
import json
import sys
from pathlib import Path

from omni_parse_bench import gold

from common_opb import TESTS, pages

LANGUAGES = {"nob", "nno", "eng", "sme", "swe", "dan", "deu", "fra"}


def check(path, seen):
    page_id = path.stem
    doc = json.loads(path.read_text())
    tests = doc.get("tests")
    if not isinstance(tests, list):
        return [f"{page_id}: no tests list"]
    if not tests:
        return [] if str(doc.get("skipped", "")).strip() else [f"{page_id}: no tests and no 'skipped' reason"]
    problems = []
    try:
        gold.parse(page_id, doc)
    except gold.GoldError as e:
        problems.append(str(e))
    for t in tests:
        tid = t.get("id", "")
        if not tid.startswith(f"{page_id}-"):
            problems.append(f"{page_id}: test id {tid!r} doesn't start with the page id")
        if tid in seen:
            problems.append(f"{page_id}: test id {tid!r} also in {seen[tid]}")
        seen[tid] = page_id
        has_text = any("text" in a for v in t.get("args", {}).values() for a in (v if isinstance(v, list) else [v]))
        if has_text and not LANGUAGES & set(t.get("tags", [])):
            problems.append(f"{page_id}: test {tid!r} has text but no language tag")
    return problems


def main():
    paths = [Path(p) for p in sys.argv[1:]] or sorted(TESTS.glob("*.json"))
    known = {p["page_id"] for p in pages()}
    seen, problems = {}, []
    for path in paths:
        if path.stem not in known:
            problems.append(f"{path.stem}: not a page in reference/pages.json")
            continue
        problems += check(path, seen)
    for p in problems:
        print(p)
    n = sum(len(json.loads(p.read_text()).get("tests", [])) for p in paths if p.stem in known)
    print(f"{len(paths)} test files, {n} tests, {len(problems)} problems")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
