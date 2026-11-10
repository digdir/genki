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

A dataset whose endpoint has `connection: knowledge` keeps a record of every document and updates documents in place ([ADR 0042](../adr/0042-the-knowledge-database.md)). A folder document there has the id `folder:<owner>/<hash>`: the dataset's scope (`platform` or the organisation number) and a hash of the file's path from the folder root, so two pipelines that list the same file name the same document and no path reaches a stored answer through the id. Its runs always run as jobs in the worker: one job lists the source and compares the listing with the pipeline's records, then one job per new, changed or deleted document converts it with the PDF text layer, chunks, embeds and replaces it. An unchanged document is not converted, embedded or written again; its source is still read to compare it when the listing gives no hash: folder files are read and hashed every run, and website pages without a sitemap `lastmod` are downloaded every run. A website page whose `lastmod` has not moved is not downloaded, except once it has not been checked for 7 days, so a page that answers `404` while its sitemap still lists it with the same `lastmod` is found by that re-check. A re-checked page that still answers is not converted, embedded or written again. A listed source (`folder`, `kudos`) deletes a document after two complete listings without it, a website after three complete crawls without it or a `404` or `410` seen twice in two runs, and an upload pipeline at its first run after the file is deleted (uploads and deletes reach the index only through a run until pushes are built, issue 250). A listing that failed part way deletes nothing, nor does an empty folder or website listing or a Kudos listing that starts after its first page.

A Kudos pipeline names each document `kudos:<uuid>` and its files by their KUDOS file UUID with the sha256 KUDOS lists. It lists `/api/v0/documents` per type (and per org in `orgs`, as `actor_name`), narrowed to the publish years of `since` and `until`, 50 a page, and checks the exact dates afterwards. A listing is complete when every page came back and each search's distinct documents reach its `meta.total` (a search without a total, or a listing from a later `startingPage`, is never complete); KUDOS repeats and skips documents that share a publish date between pages, so a search that comes back short is listed again in the other order, up to three passes. `documents` (up to 1,000 KUDOS UUIDs) lists only those documents, one request each; a UUID KUDOS no longer has is not listed. Every request to KUDOS, file downloads included, keeps under 180 a minute and 5,000 an hour per process, and a `429` waits as long as `Retry-After` asks. A file KUDOS lists as larger than 50 MiB is not downloaded; a document whose other files give no text is skipped as `too_large`, and one with a file that gives text is stored without the large one. A Kudos slice only grows: a pipeline change that moves `since` later or `until` earlier, sets `since`, `until`, `types`, `orgs` or `documents` where none were set, drops a UUID, type or org, or changes `profile` is refused with `400`, on any engine, since two complete listings would delete what fell out; a narrower slice is a pipeline of its own. A document's record keeps the numeric ids today's Typesense index used, from `packages/ingest/src/kudos-earlier-ids.json` (written by `packages/eval/src/scripts/kudos-earlier-ids.ts`: `ids` by the live site's redirect with a file sha256 in common, `byFile` by the one live document holding a file of an id the site does not redirect), so a citation of `377252` resolves to its `kudos:` document; a record listed unchanged takes new earlier ids without being converted or embedded again.

Saving a pipeline into such a dataset answers `400` with one of these errors:

- `spec.source.kind`: `a source of kind database cannot fill a dataset on the knowledge database yet`, and the same for `episerver` and `parquet`.
- `spec.phrases`: `search phrases cannot fill a dataset on the knowledge database until recipes hold them`.
- `id`: `a dataset on the knowledge database is filled by one pipeline until co-owners are built; it has <pipelines>`, when another pipeline already fills the dataset.
- `spec.chunking`: `chunking changes through a new generation, which is not built yet; the dataset's generation keeps the chunking it was filled with`, when a saved pipeline's `chunking` changes, also after the pipeline was deleted and saved again. A pipeline's first run also records its chunking on the generation, which keeps it.

Disabling a pipeline starts nothing and keeps its documents. A run's `report` counts what the listing found against the pipeline's records in `new`, `changed`, `deleted` and `unchanged`, what the document jobs did in `stored` and `skipped`, and documents whose jobs ended as dead letters in `failedDocuments`. When `failedDocuments` reaches the pipeline's `maxDocumentFailures`, the run is `cancelled` with an error that says so, and the documents it already replaced stay.

`GET .../pipelines/{id}/versions` lists every saved version, oldest first; each has `deleted`, which is `true` on the version that removed the pipeline.

