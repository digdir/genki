# Datasets and knowledge

Datasets and what fills and serves them: ingestion pipelines and their runs, file uploads, enrichment with hypothetical questions, the search engine behind a dataset and switches between engines, knowledge endpoints, the tenant catalogue, and the models a caller may use (`GET /models`).

## Rights

- Reading needs membership in the tenant. That includes the list of uploaded files (`GET /tenants/{tenant}/datasets/{id}/uploads`), like reading the dataset itself; uploading and removing files need `manage-datasets`.
- Creating and changing datasets, pipelines, uploads, enrichment and engine switches needs `manage-datasets`.
- Catalogue writes need `manage-datasets` for datasets and knowledge endpoints, otherwise `manage-services`.
- Changes need `change-reason` and appear in `GET /tenants/{tenant}/audit`. Platform datasets are changed by operators under `/operator/datasets` (see [Operations](operations.md)).

## Typical sequence: create a dataset and fill it

1. `GET /tenants/{tenant}/knowledge/endpoints`: the search engines the tenant may use.
2. `POST /tenants/{tenant}/datasets` with `name`, `description` and `index.endpoint`.
3. `POST /tenants/{tenant}/datasets/{dataset}/pipelines`: a pipeline with its source (for files: upload them with `POST /tenants/{tenant}/datasets/{id}/uploads`). Answers `201`, like creating a dataset.
4. `GET .../pipelines/{id}/estimate`: how many documents the source holds.
5. `POST .../pipelines/{id}/execute`: start a run; it continues in the background. An unknown pipeline answers `404`, for execute and delete alike.
6. `GET .../pipelines/{id}/executions` and `GET /tenants/{tenant}/datasets/{id}`: progress, status and skipped documents.

`GET .../pipelines/{id}/versions` lists every saved version, oldest first; each has `deleted`, which is `true` on the version that removed the pipeline.

A dataset may have several pipelines. A normal run replaces its own documents and carries forward documents of enabled siblings without embedding them again. Disabling or deleting a pipeline removes its documents at the next successful sibling run. Writers need document reads and conditional promotion for multiple pipelines; pgvector supports both. Typesense refuses normal multi-pipeline runs because its writer lacks conditional promotion. Overlapping runs on separate instances can fail if another run promoted first; rerun the failed pipeline to include the latest sibling documents.

Stored provenance also records the embedding model, separately from user metadata. A multi-pipeline run refuses to carry sibling documents from a different or unknown model into the dataset's current embedding space. It checks enabled siblings before preparing or embedding, then checks the documents again while copying. Single-pipeline model changes still replace the old documents normally. After changing models, rebuild all pipelines: use a re-ingest switch where available, or pause schedules, leave only the first pipeline enabled and run it, then re-enable and run each remaining pipeline before resuming schedules. The first run replaces the old generation; every source must be available. Copy switches preserve provenance when reusing compatible vectors and embed again if the stored model is different or unknown.

Typesense does not store pipeline provenance. A copy switch from Typesense yields unattributed documents. For a multi-pipeline dataset, follow that switch with the maintenance rebuild below before re-enabling schedules, or use a re-ingest switch to pgvector, which attributes each enabled pipeline.

On an existing multi-pipeline dataset, the first promotion after upgrade drops the unattributed documents of every other source. Every source must be available to rebuild its documents; an unavailable source cannot restore its old searchable content. Pause schedules while keeping the intended pipelines enabled, run each enabled pipeline once sequentially, then re-enable schedules. Do this as a planned maintenance rebuild: the first promotion that drops legacy documents is not gated behind a separate migration action. Pipeline provenance is stored separately from user metadata, so a user column named `ingestion_pipeline` neither changes ownership nor protects old documents from this removal. See [ADR 0025](../adr/0025-search-engine-switching.md#independent-pipeline-runs-107-2026-10-23) for storage, cost and identity rules.

To move a dataset to another engine: `GET .../engine-switches/estimate`, `POST .../engine-switches`, then `.../activate`, and `.../rollback` while the old engine is kept. Start, retry, cancel, activate and rollback all take the reason from the `change-reason` header only; a `reason` in the body is ignored. Activating needs a longer reason when the new engine scores worse.

## Parquet pipelines

A pipeline source can read one public https Parquet file with `url`, or a Hugging Face file with `huggingface: { dataset, file, revision }` (`revision` defaults to `main`). Sharded tables use `urls: [...]` plus a stable `table` name, or `huggingface: { dataset, table, files }`, where `files` is an explicit path list or a glob such as `data/train-*.parquet`. Give each config/split its own table name. Keep that name when updating shard layouts so document ids stay stable.

For example, a source in the pipeline request body:

```json
{
  "kind": "parquet",
  "huggingface": {
    "dataset": "owner/dataset",
    "table": "default-train",
    "files": "data/train-*.parquet"
  },
  "mapping": {
    "fields": { "id": "id", "title": "title", "text": ["body"] },
    "maxRows": 50000
  },
  "maxBytes": 2147483648
}
```

`mapping.maxRows` caps input rows across all shards before filtering (default 50,000, maximum 200,000). Files are sorted and processed sequentially; files beyond the row cap are not fetched. `maxBytes` caps each downloaded file on disk (default 1 GiB, maximum 20 GiB), never above the platform ceiling `INGEST_PARQUET_MAX_BYTES` (1 GiB unless set). The platform uses `INGEST_WORKING_DIRECTORY` or its OS temp directory for scratch files. A page may decompress to at most 64 MB and a row group to at most 128 MB; a file over either limit fails the run. Every download and CDN redirect goes through the public URL guard. A failed shard or duplicate row id in a sharded table fails the run and leaves the active dataset in place. See [ADR 0039](../adr/0039-parquet-sources.md) for mappings, limits and storage details.

A mapping can join fields from another Parquet file with `mapping.lookups` (at most three): `file` (a path in the same Hugging Face dataset, read at the same revision) or `url`, plus `key` (the lookup file's column), `on` (the source column) and `fields` (columns, optionally renamed with `as`). Each lookup file is read once per run before the first source file; only its key and field columns are decoded. A row without a matching key gets none of the joined fields, and the run report counts matches and misses per lookup under `report.source.lookups`. A key repeated with different values, more rows than `maxRows` (default 200,000) or a key map above `maxMemoryBytes` (default 64 MiB; the lookups of one mapping may add up to at most 256 MiB) fails the run and leaves the active dataset in place. Joined fields are stored like metadata columns, so a dataset can declare them as filters. Document ids do not change.
