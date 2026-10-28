# pg-boss as the durable queue

Run on 2026-10-27 with pg-boss 12.38.0, `pg` 8 and `undici` 7 on Node 24, against a fresh `pgvector/pgvector:0.8.2-pg17` container. The role `boss_app` has `CREATE` on the database and nothing else. `run.mjs` starts a fake Marker service (`fake-marker.mjs`, answers after `?seconds=N`) and one worker process per queue (`worker.mjs`). `results.txt` is the output of the run below.

| Check                                                             | Result                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Install as `boss_app`                                             | Pass: schema version 46 in 120 ms                                      |
| Send inside a transaction that rolls back                         | Pass: no job; the committed send exists                                |
| One queued job per `singletonKey`, policy `short`                 | Pass: the duplicate send returns `null`, one queued job per key        |
| Priority, one job per fetch                                       | Pass: 1, 10, 5 come out as 10, 5, 1                                    |
| A job that always fails, `retryLimit` 2, dead-letter queue        | Pass: 3 attempts, in the dead-letter queue after 57 s                  |
| Worker killed with `SIGKILL` mid-job, heartbeat 30 s              | Pass: another worker took it 30 s after the kill; it completed         |
| Connections held by four processes                                | 6                                                                      |
| A 6-minute response through Node's default `fetch`                | Fails after 302 s with `UND_ERR_HEADERS_TIMEOUT` (expected, see below) |
| A 10-minute job, heartbeat 30 s, `undici` agent with timeouts off | Pass: handed out once, completed after 10 minutes                      |

## What went wrong on the way

The first run (same day) reported two failures that were errors in the checks, not in pg-boss: it read queue counts from `getQueue()`, whose statistics pg-boss refreshes on its monitor interval, and it judged priority from the order of jobs inside one batch fetch. Both checks now count in `pgboss.job` and take one job per fetch.

That first run also handed the 10-minute job out twice. The worker's `fetch` gave up after 300 s because the fake service sends no headers until it is done, so the handler threw and pg-boss retried, as it should. Node's `fetch` (undici) has a 300-second `headersTimeout` and `bodyTimeout` by default. The platform's Marker client calls `fetch` the same way, so the worker now uses an `undici` agent with both timeouts off, and the default client is kept as its own check.
