# Kudos pilot: pgvector index and scale benchmark

pgvector 0.8.2 (Azure's version) in Docker on an M3 Pro (11 cores, 28 GB for Docker), halfvec(1536) vectors of text-embedding-3-large: DBpedia's 1M set with the pilot's 20,248 Kudos pages mixed in. Recall@10 is against exact search. Kudos queries are the 676 pilot questions; DBpedia queries are 500 held-out DBpedia vectors. Iterative scans on, as genki runs them. Latency is one client, measured from Python, so it includes the round trip.

## Build, size and exact search

| Rows | Index | Memory / workers | Build (s) | Index size (GB) | Notice |
| --- | --- | --- | --- | --- | --- |
| 100,000 | hnsw m16 efc64 | 8GB / 4 | 60.9 | 0.38 |  |
| 100,000 | ivfflat lists 100 | 8GB / 4 | 3.5 | 0.38 |  |
| 250,000 | hnsw m16 efc64 | 8GB / 4 | 47.9 | 0.95 |  |
| 250,000 | ivfflat lists 250 | 8GB / 4 | 10.0 | 0.96 |  |
| 500,000 | hnsw m16 efc64 | 8GB / 4 | 105.0 | 1.91 |  |
| 500,000 | ivfflat lists 500 | 8GB / 4 | 30.1 | 1.91 |  |
| 500,000 | hnsw bit + rerank | 8GB / 4 | 30.0 | 0.23 |  |
| 500,000 | hnsw m16 efc64 | 2GB / 2 | 153.3 | 1.91 |  |
| 1,000,000 | hnsw m16 efc64 | 8GB / 4 | 228.4 | 3.81 |  |
| 1,000,000 | ivfflat lists 1000 | 8GB / 4 | 106.3 | 3.82 |  |
| 1,000,000 | hnsw bit + rerank | 8GB / 4 | 63.6 | 0.47 |  |
| 1,000,000 | hnsw m32 efc128 | 8GB / 4 | 673.1 | 3.81 |  |
| 1,000,000 | hnsw m16 efc64 | 2GB / 2 | 708.7 | 3.81 | graph outgrew memory |
| 100,000 | (table, with TOAST) | – | load 1.8 | 0.39 | |
| 100,000 | no index: exact search p50 133.14 ms, p95 144.6 ms | | | | |
| 250,000 | (table, with TOAST) | – | load 3.7 | 0.98 | |
| 250,000 | no index: exact search p50 192.88 ms, p95 202.28 ms | | | | |
| 500,000 | (table, with TOAST) | – | load 8.1 | 1.96 | |
| 500,000 | no index: exact search p50 267.33 ms, p95 273.62 ms | | | | |
| 1,000,000 | (table, with TOAST) | – | load 19.9 | 3.91 | |
| 1,000,000 | no index: exact search p50 517.52 ms, p95 830.63 ms | | | | |

## Recall and latency

| Rows | Index | Setting | Recall@10 Kudos | Recall@10 DBpedia | p50 ms | p95 ms | Rows returned |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100,000 | hnsw m16 efc64 | hnsw.ef_search = 40 | 0.9818 | 0.954 | 1.14 | 1.52 | 10.0 |
| 100,000 | hnsw m16 efc64 | hnsw.ef_search = 100 | 0.9951 | 0.9792 | 1.98 | 2.58 | 10.0 |
| 100,000 | hnsw m16 efc64 | hnsw.ef_search = 200 | 0.997 | 0.9902 | 3.23 | 4.35 | 10.0 |
| 100,000 | hnsw m16 efc64 | hnsw.ef_search = 400 | 0.9975 | 0.994 | 5.42 | 7.27 | 10.0 |
| 100,000 | ivfflat lists 100 | ivfflat.probes = 1 | 0.6595 | 0.6438 | 2.44 | 3.66 | 10.0 |
| 100,000 | ivfflat lists 100 | ivfflat.probes = 10 | 0.9651 | 0.98 | 17.33 | 21.38 | 10.0 |
| 100,000 | ivfflat lists 100 | ivfflat.probes = 100 | 0.9981 | 1.0 | 46.71 | 48.54 | 10.0 |
| 250,000 | hnsw m16 efc64 | hnsw.ef_search = 40 | 0.9747 | 0.9406 | 1.4 | 1.73 | 10.0 |
| 250,000 | hnsw m16 efc64 | hnsw.ef_search = 100 | 0.9929 | 0.9756 | 2.36 | 3.03 | 10.0 |
| 250,000 | hnsw m16 efc64 | hnsw.ef_search = 200 | 0.9967 | 0.9872 | 4.02 | 5.26 | 10.0 |
| 250,000 | hnsw m16 efc64 | hnsw.ef_search = 400 | 0.997 | 0.9904 | 6.74 | 8.97 | 10.0 |
| 250,000 | ivfflat lists 250 | ivfflat.probes = 1 | 0.6596 | 0.5476 | 1.92 | 3.07 | 10.0 |
| 250,000 | ivfflat lists 250 | ivfflat.probes = 10 | 0.9509 | 0.9292 | 12.63 | 16.82 | 10.0 |
| 250,000 | ivfflat lists 250 | ivfflat.probes = 15 | 0.9697 | 0.9556 | 18.4 | 23.15 | 10.0 |
| 250,000 | ivfflat lists 250 | ivfflat.probes = 100 | 0.9975 | 0.9992 | 100.32 | 107.27 | 10.0 |
| 500,000 | hnsw bit + rerank 200 | hnsw.ef_search = 200 | 0.9982 | 0.9834 | 4.27 | 5.56 | 10.0 |
| 500,000 | hnsw m16 efc64 | hnsw.ef_search = 40 | 0.9762 | 0.9408 | 2.22 | 3.83 | 10.0 |
| 500,000 | hnsw m16 efc64 | hnsw.ef_search = 100 | 0.9933 | 0.97 | 2.89 | 3.66 | 10.0 |
| 500,000 | hnsw m16 efc64 | hnsw.ef_search = 200 | 0.997 | 0.982 | 4.56 | 6.07 | 10.0 |
| 500,000 | hnsw m16 efc64 | hnsw.ef_search = 400 | 0.9975 | 0.9884 | 7.96 | 11.45 | 10.0 |
| 500,000 | ivfflat lists 500 | ivfflat.probes = 1 | 0.6793 | 0.5564 | 2.27 | 4.69 | 10.0 |
| 500,000 | ivfflat lists 500 | ivfflat.probes = 10 | 0.9528 | 0.9036 | 9.25 | 13.0 | 10.0 |
| 500,000 | ivfflat lists 500 | ivfflat.probes = 22 | 0.9821 | 0.9468 | 17.76 | 23.09 | 10.0 |
| 500,000 | ivfflat lists 500 | ivfflat.probes = 100 | 0.9978 | 0.9934 | 75.86 | 85.52 | 10.0 |
| 1,000,000 | hnsw bit + rerank 200 | hnsw.ef_search = 200 | 0.9966 | 0.9748 | 4.98 | 6.5 | 10.0 |
| 1,000,000 | hnsw m16 efc64 | hnsw.ef_search = 40 | 0.9666 | 0.928 | 4.48 | 13.53 | 10.0 |
| 1,000,000 | hnsw m16 efc64 | hnsw.ef_search = 100 | 0.9907 | 0.966 | 3.71 | 5.08 | 10.0 |
| 1,000,000 | hnsw m16 efc64 | hnsw.ef_search = 200 | 0.9942 | 0.9792 | 5.86 | 8.34 | 10.0 |
| 1,000,000 | hnsw m16 efc64 | hnsw.ef_search = 400 | 0.9945 | 0.9868 | 8.92 | 12.34 | 10.0 |
| 1,000,000 | hnsw m16 efc64, filter 1% | hnsw.ef_search = 100 | 0.9902 | 0.9536 | 19.76 | 30.41 | 10.0 |
| 1,000,000 | hnsw m16 efc64, filter 1%, no iterative scan | hnsw.ef_search = 100 | 0.0994 | 0.0948 | 2.89 | 3.68 | 0.9 |
| 1,000,000 | hnsw m16 efc64, filter 10% | hnsw.ef_search = 100 | 0.978 | 0.9336 | 4.34 | 7.62 | 10.0 |
| 1,000,000 | hnsw m16 efc64, filter 10%, no iterative scan | hnsw.ef_search = 100 | 0.868 | 0.827 | 2.95 | 3.82 | 8.7 |
| 1,000,000 | hnsw m32 efc128 | hnsw.ef_search = 40 | 0.9753 | 0.9684 | 4.11 | 7.69 | 10.0 |
| 1,000,000 | hnsw m32 efc128 | hnsw.ef_search = 100 | 0.9926 | 0.9894 | 5.36 | 7.63 | 10.0 |
| 1,000,000 | ivfflat lists 1000 | ivfflat.probes = 1 | 0.6641 | 0.531 | 3.7 | 7.9 | 10.0 |
| 1,000,000 | ivfflat lists 1000 | ivfflat.probes = 10 | 0.9479 | 0.8636 | 11.43 | 24.5 | 10.0 |
| 1,000,000 | ivfflat lists 1000 | ivfflat.probes = 31 | 0.984 | 0.938 | 27.41 | 36.7 | 10.0 |
| 1,000,000 | ivfflat lists 1000 | ivfflat.probes = 100 | 0.997 | 0.9816 | 84.98 | 101.43 | 10.0 |
| 100,000 | hnsw m16 efc64 | hnsw.ef_search = 100, 8 clients | | | 2266.3 queries/s | | |
| 250,000 | hnsw m16 efc64 | hnsw.ef_search = 100, 8 clients | | | 2297.3 queries/s | | |
| 500,000 | hnsw m16 efc64 | hnsw.ef_search = 100, 8 clients | | | 2127.0 queries/s | | |
| 1,000,000 | hnsw m16 efc64 | hnsw.ef_search = 100, 8 clients | | | 1958.7 queries/s | | |

## Nightly-sync style write on the HNSW index

1,000,000 rows: 10,000 inserted at 280.4 rows/s (35.7 s), 10,000 deleted (1.2 s), VACUUM 460.9 s; DBpedia recall@10 afterwards about 0.9624 (approximate: inserted rows left out of both sides).

## Projected to Kudos scale (not measured)

From the measured 1,000,000-row point: HNSW index 4,095 bytes per vector, table with TOAST 4,202 bytes per vector (vectors only: genki's rows also hold the text, about 2.3 KB, and its full-text data, about 2.0 KB). Build time fitted as 1.15e-05 × N log2 N seconds on this Mac with 8 GB of build memory and 4 workers.

| Vectors | Dims | HNSW index (GB) | Vector table (GB) | HNSW build, room to spare (h) |
| --- | --- | --- | --- | --- |
| 1,000,000 | 1536 | 3.8 | 3.9 | 0.1 |
| 1,000,000 | 1024 | 2.5 | 2.6 | 0.0 |
| 1,000,000 | 768 | 1.9 | 2.0 | 0.0 |
| 2,700,000 | 1536 | 10.3 | 10.6 | 0.2 |
| 2,700,000 | 1024 | 6.9 | 7.1 | 0.1 |
| 2,700,000 | 768 | 5.2 | 5.3 | 0.1 |
| 10,000,000 | 1536 | 38.1 | 39.1 | 0.7 |
| 10,000,000 | 1024 | 25.5 | 26.1 | 0.5 |
| 10,000,000 | 768 | 19.1 | 19.6 | 0.4 |
| 25,000,000 | 1536 | 95.3 | 97.8 | 2.0 |
| 25,000,000 | 1024 | 63.6 | 65.3 | 1.3 |
| 25,000,000 | 768 | 47.8 | 49.0 | 1.0 |
| 50,000,000 | 1536 | 190.7 | 195.7 | 4.1 |
| 50,000,000 | 1024 | 127.3 | 130.6 | 2.7 |
| 50,000,000 | 768 | 95.6 | 98.1 | 2.0 |

2.7M is full Kudos at one vector per page (67 pages per document). A build whose graph does not fit in maintenance_work_mem (Azure allows about 2 GB) slows down sharply; see the 2 GB rows above for how much at the sizes measured.

