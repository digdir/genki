"""Page tests for the era test set (results/eras-test-set.json): the opb page tests' method, test types, file
format and scorer, on a set of its own in reference-eras/ (never mixed into opb's 1,933 tests).

    ../opb/.venv/bin/python eras_tests.py select          # draw the pages into reference-eras/pages.json (seeded)
    ../opb/.venv/bin/python eras_tests.py sheets          # contact sheets of the scanned pages, for the table screen
    ../opb/.venv/bin/python eras_tests.py select-tables   # more table pages, appended to reference-eras/pages.json
    ../opb/.venv/bin/python eras_tests.py render          # page images for the test writers
    ../opb/.venv/bin/python eras_tests.py zoom <page_id> <x0> <y0> <x1> <y1>
    ../opb/.venv/bin/python eras_tests.py validate [reference-eras/tests/<page_id>.json ...]
    ../opb/.venv/bin/python eras_tests.py verify-queue [batches]   # every test, for the blind check
    ../opb/.venv/bin/python eras_tests.py apply-review              # its verdicts into reference-eras/tests/
    ../opb/.venv/bin/python eras_tests.py canary                    # a test of the blind check, reference-eras/canary/
    ../opb/.venv/bin/python eras_tests.py dataset                   # the scorer's dataset, .data/eras/dataset/
    ../opb/.venv/bin/python eras_tests.py counts                    # tests per page kind and era

Pages are drawn as opb's select_pages.py drew them: per document one random page that isn't blank, one more
scanned page (scan+text or image-only) where the document has one, and one more table page where it has one.
Page kinds and table counts come from .data/eras/pages.jsonl. The documents aren't in our index, so a page id is
`eras-<first 8 characters of the uuid>-p<page>`, and the dataset's `document` is those 8 characters.

The writers and checkers follow opb/reference/writing-tests.md and verifying-tests.md, reading the images under
.data/eras/png and .data/eras/hires (reference-eras/README.md says what differs).
"""
import collections
import json
import random
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OPB_CODE = HERE.parent / "opb"
sys.path.insert(0, str(OPB_CODE))

SET = HERE / "results" / "eras-test-set.json"
DATA = HERE / ".data" / "eras"
PAGE_KINDS = DATA / "pages.jsonl"
PNG, HIRES, ZOOM, DATASET, VERIFY = (DATA / x for x in ("png", "hires", "zoom", "dataset", "verify"))
REFERENCE = HERE / "reference-eras"
PAGES, TESTS, REVIEW_LOG = REFERENCE / "pages.json", REFERENCE / "tests", REFERENCE / "review-log.jsonl"
CANARY = REFERENCE / "canary"

SEED = 20261111
SCANNED = ("scan+text", "image-only")
OVERVIEW, HIRES_DPI, LONG_EDGE = 1600, 300, 1600   # as opb render.py and zoom.py


def documents():
    return json.loads(SET.read_text())["documents"]


def pdf_path(uuid):
    return DATA / "pdf" / f"{uuid}.pdf"


def pages():
    return json.loads(PAGES.read_text())


def select():
    rng = random.Random(SEED)
    kinds = collections.defaultdict(dict)
    for r in map(json.loads, open(PAGE_KINDS)):
        kinds[r["uuid"]][r["page"]] = r
    picked, taken = [], set()

    def pick(d, page, reason):
        k = kinds[d["uuid"]][page]
        picked.append({"page_id": f'eras-{d["id"]}-p{page}', "id": d["id"], "uuid": d["uuid"], "page": page,
                       "reason": reason, "pdf_kind": k["kind"], "tables": k["tables"],
                       "multi_column": k["multi_column"], "era": d["era"], "picked_for": d["picked_for"],
                       "type": d["type"], "publish_year": d["publish_year"]})
        taken.add((d["uuid"], page))

    docs = documents()
    for d in docs:
        pick(d, rng.choice(sorted(p for p, k in kinds[d["uuid"]].items() if k["kind"] != "blank")), "random")
    for d in docs:
        scans = sorted(p for p, k in kinds[d["uuid"]].items() if k["kind"] in SCANNED and (d["uuid"], p) not in taken)
        if scans:
            pick(d, rng.choice(scans), "scan")
    for d in docs:
        tables = sorted(p for p, k in kinds[d["uuid"]].items() if k["tables"] and (d["uuid"], p) not in taken)
        if tables:
            pick(d, rng.choice(tables), "table")
    REFERENCE.mkdir(exist_ok=True)
    PAGES.write_text(json.dumps(picked, indent=1, ensure_ascii=False) + "\n")
    print(f"{len(picked)} pages:", dict(collections.Counter(p["reason"] for p in picked)),
          dict(collections.Counter(p["pdf_kind"] for p in picked)))


