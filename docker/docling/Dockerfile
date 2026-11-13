# The Docling server for PDF conversions (ADR 0042, issue 476), built to match the parser benchmark's winner
# (benchmarks/ingestion/blocks, run 2, docling-tess): Python 3.13 on Debian trixie, Tesseract 5.5.0 with Debian's
# Norwegian data, Docling 2.146.0, docling-core 2.105.0, docling-ibm-models 4.0.4, CPU torch 2.15.0. docling-serve
# 1.38.2 serves it. The version is part of each conversion's key, so an upgrade here converts files again only when
# they have no kept conversion. The settings it runs with are set in infra/modules/containerapps.bicep.
FROM python:3.13-slim-trixie@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90

# Debian's mirrors keep only a package's newest build, so the packages are not pinned by version (a rebuild such as
# +b2 would fail every deploy); the build stops instead if Tesseract is no longer 5.5.0 or the Norwegian data is not
# the file the benchmark ran (tesseract-ocr-nor 1:4.1.0-2; not the same file as tessdata 4.1.0 on GitHub).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 tesseract-ocr tesseract-ocr-nor \
    && rm -rf /var/lib/apt/lists/* \
    && tesseract --version 2>&1 | head -1 | grep -qx 'tesseract 5.5.0' \
    && echo "0451eb4f8049ae78196806bf878a389a2f40f1386fe038568cf4441226ba6ef2  /usr/share/tesseract-ocr/5/tessdata/nor.traineddata" | sha256sum -c -

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=4 \
    DOCLING_SERVE_ARTIFACTS_PATH=/opt/docling/models

# CPU torch from PyTorch's own index first, then every other package at the version in requirements.txt, so each
# build installs the same code. requirements.txt is what PyPI offered when the benchmark run started (see its header).
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.15.0+cpu torchvision==0.29.2+cpu
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-deps -r /tmp/requirements.txt && pip check \
    && python -c "import torch, sys; sys.exit(0 if torch.__version__ == '2.15.0+cpu' else 'torch replaced: ' + torch.__version__)"

# Only the models the conversion uses: Heron layout and TableFormer. Baked in, so a replica fetches nothing.
RUN docling-tools models download -o "$DOCLING_SERVE_ARTIFACTS_PATH" layout tableformer

RUN useradd --uid 1001 --create-home --home-dir /home/docling docling
USER 1001
WORKDIR /home/docling
# Tesseract with Norwegian is the only OCR here, so it is the only OCR a request gets: `auto`, the preset a request
# without one asks for and the server warms up at start, means Tesseract `nor` too, not RapidOCR, which is not here.
ENV HF_HUB_OFFLINE=1 \
    DOCLING_SERVE_DEFAULT_OCR_PRESET=tesseract \
    DOCLING_SERVE_ALLOWED_OCR_PRESETS='["tesseract"]' \
    DOCLING_SERVE_CUSTOM_OCR_PRESETS='{"auto": {"kind": "tesseract", "lang": ["nor"]}}'
EXPOSE 5001
CMD ["docling-serve", "run", "--host", "0.0.0.0", "--port", "5001"]
