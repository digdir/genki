"""Convert every PDF in sample.json with the Marker service, so the pilot's ingest finds each result in
the service's cache (`cache=true`, keyed by the file's sha256).

Resumable: files already converted are skipped. Test documents go first, then decoys, then the
benchmark documents, so the documents the eval needs are ready earliest. A PDF the ingestion
benchmark already downloaded is reused when its sha256 matches.

Settings: MARKER_URL (default http://localhost:8080/api/v1/marker-pdf-to-markdown) and MARKER_API_KEY.
Writes .data/conversions.jsonl, one line per file.
"""
import hashlib
import http.client
import json
import os
import shutil
import time
import urllib.error
import urllib.request
import uuid as uuidlib

from common import DATA, INGESTION_DATA, SAMPLE, get

MARKER_URL = os.environ.get("MARKER_URL", "http://localhost:8080/api/v1/marker-pdf-to-markdown")
LEDGER = DATA / "conversions.jsonl"
PDFS = DATA / "pdf"


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def pdf_for(entry, file):
    path = PDFS / f"{file['sha256']}.pdf"
    if path.exists() and sha256(path) == file["sha256"]:
        return path
    known = INGESTION_DATA / "pdf" / f"{entry['old_id']}.pdf"
    if entry.get("old_id") and known.exists() and sha256(known) == file["sha256"]:
        shutil.copyfile(known, path)
        return path
    data = get(file["url"])
    if hashlib.sha256(data).hexdigest() != file["sha256"]:
        raise ValueError("the downloaded file does not match its listed sha256")
    path.write_bytes(data)
    return path


def convert(path, key):
    boundary = uuidlib.uuid4().hex
    head = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
        "Content-Type: application/pdf\r\n\r\n"
    ).encode()
    body = head + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    request = urllib.request.Request(
        f"{MARKER_URL}?cache=true",
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "X-API-Key": key},
    )
    with urllib.request.urlopen(request, timeout=6 * 3600) as response:
        return json.load(response)


def wait_for_service(minutes=30):
    """Until the Marker service answers again (it restarts after a crash), at most `minutes`."""
    up = MARKER_URL.split("/api/")[0] + "/up"
    deadline = time.monotonic() + minutes * 60
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(up, timeout=10):
                return
        except Exception:
            time.sleep(10)
    raise SystemExit(f"the Marker service did not come back within {minutes} minutes")


def main():
    key = os.environ.get("MARKER_API_KEY") or exit("MARKER_API_KEY is not set")
    PDFS.mkdir(parents=True, exist_ok=True)
    done = set()
    if LEDGER.exists():
        done = {r["sha256"] for r in map(json.loads, filter(str.strip, open(LEDGER))) if r["ok"]}
    files = [(e, f) for e in json.load(open(SAMPLE))["documents"] for f in e["files"] if f["sha256"] not in done]
    left = sum(f.get("pages") or 0 for _, f in files)
    converted, started = 0, time.monotonic()
    for entry, file in files:
        if file["sha256"] in done:
            continue
        record = {"uuid": entry["uuid"], "role": entry["role"], "file": file["uuid"], "sha256": file["sha256"],
                  "listed_pages": file.get("pages")}
        begun = time.monotonic()
        for attempt in (1, 2):
            try:
                if file.get("mimetype") != "application/pdf":
                    raise ValueError("not a PDF")
                result = convert(pdf_for(entry, file), key)
                stats = result["metadata"].get("page_stats", [])
                record.update(ok=True, pages=len(result["json"]["children"]), cached=result["cached"],
                              marker_version=result["marker_version"],
                              ocr_pages=sum(1 for s in stats if s.get("text_extraction_method") != "pdftext"))
                record.pop("error", None)
                done.add(file["sha256"])
                break
            except (urllib.error.URLError, ConnectionError, http.client.HTTPException) as error:
                # The service went down, most likely Marker crashing on this file: wait for it, try once more
                record.update(ok=False, error=f"{type(error).__name__}: {error}"[:300])
                if attempt == 1:
                    print(f"  service unreachable on {file['uuid'][:8]}, waiting for it to come back", flush=True)
                    wait_for_service()
                else:
                    record["error"] = f"Marker stopped twice on this file. {record['error']}"[:300]
                    wait_for_service()
            except Exception as error:
                record.update(ok=False, error=f"{type(error).__name__}: {error}"[:300])
                break
        record["seconds"] = round(time.monotonic() - begun, 1)
        with open(LEDGER, "a") as ledger:
            ledger.write(json.dumps(record) + "\n")
        converted += file.get("pages") or 0
        per_page = (time.monotonic() - started) / max(converted, 1)
        print(f"{entry['role']:9} {file['uuid'][:8]} {record.get('pages', record.get('error'))} in "
              f"{record['seconds']} s | {converted}/{left} pages, ~{(left - converted) * per_page / 3600:.1f} h left",
              flush=True)


if __name__ == "__main__":
    main()