SHEETS = DATA / "sheets"
SCREEN = REFERENCE / "scan-tables.json"   # the table screen of the scanned pages: {"<id>-p<page>": true|false}
MORE_TABLES = 3                           # more table pages per document, so at most 4 a document


def sheets():
    """Every scanned page of the set, 3 x 3 to a sheet, each labelled <id>-p<page>, for a reader to mark the
    pages with a table (a grid with column headings or row labels). The PDF's own table count can't see a
    table that is only in a page image."""
    import pymupdf
    from PIL import Image, ImageDraw
    SHEETS.mkdir(parents=True, exist_ok=True)
    taken = {(p["uuid"], p["page"]) for p in pages()}
    docs = {d["uuid"]: d for d in documents()}
    todo = [r for r in map(json.loads, open(PAGE_KINDS))
            if r["uuid"] in docs and r["kind"] in SCANNED and (r["uuid"], r["page"]) not in taken]
    cell = 560
    for n in range(0, len(todo), 9):
        sheet = Image.new("RGB", (3 * cell, 3 * (cell + 30)), "white")
        draw = ImageDraw.Draw(sheet)
        for i, r in enumerate(todo[n:n + 9]):
            with pymupdf.open(pdf_path(r["uuid"])) as pdf:
                page = pdf[r["page"] - 1]
                z = cell / max(page.rect.width, page.rect.height)
                pix = page.get_pixmap(matrix=pymupdf.Matrix(z, z))
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            x, y = (i % 3) * cell, (i // 3) * (cell + 30)
            draw.text((x + 8, y + 6), f'{docs[r["uuid"]]["id"]}-p{r["page"]}', fill="red")
            sheet.paste(img, (x, y + 30))
        sheet.save(SHEETS / f"sheet-{n // 9 + 1:02d}.png")
    print(f"{len(todo)} scanned pages on {-(-len(todo) // 9)} sheets in {SHEETS}")


def select_tables():
    """More table pages, after the first draw (which stays as it was): per document up to MORE_TABLES pages not
    yet drawn, from the pages where the PDF finds a table (reason table-more) or, on scans, where the table
    screen saw one (reason scan-table). Seeded; a rerun with the same screen gives the same pages."""
    rng = random.Random(SEED + 2)
    picked = [p for p in pages() if p["reason"] not in ("table-more", "scan-table")]
    taken = {(p["uuid"], p["page"]) for p in picked}
    screen = json.loads(SCREEN.read_text())
    kinds = collections.defaultdict(dict)
    for r in map(json.loads, open(PAGE_KINDS)):
        kinds[r["uuid"]][r["page"]] = r
    for d in documents():
        free = [(p, k) for p, k in sorted(kinds[d["uuid"]].items()) if (d["uuid"], p) not in taken]
        digital = [p for p, k in free if k["tables"] and k["kind"] not in SCANNED]
        scans = [p for p, k in free if k["kind"] in SCANNED and screen.get(f'{d["id"]}-p{p}')]
        pool = [(p, "table-more") for p in digital] + [(p, "scan-table") for p in scans]
        for page, reason in rng.sample(pool, min(MORE_TABLES, len(pool))):
            k = kinds[d["uuid"]][page]
            picked.append({"page_id": f'eras-{d["id"]}-p{page}', "id": d["id"], "uuid": d["uuid"], "page": page,
                           "reason": reason, "pdf_kind": k["kind"], "tables": k["tables"],
                           "multi_column": k["multi_column"], "era": d["era"], "picked_for": d["picked_for"],
                           "type": d["type"], "publish_year": d["publish_year"]})
    PAGES.write_text(json.dumps(picked, indent=1, ensure_ascii=False) + "\n")
    more = [p for p in picked if p["reason"] in ("table-more", "scan-table")]
    print(f"{len(more)} more table pages:", dict(collections.Counter(p["reason"] for p in more)),
          dict(collections.Counter(p["pdf_kind"] for p in more)))


def render():
    import pymupdf
    PNG.mkdir(parents=True, exist_ok=True)
    HIRES.mkdir(parents=True, exist_ok=True)
    for n, p in enumerate(pages(), 1):
        small, big = PNG / f'{p["page_id"]}.png', HIRES / f'{p["page_id"]}.png'
        if small.exists() and big.exists():
            continue
        with pymupdf.open(pdf_path(p["uuid"])) as pdf:
            page = pdf[p["page"] - 1]
            zoom = OVERVIEW / max(page.rect.width, page.rect.height)
            page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom)).save(small)
            page.get_pixmap(dpi=HIRES_DPI).save(big)
        print(f"{n} {p['page_id']}")


