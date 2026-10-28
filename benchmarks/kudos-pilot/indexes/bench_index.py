"""Index and scale benchmark for the Kudos pilot (genki issue 92): pgvector 0.8.2 (Azure's version) in its own
container, halfvec(1536) vectors of text-embedding-3-large, at growing sizes.

Data: Qdrant's DBpedia 1M set embedded with text-embedding-3-large at 1,536 dimensions (.data/dbpedia), with the
pilot's 20,248 Kudos page vectors mixed in, so in-domain Kudos questions (.data/queries-baseline.npy) can be asked
of a haystack that is mostly foreign. Queries: 500 held-out DBpedia vectors and the 676 Kudos question vectors.
The true nearest neighbours come from numpy over the same half-precision values Postgres stores.

Per size: HNSW (m 16, ef_construction 64, pgvector's defaults; ef_search swept, iterative scans on as genki runs
them), IVFFlat (lists = rows/1000, probes swept) and, from 500k, binary quantisation with re-ranking. At the
largest size also: HNSW built the way Azure allows (maintenance_work_mem 2 GB, 2 workers), m 32 / ef_construction
128, filtered search (10% and 1% of rows) and a nightly-sync style write (1% inserted, 1% deleted, VACUUM).

    ../.data/embed-venv/bin/python bench_index.py [size ...]    # 100000 250000 500000 1000000 by default

Starts the container genki-kudos-pilot-bench on 127.0.0.1:55444 if it is not running. Appends one JSON line per
measurement to results/measurements.jsonl; report.py builds the report from it.
"""
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
import psycopg
import pyarrow.parquet as pq
from pgvector import HalfVector
from pgvector.psycopg import register_vector

from common_indexes import DATA, MEASUREMENTS

CONTAINER = "genki-kudos-pilot-bench"
PORT = 55444
URL = f"postgresql://genai:genai-local-only@127.0.0.1:{PORT}/bench"
OUT = MEASUREMENTS
DIMS = 1536
HELD_OUT = 500
SIZES = [100_000, 250_000, 500_000, 1_000_000]
# From this size: binary quantisation and the Azure-like build. BENCH_BIG=0 runs every step at any size (a smoke run)
BIG = int(os.environ.get("BENCH_BIG", "500000"))


def start_container():
    running = subprocess.run(["docker", "ps", "-q", "-f", f"name={CONTAINER}"], capture_output=True, text=True).stdout
    if running.strip():
        return
    subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True)
    subprocess.run([
        "docker", "run", "-d", "--name", CONTAINER, "-p", f"127.0.0.1:{PORT}:5432", "--shm-size=10g",
        "-e", "POSTGRES_USER=genai", "-e", "POSTGRES_PASSWORD=genai-local-only", "-e", "POSTGRES_DB=bench",
        "pgvector/pgvector:0.8.2-pg17",
        "-c", "shared_buffers=6GB", "-c", "effective_cache_size=16GB", "-c", "work_mem=4MB",
        "-c", "max_worker_processes=16", "-c", "max_parallel_workers=8", "-c", "max_parallel_maintenance_workers=4",
        "-c", "max_parallel_workers_per_gather=4", "-c", "synchronous_commit=off", "-c", "jit=off",
        "-c", "max_wal_size=8GB", "-c", "checkpoint_timeout=30min",
    ], check=True, capture_output=True)
    for _ in range(60):
        if subprocess.run(["docker", "exec", CONTAINER, "pg_isready", "-U", "genai", "-q"]).returncode == 0:
            break
        time.sleep(1)
    time.sleep(2)


def connect():
    connection = psycopg.connect(URL, autocommit=True)
    connection.execute("create extension if not exists vector")
    register_vector(connection)
    return connection


def record(**fields):
    line = json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **fields})
    with OUT.open("a") as f:
        f.write(line + "\n")
    print(line, flush=True)


def dbpedia(count):
    files = sorted((DATA / "dbpedia" / "data").glob("*.parquet"))
    parts, have = [], 0
    for path in files:
        table = pq.read_table(path, columns=["text-embedding-3-large-1536-embedding"])
        column = table.column(0).combine_chunks()
        parts.append(column.values.to_numpy(zero_copy_only=False).reshape(-1, DIMS).astype(np.float16))
        have += parts[-1].shape[0]
        if have >= count:
            break
    return np.concatenate(parts)[:count]


