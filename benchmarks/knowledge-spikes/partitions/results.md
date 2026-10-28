# A new generation beside the active one

Run on 2026-10-27 in a `pgvector/pgvector:0.8.2-pg17` container limited to 4 CPUs and 16 GB, with `shared_buffers` 4 GB, `maintenance_work_mem` 2 GB and `max_parallel_maintenance_workers` 2. `setup.sql` loads one million 1,536-dimension `halfvec` vectors (DBpedia, text-embedding-3-large) with a synthetic 30-word text each into partition `kn_g1` of the list-partitioned table `kn`: 8.5 GB in all, of which the HNSW index is 3.9 GB and the GIN index 131 MB. Its HNSW build took 974 s with two workers.

`load.mjs` runs 8 clients that search `g1` as fast as they can, each search being one HNSW query (`ef_search` 100, top 10) followed by one full-text query. The clients never wait, so the 4 CPUs are busy before anything else starts: this is the worst case for CPU, not a realistic search rate. `analyse.py` counts a search in a phase when it overlaps it.

## Part 1: copy and build while searches run (`phases.sh`)

The new generation `kn_g2` is a copy of the same million rows, built as a standalone table with `max_parallel_maintenance_workers` 1. The HNSW graph outgrew `maintenance_work_mem` after 570,906 vectors, 20 minutes into the build (the time of PostgreSQL's notice). The build was stopped after 78 minutes at 594,024 of 1,000,000 vectors, so attach and detach were measured in part 2.

| Phase                  | Seconds | Searches a second | p50 ms | p95 ms | p99 ms | Max ms | Over 1 s | p95 against baseline |
| ---------------------- | ------: | ----------------: | -----: | -----: | -----: | -----: | -------: | -------------------: |
| Baseline               |     180 |               735 |    6.7 |   39.5 |   48.7 |  2,439 |       15 |                      |
| Copy of 1M rows        |     287 |                35 |    122 |    778 |  1,398 |  3,379 |      254 |              +1872 % |
| Build, graph in memory |   1,218 |               373 |    9.3 |   62.3 |    121 |  4,022 |      200 |                +58 % |
| Build, graph spilled   |   3,495 |               113 |   59.3 |    195 |    451 |  6,702 |      955 |               +393 % |

No search failed. During the spilled build, both the searches and the build waited on `DataFileRead`, which points to the two pushing each other's pages out of memory. After the spill the build added about 7 vectors a second, against about 470 a second before it.

**Fails** the criterion of p95 within 20 % of the baseline during the build. The test does not show what happens at a realistic search rate.

## Part 2: build with no searches, then attach and detach while searches run (`phases2.sh`)

With no searches running and one parallel worker, the primary key took 0.3 s, the GIN index 12.9 s and the HNSW index 1,069 s (17.8 minutes; the graph spilled after 570,909 vectors here too). Then the 8 clients started, and after a minute of warm-up:

| Phase                                     | Seconds | Searches | p50 ms | p95 ms | Max ms | Over 1 s | p95 against baseline |
| ----------------------------------------- | ------: | -------: | -----: | -----: | -----: | -------: | -------------------: |
| Baseline                                  |     120 |  127,817 |    5.3 |   31.6 |   65.2 |        0 |                      |
| `ATTACH PARTITION`, `lock_timeout` 1 s    |     0.6 |      597 |    5.3 |   33.0 |   51.5 |        0 |                 +4 % |
| `DETACH PARTITION ... CONCURRENTLY`, drop |     0.3 |      331 |    5.8 |   38.2 |   45.3 |        0 |                +21 % |
| After                                     |     120 |  133,482 |    5.0 |   31.4 |    182 |        0 |                 −1 % |

`ATTACH PARTITION` took 18.5 ms (the `CHECK` constraint on `generation` spares it a scan), `DETACH PARTITION ... CONCURRENTLY` 7.3 ms and `DROP TABLE` 71 ms. Neither statement hit its `lock_timeout`, and no search failed.

**Passes** the criterion of no search held up past 1 s. The detach's p95 is 1 point over the 20 % criterion, on 331 searches in 0.3 s; its slowest search, 45 ms, was faster than the baseline's slowest.

## What it means

Swapping generations with partition DDL does not hold up searches. Building one does: on the same server, the copy and the index build compete with searches for CPU, memory and disk, and once the graph no longer fits in `maintenance_work_mem` both get much slower. A build of the same size took 18 minutes with no searches and had not reached 60 % after 78 minutes with them.
