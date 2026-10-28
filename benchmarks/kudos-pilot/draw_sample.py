"""Draw the pilot's ~300 Kudos documents and write sample.json next to this script (committed).

Roles:
- test: every document a ka-kudos-draft case cites. Mapped to KUDOS by file sha256, else by title
  and publish date (the file then differs from the indexed one; every registration that matches
  is kept, and a hit on any of them counts). Documents with no match are listed as missing.
- benchmark: the ingestion benchmark's 150 documents.
- decoy: documents of the test documents' types and publish years, drawn only from documents
  that pair with Typesense on their one file's sha256, so both engines hold the same set.

Reads the KUDOS listing and the Typesense records the ingestion benchmark fetched.
"""
import collections
import json
import random
import re

from common import INGESTION, INGESTION_DATA, SAMPLE, TESTSET

TOTAL = 300
SEED = 20261022


def year(doc):
    return str(doc.get("publish_date") or "")[:4]


def summary(doc, role, old_id=None, matched_by=None):
    return {
        "uuid": doc["uuid"],
        "role": role,
        "old_id": old_id,
        "matched_by": matched_by,
        "type": doc.get("type"),
        "publish_year": year(doc),
        "title": doc.get("title"),
        "files": [
            {key: f.get(key) for key in ("uuid", "url", "sha256", "size", "mimetype", "pages", "is_primary")}
            for f in doc.get("files") or []
        ],
    }


def main():
    ours = {str(o["doc_num"]): o for o in (json.loads(l) for l in open(INGESTION_DATA / "ts-documents.jsonl") if l.strip())}
    kudos = {d["uuid"]: d for d in (json.loads(l) for l in open(INGESTION_DATA / "kudos-listing.jsonl") if l.strip())}
    by_sha, by_primary_sha, by_title = (collections.defaultdict(set) for _ in range(3))
    for d in kudos.values():
        by_title[(d.get("title"), str(d.get("publish_date") or "")[:10])].add(d["uuid"])
        for f in d.get("files") or []:
            if f.get("sha256"):
                by_sha[f["sha256"]].add(d["uuid"])
                if f.get("is_primary"):
                    by_primary_sha[f["sha256"]].add(d["uuid"])

    chosen, missing = {}, []
    for old_id in sorted(set(re.findall(r"document: '?(\d+)'?", TESTSET.read_text()))):
        o = ours.get(old_id)
        if o is None:
            missing.append(old_id)
            continue
        hits = {u for f in o.get("files") or [] for u in by_sha.get(f.get("sha256"), ())}
        matched_by = "sha256"
        if len(hits) != 1:
            hits = by_title.get((o.get("title"), str(o.get("publish_date") or "")[:10]), set())
            matched_by = "title"
        if not hits:
            missing.append(old_id)
        for uuid in sorted(hits):
            chosen[uuid] = summary(kudos[uuid], "test", old_id, matched_by)

    for entry in json.load(open(INGESTION / "sample.json")):
        if entry["uuid"] in kudos and entry["uuid"] not in chosen:
            chosen[entry["uuid"]] = summary(kudos[entry["uuid"]], "benchmark", entry["doc_num"], "sha256")

    # Strict pairing, as the ingestion benchmark does: our one file is a KUDOS document's primary file
    pool = collections.defaultdict(list)
    for old_id, o in ours.items():
        files = o.get("files") or []
        hits = by_primary_sha.get(files[0].get("sha256"), set()) if len(files) == 1 else set()
        if len(hits) == 1:
            (uuid,) = hits
            d = kudos[uuid]
            if uuid not in chosen:
                pool[(d.get("type"), year(d))].append((uuid, old_id))

    strata = collections.Counter((e["type"], e["publish_year"]) for e in chosen.values() if e["role"] == "test")
    want = TOTAL - len(chosen)
    total = sum(strata.values())
    quota = {s: want * n // total for s, n in strata.items()}
    for s, _ in sorted(strata.items(), key=lambda kv: -(want * kv[1] % total))[: want - sum(quota.values())]:
        quota[s] += 1
    rng = random.Random(SEED)
    short = collections.Counter()
    for s in sorted(quota):
        candidates = sorted(pool.get(s, []))
        picked = rng.sample(candidates, min(quota[s], len(candidates)))
        short[s[0]] += quota[s] - len(picked)
        for uuid, old_id in picked:
            chosen[uuid] = summary(kudos[uuid], "decoy", old_id, "sha256")
    for doc_type, n in sorted(short.items()):  # fill a short stratum from the same type, any year
        candidates = sorted(c for (t, _), cs in pool.items() if t == doc_type for c in cs if c[0] not in chosen)
        for uuid, old_id in rng.sample(candidates, min(n, len(candidates))):
            chosen[uuid] = summary(kudos[uuid], "decoy", old_id, "sha256")

    order = {"test": 0, "decoy": 1, "benchmark": 2}
    entries = sorted(chosen.values(), key=lambda e: (order[e["role"]], e["uuid"]))
    SAMPLE.write_text(json.dumps({"missing_test_documents": missing, "documents": entries}, ensure_ascii=False, indent=2) + "\n")

    for role in order:
        docs = [e for e in entries if e["role"] == role]
        files = [f for e in docs for f in e["files"]]
        pdfs = [f for f in files if f.get("mimetype") == "application/pdf"]
        print(f"{role:9} {len(docs):4} documents, {len(files):4} files ({len(files) - len(pdfs)} not PDF), "
              f"{sum(f.get('pages') or 0 for f in pdfs):6} PDF pages, {sum(f.get('size') or 0 for f in pdfs) / 1e9:.1f} GB")
    print("test documents matched by title:", sorted(e["old_id"] for e in entries if e["matched_by"] == "title"))
    print("test documents missing:", missing)


if __name__ == "__main__":
    main()
