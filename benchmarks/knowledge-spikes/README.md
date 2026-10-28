# Knowledge database spikes

Throwaway checks behind [ADR 0039](https://github.com/digdir/genki/blob/docs/knowledge-database-adr/docs/adr/0039-durable-jobs-on-pg-boss.md) and [ADR 0040](https://github.com/digdir/genki/blob/docs/knowledge-database-adr/docs/adr/0040-the-knowledge-database.md) (proposed, branch `docs/knowledge-database-adr`), run on 2026-10-27. Each tests one claim the design rests on, in a `pgvector/pgvector:0.8.2-pg17` container (Azure ships pgvector 0.8.2). `sizes.md` records how much space stored conversions take. None of this is platform code, and nothing here runs in CI.

| Folder        | Claim                                                                                                                                                      | Result                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `rls/`        | Row-level security on the knowledge tables would cost full-text and jsonb filters their GIN indexes, on partitions too; `SECURITY DEFINER` reads would not | Confirmed, see `results.md`                                              |
| `partitions/` | A new generation can be built, attached and detached beside the active one while searches run                                                              | Attach and detach pass; building beside searches fails, see `results.md` |
| `churn/`      | In-place updates with autovacuum off and an explicit VACUUM after each run keep the HNSW index healthy                                                     | Passed, see `results.txt`                                                |
| `pgboss/`     | pg-boss works as a durable queue that pushes long jobs to an external HTTP service                                                                         | Passed, see `results.md`                                                 |

## Running them again

All of them need Docker. Data and containers are not kept in the repository.

- `rls/`: start a `pgvector/pgvector:0.8.2-pg17` container with default settings, then run `setup.sql`, `plans.sql`, `ranked.sql` and `fn-plan.sql` with `psql` as the superuser.
- `partitions/`: needs one million 1,536-dimension vectors in a table `items (id int, vec halfvec(1536))`; the runs used DBpedia's text-embedding-3-large set. Start the container with `--cpus 4` and `-c maintenance_work_mem=2GB -c max_parallel_maintenance_workers=2`, run `setup.sql`, then `SPIKE_DB_URL=postgres://… sh phases.sh` (part 1, building while searches run) and `sh phases2.sh` (part 2, attach and detach while searches run), and `python3 analyse.py phases.txt latency.txt` for each part (the load generator `load.mjs` needs `pg`). Part 1 takes hours if not stopped; part 2 expects the table it copied.
- `churn/`: needs a table `pool (n int, vec halfvec(1536))` of page vectors and `qtab (n int, vec halfvec(1536))` of question vectors; the runs used the Kudos pilot's 20,248 pages and 676 questions (`npy_to_copy.py` turns a `.npy` file into `COPY` rows). Run `run.sh` inside the container with this folder mounted at `/s2`.
- `pgboss/`: `npm install pg-boss@12.38.0 pg@8` in a scratch folder, copy the scripts there, create a database with a role that only has `CREATE` on it, and run `BOSS_URL=postgres://… node run.mjs`. It takes about 12 minutes because of the 10-minute job.