def pilot():
    with psycopg.connect("postgresql://genai:genai-local-only@127.0.0.1:55443/knowledge") as c:
        register_vector(c)
        rows = c.execute(
            "select x.vec from kn_chunks x join kn_active a on a.dataset = x.dataset and a.generation = x.generation "
            "where x.dataset = 'digdir/kudos-next' order by x.id").fetchall()
    return np.stack([r[0].to_numpy() for r in rows]).astype(np.float16)


def truth(base, queries, k=100, mask=None):
    """Exact top-k by cosine (the vectors are unit length, so by dot product) over the half-precision values."""
    q = queries.astype(np.float32)
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    best_scores = np.full((len(q), 0), -np.inf, dtype=np.float32)
    best_ids = np.zeros((len(q), 0), dtype=np.int64)
    for start in range(0, len(base), 100_000):
        chunk = base[start:start + 100_000].astype(np.float32)
        chunk /= np.linalg.norm(chunk, axis=1, keepdims=True)
        scores = q @ chunk.T
        if mask is not None:
            scores[:, ~mask[start:start + 100_000]] = -np.inf
        ids = np.arange(start, start + len(chunk))
        scores = np.concatenate([best_scores, scores], axis=1)
        ids = np.concatenate([best_ids, np.broadcast_to(ids, (len(q), len(chunk)))], axis=1)
        top = np.argpartition(-scores, k, axis=1)[:, :k]
        best_scores = np.take_along_axis(scores, top, axis=1)
        best_ids = np.take_along_axis(ids, top, axis=1)
    order = np.argsort(-best_scores, axis=1)
    return np.take_along_axis(best_ids, order, axis=1)


def load(connection, vectors, years, categories):
    connection.execute("drop table if exists items")
    connection.execute(f"create table items (id int primary key, vec halfvec({DIMS}) not null, year int, category int)")
    started = time.perf_counter()
    with connection.cursor() as cur:
        with cur.copy("copy items (id, vec, year, category) from stdin with (format binary)") as copy:
            copy.set_types(["int4", "halfvec", "int4", "int4"])
            for i, v in enumerate(vectors):
                copy.write_row((i, HalfVector(v), int(years[i]), int(categories[i])))
    connection.execute("vacuum analyze items")
    return time.perf_counter() - started


def sizes(connection):
    row = connection.execute(
        "select pg_relation_size('items'), pg_total_relation_size('items') - pg_indexes_size('items'), "
        "pg_indexes_size('items')").fetchone()
    return {"heap_bytes": row[0], "table_with_toast_bytes": row[1], "indexes_bytes": row[2]}


def build(connection, sql, memory="8GB", workers=4):
    notices = []

    def keep(notice):
        notices.append(notice.message_primary)

    connection.add_notice_handler(keep)
    connection.execute(f"set maintenance_work_mem = '{memory}'")
    connection.execute(f"set max_parallel_maintenance_workers = {workers}")
    started = time.perf_counter()
    connection.execute(sql)
    seconds = time.perf_counter() - started
    connection.remove_notice_handler(keep)
    name = sql.split()[2]
    size = connection.execute(f"select pg_relation_size('{name}')").fetchone()[0]
    return seconds, size, [n for n in notices if "maintenance_work_mem" in n]


def drop_indexes(connection):
    for (name,) in connection.execute(
            "select indexname from pg_indexes where tablename = 'items' and indexname <> 'items_pkey'").fetchall():
        connection.execute(f"drop index {name}")


def run_queries(connection, sql, queries, settings):
    for s in settings:
        connection.execute(s)
    results, seconds = [], []
    for q in queries:
        vector = HalfVector(q)
        t0 = time.perf_counter()
        rows = connection.execute(sql, {"q": vector}).fetchall()
        seconds.append(time.perf_counter() - t0)
        results.append([r[0] for r in rows])
    return results, np.array(seconds) * 1000


def recall(results, expected, k=10):
    return float(np.mean([len(set(r[:k]) & set(e[:k])) / k for r, e in zip(results, expected)]))


def qps(sql, queries, settings, clients=8, seconds=20):
    done = [0] * clients
    stop = time.perf_counter() + seconds

    def worker(i):
        c = connect()
        for s in settings:
            c.execute(s)
        n = 0
        while time.perf_counter() < stop:
            c.execute(sql, {"q": HalfVector(queries[n % len(queries)])}).fetchall()
            n += 1
        done[i] = n
        c.close()

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(clients)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return sum(done) / seconds


