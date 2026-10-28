# Indexes: which pgvector index for Kudos, and how it scales

Which vector index should Kudos on pgvector use, and what does it take at tens of millions of vectors? This benchmark measures pgvector 0.8.2 (the version Azure ships) at 100,000 to 1 million halfvec(1536) vectors against exact search. The choice it informs: the index and the server size in the plan to retire Typesense for Kudos ([issue 92](https://github.com/digdir/genki/issues/92)).

## Results

Measured 23 October 2026; the tables are in [results/report.md](results/report.md).

HNSW is the index to use: at ef_search 100 it finds 99% of the true nearest Kudos pages at a million vectors in a few milliseconds. IVFFlat needs several times the work for the same accuracy, and binary quantisation with re-ranking matches HNSW with an index an eighth of the size. Filtered searches need iterative scans, which genki turns on; Azure's 2 GB cap on build memory slows builds past about half a million vectors.

## Sides

Exact search (no index); HNSW at m 16 with ef_search 40, 100, 200 and 400, and at m 32; IVFFlat with 1,000 lists at probes 10, 31 and 100; binary quantisation with the best 200 re-scored. At the largest size also: HNSW built within Azure's limits (2 GB, 2 workers), filtered search keeping 10% and 1% of rows, and a nightly-sync style write (1% inserted, 1% deleted, VACUUM).

## Reference

Exact search: the true ten nearest neighbours of each query, computed by `bench_index.py` in numpy over the same half-precision values Postgres stores. Recall@10 is the share of those an index returns. Queries: the 676 Kudos questions (text-embedding-3-large vectors) and 500 held-out DBpedia vectors.

## Method

- **Data.** Qdrant's public DBpedia set embedded with text-embedding-3-large at 1,536 dimensions, with the pilot's 20,248 Kudos page vectors mixed in, so Kudos questions search a haystack that is mostly foreign.
- **Measurements, not verdicts.** Each line of `results/measurements.jsonl` is a mean over all queries for one size and setting (recall, latency, build time, sizes). There are no per-query rows, so no intervals and no tiers: this benchmark predates the layout and keeps its shape.
- **Projections.** `report.py` projects sizes linearly and HNSW build time as N log N from the measured points, on this Mac; projected numbers are marked as such.

## Commands

```sh
cd benchmarks/kudos-pilot/indexes
../.data/embed-venv/bin/python bench_index.py   # about an hour; appends to results/measurements.jsonl
../.data/embed-venv/bin/python report.py        # results/report.md and summary.csv, from results/ alone
BENCH_BIG=0 ../.data/embed-venv/bin/python bench_index.py 30000   # a smoke run through every step
```

`bench_index.py` starts the container `genki-kudos-pilot-bench` on 127.0.0.1:55444 if it is not running, and needs the DBpedia set in `../.data/dbpedia` and the pilot's question vectors (`../.data/queries-baseline.npy`, from `../score_vectors.py baseline`).

## Files

| File                         | Holds                                                         |
| ---------------------------- | ------------------------------------------------------------- |
| `results/measurements.jsonl` | One line per measurement: size, index, setting, recall, times |
| `results/report.md`          | The tables, measured and projected                            |
| `results/summary.csv`        | The report's main table as rows                               |

## Limits

- Measured on a laptop in Docker, up to a million vectors, on a public English set with Kudos pages mixed in. Larger sizes and Azure prices are estimates.
- Recall is against exact search over the same vectors: it says what an index loses, not whether the right page is found.
