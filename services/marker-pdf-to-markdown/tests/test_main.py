import asyncio
import hashlib
import importlib.util
import threading
from pathlib import Path

import httpx
import pytest

import main
from conftest import API_KEY, FakeConverter

CONVERT = "/api/v1/marker-pdf-to-markdown"


def pdf(content: bytes, name: str = "report.pdf"):
    return {"file": (name, content, "application/pdf")}


def sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def test_refuses_to_start_without_an_api_key(monkeypatch):
    monkeypatch.delenv("MARKER_PDF_TO_MARKDOWN_API_KEY")
    spec = importlib.util.spec_from_file_location("main_without_key", Path(main.__file__))
    with pytest.raises(ValueError, match="MARKER_PDF_TO_MARKDOWN_API_KEY"):
        spec.loader.exec_module(importlib.util.module_from_spec(spec))


def test_rejects_a_conversion_with_a_wrong_api_key(client):
    response = client.post(CONVERT, files=pdf(b"page"), headers={"X-API-Key": "wrong"})
    assert response.status_code == 401
    assert FakeConverter.converted == []


def test_rejects_a_conversion_without_an_api_key(client):
    del client.headers["X-API-Key"]
    response = client.post(CONVERT, files=pdf(b"page"))
    assert response.status_code == 422
    assert FakeConverter.converted == []


def test_rejects_cache_routes_without_the_right_api_key(client):
    for method, path in [
        ("GET", "/api/v1/cache/abc"),
        ("GET", "/api/v1/cache/abc/pdf"),
        ("DELETE", "/api/v1/cache/abc"),
    ]:
        assert client.request(method, path, headers={"X-API-Key": "wrong"}).status_code == 401


def test_answers_health_checks_without_an_api_key(client):
    del client.headers["X-API-Key"]
    assert client.get("/").json()["status"] == "ok"
    assert client.get("/health").json()["status"] == "healthy"
    assert client.get("/up").json() == {"status": "ok"}


def test_configures_marker_to_separate_pages_with_the_separator_it_splits_on(client):
    assert FakeConverter.configs
    for config in FakeConverter.configs:
        assert config["output_format"] == "markdown"
        assert config["paginate_output"] is True
        assert config["page_separator"] == main.PAGE_SEPARATOR


def test_returns_markers_output_split_on_the_page_separator(client):
    response = client.post(CONVERT, files=pdf(b"One|Two"))
    assert response.status_code == 200
    assert response.json() == {
        "success": True,
        "pages": ["\n\n{0}", "\n\nOne\n\n{1}", "\n\nTwo"],
        "cached": False,
        "file_hash": None,
    }


def test_accepts_a_pdf_by_its_file_name_when_the_content_type_is_generic(client):
    files = {"file": ("report.PDF", b"page", "application/octet-stream")}
    assert client.post(CONVERT, files=files).status_code == 200


def test_rejects_a_file_that_is_not_a_pdf(client):
    files = {"file": ("notes.txt", b"hello", "text/plain")}
    response = client.post(CONVERT, files=files)
    assert response.status_code == 400
    assert FakeConverter.converted == []


def test_rejects_an_empty_file(client):
    response = client.post(CONVERT, files=pdf(b""))
    assert response.status_code == 400
    assert FakeConverter.converted == []


def test_reports_a_failed_conversion_as_a_server_error(client):
    response = client.post(CONVERT, files=pdf(b"broken"))
    assert response.status_code == 500
    assert "Marker could not read the PDF" in response.json()["detail"]


def test_serves_a_cached_result_without_converting_the_pdf_again(client):
    content = b"first|second"
    first = client.post(CONVERT, files=pdf(content), params={"cache": "true"}).json()
    again = client.post(CONVERT, files=pdf(content), params={"cache": "true"}).json()
    assert first["cached"] is False
    assert again == {
        "success": True,
        "pages": first["pages"],
        "cached": True,
        "file_hash": sha256(content),
    }
    assert FakeConverter.converted == [content]


def test_stores_nothing_when_the_cache_is_off(client):
    client.post(CONVERT, files=pdf(b"page"))
    client.post(CONVERT, files=pdf(b"broken"))
    assert list(main.CACHE_DIR.iterdir()) == []


def test_keeps_only_the_pdf_and_its_pages_when_the_cache_is_on(client):
    content = b"page"
    client.post(CONVERT, files=pdf(content), params={"cache": "true"})
    client.post(CONVERT, files=pdf(b"broken"), params={"cache": "true"})
    names = sorted(p.name for p in main.CACHE_DIR.iterdir())
    assert names == [f"{sha256(content)}.json", f"{sha256(content)}.pdf"]


def test_returns_cached_pages_and_the_cached_pdf_by_hash(client):
    content = b"one|two"
    converted = client.post(CONVERT, files=pdf(content), params={"cache": "true"}).json()
    pages = client.get(f"/api/v1/cache/{sha256(content)}")
    assert pages.json() == {"success": True, "pages": converted["pages"], "file_hash": sha256(content)}
    stored = client.get(f"/api/v1/cache/{sha256(content)}/pdf")
    assert stored.headers["content-type"] == "application/pdf"
    assert stored.content == content


def test_answers_not_found_for_a_hash_it_has_not_cached(client):
    assert client.get(f"/api/v1/cache/{sha256(b'unknown')}").status_code == 404
    assert client.get(f"/api/v1/cache/{sha256(b'unknown')}/pdf").status_code == 404
    assert client.delete(f"/api/v1/cache/{sha256(b'unknown')}").status_code == 404


def test_deleting_a_cache_entry_removes_both_the_pdf_and_its_pages(client):
    content = b"one|two"
    client.post(CONVERT, files=pdf(content), params={"cache": "true"})
    response = client.delete(f"/api/v1/cache/{sha256(content)}")
    assert response.status_code == 200
    assert list(main.CACHE_DIR.iterdir()) == []
    assert client.get(f"/api/v1/cache/{sha256(content)}").status_code == 404


async def _until(condition):
    for _ in range(500):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition never held")


def test_converts_a_priority_request_before_waiting_normal_requests(monkeypatch):
    monkeypatch.setattr(main, "MARKER_WORKERS", 1)
    FakeConverter.gate = threading.Event()

    async def scenario():
        transport = httpx.ASGITransport(app=main.app)
        async with main.lifespan(main.app), httpx.AsyncClient(
            transport=transport, base_url="http://service", headers={"X-API-Key": API_KEY}
        ) as client:

            def convert(content, **params):
                return asyncio.create_task(client.post(CONVERT, files=pdf(content), params=params))

            busy = convert(b"busy")
            await _until(lambda: FakeConverter.converted == [b"busy"])
            normal = convert(b"normal")
            await _until(lambda: main.normal_queue.qsize() == 1)
            urgent = convert(b"urgent", priority="true")
            await _until(lambda: main.priority_queue.qsize() == 1)
            FakeConverter.gate.set()
            responses = await asyncio.gather(busy, normal, urgent)
            assert [r.status_code for r in responses] == [200, 200, 200]

    asyncio.run(scenario())
    assert FakeConverter.converted == [b"busy", b"urgent", b"normal"]