def zoom(page_id, *box):
    from PIL import Image
    x0, y0, x1, y1 = (float(x) for x in box)
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        raise SystemExit("the box must be x0 < x1 and y0 < y1, all from 0 to 1")
    img = Image.open(HIRES / f"{page_id}.png")
    w, h = img.size
    crop = img.crop((round(x0 * w), round(y0 * h), round(x1 * w), round(y1 * h)))
    if max(crop.size) > LONG_EDGE:
        crop.thumbnail((LONG_EDGE, LONG_EDGE))
    out = ZOOM / f"{page_id}-{x0:g}-{y0:g}-{x1:g}-{y1:g}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    crop.save(out)
    print(out)


def validate(*paths):
    import validate as opb_validate   # opb's checks: the scorer's own rules, ids, a language tag on each test
    paths = [Path(p) for p in paths] or sorted(TESTS.glob("*.json"))
    known = {p["page_id"] for p in pages()}
    seen, problems = {}, []
    for path in paths:
        if path.stem not in known:
            problems.append(f"{path.stem}: not a page in reference-eras/pages.json")
            continue
        problems += opb_validate.check(path, seen)
    for p in problems:
        print(p)
    n = sum(len(json.loads(p.read_text()).get("tests", [])) for p in paths if p.stem in known)
    print(f"{len(paths)} test files, {n} tests, {len(problems)} problems")
    sys.exit(1 if problems else 0)


def verify_queue(batches=6):
    """Every test not yet in the review log: there are no graded sides yet to pick the disputed ones by, so the
    blind check reads them all. A page's tests stay in one batch."""
    batches = int(batches)
    argv, sys.argv[1:] = sys.argv[1:], []   # opb's verify_queue reads its batch count from argv on import
    from verify_queue import claim          # opb's wording of a test as a claim
    sys.argv[1:] = argv
    done = {json.loads(l)["test_id"] for l in open(REVIEW_LOG)} if REVIEW_LOG.exists() else set()
    queue = []
    for p in pages():
        path = TESTS / f'{p["page_id"]}.json'
        for t in json.loads(path.read_text())["tests"] if path.exists() else []:
            if t["id"] not in done:
                queue.append({"test_id": t["id"], "page_id": p["page_id"], "test_type": t["test_type"],
                              "claim": claim(t), "args": t["args"]})
    VERIFY.mkdir(parents=True, exist_ok=True)
    for old in VERIFY.glob("batch-*.jsonl"):
        old.unlink()
    ids = sorted({q["page_id"] for q in queue})
    for i in range(batches):
        mine = set(ids[i::batches])
        lines = [json.dumps(q, ensure_ascii=False) for q in queue if q["page_id"] in mine]
        (VERIFY / f"batch-{i + 1:02d}.jsonl").write_text("\n".join(lines) + "\n" if lines else "")
        print(f"batch-{i + 1:02d}: {len(lines)} tests on {len(mine)} pages")
    print(f"{len(queue)} tests to check")


