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

To move a dataset to another engine: `GET .../engine-switches/estimate`, `POST .../engine-switches`, then `.../activate`, and `.../rollback` while the old engine is kept. Start, retry, cancel, activate and rollback all take the reason from the `change-reason` header only; a `reason` in the body is ignored. Activating needs a longer reason when the new engine scores worse.

## Website citations from a mirror

Set `source.cite` when fetching a mirror whose pages should cite the original site:

```yaml
source:
  kind: website
  sitemap: https://owner.github.io/altinn-studio-docs/sitemap-markdown.xml
  include: [en/**, nb/**]
  exclude: [en/internal/**]
  cite:
    baseUrl: https://docs.altinn.studio/
    dropIndexMd: true
```

The fetch root defaults to the sitemap's directory (`https://owner.github.io/altinn-studio-docs/` here). Set `cite.fetchBaseUrl` explicitly when the sitemap is elsewhere, such as in a nested `sitemaps/` directory. Both citation and explicit fetch roots must be HTTPS directory URLs ending in `/`, without credentials, query or fragment. A listed page outside the fetch root fails the run instead of producing an unrelated citation. The fetch root does not grant access to another host.

In cite mode, include/exclude globs match the fetch-root-relative path without a leading slash, such as `en/authorization/index.md`. Language is derived from that path's `en/` or `nb/` prefix. Citation URLs do not affect filtering or language. With `dropIndexMd: true`, `en/authorization/index.md` becomes `https://docs.altinn.studio/en/authorization/`, and `en/guide.md` becomes `https://docs.altinn.studio/en/guide/`. Other extensions stay as they are. The option defaults to false; query strings and fragments are preserved. For a site that serves its pages as `.html` files, such as a Jekyll site, add `pageSuffix: .html`: `docs/guide.md` then becomes `https://docs.example.no/docs/guide.html`, while `index.md` still maps to its directory.

Documents and chunks store the absolute citation URL. Document ids hash that URL, so changing the sitemap to `https://docs.altinn.studio/sitemap-markdown.xml` keeps the ids when it lists equivalent paths and uses the same `cite` settings. The citation host is never fetched or added to the fetch allowlist; only existing sitemap and `source.baseUrl` access applies. Without `cite`, existing relative URL storage, fetch-URL ids and full-path glob matching stay unchanged.

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
