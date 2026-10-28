"""Create or update the pilot pipeline on digdir/kudos-next (or --dataset) from sample.json, run it through the API
and wait for the result.

The API must run in dev mode (it logs in through POST /mock/dev-login as an operator) with Marker and the
knowledge server configured; see README.md. Writes .data/ingest-<execution>.json with the run's report.

    python3 run_ingest.py --converted-only --roles test     # smoke run: test documents Marker has done
    python3 run_ingest.py                                    # every document in sample.json
    python3 run_ingest.py --api http://localhost:8301 --dataset digdir/kudos-next-borealis   # one model's dataset
"""
import argparse
import json
import time
import urllib.parse
import urllib.request

from common import DATA, SAMPLE

DATASET = "digdir/kudos-next"
PIPELINE = "kudos-pilot"
REASON = "Kudos pilot on pgvector (genki issue 92)"


def call(api, method, path, token=None, body=None):
    headers = {"content-type": "application/json", "change-reason": REASON}
    if token:
        headers["authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        api + path, method=method, headers=headers, data=None if body is None else json.dumps(body).encode()
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def chosen_ids(roles, converted_only):
    documents = [d for d in json.load(open(SAMPLE))["documents"] if d["role"] in roles]
    if converted_only:
        ledger = DATA / "conversions.jsonl"
        done = {r["sha256"] for r in map(json.loads, filter(str.strip, open(ledger))) if r["ok"]} if ledger.exists() else set()
        documents = [d for d in documents if all(f["sha256"] in done for f in d["files"])]
    return [d["uuid"] for d in documents]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://localhost:8096")
    parser.add_argument("--roles", default="test,decoy,benchmark")
    parser.add_argument("--converted-only", action="store_true")
    parser.add_argument("--dataset", default=DATASET)
    args = parser.parse_args()

    ids = chosen_ids(args.roles.split(","), args.converted_only)
    if not ids:
        raise SystemExit("no documents to ingest")
    status, login = call(args.api, "POST", "/mock/dev-login", body={"as": "operator"})
    if status != 200:
        raise SystemExit(f"dev login failed with HTTP {status}: {login}")
    token = login["token"]
    base = f"/operator/datasets/{urllib.parse.quote(args.dataset, safe='')}/pipelines"
    spec = {
        "name": "Kudos-piloten",
        "description": "Dokumentene i benchmarks/kudos-pilot/sample.json, konvertert med Marker og delt opp side for side",
        "source": {"kind": "kudos", "ids": ids},
        "chunking": {"strategy": {"kind": "page", "splitMaxLength": 4000}, "minimumLength": 1, "maximumLength": 4000},
        "parallelism": 2,
        "maxDocumentFailures": 1000,
    }
    status, _ = call(args.api, "GET", f"{base}/{PIPELINE}", token)
    status, saved = (
        call(args.api, "PUT", f"{base}/{PIPELINE}", token, spec)
        if status == 200
        else call(args.api, "POST", base, token, {"id": PIPELINE, **spec})
    )
    if status not in (200, 201):
        raise SystemExit(f"saving the pipeline failed with HTTP {status}: {saved}")
    status, started = call(args.api, "POST", f"{base}/{PIPELINE}/execute", token)
    if status != 202:
        raise SystemExit(f"starting the run failed with HTTP {status}: {started}")
    print(f"started {len(ids)} documents: {json.dumps(started)[:300]}", flush=True)
    execution = started.get("execution") or started.get("id")
    while True:
        time.sleep(15)
        status, listed = call(args.api, "GET", f"{base}/{PIPELINE}/executions", token)
        if status == 401:  # the dev login lasts an hour; a long run logs in again
            token = call(args.api, "POST", "/mock/dev-login", body={"as": "operator"})[1]["token"]
            continue
        if status != 200:
            print(f"listing the runs failed with HTTP {status}; trying again", flush=True)
            continue
        runs = listed.get("data", listed) if isinstance(listed, dict) else listed
        run = next((r for r in runs if r.get("execution", r.get("id")) == execution), runs[0] if runs else {})
        print(f"{run.get('status')}: {json.dumps(run.get('progress', run.get('report', {})))[:200]}", flush=True)
        if run.get("status") not in ("queued", "running", "pending", None):
            break
    out = DATA / f"ingest-{execution}.json"
    out.write_text(json.dumps({"dataset": args.dataset, "documents": ids, "run": run}, indent=2, ensure_ascii=False))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
