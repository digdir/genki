import os
import sys
import tempfile
import threading
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

API_KEY = "test-key"
MARKER_VERSION = "1.10.2-test"
POLYGON = [[0.0, 0.0], [612.0, 0.0], [612.0, 792.0], [0.0, 792.0]]
BBOX = [0.0, 0.0, 612.0, 792.0]


class FakeDocument:
    def __init__(self, pages: list[str]):
        self.pages = pages


def fake_metadata(document: FakeDocument) -> dict:
    return {
        "table_of_contents": [
            {"title": page, "heading_level": 1, "page_id": n, "polygon": POLYGON}
            for n, page in enumerate(document.pages)
        ],
        "page_stats": [
            {"page_id": n, "text_extraction_method": "pdftext", "block_counts": [["Text", 1]]}
            for n in range(len(document.pages))
        ],
    }


class FakeMarkdownRenderer:
    """Like Marker's MarkdownRenderer with paginate_output: `{n}` and the separator before every page."""

    def __init__(self, config):
        self.config = config

    def __call__(self, document: FakeDocument):
        separator = self.config["page_separator"]
        markdown = "".join(
            f"\n\n{{{n}}}{separator}\n\n{page}" for n, page in enumerate(document.pages)
        )
        return types.SimpleNamespace(markdown=markdown, images={}, metadata=fake_metadata(document))


class FakeJSONOutput:
    def __init__(self, document: FakeDocument):
        self.document = document

    def model_dump(self, mode="python"):
        return {
            "children": [self._page(n, text) for n, text in enumerate(self.document.pages)],
            "block_type": "Document",
            "metadata": fake_metadata(self.document),
        }

    @staticmethod
    def _page(n: int, text: str) -> dict:
        kind = "Picture" if "picture" in text else "Text"
        block = {
            "id": f"/page/{n}/{kind}/1",
            "block_type": kind,
            "html": f"<p>{text}</p>",
            "polygon": POLYGON,
            "bbox": BBOX,
            "children": None,
            "section_hierarchy": {},
            "images": {f"/page/{n}/{kind}/1": "aW1hZ2U="} if kind == "Picture" else {},
        }
        return {
            "id": f"/page/{n}/Page/0",
            "block_type": "Page",
            "html": f"<content-ref src='/page/{n}/{kind}/1'></content-ref>",
            "polygon": POLYGON,
            "bbox": BBOX,
            "children": [block],
            "section_hierarchy": None,
            "images": None,
        }


class FakeJSONRenderer:
    def __init__(self, config):
        self.config = config

    def __call__(self, document: FakeDocument):
        return FakeJSONOutput(document)


class FakeConverter:
    """Stands in for Marker's PdfConverter: each `|` in the PDF bytes starts a new page."""

    configs: list[dict] = []
    converted: list[bytes] = []
    gate: threading.Event | None = None

    def __init__(self, config, artifact_dict, processor_list, renderer, llm_service):
        self.config = config
        FakeConverter.configs.append(config)

    def build_document(self, path):
        content = Path(path).read_bytes()
        FakeConverter.converted.append(content)
        if FakeConverter.gate is not None:
            FakeConverter.gate.wait(5)
        if b"broken" in content:
            raise RuntimeError("Marker could not read the PDF")
        return FakeDocument(content.decode().split("|"))

    def resolve_dependencies(self, cls):
        return cls(self.config)

    def __call__(self, path):
        return FakeMarkdownRenderer(self.config)(self.build_document(path))


class FakeConfigParser:
    def __init__(self, config_dict):
        self.config_dict = config_dict

    def generate_config_dict(self):
        return dict(self.config_dict)

    def get_processors(self):
        return []

    def get_renderer(self):
        return None

    def get_llm_service(self):
        return None


def _module(name, **attributes):
    module = types.ModuleType(name)
    module.__dict__.update(attributes)
    sys.modules[name] = module


_module("marker")
_module("marker.converters")
_module("marker.converters.pdf", PdfConverter=FakeConverter)
_module("marker.models", create_model_dict=lambda: {})
_module("marker.config")
_module("marker.config.parser", ConfigParser=FakeConfigParser)
_module("marker.renderers")
_module("marker.renderers.json", JSONRenderer=FakeJSONRenderer)
_module("marker.renderers.markdown", MarkdownRenderer=FakeMarkdownRenderer)

os.environ["MARKER_PDF_TO_MARKDOWN_API_KEY"] = API_KEY
os.environ["CACHE_DIR"] = tempfile.mkdtemp(prefix="marker-test-")

import main  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_service(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(main, "marker_version", lambda: MARKER_VERSION)
    FakeConverter.configs.clear()
    FakeConverter.converted.clear()
    FakeConverter.gate = None
    yield
    FakeConverter.gate = None


@pytest.fixture
def client():
    with TestClient(main.app, headers={"X-API-Key": API_KEY}) as client:
        yield client
