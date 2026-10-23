# 0039 Parquet sources

Status: proposed, 2026-10-23 (built locally)

## Context

Open data is increasingly published as Parquet: on Hugging Face, in national data portals and in research archives. genki can ingest websites, folders, uploads, Kudos, EPiServer exports and tables in a tenant's own Postgres database, but not a Parquet file. Converting a file by hand to another format loses its types (lists, dates, numbers) and has to be redone each time the publisher updates it.

## Decision

A pipeline may read one Parquet file with the source kind `parquet`.

- The file comes from an https `url`, or from a Hugging Face dataset as `huggingface: { dataset, file, revision }`, which resolves to `https://huggingface.co/datasets/{dataset}/resolve/{revision}/{file}`. The revision defaults to `main`, so a weekly schedule picks up the publisher's updates.
- Rows become documents through a field mapping like the one database sources use: `id`, `title`, `text` columns, `url`, `date`, `metadata` columns (each may be stored under another name with `as`), `constants`, and `year` (a date or year column whose first four digits are stored as a number). Optional equality filters (`eq`, `neq`, `in`, `not_in`, `is_null`, `not_null`) and `maxRows` limit which rows are read. A document's id depends only on the file's origin (the URL, or `hf://datasets/{dataset}/{file}` without the revision) and the row's id, so it stays the same across runs and revisions.
- The title is the first line of the document text, in bold rather than as a heading, so it stays in the text that is embedded and searched. Metadata columns are stored as document fields; list columns stay lists, so a `multiselect` filter matches a row when the list contains the value.
- The file is fetched through the ingestion's guarded fetch: http and https only, every redirect checked again, private and reserved addresses refused, at most 5 redirects, a read timeout of two minutes, and `maxBytes` (default 100 MB, at most 500 MB). There is no host allowlist, as for Kudos files: Hugging Face redirects to CDN hosts that differ by region.
- Decoding is in a provider package, `@genai/providers-parquet` (hyparquet and hyparquet-compressors, pure JavaScript, MIT), behind the `ParquetReader` interface in `@genai/ingest`, and is wired in by the composition root like the database row reader. The dependency rules allow the parser only in provider packages. Before reading rows, the source checks that every mapped column exists and names the ones that do not.

## Why

A field mapping that works the same for a database table and a Parquet file keeps one way of describing structured sources, and keeps types that matter for filtering. Resolving Hugging Face files by dataset and path makes a published dataset a one-line source. The guarded fetch without a host allowlist matches how genki already fetches public files, and still keeps a pipeline from reaching internal addresses. A pure JavaScript parser avoids native binaries in the images.

Rejected: reading Parquet through DuckDB (a native dependency in every image, and a SQL surface the mapping does not need), and converting Parquet to CSV on upload (loses lists and types, and needs a person each time the publisher updates).
