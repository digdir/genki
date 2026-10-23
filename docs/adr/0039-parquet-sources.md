# 0039 Parquet sources

Status: proposed, 2026-10-23 (built locally)

## Context

Open data is increasingly published as Parquet: on Hugging Face, in national data portals and in research archives. genki can ingest websites, folders, uploads, Kudos, EPiServer exports and tables in a tenant's own Postgres database. Converting Parquet by hand loses types and has to be repeated when publishers update it. Many datasets split one table across multiple shard files, with layouts that change between revisions. Loading a whole file into memory also makes larger datasets expensive to ingest.

## Decision

A pipeline may read one file or a sharded table with source kind `parquet`. Existing single-file specifications remain valid:

```yaml
source:
  kind: parquet
  huggingface:
    dataset: kelkalot/every-ai-policy-ever
    file: data/definitions.parquet
  mapping:
    fields:
      id: id
      title: term
      text: [definition, english]
```

An https `url` is the other single-file form. Hugging Face revisions default to `main`. Single-file document ids remain exactly `documentId(origin + '#' + rowId)`, with the original URL or `hf://datasets/{dataset}/{file}` as origin, without the revision.

A sharded Hugging Face source uses a stable logical `table` name and `files`, either a glob or an explicit list:

```yaml
source:
  kind: parquet
  huggingface:
    dataset: owner/dataset
    table: default-train
    revision: main
    files: data/train-*.parquet
    # Alternatively: [data/train-00000.parquet, data/train-00001.parquet]
  maxBytes: 2147483648
  mapping:
    fields:
      id: id
      title: title
      text: [body]
    maxRows: 50000
```

For a non-Hugging Face table, specify URLs explicitly:

```yaml
source:
  kind: parquet
  table: policies-train
  urls:
    - https://data.example/train-00000.parquet
    - https://data.example/train-00001.parquet
  mapping:
    fields:
      id: id
      title: title
      text: [body]
```

Exactly one of `url`, `urls` and `huggingface` is required. A top-level `table` is required only with `urls`. Sharded Hugging Face specs require `huggingface.table`. Use different table names for different configs or splits. Explicit lists have 1–1000 files. Glob syntax supports `*`, `?` and `**` with path matching; traversal paths are refused. Globs resolve through the [Hugging Face tree API](https://huggingface.co/docs/huggingface_hub/package_reference/hf_api#huggingface_hub.HfApi.list_repo_tree), recursively from their longest literal directory prefix. Pagination follows `Link: ...; rel="next"` only within that tree endpoint. Listing limits are 5 MiB per page, 100 pages and 1000 matched files. An empty match, malformed listing, invalid pagination or excess limit fails the run. File paths/URLs are deduplicated and sorted by code point before reading.

Sharded origins are `hf://datasets/{dataset}?table={table}` and `parquet://tables/{table}`. These origins never contain the resolved file list, glob or revision, so a row can move between shards or the glob can change without changing its document id. The `?table=` form cannot collide with a single-file Hugging Face path. A publisher must provide a unique nonempty row id across all selected shards. Duplicate ids among rows that pass the filters fail the entire run with the conflicting id and table in the existing execution failure message. Single-file duplicate behavior (first occurrence wins) and missing-id behavior (skip the row) are preserved.

Rows become documents through the database-style field mapping: `id`, `title`, `text`, optional `url`, `date`, `year`, metadata columns (optionally renamed with `as`), constants and equality filters (`eq`, `neq`, `in`, `not_in`, `is_null`, `not_null`). Lists stay lists. Titles are bold first lines of the embedded text. Mapped columns must exist in every visited shard. `mapping.maxRows` is a **total input row cap before filtering**, default 50,000 and maximum 200,000. Once reached, iteration stops and later shards are not fetched or validated. Deterministic file order makes this truncation repeatable for an unchanged layout; it does not promise the same subset after re-sharding when the cap truncates a table.

Each visited shard downloads through the same guarded fetch as other public ingestion files: http/https only, private/reserved addresses refused, every redirect checked, at most five redirects, and a two-minute read timeout. Source specs require https. CDN redirects are allowed without a host allowlist. Tree pages also use the guard. Each connection is pinned to its validated DNS addresses while preserving the original hostname for HTTP Host, TLS SNI and certificate verification. Every redirect uses fresh validation and transport, preventing DNS rebinding between validation and connection. Cancellation propagates through fetch, download and file range reads.

Downloads stream with backpressure into a private file under `INGEST_WORKING_DIRECTORY` (composition option `ingestWorkingDirectory`, access option `workingDirectory`), defaulting to the OS temp directory. `INGEST_FOLDER_ROOT` is an input/read boundary for folder sources and is not reused as writable scratch space. Each run creates a unique directory with a mode-0600 file. The file handle closes and the directory is removed in `finally`, including early iteration exit, failure and abort. Shards download and decode sequentially; only one shard occupies disk per run.

`maxBytes` now caps disk consumption **per shard**, default **2 GiB**, maximum **20 GiB**; previously supplied smaller limits remain valid. Provision writable ephemeral disk for at least `maxBytes` per concurrent Parquet run, plus other application scratch use. Mount scratch storage separately when the container's ephemeral storage budget is smaller, and size container storage requests/limits accordingly. OS termination, SIGKILL or a machine crash cannot execute `finally`; ephemeral volume lifecycle or operator cleanup handles abandoned directories. There is no persistent cache or resumption.

Decoding uses hyparquet and hyparquet-compressors (MIT), JavaScript with embedded WebAssembly for Snappy, without platform-specific native binaries. It remains in `@genai/providers-parquet`, behind the structural `ParquetReader`/`ParquetFile` interfaces in `@genai/ingest`. The API supplies a file-backed AsyncBuffer with `fs` byte-range reads. Hyparquet reads the footer, then the selected columns of **one row group at a time**, reusing metadata for that iteration. Memory is proportional to metadata, one decoded row group and ingestion concurrency, not the downloaded file. Publishers can still create very large row groups; a disk cap is not a hard limit on decompressed memory. Existing byte-array reader callers remain supported.

Any visited shard download, schema or decode failure, or duplicate id in a sharded table, throws from source iteration and fails the run. The existing generation writer only promotes after iteration completes, so previously active data remains active. Partial staged generations follow existing storage retention behavior. This is preferable to promoting an incomplete table that silently removes documents from failed shards.

## Why

An explicit logical table identity gives stable ids even when filenames, globs, revisions and shard counts change. Requiring the name avoids guessing configs/splits from layouts, and lets publishers use the same mechanism for multiple tables. A config/split convenience resolver is deferred; explicit lists and globs cover existing publishing layouts without another discovery protocol.

A local file provides a consistent downloaded snapshot, single-pass accounting, backpressure, cancellation and reliable per-shard cleanup while retaining the existing SSRF and redirect policy. Hyparquet's direct URL range reader was considered: it would require the guard on every HEAD/range/redirect, CDN range support and protection against the underlying remote file changing between ranges. A scratch file is simpler and works with hosts that do not support ranges, at the cost of downloading the whole selected shard before decoding any row.

Rejected: DuckDB (native dependencies and an unnecessary SQL surface), converting to CSV (loses lists and types), retaining entire files in memory, deriving sharded ids from individual filenames, and promoting partial tables after a failed shard.
