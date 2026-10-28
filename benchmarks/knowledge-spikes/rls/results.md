# Row-level security on knowledge tables

Run on 2026-10-27 in a throwaway `pgvector/pgvector:0.8.2-pg17` container: 200,000 rows with a 64-dimension `halfvec`, a 30-word text from a 50,000-word vocabulary, GIN indexes on `tsv`, `fields` and the text with `gin_trgm_ops`, and HNSW on the vector. `setup.sql` builds it, with a policy `dataset = any(string_to_array(current_setting('app.datasets', true), ','))` and a role `reader` without `BYPASSRLS`.

## Which operators are leakproof (`setup.sql`)

| Function                           | Leakproof |
| ---------------------------------- | --------- |
| `int4eq(integer,integer)`          | yes       |
| `texteq(text,text)`                | yes       |
| `ts_match_vq(tsvector,tsquery)`    | no        |
| `jsonb_contains(jsonb,jsonb)`      | no        |
| `cosine_distance(halfvec,halfvec)` | no        |
| `similarity_op(text,text)`         | no        |

## Plans with and without the policy (`plans.sql`)

| Query                                  | Owner (no policy)                         | `reader` (policy)                                                  |
| -------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| Full text, `LIMIT 10`                  | Bitmap index scan on the `tsv` GIN index  | Sequential scan, 13,913 rows removed by the filter                 |
| jsonb filter `fields @> '{"type": …}'` | BitmapAnd of the `fields` GIN and the key | Key index only, `fields @> …` as a filter: 18,000 heap blocks read |
| Vector, `ORDER BY vec <=> q LIMIT 10`  | HNSW index scan                           | HNSW index scan, the policy as a filter on its candidates          |

## Ranked full text, warm (`ranked.sql`)

`tsv @@ q ORDER BY ts_rank_cd(tsv, q) DESC LIMIT 50` on the 180,000 rows of one dataset:

| Path                                                          | Time    |
| ------------------------------------------------------------- | ------- |
| Owner, no policy                                              | 0.36 ms |
| `reader` with the policy                                      | 31 ms   |
| `reader` through a `SECURITY DEFINER` function (`ranked.sql`) | 4.6 ms  |

The function checks the dataset once (a one-time filter in `fn-plan.sql`'s plan) and uses the GIN index. Asked for a dataset outside `app.datasets`, it returns nothing.

## A policy per partition that does not read the row (`partition-policy.sql`)

Run on 2026-10-27 in the partition spike's container. Two partitions of 200,000 rows, one per dataset, each with its own GIN index, and a policy on each partition that only compares the partition's own dataset with `app.datasets`, so it reads no column. The reader has `SELECT` on the partitions and none on the parent.

| Query on `kc_g1`, ranked full text, 40 hits | Plan                           | Time    |
| ------------------------------------------- | ------------------------------ | ------- |
| Owner, no policy applies                    | Bitmap scan on the GIN index   | 0.11 ms |
| Reader, policy that does not read the row   | Sequential scan, policy filter | 40 ms   |
| Reader, policy that reads `dataset`         | Sequential scan, policy filter | 39.5 ms |

PostgreSQL keeps the policy in the scan's filter even when it reads no column, so full-text match (`@@`), which is not leakproof, still cannot be used on the index. Row-level security loses the GIN index on partitions too. With another dataset in `app.datasets` the reader gets no rows, and through the parent it is refused.

## Reads through a `SECURITY DEFINER` function on partitions (`definer-partitions.sql`)

Run on 2026-10-27 in the same container: a table partitioned by generation with 301 partitions (one of 200,000 rows, 300 of 200 rows), a GIN index on each, and a reader role with `EXECUTE` on two functions and no `SELECT`. Ranked full text, 40 hits, timed by `psql` after the first call:

| Read                                                                              | Time            |
| --------------------------------------------------------------------------------- | --------------- |
| Owner, direct read                                                                | 0.06 to 0.10 ms |
| Reader, PL/pgSQL function that writes the dataset and generation into dynamic SQL | 0.09 to 0.12 ms |
| Reader, plain SQL function with the same query and parameters                     | 86 to 93 ms     |

The PL/pgSQL function plans one partition, because the generation is a literal; the SQL function plans all 301. Asked for a dataset outside `app.datasets`, the function raises an error, and a direct read by the reader is refused.