def apply_review():
    """As opb apply_review.py: ok keeps a test, fix replaces its args (derivation model_review), drop removes it;
    every verdict is logged in reference-eras/review-log.jsonl with the test before and after."""
    logged = {json.loads(l)["test_id"] for l in open(REVIEW_LOG)} if REVIEW_LOG.exists() else set()
    results = [json.loads(l) for f in sorted(VERIFY.glob("result-*.jsonl")) for l in open(f) if l.strip()]
    # Note: a verdict marked "again" is a second look at a test already logged (to make two calls consistent)
    todo = [r for r in results if r["test_id"] not in logged or r.get("again")]
    if any(r.get("again") for r in todo):
        again = [(json.loads(l)["test_id"], json.loads(l).get("again", False)) for l in open(REVIEW_LOG)]
        todo = [r for r in todo if not r.get("again") or (r["test_id"], True) not in again]
    by_page = collections.defaultdict(list)
    for r in todo:
        by_page[r["test_id"].rsplit("-t", 1)[0]].append(r)
    counts = {"ok": 0, "fix": 0, "drop": 0}
    with open(REVIEW_LOG, "a") as log:
        for page_id, rs in sorted(by_page.items()):
            path = TESTS / f"{page_id}.json"
            doc = json.loads(path.read_text())
            tests = {t["id"]: t for t in doc["tests"]}
            for r in rs:
                if r["verdict"] not in counts:
                    raise SystemExit(f'{r["test_id"]}: unknown verdict {r["verdict"]!r}')
                before = tests.get(r["test_id"])
                if before is None:
                    raise SystemExit(f'{r["test_id"]}: not in {path.name}')
                after = None
                if r["verdict"] == "fix":
                    after = {**before, "args": r["args"], "derivation": "model_review"}
                    tests[r["test_id"]] = after
                elif r["verdict"] == "drop":
                    del tests[r["test_id"]]
                else:
                    after = before
                counts[r["verdict"]] += 1
                log.write(json.dumps({"test_id": r["test_id"], "verdict": r["verdict"], "note": r.get("note", ""),
                                      **({"again": True} if r.get("again") else {}),
                                      "before": before["args"], "after": after and after["args"]},
                                     ensure_ascii=False) + "\n")
            doc["tests"] = list(tests.values())
            if not doc["tests"]:
                doc["skipped"] = "every test was dropped in the blind check"
            path.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    print(f"applied {len(todo)} verdicts: {counts}")


def _break(t, how, rng):
    """One test broken on purpose, as opb's canary broke them; None when this test can't be broken that way."""
    import copy
    import re
    t = copy.deepcopy(t)
    a = t["args"]
    if how == "changed a digit":
        role = next((k for k, v in a.items() if isinstance(v, dict) and re.search(r"\d", v.get("text", ""))), None)
        if role is None:
            return None
        text = a[role]["text"]
        i = rng.choice([m.start() for m in re.finditer(r"\d", text)])
        a[role]["text"] = text[:i] + str((int(text[i]) + rng.randint(1, 8)) % 10) + text[i + 1:]
    elif how == "dropped a word":
        words = a.get("content", {}).get("text", "").split()
        if t["test_type"] != "present" or len(words) < 6:
            return None
        del words[rng.randrange(1, len(words) - 1)]
        a["content"]["text"] = " ".join(words)
        a["content"]["max_diffs"] = 0
    elif how == "swapped before and after":
        if t["test_type"] != "order":
            return None
        a["before"], a["after"] = a["after"], a["before"]
    elif how == "top_heading: swapped two letters":
        text = a.get("top_heading", {}).get("text", "")
        spots = [i for i in range(len(text) - 1) if text[i].isalpha() and text[i + 1].isalpha()
                 and text[i].lower() != text[i + 1].lower()]
        if not spots:
            return None
        i = rng.choice(spots)
        a["top_heading"]["text"] = text[:i] + text[i + 1] + text[i] + text[i + 2:]
    return t


def canary():
    """As opb's reference/canary: 14 tests for a fresh blind checker, 7 broken on purpose and 7 as written,
    shuffled, with new ids (<page_id>-cNN) so the checker can't tell which is which. Writes
    reference-eras/canary/canary.jsonl (the batch) and answers.json (which were broken and how); the checker's
    verdicts go to canary/result.jsonl."""
    argv, sys.argv[1:] = sys.argv[1:], []
    from verify_queue import claim
    sys.argv[1:] = argv
    rng = random.Random(SEED + 1)
    tests = [t for p in pages() for t in json.loads((TESTS / f'{p["page_id"]}.json').read_text())["tests"]]
    rng.shuffle(tests)
    plan = (["changed a digit"] * 2 + ["dropped a word"] * 2 + ["swapped before and after"] * 2
            + ["top_heading: swapped two letters"] + ["unchanged"] * 7)
    rng.shuffle(plan)
    used, items = set(), []
    for how in plan:
        for t in tests:
            if t["id"] in used:
                continue
            broken = t if how == "unchanged" else _break(t, how, rng)
            if broken is not None:
                used.add(t["id"])
                items.append((how, t["id"], broken))
                break
        else:
            raise SystemExit(f"no test can be broken as {how!r}")
    CANARY.mkdir(parents=True, exist_ok=True)
    lines, answers = [], {}
    for n, (how, source, t) in enumerate(items):
        page_id = source.rsplit("-t", 1)[0]
        cid = f"{page_id}-c{n:02d}"
        lines.append(json.dumps({"test_id": cid, "page_id": page_id, "test_type": t["test_type"],
                                 "claim": claim(t), "args": t["args"]}, ensure_ascii=False))
        answers[cid] = {"corrupt": how != "unchanged", "how": how, "from": source}
    (CANARY / "canary.jsonl").write_text("\n".join(lines) + "\n")
    (CANARY / "answers.json").write_text(json.dumps(answers, indent=1, ensure_ascii=False) + "\n")
    print(f"{len(lines)} canary tests, {sum(a['corrupt'] for a in answers.values())} broken")
    result = CANARY / "result.jsonl"
    if result.exists():
        got = {r["test_id"]: r["verdict"] for r in map(json.loads, open(result)) }
        caught = sum(got.get(c) in ("fix", "drop") for c, a in answers.items() if a["corrupt"])
        kept = sum(got.get(c) == "ok" for c, a in answers.items() if not a["corrupt"])
        print(f"the checker caught {caught} of 7 broken tests and kept {kept} of 7 real ones")


