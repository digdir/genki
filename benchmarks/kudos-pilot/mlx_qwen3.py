"""Qwen3-architecture embedding models (Qwen3-Embedding, F2LLM-v2, harrier-oss-v1) on Apple's MLX: the same weights
and tokenizer as sentence-transformers, last-token pooling and normalisation, for the Kudos pilot's batch embedding
(pre_embed.py). Weights load in float16, as the PyTorch server runs them. One text per forward pass, so there is
no padding to get wrong. MLX keeps freed buffers for reuse, and every new text length needs new ones, so its cache
is capped and cleared after each batch.

    .data/embed-venv/bin/python mlx_qwen3.py <snapshot dir> [check]   # check: compare with sentence-transformers
"""
import json
import sys
import time
from pathlib import Path

import mlx.core as mx
import numpy as np
from mlx_lm.models import qwen3
from transformers import AutoTokenizer


mx.set_cache_limit(2 * 1024**3)


class Qwen3Embedder:
    def __init__(self, snapshot, max_tokens=8192):
        snapshot = Path(snapshot)
        config = json.loads((snapshot / "config.json").read_text())
        self.model = qwen3.Model(qwen3.ModelArgs.from_dict(config))
        weights = {}
        for path in sorted(snapshot.glob("*.safetensors")):
            weights.update(mx.load(str(path)))
        weights = {(k if k.startswith("model.") else f"model.{k}"): v.astype(mx.float16) for k, v in weights.items()}
        self.model.load_weights(list(weights.items()), strict=False)
        self.model.set_dtype(mx.float16)
        mx.eval(self.model.parameters())
        self.tokenizer = AutoTokenizer.from_pretrained(str(snapshot))
        self.max_tokens = max_tokens

    def tokens(self, text):
        return self.tokenizer(text, truncation=True, max_length=self.max_tokens)["input_ids"]

    def embed(self, texts):
        out = []
        for text in texts:
            ids = mx.array([self.tokens(text)])
            hidden = self.model.model(ids)
            vector = hidden[0, -1].astype(mx.float32)
            vector = vector / mx.linalg.norm(vector)
            mx.eval(vector)  # one text at a time, so only one forward pass is in memory
            out.append(vector)
        stacked = mx.stack(out)
        mx.eval(stacked)
        vectors = np.array(stacked)
        mx.clear_cache()
        return vectors


def check(snapshot):
    import psycopg
    from sentence_transformers import SentenceTransformer

    with psycopg.connect("postgresql://genai:genai-local-only@127.0.0.1:55443/knowledge") as c:
        texts = [r[0] for r in c.execute(
            "select x.text from kn_chunks x join kn_active a on a.dataset = x.dataset and a.generation = x.generation "
            "where x.dataset = 'digdir/kudos-next' order by md5(x.id) limit 24").fetchall()]
    texts += ["Hvorfor var forbruket av tildelingen lavt i 2024?", "Kva gjer Statped?"]
    mlx_model = Qwen3Embedder(snapshot)
    t0 = time.perf_counter()
    a = mlx_model.embed(texts)
    mlx_seconds = time.perf_counter() - t0
    tokens = sum(len(mlx_model.tokens(t)) for t in texts)
    del mlx_model
    st = SentenceTransformer(str(snapshot), device="mps", model_kwargs={"torch_dtype": "float16"})
    st_ids = st.tokenize([texts[0]])["input_ids"][0].tolist()
    t0 = time.perf_counter()
    b = st.encode(texts, prompt="", batch_size=8, normalize_embeddings=True, convert_to_numpy=True)
    st_seconds = time.perf_counter() - t0
    cos = (a * b).sum(axis=1)
    same_ids = st_ids == AutoTokenizer.from_pretrained(str(snapshot))(texts[0], truncation=True, max_length=8192)["input_ids"]
    print(json.dumps({"texts": len(texts), "tokens": tokens, "same_token_ids": same_ids,
                      "cosine_min": round(float(cos.min()), 6), "cosine_mean": round(float(cos.mean()), 6),
                      "mlx_tok_per_s": round(tokens / mlx_seconds), "torch_mps_tok_per_s": round(tokens / st_seconds)}))


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[2] == "check":
        check(sys.argv[1])
