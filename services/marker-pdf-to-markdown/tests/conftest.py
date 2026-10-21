import os
import sys
import tempfile
import threading
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

API_KEY = "test-key"


class FakeConverter:
    """Stands in for Marker's PdfConverter: each `|` in the PDF bytes starts a new page.

    Like Marker with paginate_output, it writes `{n}` and the separator before every page."""

    configs: list[dict] = []
    converted: list[bytes] = []
    gate: threading.Event | None = None

    def __init__(self, config, artifact_dict, processor_list, renderer, llm_service):
        self.config = config
        FakeConverter.configs.append(config)

    def __call__(self, path):
        content = Path(path).read_bytes()
        FakeConverter.converted.append(content)
        if FakeConverter.gate is not None:
            FakeConverter.gate.wait(5)
        if b"broken" in content:
            raise RuntimeError("Marker could not read the PDF")
        separator = self.config["page_separator"]
        pages = content.decode().split("|")
        markdown = "".join(f"\n\n{{{n}}}{separator}\n\n{page}" for n, page in enumerate(pages))
        return types.SimpleNamespace(markdown=markdown)


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

os.environ["MARKER_PDF_TO_MARKDOWN_API_KEY"] = API_KEY
os.environ["CACHE_DIR"] = tempfile.mkdtemp(prefix="marker-test-")

import main  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_service(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CACHE_DIR", tmp_path)
    FakeConverter.configs.clear()
    FakeConverter.converted.clear()
    FakeConverter.gate = None
    yield
    FakeConverter.gate = None


@pytest.fixture
def client():
    with TestClient(main.app, headers={"X-API-Key": API_KEY}) as client:
        yield client