def dataset():
    """As opb build_dataset.py: manifest.parquet, pages/<page_id>.pdf (the page cut out), gold/<page_id>.json.
    Grade a side with `opb grade <run> --dataset .data/eras/dataset --unsupported`."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    import pymupdf
    if DATASET.exists():
        shutil.rmtree(DATASET)
    (DATASET / "pages").mkdir(parents=True)
    (DATASET / "gold").mkdir()
    rows, skipped, missing = [], 0, 0
    for p in pages():
        src = TESTS / f'{p["page_id"]}.json'
        if not src.exists():
            missing += 1
            continue
        if not json.loads(src.read_text())["tests"]:
            skipped += 1
            continue
        with pymupdf.open(pdf_path(p["uuid"])) as doc, pymupdf.open() as one:
            one.insert_pdf(doc, from_page=p["page"] - 1, to_page=p["page"] - 1)
            one.save(DATASET / "pages" / f'{p["page_id"]}.pdf')
        shutil.copy(src, DATASET / "gold" / src.name)
        rows.append({"page_id": p["page_id"], "document": p["id"], "suite": p["reason"],
                     "doc_path": f'pages/{p["page_id"]}.pdf', "gt_path": f'gold/{p["page_id"]}.json',
                     "outputs": ["html"]})
    pq.write_table(pa.Table.from_pylist(rows), DATASET / "manifest.parquet")
    print(f"{len(rows)} pages in {DATASET}; {skipped} skipped, {missing} without a test file yet")


def counts():
    """Pages and tests (text = present and order, table = table_cell) per page kind and per era."""
    rows = []
    for p in pages():
        path = TESTS / f'{p["page_id"]}.json'
        tests = json.loads(path.read_text())["tests"] if path.exists() else []
        rows.append((p, sum(t["test_type"] != "table_cell" for t in tests),
                     sum(t["test_type"] == "table_cell" for t in tests)))
    for key in ("pdf_kind", "era", "reason"):
        print(f"\n{'by ' + key:<16}{'pages':>6}{'with tests':>11}{'docs':>6}{'text':>6}{'table':>6}")
        for value in sorted({p[key] for p, *_ in rows}):
            mine = [r for r in rows if r[0][key] == value]
            print(f"{value:<16}{len(mine):>6}{sum(1 for r in mine if r[1] + r[2]):>11}"
                  f"{len({r[0]['id'] for r in mine if r[1] + r[2]}):>6}"
                  f"{sum(r[1] for r in mine):>6}{sum(r[2] for r in mine):>6}")
    print(f"\nall: {len(rows)} pages, {sum(1 for r in rows if r[1] + r[2])} with tests, "
          f"{sum(r[1] for r in rows)} text tests, {sum(r[2] for r in rows)} table tests")


COMMANDS = {"select": select, "sheets": sheets, "select-tables": select_tables, "render": render, "zoom": zoom, "validate": validate, "verify-queue": verify_queue,
            "apply-review": apply_review, "canary": canary, "dataset": dataset, "counts": counts}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        raise SystemExit(__doc__)
    COMMANDS[sys.argv[1]](*sys.argv[2:])
