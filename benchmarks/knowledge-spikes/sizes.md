# Stored conversion size

Measured on 2026-10-27 in the Kudos pilot's knowledge database (branch `feat/kudos-local-pilot`), where the pilot stored Marker 1.10.2's output for its sample:

```sql
select count(*),
       pg_size_pretty(sum(pg_column_size(markdown))),
       pg_size_pretty(sum(pg_column_size(output)))
from src_conversions;
-- 306 | 19 MB | 100 MB
```

`pg_column_size` is the size as Postgres stores it, after compression. The 306 PDFs have 16,611 pages (`benchmarks/kudos-pilot/results/timings.md` on that branch), so stored conversions take about 7 KB a page, markdown and structured output together. At that rate, all of Kudos, about 3.1 million pages by the page counts in the KUDOS listing, would take about 22 GB.
