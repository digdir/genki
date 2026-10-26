"""Copy the pilot's documents from the shared Typesense test cluster into a local Typesense, so the comparison
runs both engines on this machine over the same documents.

Only reads the shared cluster: the collection schemas (the same as headless-rag's server/src/digdir/docs/
loader.clj) and searches filtered to the pilot's old ids. The local collections get the same names and fields;
phrase vectors are left out and computed again locally by the same model (ts/all-MiniLM-L12-v2).

    docker run -d --name genki-kudos-pilot-typesense -p 127.0.0.1:8108:8108 \
      -v genki-kudos-pilot-typesense:/data typesense/typesense:30.1 --data-dir /data --api-key=<local key>
    python3 copy_typesense.py

Settings: TYPESENSE_URL and TYPESENSE_KEY (the shared cluster, from the environment or .env.local),
TYPESENSE_LOCAL_URL (default http://127.0.0.1:8108) and the local key in .data/typesense-local-key.
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from common import DATA, REPO, SAMPLE

COLLECTIONS = [  # documents first: chunks and phrases reference them
    "KUDOS_preprod_v4_documents_ab897fbdedfa",
    "KUDOS_preprod_v4_chunks_ab897fbdedfa",
    "KUDOS_preprod_v4_phrases_ab897fbdedfa",
]
LEFT_OUT = {"phrase_vec"}  # computed again by the local Typesense
READ_ONLY = {"created_at", "num_documents", "curation_sets", "synonym_sets"}


def setting(name):
    if os.environ.get(name):
        return os.environ[name]
    value = ""
    for line in (REPO / ".env.local").read_text().splitlines():
        key, sep, rest = line.partition("=")
        if sep and key.strip() == name and rest.strip():
            value = rest.strip().strip("'\"")
    return value


REMOTE = (setting("TYPESENSE_URL").rstrip("/"), setting("TYPESENSE_KEY"))
LOCAL = (os.environ.get("TYPESENSE_LOCAL_URL", "http://127.0.0.1:8108"), (DATA / "typesense-local-key").read_text().strip())


def call(server, method, path, body=None, raw=None):
    request = urllib.request.Request(
        server[0] + path,
        method=method,
        headers={"X-TYPESENSE-API-KEY": server[1], "content-type": "application/json"},
        data=raw if raw is not None else (None if body is None else json.dumps(body).encode()),
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        return response.read()


def main():
    ids = sorted({d["old_id"] for d in json.load(open(SAMPLE))["documents"] if d["old_id"]})
    filter_by = f"doc_num:=[{','.join(ids)}]"
    for name in COLLECTIONS:
        schema = json.loads(call(REMOTE, "GET", f"/collections/{name}"))
        try:
            call(LOCAL, "GET", f"/collections/{name}")
            print(f"{name}: exists locally")
        except urllib.error.HTTPError:
            call(LOCAL, "POST", "/collections", {k: v for k, v in schema.items() if k not in READ_ONLY})
            print(f"{name}: created")
        copied, page, found = 0, 1, None
        while found is None or copied < found:
            params = {"q": "*", "filter_by": filter_by, "per_page": 250, "page": page}
            if LEFT_OUT & {f["name"] for f in schema["fields"]}:
                params["exclude_fields"] = ",".join(sorted(LEFT_OUT))
            result = json.loads(call(REMOTE, "GET", f"/collections/{name}/documents/search?{urllib.parse.urlencode(params)}"))
            found = result["found"]
            documents = [hit["document"] for hit in result["hits"]]
            if not documents:
                break
            lines = "\n".join(json.dumps(d, ensure_ascii=False) for d in documents).encode()
            answers = call(LOCAL, "POST", f"/collections/{name}/documents/import?action=upsert", raw=lines)
            failed = [a for a in map(json.loads, answers.decode().splitlines()) if not a.get("success")]
            if failed:
                raise SystemExit(f"{name}: {len(failed)} documents were refused, first: {failed[0]}")
            copied += len(documents)
            page += 1
            if page % 40 == 0:
                print(f"  {name}: {copied}/{found}", flush=True)
        local = json.loads(call(LOCAL, "GET", f"/collections/{name}"))["num_documents"]
        print(f"{name}: {found} on the shared cluster for the pilot, {local} locally", flush=True)


if __name__ == "__main__":
    main()