To move a dataset to another engine: `GET .../engine-switches/estimate`, `POST .../engine-switches`, then `.../activate`, and `.../rollback` while the old engine is kept. Start, retry, cancel, activate and rollback all take the reason from the `change-reason` header only; a `reason` in the body is ignored. Activating needs a longer reason when the new engine scores worse.

A switch into the knowledge database (an endpoint with `connection: knowledge`) re-ingests or copies. Re-ingest is refused for a dataset with more than one pipeline, search phrases or a source the knowledge database does not take yet, with the reason in the estimate. `method: copy` reads the dataset from an engine that hands its documents over one by one (Typesense) and writes a record per document, owned by `_copy`, with the chunks as they are, new chunk ids, pages from Marker's page breaks, and vectors from the switch's `embedding`, which it needs. A dataset with a Kudos pipeline, even one turned off, gets `kudos:<uuid>` ids with its old numbers as earlier ids. `documents` (1 to 1000 source ids) copies only those, to try it out: it deletes nothing, compares, and is refused at `activate`. The estimate takes `model` to price a dataset with no embedding (without one, a copy is priced at no embedding cost), scales a copy's chunks and tokens from its first 100 documents (`basis.chunks`, `basis.tokens`), and lists in `embeddings` the models the dataset's residency allows. A copy with a model wider than that residency is refused with `409`, and so is a copy of a dataset no model may embed. A filled copy's view carries `copy`: `copied`, `skipped` by reason (`no_uuid`, `same_uuid`, `no_text`) and `failed`. A pipeline that later lists a copied document takes it over as changed; copied documents it does not list stay. Its fill and the refresh before activation are ingestion runs that name the switch and its generation (`generation`, `engineSwitch` on the run). While they run, the dataset's other runs are refused with `409`. `activate` answers `202` with the state `activating`; the switch becomes `active` once the refresh has run and the catalog names the generation. The switch view carries `generation`, and `failedDocuments` when documents of the fill could not be read in. An operator switches a platform dataset with the same routes under `/operator/datasets/{id}`, which the console shows under the dataset in Katalog, Datasett. `GET /operator/knowledge/endpoints` lists each endpoint's `datasets`, with `id`, `scope` (`platform` or the organisation number), `name` and `pipelines` (how many pipelines fill it), so an operator sees what is still on an endpoint before it goes.

## Deleting a dataset

`DELETE /tenants/{tenant}/datasets/{id}` with `manage-datasets` and a `change-reason` deletes a dataset the tenant owns (`DELETE /operator/datasets/{id}` does the same for a platform dataset). It is refused with `409` while a published service or an adopted building block reads the dataset (`GET /tenants/{tenant}/datasets/{id}` lists them in `usedBy`) and while one of its runs is open. Otherwise it is one audited task (`platform.dataset.delete`) that, for a dataset whose engine runs on the platform (pgvector or Typesense endpoints), drops the generations its own runs wrote, then deletes its uploaded files from the blob store, removes its pipelines (each as a deleted version), writes the catalog version that deletes the dataset, and last drops the generation the engine served. A step that fails leaves the dataset in place, so the delete can be sent again; only a served generation that refuses to drop after the catalog version is written is left behind, and then reported. A served generation that no run of the dataset wrote is never dropped. The answer says what went and what stays: `removed` (`pipelines`, `uploads`, `generations` that held documents) and `kept` (`generations` left on the engine, `knowledgeRecords`). The run history and the audit log stay for every dataset. A platform dataset (`DELETE /operator/datasets/{id}`) has no uploads, so that step is skipped.

A dataset on the knowledge database (`connection: knowledge`) is deleted the same way, but its records and partitions stay on the knowledge server until the `knowledge.drop` job exists (issue 250): the deletion is the explicit catalog record that job will follow ([ADR 0042](../adr/0042-the-knowledge-database.md), "Deletion follows an explicit record"), `kept.knowledgeRecords` is `true`, and the id is refused for a new dataset until the records are dropped, so old records cannot mix with a new dataset under the same id. Dropping them needs the `knowledge.drop` job, so until issue 250 is built the id stays held.

`DELETE /tenants/{tenant}/catalog/dataset/{id}` is the raw catalogue write: it removes the entry only, refused while a published service uses it, and leaves pipelines, uploads and the engine's content behind. Use the dataset route unless you mean that.

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