def measure(connection, size, index, sql, queries, truths, settings_list, extra=None):
    for settings in settings_list:
        for label, (rows, expected) in {"dbpedia": (queries["dbpedia"], truths["dbpedia"]),
                                        "kudos": (queries["kudos"], truths["kudos"])}.items():
            results, ms = run_queries(connection, sql, rows, settings)
            record(size=size, index=index, settings=settings, queries=label, n=len(rows),
                   recall_at_10=round(recall(results, expected), 4),
                   returned_mean=round(float(np.mean([len(r) for r in results])), 1),
                   p50_ms=round(float(np.percentile(ms, 50)), 2), p95_ms=round(float(np.percentile(ms, 95)), 2),
                   **(extra or {}))


def bench(size, base_all, kudos, kudos_queries, dbpedia_queries, full):
    connection = connect()
    rng = np.random.default_rng(size)
    filler = base_all[:size - len(kudos)]
    vectors = np.concatenate([filler, kudos])
    years = rng.integers(2015, 2025, size=len(vectors))
    categories = rng.integers(0, 100, size=len(vectors))
    load_seconds = load(connection, vectors, years, categories)
    record(size=size, step="load", seconds=round(load_seconds, 1), **sizes(connection))
    truths = {"dbpedia": truth(vectors, dbpedia_queries), "kudos": truth(vectors, kudos_queries)}
    queries = {"dbpedia": dbpedia_queries, "kudos": kudos_queries}
    knn = "select id from items order by vec <=> %(q)s limit 10"
    iterative = "set hnsw.iterative_scan = relaxed_order"

    # Exact search, the cost of having no index
    _, ms = run_queries(connection, knn, dbpedia_queries[:50], ["set enable_indexscan = off"])
    record(size=size, index="none (exact)", queries="dbpedia", n=50, recall_at_10=1.0,
           p50_ms=round(float(np.percentile(ms, 50)), 2), p95_ms=round(float(np.percentile(ms, 95)), 2))
    connection.execute("set enable_indexscan = on")

    # HNSW with pgvector's defaults, built with room to spare
    seconds, index_bytes, notices = build(
        connection, "create index items_hnsw on items using hnsw (vec halfvec_cosine_ops)")
    record(size=size, step="build", index="hnsw m16 efc64", memory="8GB", workers=4, seconds=round(seconds, 1),
           index_bytes=index_bytes, notices=notices)
    sweep = [[iterative, f"set hnsw.ef_search = {ef}"] for ef in (40, 100, 200, 400)]
    measure(connection, size, "hnsw m16 efc64", knn, queries, truths, sweep)
    record(size=size, index="hnsw m16 efc64", settings=sweep[1], clients=8,
           qps=round(qps(knn, dbpedia_queries, sweep[1]), 1))

    if full:
        # Filters: 10% (one year) and 1% (one category) of rows, with iterative scans as genki uses them
        for label, where, mask in (("10%", "year = 2023", years == 2023), ("1%", "category = 7", categories == 7)):
            filtered = f"select id from items where {where} order by vec <=> %(q)s limit 10"
            t = {"dbpedia": truth(vectors, dbpedia_queries, mask=mask), "kudos": truth(vectors, kudos_queries, mask=mask)}
            measure(connection, size, f"hnsw m16 efc64, filter {label}", filtered, queries, t,
                    [[iterative, "set hnsw.ef_search = 100"]])
            measure(connection, size, f"hnsw m16 efc64, filter {label}, no iterative scan", filtered, queries, t,
                    [["set hnsw.iterative_scan = off", "set hnsw.ef_search = 100"]])

    drop_indexes(connection)

    # IVFFlat, lists = rows / 1000
    lists = max(10, size // 1000)
    seconds, index_bytes, _ = build(
        connection, f"create index items_ivf on items using ivfflat (vec halfvec_cosine_ops) with (lists = {lists})")
    record(size=size, step="build", index=f"ivfflat lists {lists}", memory="8GB", workers=4, seconds=round(seconds, 1),
           index_bytes=index_bytes)
    probes = sorted({1, 10, max(1, int(lists ** 0.5)), 100})
    measure(connection, size, f"ivfflat lists {lists}", knn, queries, truths,
            [[f"set ivfflat.probes = {p}"] for p in probes])
    drop_indexes(connection)

    if size >= BIG:
        # Binary quantisation: a bit index, then the 200 closest by Hamming distance re-ranked by cosine
        seconds, index_bytes, _ = build(
            connection, f"create index items_bit on items using hnsw ((binary_quantize(vec)::bit({DIMS})) bit_hamming_ops)")
        record(size=size, step="build", index="hnsw bit + rerank", memory="8GB", workers=4, seconds=round(seconds, 1),
               index_bytes=index_bytes)
        rerank = (f"select id from (select id, vec from items order by binary_quantize(vec)::bit({DIMS}) <~> "
                  f"binary_quantize(%(q)s)::bit({DIMS}) limit 200) s order by vec <=> %(q)s limit 10")
        measure(connection, size, "hnsw bit + rerank 200", rerank, queries, truths,
                [[iterative, "set hnsw.ef_search = 200"]])
        drop_indexes(connection)

    if full:
        seconds, index_bytes, notices = build(
            connection, "create index items_hnsw32 on items using hnsw (vec halfvec_cosine_ops) "
                        "with (m = 32, ef_construction = 128)")
        record(size=size, step="build", index="hnsw m32 efc128", memory="8GB", workers=4, seconds=round(seconds, 1),
               index_bytes=index_bytes, notices=notices)
        measure(connection, size, "hnsw m32 efc128", knn, queries, truths,
                [[iterative, f"set hnsw.ef_search = {ef}"] for ef in (40, 100)])
        drop_indexes(connection)

    if size >= BIG:
        # HNSW the way Azure Flexible Server allows it: maintenance_work_mem 2 GB, 2 parallel workers
        seconds, index_bytes, notices = build(
            connection, "create index items_hnsw_azure on items using hnsw (vec halfvec_cosine_ops)",
            memory="2GB", workers=2)
        record(size=size, step="build", index="hnsw m16 efc64", memory="2GB", workers=2, seconds=round(seconds, 1),
               index_bytes=index_bytes, notices=notices)

    if full:
        # Last, since it changes the rows: a nightly-sync style write on that HNSW index, then VACUUM
        count = size // 100
        fresh = (vectors[rng.integers(0, len(filler), size=count)].astype(np.float32)
                 + rng.normal(0, 0.01, size=(count, DIMS)).astype(np.float32))
        fresh /= np.linalg.norm(fresh, axis=1, keepdims=True)
        started = time.perf_counter()
        with connection.cursor() as cur:
            with cur.copy("copy items (id, vec, year, category) from stdin with (format binary)") as copy:
                copy.set_types(["int4", "halfvec", "int4", "int4"])
                for i, v in enumerate(fresh.astype(np.float16)):
                    copy.write_row((10_000_000 + i, HalfVector(v), 2025, 0))
        insert_seconds = time.perf_counter() - started
        gone = rng.choice(len(filler), size=count, replace=False)
        started = time.perf_counter()
        connection.execute("delete from items where id = any(%s)", (gone.tolist(),))
        delete_seconds = time.perf_counter() - started
        started = time.perf_counter()
        connection.execute("vacuum items")
        vacuum_seconds = time.perf_counter() - started
        record(size=size, step="write", index="hnsw m16 efc64", inserted=count, deleted=count,
               insert_seconds=round(insert_seconds, 1), insert_rows_per_second=round(count / insert_seconds, 1),
               delete_seconds=round(delete_seconds, 1), vacuum_seconds=round(vacuum_seconds, 1))
        results, _ = run_queries(connection, knn, dbpedia_queries, [iterative, "set hnsw.ef_search = 100"])
        alive = set(range(size)) - set(gone.tolist())
        still = [[i for i in e if i in alive] for e in truths["dbpedia"]]
        record(size=size, index="hnsw m16 efc64 after write", queries="dbpedia", n=len(results),
               recall_at_10=round(recall([[i for i in r if i < 10_000_000] for r in results], still), 4))
    drop_indexes(connection)
    connection.close()


def main():
    chosen = [int(s) for s in sys.argv[1:]] or SIZES
    start_container()
    kudos = pilot()
    kudos_queries = np.load(DATA / "queries-baseline.npy").astype(np.float16)
    base_all = dbpedia(max(chosen) - len(kudos) + HELD_OUT)
    dbpedia_queries, base_all = base_all[-HELD_OUT:], base_all[:-HELD_OUT]
    record(step="data", kudos=len(kudos), dbpedia=len(base_all), dbpedia_queries=HELD_OUT,
           kudos_queries=len(kudos_queries))
    for size in chosen:
        bench(size, base_all, kudos, kudos_queries, dbpedia_queries, full=size == max(chosen))


if __name__ == "__main__":
    main()
