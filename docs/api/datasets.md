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

Typesense does not store pipeline provenance. A copy switch from Typesense yields unattributed documents. For a multi-pipeline dataset, follow that switch with the maintenance rebuild below before re-enabling schedules, or use a re-ingest switch to pgvector, which attributes each enabled pipeline.

On an existing multi-pipeline dataset, the first promotion after upgrade drops the unattributed documents of every other source. Every source must be available to rebuild its documents; an unavailable source cannot restore its old searchable content. Pause schedules while keeping the intended pipelines enabled, run each enabled pipeline once sequentially, then re-enable schedules. Do this as a planned maintenance rebuild: the first promotion that drops legacy documents is not gated behind a separate migration action. Pipeline provenance is stored separately from user metadata, so a user column named `ingestion_pipeline` neither changes ownership nor protects old documents from this removal. See [ADR 0025](../adr/0025-search-engine-switching.md#independent-pipeline-runs-107-2026-10-23) for storage, cost and identity rules.

To move a dataset to another engine: `GET .../engine-switches/estimate`, `POST .../engine-switches`, then `.../activate`, and `.../rollback` while the old engine is kept. Start, retry, cancel, activate and rollback all take the reason from the `change-reason` header only; a `reason` in the body is ignored. Activating needs a longer reason when the new engine scores worse.
