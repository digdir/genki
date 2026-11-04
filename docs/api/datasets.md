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

A dataset whose runs run as knowledge jobs ([ADR 0042](../adr/0042-the-knowledge-database.md)) runs them in the worker. A start while the pipeline has an open run creates the run `queued`, and a start while one is already `queued` is refused with `409`. Such a run ends when its jobs have ended: `failed` when the source could not be listed, otherwise `succeeded`, with `report.failedDocuments` counting documents whose jobs ended as dead letters. `POST .../pipelines/{id}/executions/{execution}/redrive` with a `change-reason` sends those dead letters back and reopens the run (`202`, audited as `platform.jobs.redrive`, `manage-datasets`); the worker sends them back within a minute.

### Datasets on the knowledge database

A dataset whose endpoint has `connection: knowledge` keeps a record of every document and updates documents in place ([ADR 0042](../adr/0042-the-knowledge-database.md)). Its runs always run as jobs in the worker: one job lists the source and compares the listing with the pipeline's records, then one job per new, changed or deleted document converts it with the PDF text layer, chunks, embeds and replaces it. An unchanged document is not converted, embedded or written again; its source is still read to compare it when the listing gives no hash: folder files are read and hashed every run, and website pages without a sitemap `lastmod` are downloaded every run. A website page whose `lastmod` has not moved is not downloaded, except once it has not been checked for 7 days, so a page that answers `404` while its sitemap still lists it with the same `lastmod` is found by that re-check. A re-checked page that still answers is not converted, embedded or written again. A listed source (`folder`, `kudos`) deletes a document after two complete listings without it, a website after three complete crawls without it or a `404` or `410` seen twice in two runs, and an upload pipeline at its first run after the file is deleted (uploads and deletes reach the index only through a run until pushes are built, issue 250). A listing that failed part way deletes nothing, nor does an empty folder or website listing or a Kudos listing that starts after its first page.

A Kudos pipeline names each document `kudos:<uuid>` and its files by their KUDOS file UUID with the sha256 KUDOS lists. It lists `/api/v0/documents` per type (and per org in `orgs`, as `actor_name`), narrowed to the publish years of `since` and `until`, 50 a page, and checks the exact dates afterwards. A listing is complete when every page came back and each search's distinct documents reach its `meta.total`; KUDOS repeats and skips documents that share a publish date between pages, so a search that comes back short is listed again in the other order, up to three passes. `documents` (up to 1,000 KUDOS UUIDs) lists only those documents, one request each; a UUID KUDOS no longer has is not listed. Every request to KUDOS, file downloads included, keeps under 180 a minute and 5,000 an hour per process, and a `429` waits as long as `Retry-After` asks. A file KUDOS lists as larger than 50 MiB is not downloaded and is skipped as `too_large`. A Kudos slice only grows: a pipeline change that moves `since` later or `until` earlier, sets `until`, or drops a UUID, type or org is refused with `400`, on any engine, since two complete listings would delete what fell out; a narrower slice is a pipeline of its own. A document's record keeps the numeric ids today's Typesense index used (`packages/ingest/src/kudos-earlier-ids.json`), so a citation of `377252` resolves to its `kudos:` document.

Saving a pipeline into such a dataset answers `400` with one of these errors:

- `spec.source.kind`: `a source of kind database cannot fill a dataset on the knowledge database yet`, and the same for `episerver` and `parquet`.
- `spec.phrases`: `search phrases cannot fill a dataset on the knowledge database until recipes hold them`.
- `id`: `a dataset on the knowledge database is filled by one pipeline until co-owners are built; it has <pipelines>`, when another pipeline already fills the dataset.
- `spec.chunking`: `chunking changes through a new generation, which is not built yet; the dataset's generation keeps the chunking it was filled with`, when a saved pipeline's `chunking` changes, also after the pipeline was deleted and saved again. A pipeline's first run also records its chunking on the generation, which keeps it.

Disabling a pipeline starts nothing and keeps its documents. A run's `report` counts what the listing found against the pipeline's records in `new`, `changed`, `deleted` and `unchanged`, what the document jobs did in `stored` and `skipped`, and documents whose jobs ended as dead letters in `failedDocuments`. When `failedDocuments` reaches the pipeline's `maxDocumentFailures`, the run is `cancelled` with an error that says so, and the documents it already replaced stay.

`GET .../pipelines/{id}/versions` lists every saved version, oldest first; each has `deleted`, which is `true` on the version that removed the pipeline.

To move a dataset to another engine: `GET .../engine-switches/estimate`, `POST .../engine-switches`, then `.../activate`, and `.../rollback` while the old engine is kept. Start, retry, cancel, activate and rollback all take the reason from the `change-reason` header only; a `reason` in the body is ignored. Activating needs a longer reason when the new engine scores worse.

A switch into the knowledge database (an endpoint with `connection: knowledge`) re-ingests only: `method: copy` is refused, and so is a dataset with more than one pipeline, search phrases or a source the knowledge database does not take yet, with the reason in the estimate. Its fill and the refresh before activation are ingestion runs that name the switch and its generation (`generation`, `engineSwitch` on the run). While they run, the dataset's other runs are refused with `409`. `activate` answers `202` with the state `activating`; the switch becomes `active` once the refresh has run and the catalog names the generation. The switch view carries `generation`, and `failedDocuments` when documents of the fill could not be read in.

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
