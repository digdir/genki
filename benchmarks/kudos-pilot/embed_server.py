"""A local embedding server for the Kudos pilot's model comparison: one sentence-transformers model on the Mac's GPU
(MPS) behind an OpenAI-compatible POST /v1/embeddings, so genki's openai-embeddings protocol can use it unchanged.

It embeds each text exactly as it arrives: genki adds any query or passage prompt itself (`prompts` in
embeddings.yaml), so the model's own default prompt is never applied here. Vectors are normalised for cosine.

    EMBED_MODEL=NbAiLab/borealis-embed-212m EMBED_PORT=8201 .data/embed-venv/bin/python embed_server.py

Settings: EMBED_MODEL (Hugging Face id), EMBED_REVISION (a commit; default the cached snapshot), EMBED_PORT,
EMBED_DTYPE (float32, float16 or bfloat16), EMBED_BATCH (texts per forward pass, default 16), EMBED_MAX_TOKENS
(default 8192), EMBED_DIMENSIONS (shorten a Matryoshka model's vectors), HF_HOME (default .data/hf).
Standard library plus the packages in .data/embed-venv (torch, sentence-transformers, fastapi, uvicorn).
"""
import os
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
os.environ.setdefault("HF_HOME", str(HERE / ".data" / "hf"))
os.environ.setdefault("HF_HUB_OFFLINE", "1")

import torch  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from pydantic import BaseModel  # noqa: E402
from sentence_transformers import SentenceTransformer  # noqa: E402

MODEL = os.environ["EMBED_MODEL"]
DTYPE = {"float32": torch.float32, "float16": torch.float16, "bfloat16": torch.bfloat16}[
    os.environ.get("EMBED_DTYPE", "float32")
]
BATCH = int(os.environ.get("EMBED_BATCH", "16"))
DIMENSIONS = int(os.environ["EMBED_DIMENSIONS"]) if os.environ.get("EMBED_DIMENSIONS") else None
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"

model = SentenceTransformer(
    MODEL,
    revision=os.environ.get("EMBED_REVISION"),
    device=DEVICE,
    trust_remote_code=False,
    model_kwargs={"torch_dtype": DTYPE},
    truncate_dim=DIMENSIONS,
)
model.max_seq_length = min(int(os.environ.get("EMBED_MAX_TOKENS", "8192")), model.max_seq_length or 8192)
tokenizer = model.tokenizer
lock = threading.Lock()  # one forward pass at a time; MPS does not share well
stats = {"requests": 0, "texts": 0, "tokens": 0, "seconds": 0.0}

app = FastAPI()


class EmbeddingRequest(BaseModel):
    input: str | list[str]
    model: str | None = None
    encoding_format: str | None = "float"
    dimensions: int | None = None


@app.get("/health")
def health():
    return {
        "model": MODEL,
        "device": DEVICE,
        "dtype": str(DTYPE),
        "dimensions": model.get_embedding_dimension(),
        "max_seq_length": model.max_seq_length,
        **stats,
    }


@app.post("/v1/embeddings")
def embeddings(request: EmbeddingRequest):
    texts = [request.input] if isinstance(request.input, str) else request.input
    if not texts:
        raise HTTPException(400, "input is empty")
    if request.encoding_format not in (None, "float"):
        raise HTTPException(400, "only float encoding is supported")
    tokens = sum(len(ids) for ids in tokenizer(texts, truncation=True, max_length=model.max_seq_length)["input_ids"])
    with lock:
        started = time.perf_counter()
        vectors = model.encode(
            texts, prompt="", batch_size=BATCH, normalize_embeddings=True, convert_to_numpy=True
        )
        seconds = time.perf_counter() - started
        if DEVICE == "mps":
            torch.mps.empty_cache()  # hand cached GPU memory back between requests
    if request.dimensions and request.dimensions != vectors.shape[1]:
        raise HTTPException(400, f"this server returns {vectors.shape[1]} dimensions")
    stats["requests"] += 1
    stats["texts"] += len(texts)
    stats["tokens"] += tokens
    stats["seconds"] += seconds
    return {
        "object": "list",
        "model": MODEL,
        "data": [{"object": "embedding", "index": i, "embedding": v.tolist()} for i, v in enumerate(vectors)],
        "usage": {"prompt_tokens": tokens, "total_tokens": tokens},
    }


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("EMBED_PORT", "8201")), log_level="warning")
