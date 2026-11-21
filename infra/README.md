# Infrastructure

The test environment is deployed from `main` by running `.github/workflows/deploy.yml` by hand (`gh workflow run deploy.yml`), after the checks in `ci.yml` pass. Infrastructure changes run by hand with `.github/workflows/infra.yml`, `what-if` first.

Bicep for genki's Azure environments: test (`env/test.bicepparam`, `genki-test.digdir.cloud`) and prod (`env/prod.bicepparam`, `genki.digdir.cloud`, see [Prod](#prod)). Both use the same template and the same host names under their own zone.

## What gets created (one resource group per environment)

| Resource                                            | Notes                                                                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Virtual network                                     | `apps` subnet (/23, delegated to Container Apps), `postgres` subnet (delegated to Postgres Flexible Server)                                                                        |
| Container Apps environment                          | The six container apps below, the shared `data` volume, managed certificates                                                                                                       |
| Container registry (Basic)                          | No admin user; the apps pull with their identity (AcrPull), the deploy identity pushes (AcrPush)                                                                                   |
| Key Vault                                           | RBAC only, purge protection; the apps read secrets with Key Vault Secrets User                                                                                                     |
| Postgres Flexible Server 17                         | Private networking only, Entra ID auth only (no passwords), database `genai`                                                                                                       |
| Storage account with the file share `data`          | Mounted at `/data` in the API and worker: uploads and other blobs (`BLOB_DIR=/data/blobs`)                                                                                         |
| Blob container `conversions`                        | In the same account: converters' native output (ADR 0042), blob versioning, earlier versions deleted 30 days after they were written, the knowledge worker writes                  |
| Log Analytics and Application Insights              | The environment's managed OpenTelemetry agent sends traces and logs to Application Insights                                                                                        |
| Alerts (`alertsEnabled`)                            | Action group `<name>-alerts`, an availability test on the API's `/health`, the alert rules and the budgets, see the [runbook](../docs/runbook.md#alerts)                           |
| Backups (`backupsEnabled`)                          | A Recovery Services vault for the share `data`, the nightly database copy's job, identity and storage account, see [Backups](#backups)                                             |
| Assistant host (`assistantHostEnabled`, on in test) | `<name>-assistant` in its own environment `<name>-hosted-env`, identity `<name>-assistant-id` with AcrPull only, Key Vault `<name>-hostkv` for the host alone (ADR 0061, ADR 0062) |
| DNS zone (optional, `createDnsZone`)                | `genki-test.digdir.cloud` or `genki.digdir.cloud` with a CNAME and a validation TXT record per host name                                                                           |

From `KNOWLEDGE_SERVER_STAGE=server` on, also the environment's knowledge server in a network of its own, the knowledge identities and the principals job: see [Knowledge server](#knowledge-server).

## The containers

One `Dockerfile`, three targets:

| Container app          | Target   | Ingress            | What it runs                                           |
| ---------------------- | -------- | ------------------ | ------------------------------------------------------ |
| `genai-test-api`       | `api`    | Public             | The API, on `api.genki-test.digdir.cloud`              |
| `genai-test-worker`    | `worker` | None               | Triggers, ingestion and batch jobs. One replica        |
| `genai-test-portal`    | `apps`   | Public             | The portal, on `portal.genki-test.digdir.cloud`        |
| `genai-test-workspace` | `apps`   | Public             | The workspace, on `workspace.genki-test.digdir.cloud`  |
| `genai-test-console`   | `apps`   | Public             | The console, on `console.genki-test.digdir.cloud`      |
| `genai-test-docling`   | (own)    | Internal TCP, 5001 | PDF conversions, see [Docling server](#docling-server) |

The API and the worker are sized apart, the same in test and prod. The API has 0.5 vCPU and 1 GiB a replica (`cpu`, `memory` in `infra/main.bicep`). The worker has 2 vCPU and 4 GiB (`workerCpu`, `workerMemory`), and Node's heap gets three quarters of that memory through `NODE_OPTIONS=--max-old-space-size` (3072 MB), since an ingestion run holds its whole listing in memory and a Kudos listing ran out of 1 GiB. `workerMemory` is in whole Gi. A change to the worker by hand in the portal lasts until the next deploy.

The worker paces its KUDOS file downloads (issue 931): at most 2 at once (`kudosDownloadsAtOnce` in `packages/ingest/src/kudos-downloads.ts`), on connections kept open to `kudos.dfo.no`. A download whose DNS answer says try again, that cannot connect, gets no answer, or gets 429 or 503 holds back every KUDOS download in the worker for a wait from 5 s doubling to 2 min with jitter, and is tried again without using one of its convert job's tries; after 30 minutes of waits in all the try fails as before. Each wait is logged as `a KUDOS download waits` with `host`, `cause` and `waitMs`, never the file's URL. The worker has no fixed outbound address: in test it leaves from Azure's shared pool (321 `outboundIpAddresses`, no NAT gateway), and two of those took turns in one probe. On 2026-11-21, with no run going, 7 of 8 new connections opened to `kudos.dfo.no` at once went unanswered for 10 s while a kept one answered; whether KUDOS or the outbound path dropped them is not measured (results on https://github.com/digdir/genki/issues/931).

In prod the names are `genai-prod-*` and the host names end in `genki.digdir.cloud`. The Docling server has its own image, from `docker/docling/Dockerfile`.

The `api` and `worker` images hold each package's `dist` and the folders in `docker/runtime-assets`: the files the code reads from disk next to itself, such as eval judges, test sets and the seeded services. A test (`scripts/runtime-assets.test.ts`) fails when the code reads such a folder that is not listed.

They also hold `/app/genki-docs`: the documentation the GenKI guide answers from, collected at build time by `scripts/docs-bundle.ts` with the include list of `apps/api/config/local/pipelines/genki-docs.yaml`, so the guide always matches the deployed code. `INGEST_FOLDER_ROOT` points there, which makes it the only folder that folder pipelines can read.

The `apps` image holds all three app builds; `APP` picks which one a container serves. Settings are read at start, not at build: the container writes `/config.js` from its environment (`ANSATTPORTEN_ISSUER`, `OIDC_CLIENT_ID`, `API_AUDIENCE`, `ALTINN_RESOURCE`, `PUBLIC_API_BASE`, `PORTAL_URL`, and for the console `OIDC_ISSUER`, `OIDC_TOKEN_ENDPOINT`, `ENVIRONMENT`), so one image runs in every environment. It proxies `/api/` to the API (`API_UPSTREAM`), so the browser talks to one origin and the API needs no CORS. The proxy drops `/api` and forwards the rest of the request URI as the browser sent it, so encoded slashes in ids such as `digdir%2Fkudos` reach the API still encoded. The Azure ingress in front of the API decodes `%2F` anyway, so the API also accepts these ids with a plain slash (`/operator/datasets/digdir/kudos/pipelines`) and reads them as the encoded form (`apps/api/src/decoded-ids.ts`). It sends a Content Security Policy that allows connections to the login issuer only.

The API writes one JSON line to its console log for each request slower than `SLOW_REQUEST_MS` (500 ms by default): `{"msg":"request","method":"GET","route":"/tenants/:tenant/overview","status":200,"ms":1234}`. It names the route pattern, never the ids in the path or the query string. `LOG_REQUESTS=true` logs every request the same way.

## Docling server

`genai-<env>-docling` converts PDFs for `knowledge.convert` (ADR 0042, issue 476; the worker calls it from issue 477 on). Test and prod alike:

- **Image:** `docker/docling/Dockerfile`, Python 3.13 on Debian trixie (base pinned by digest) with the versions the parser benchmark's winner ran (`benchmarks/ingestion/blocks/results/run2.md`, `docling-tess`): Docling 2.146.0, docling-core 2.105.0, docling-ibm-models 4.0.4, CPU torch 2.15.0, Tesseract 5.5.0 and Debian's Norwegian data, served by docling-serve 1.38.2 behind genki's middleware (`docker/docling/genki_busy.py`, started as `python -m genki_busy`, see Spread below), with the layout and TableFormer models inside. The Debian packages are not pinned by version, since the mirrors keep only the newest build; the build stops if Tesseract is no longer 5.5.0 or the Norwegian data changes. Every Python package is installed at the version in `docker/docling/requirements.txt`, resolved from what PyPI offered when the benchmark run started, so a later rebuild installs the same code. Tesseract is the only OCR a request gets, with Norwegian when it names no OCR preset (`auto`); English data is there too. Unlike the platform's images, a rebuild need not give the same digest, since the Debian packages come from the live mirrors. `images.yml` builds it when the tree of `docker/docling` changes, and at least weekly so the Debian packages stay current; the deploy deploys it by digest, and prod gets the same digest.
- **Size:** Consumption, 4 vCPU and 8 GiB a replica (`doclingMemoryGiB`, at most 8 on Consumption), one conversion at a time (one Docling worker, 4 threads), 0 to 8 replicas (`doclingMaxReplicas` in `infra/modules/containerapps.bicep`, the same in both environments). The parser benchmark's rate, 8 Docling processes on 32 vCPUs, was 5,413 pages an hour; 8 replicas are the same 32 vCPUs. Peak memory converting a four-page scan locally was 1.4 GiB; a 452-page Kudos PDF alone, 5.4 GiB (locally, 4 CPUs, 2026-11-21, issue 922). The worker asks Docling to stop after 5 h 50 min (`document_timeout`), since the server has no route to cancel a conversion and does not stop one whose client left; `DOCLING_SERVE_MAX_SYNC_WAIT` (21,600) applies only to the synchronous route, which the worker no longer uses (issue 906); the worker converts `doclingMaxReplicas` files at once (`KNOWLEDGE_CONVERT_CONCURRENCY`, issue 477).
- **Reach:** internal TCP ingress on port 5001, so only apps in the environment reach it, and every request but the health routes needs `X-Api-Key`: the Key Vault secret `docling-api-key`, which only the worker (`DOCLING_API_KEY`) and the server are given; an app with the platform identity could still read it from Key Vault. The server can use the platform identity only to pull its image and read its key (`identitySettings` `lifecycle: 'None'`): its code, which parses untrusted PDFs, gets no token. The worker gets `DOCLING_URL`, `http://genai-<env>-docling:5001`: the app's name, by which other apps in the environment reach its TCP port. Not the internal FQDN (`genai-<env>-docling.internal.<domain>`): it leads to the environment's HTTP ingress, which has nothing on 5001, so a connection to it gets no answer even while a replica runs (issue 867). TCP, not HTTP, because HTTP ingress ends a request after 240 s and a conversion takes minutes. The TCP ingress closes a connection that sends nothing for 300 s (measured from the worker, 2026-11-21: an idle connection closed at 300.0 s, one polled every 30 s still open after 900 s; issue 906), so the worker uses the async route: it submits the file (`/v1/convert/file/async`), polls its task every 30 s and fetches the result, on one connection a job, since a task lives only in the memory of the replica that took it and the ingress picks a replica per connection. TCP keepalive probes do not count as traffic for that limit.
- **Scale:** from zero, on open connections (`concurrentConnections` 1). A connection to Docling at 0 replicas is accepted and its request held while the first replica starts, then answered: 74 s in test (2026-11-20, issue 867), from the worker with Node's `fetch`, whose undici client gives up connecting after 10 s, as the worker's Docling client does, so the connection was accepted within those 10 s and the rest of the wait was for the answer. The Docling client then waits hours for the answer, so a cold start only makes the first conversions later; nothing in the worker waits or retries for it. Azure scales in after 300 s below its target, picking replicas without regard to their work: on 2026-11-21 two probe connections started 4 replicas (`http-scaler`, `upstream_rq_total`), which went to 3 at 06:56:25 UTC, and a connection a probe was polling on was closed about 10 s later. A stopped replica is given 600 s (`terminationGracePeriodSeconds`), but docling-serve waits only for a request in flight, not for a task between polls, so its task is lost. When 16 new connections find no replica with the task, the worker submits the file again, at most 3 times a try in all, and logs `docling task lost` each time.
- **Spread:** one task a replica (issue 922). docling-serve's `local` engine runs one task at a time but accepts more and queues them in memory, and the TCP ingress spreads connections, not work: on 2026-11-21 in test three conversions sat on one replica, which grew from 4.3 to 7.9 GiB in 30 minutes and was killed with exit code 137 while the other replicas idled at 0.85 GiB. So a replica that holds a task (pending or started), or is taking one, answers a submit that carries the key with 503, `Retry-After: 15` and its name; one without the key goes on to docling-serve, which answers 401. The worker keeps that connection open for 15 s, so the waiting job still counts toward scaling, and then submits the file again on a new one, which the ingress may send to another replica. A busy answer starts nothing, so it is not one of the 3 submits a try; a try waits at most 50 minutes for its first replica (`doclingBusyLimitMs`), and its document timeout and deadline count from the submit a replica took. Only a 503 that names its replica is busy; another 503 fails the try. A submit whose connection is refused or reset before an answer, as while a replica restarts, is asked again the same way, at most 8 times in a row; one whose answer times out is not. A submit that cannot connect within undici's 10 s (`UND_ERR_CONNECT_TIMEOUT`) waits like a busy answer: the ingress holds a new connection while every replica is taken and the next one starts. On 2026-11-21 in test, while Docling scaled from 1 to 8 replicas and back, such timeouts failed 371 convert attempts in under an hour and dead-lettered 43 jobs, each try failing in 10 s. A replica also keeps memory after a conversion: locally, 0.76 GiB at start, 4.7 GiB after the 452-page file and 5.5 GiB after a 331-page one, which peaked at 7.2 GiB on top of what the first kept. The image sets glibc to give freed memory back sooner (`MALLOC_ARENA_MAX=2`, `MALLOC_TRIM_THRESHOLD_=131072`): idle after the 452-page file, 2.4 GiB instead of 4.4, with the same peak and time. As the bound, a replica that holds no task and no result waiting for its client (a result unfetched for 10 minutes counts as abandoned), with more memory than `GENKI_DOCLING_RESTART_IDLE_GIB` (half of `doclingMemoryGiB`, 4 GiB; the cgroup's usage less its inactive file pages, meant to match Azure's `WorkingSetBytes`), ends its own process with SIGTERM, and Azure starts the container again (models load in about 40 s); it answers busy meanwhile. A replica that cannot read its memory logs `memory unreadable` once and does not restart. A fetched result is gone 1 s later (`DOCLING_SERVE_RESULT_REMOVAL_DELAY`), so a replica can restart within seconds of its last fetch. The middleware reads docling-serve's orchestrator (`tasks`, `_task_results`): a docling-serve upgrade that moves them stops the replica at start, and the middleware's tests (`docker/docling/test_busy.py`) run in the image build.
- **Logs and alerts:** the worker logs one `docling task` line for each task when it ends, with the task id, the file's `sha256`, its `pages` (read with pdf.js before the submit), the submit number, the `replica` that took it, `queuedMs`, `convertingMs`, `busyWaits` and `result` (`success`, `too_large`, `conversion_failed`, `failed` or `lost`); no file name. Each answer to a submit names its replica (`X-Docling-Replica`: `CONTAINER_APP_REPLICA_NAME`, else the host name), and the middleware logs `task accepted`, `task ended`, `busy` and `restarting` at WARNING, each with its replica and the tasks it holds (`running`, `queued`). The alerts `docling-out-of-memory` (exit code 137) and `docling-memory` (a replica's 1-minute peak above 85 % of its memory) go to the alerts' action group; the [runbook](../docs/runbook.md) has the query that lists each replica's tasks.
- **Keeps:** no volume; uploads over 1 MB spooled to the replica's `/tmp`, each region Tesseract reads written there as an image and deleted when read, and results in memory, single-use and removed `DOCLING_SERVE_RESULT_REMOVAL_DELAY` (1 s) after they are fetched, while a result never fetched, such as one whose request was cut, stays until the replica stops; `DOCLING_SERVE_LOG_LEVEL=WARNING`. Docling's Tesseract stage logs OCR failures at ERROR with the uploaded file's name and the page; no text. All of it is gone when the replica stops. The API docs, version, capabilities and metrics routes are off; the status, result and clear routes stay, behind the key.

**Before the first deploy with it,** create the Key Vault secret `docling-api-key` (`openssl rand -base64 32`). The worker and the server read it, and, as for the secrets above, a secret missing behind its name stops the revision from starting: the worker's included.

**Check it** after a deploy, from the worker, with a PDF that takes more than five minutes (an image-only Kudos report of 30 pages or more), so the polled connection is shown to last past the 300 s idle limit:

```sh
az containerapp exec -g <resource group> -n genai-<env>-worker \
  --command "node scripts/docling-check.ts https://kudos.dfo.no/dokument/73b8a416-7746-4816-b7bc-de228880168a/filer/b9e6d79a-a23d-4f4f-bf35-13c61735b173.pdf"
```

It prints one line for the conversion (`http` 200, `status` `success`, `seconds`, `pages`, `characters`) and one for the same request without the key (`http` 401). A first request after the server was idle also waits for a replica to start (74 s in test). Then, after five minutes with no conversion, `az containerapp replica list -g <resource group> -n genai-<env>-docling` lists none.

Not checked yet:

- whether the environment's Consumption cores allow 8 Docling replicas (32 vCPUs) beside the other apps;
- how often scale-in stops a converting replica at the end of a run: count `docling task lost` in the worker's logs;
- that `X-Docling-Replica` matches the `podName` of Azure's metrics in test, and how long a replica takes to restart there;
- that a replica reads its memory in Azure (`/sys/fs/cgroup/memory.current`; no `memory unreadable` line), and that the value is close to `WorkingSetBytes`;
- whether a run's jobs wait long for a replica: `busyWaits` on the `docling task` lines.

`az containerapp exec` needs a terminal: from a script, run it under `script -q <log file> az containerapp exec ...`.

## Database

The API and worker log in to Postgres with the app's managed identity and an Entra ID token as the password (`PGHOST`, `PGUSER`, `PGDATABASE`, `PGSSLMODE`, `AZURE_CLIENT_ID`). The token is fetched when a connection opens and reused until five minutes before it expires. `DATABASE_URL` still wins when set, which is how local development connects. `DATABASE_POOL_MAX` caps each of a process's two pools to the platform database, the owner's and the store pool's; unset, each opens up to 10, and less than 3 refuses to start, since the store pool keeps two connections listening. The template sets it from `apiDatabasePoolMax` and `workerDatabasePoolMax`: 10 in test, where the B2s server takes 414 connections from users, and in prod. A request waits at most 10 seconds for a free connection of a pool (`connectionTimeoutMillis`); then it fails, and the API answers 503 with `Retry-After`, instead of queuing behind a starved pool. Azure keeps a server's first `max_connections` through a resize, so the template sets the platform server's from the table ([Azure: limits](https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/concepts-limits#maximum-connections)); a change waits for a restart. `scripts/postgres-connections.test.ts` adds up every pool full, two API revisions at most replicas, the worker and one connection for a one-off job, for each phase of a deploy, and fails when a sum passes the server's user connections in `infra/postgres-connections.json`. In test every phase fits at 101 of 414. The worker there runs in multiple revision mode (`workerRevisionsMode`), so `scripts/worker-revisions.sh` stops it before each deploy that applies the template (`candidate`, `deploy-test` and `infra.yml`) and after it settles on exactly one running worker revision, whatever the deploy did: it cancels the run's deployment if a cancelled run left it going in Azure, keeps the newest revision once it runs, and otherwise starts the last good one again and fails the step. Old and new worker never run together. Background work pauses for the deploy: queued jobs wait, the stop gives running jobs 10 seconds to finish, and one it cuts off is retried once its heartbeat lapses, or kept as a dead letter when its queue has no retries left, as on any worker restart, and the leases are advisory locks that end with the worker's connection. Prod keeps single revision mode, where Azure starts the new worker before it stops the old one. The worker holds all its leader leases on one connection (`PostgresLeases`), which it checks every 10 seconds with a 5 second query timeout. A worker counts as leader only within 15 seconds of its last good check, so it stops leading on its own clock long before the server would drop a silent connection's locks (`tcp_keepalives_idle` 120 seconds on test's server); when the connection stops answering, it opens a new one and takes the leases back once they are free. An alert fires when the server has more than 80 % of its user connections open ([runbook](../docs/runbook.md), Database connections).

The app identity owns the schema and runs migrations. Queries run as `genai_runtime` (no BYPASSRLS), switched per connection with the `role` option, so row-level security applies (ADR 0022). The worker switches to `genai_worker` instead: a member of `genai_runtime` with the same row-level security, and of the roles the apps run queries as, the only one with rights on the `pgboss` job tables (ADR 0041). The migration creates both roles and lets the app identity switch to them.

The server allows the `vector` extension through its `azure.extensions` setting (`VECTOR`, in `modules/postgres.bicep`, for test and prod alike). Azure Postgres refuses `create extension` for any extension not on that list, and the pgvector engine creates `vector` when it first migrates. To allow more extensions later, add them to the same comma-separated value.

## Backups

What is kept and how to restore it is in the [runbook](../docs/runbook.md#backups). In the template:

- `postgresBackupRetentionDays` (35 in test) and `postgresMaintenanceWindow` (Sundays 02:00 UTC in test; Azure's own choice of time, as before, by default and on the knowledge server).
- `backupsEnabled`: `modules/files-backup.bicep` (the vault and the daily share backup), `modules/platform-backup.bicep` (the copies' storage account, reachable only through a private endpoint in the subnet `endpoints` (`endpointsSubnetPrefix`), its immutability policy and the backup identity's one role, Storage Blob Data Contributor on the container, which the deploy identity may already assign), the identity `<name>-backup-id`, and the jobs `<name>-pg-backup` and `<name>-pg-restore-check` in `modules/containerapps.bicep`. The dump runs in the official `postgres` image pinned by digest (`pgDumpImage`); keep its major version at `postgresVersion`.
- `infraBudgetAmount`, `modelsBudgetAmount` and `modelsBudgetResourceGroup`: `modules/budget.bicep`, with the alerts' action group.

Four settings stay off in test, since the deploy identity (Contributor and a limited Role Based Access Control Administrator on the resource group) cannot write what they need:

| Setting                            | Needs                                                                                                 | Until then                                                                                                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resourceLocksEnabled`             | `Microsoft.Authorization/locks/write`, in Owner or User Access Administrator; Contributor excludes it | An owner makes the locks once: `az lock create -n do-not-delete -t CanNotDelete -g <resource group> --resource <name> --resource-type <type>` for the platform server, the storage account, the copies' storage account and Key Vault |
| `serviceHealthAlertEnabled`        | A rule scoped to the subscription, where the deploy identity has no role                              | An owner gives the deploy identity Monitoring Contributor on the subscription, or makes the rule by hand as in `modules/alerts.bicep`                                                                                                 |
| `platformBackupImmutabilityLocked` | An owner locks the copies' immutability policy (runbook, "Backups")                                   | Set it to `true` once locked, so the template no longer sends the policy                                                                                                                                                              |
| `modelsBudgetResourceGroup`        | Cost Management Contributor (or Contributor) on `rg-genki-test-swc`                                   | Set it to `rg-genki-test-swc` once the role is there                                                                                                                                                                                  |

Changing `postgresSkuName` restarts the server during the deploy, for a few minutes, and the new `max_connections` waits for one more restart: deploy it in a quiet window and restart the server after (`az postgres flexible-server restart`).

## Knowledge server

Each environment has a knowledge server of its own (ADR 0042), set up as its platform server is: private access in a delegated subnet, its own private DNS zone, Entra ID auth only. Each holds only its own environment's data and is bound to its own platform server. Test's has run since 2026-11-04; prod's is in the template, switched on with the same steps when genki prod runs.

| Resource                                           | Notes                                                                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `genai-<env>-knowledge-vnet`                       | Test `10.43.0.0/24`, prod `10.42.0.0/24`: one delegated `postgres` subnet, peered both ways with `genai-<env>-vnet`. A server can never move network, so a network peered with it later reaches only the knowledge server |
| `genai-<env>-knowledge-<suffix>`, PostgreSQL 17    | `Standard_D2ds_v5` (2 vCores, 8 GiB) and 64 GB in both to start, 7-day backups, not geo-redundant, no standby, all `knowledgePostgres*` parameters. Database `genai_knowledge`                                            |
| Its private DNS zone                               | `genai-<env>-knowledge-<suffix>.private.postgres.database.azure.com`, linked to the knowledge network and the environment's own                                                                                           |
| `genai-<env>-knowledge-api-id`, `-worker-id`       | The API's and the worker's own logins: the API's may act only as `genai_knowledge_reader`, the worker's as the writer and the owner                                                                                       |
| `genai-<env>-knowledge-admin-id`                   | An Entra admin of the environment's knowledge server beside its admin group, held only by its principals job                                                                                                              |
| `genai-<env>-knowledge-setup` (Container Apps job) | Started by hand: makes the two logins and sets up the database                                                                                                                                                            |

- **Settings:** `azure.extensions` is `VECTOR,PG_PREWARM` and `shared_preload_libraries` is `pg_stat_statements,pg_prewarm` (PostgreSQL 17's default is `pg_stat_statements`). `shared_preload_libraries` is static: the server takes it only after a restart ([Azure: set a parameter](https://learn.microsoft.com/en-us/azure/postgresql/parameters/how-to-parameters-set-value)).
- **Size:** start small and grow. Compute moves up or down with a restart, 10 to 30 seconds with Azure's near-zero downtime scaling ([Azure: scaling](https://learn.microsoft.com/en-us/azure/postgresql/scale/concepts-scaling-resources)); the disk only grows, and autogrow doubles it when it runs low ([Azure: autogrow](https://learn.microsoft.com/en-us/azure/postgresql/scale/how-to-auto-grow-storage)). After an autogrow, raise `knowledgePostgresStorageSizeGB` to the new size: Azure does not shrink a disk, so a smaller value in the template is refused. For Kudos, binary quantisation would keep the vector index at about 1.5 GB instead of 12.7 GB, by extrapolation from 0.47 GB at 1 million vectors (issue 265 measures it at about 3 million).
- **Connections:** `max_connections` stays at Azure's default, 859 on `Standard_D2ds_v5` with 15 reserved ([Azure: limits](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-limits)). Prod's pools need at most 162: the API's reader pool takes 20 per replica (`KNOWLEDGE_DATABASE_POOL_MAX`'s default), the worker's owner and writer pools 20, pg-boss uses those pools (ADR 0041), counted twice for a deploy, for 3 API replicas, plus 2 for the job. Test's need at most 122, for 2 replicas.
- **pgvector:** Azure lists 0.8.2 for PostgreSQL 17 ([Azure: extension versions](https://learn.microsoft.com/en-us/azure/postgresql/extensions/concepts-extensions-versions)); the job's log shows the version the server runs (`extensions`). The VACUUM workaround of ADR 0042 holds until it is 0.8.4 or later.
- **Only its own logins connect:** the setup revokes `CONNECT` from `PUBLIC` and grants it to the environment's two logins and `azure_pg_admin`, since roles are global to a server. It fails when a grant it cannot remove is left, or while another role holds one of the logins with inherit or set.

### Disk tier

`knowledgePostgresPerformanceTier` sets the disk's performance tier. Empty, the default, sends no tier, as the template did before it had one. What Azure then does to a tier raised by hand is not documented; in test, three deploys that sent no tier kept the hand-raised P30 (2026-11-14 17:00 and 17:21, 2026-11-15 06:53 UTC). Test sets `P30` (issue 599); prod sets none.

A disk's size sets its lowest tier, and a 128 GB disk can go up to P50 ([Azure: performance tiers](https://learn.microsoft.com/en-us/azure/virtual-machines/disks-change-performance)). At 128 GB ([Azure: disk targets](https://learn.microsoft.com/en-us/azure/virtual-machines/disks-scalability-targets)):

| Tier            | Base IOPS | Base MB/s |
| --------------- | --------: | --------: |
| P10 (the floor) |       500 |       100 |
| P15             |     1,100 |       125 |
| P20             |     2,300 |       150 |
| P30             |     5,000 |       200 |

The server's compute has limits of its own: `Standard_D2ds_v5` supports at most 3,750 IOPS and 85 MiB/s ([Azure: compute](https://learn.microsoft.com/en-us/azure/postgresql/compute-storage/concepts-compute)). The page does not say how they combine with the disk's, and the recall check below reads past both.

Disks of the P20 size and smaller burst on credits, to 3,500 IOPS and 170 MB/s for up to 30 minutes ([Azure: disk bursting](https://learn.microsoft.com/en-us/azure/virtual-machines/disk-bursting)); whether a disk raised to a higher tier still bursts is not documented. In test, the Kudos fill ran out of burst credits on 2026-11-14, and at P30 on 2026-11-15 it read at hourly maxima of 3,600 to 4,200 IOPS.

**For a full fill or a new embedding model,** raise the tier first and step it back afterwards:

1. Set `knowledgePostgresPerformanceTier = 'P30'` in `infra/env/<env>.bicepparam` and run infra. Both `infra.yml` and `deploy.yml` deploy `main.bicep` with the environment's parameters, so merge the raise to main before the fill. A tier raised above the file's only by hand (`az postgres flexible-server update -g <resource group> -n <server> --performance-tier P30`) or from a branch makes every infra run and every deploy that applies the whole template fail for 12 hours (step 3), and the first such run after that lowers it, fill or not; a deploy that skips the infrastructure leaves the tier as it is.
2. Run the fill. Watch `disk_iops_consumed_percentage` and `disk_bandwidth_consumed_percentage` on the server in Azure Monitor: at 100 % the disk is holding the fill back.
3. After the fill, set the file back to the lower tier, and merge it no sooner than 12 hours after the raise. Azure lowers a tier only 12 hours after the last raise, and refuses an earlier change with `PerformanceTierCannotBeDowngradedBefore12HoursError`, so an earlier infra or deploy run fails ([Azure: scale storage performance](https://learn.microsoft.com/en-us/azure/postgresql/scale/how-to-scale-storage-performance)). Whether a tier change restarts a flexible server is not documented.

Size the tier by the two `consumed_percentage` metrics, not by `read_iops` or `read_throughput`. The nightly recall check (`knowledge.check`, ADR 0042) runs from the window's start, one sequential scan per sample over the partition of each active generation on the knowledge server. On 2026-11-16 it took 63 minutes, for 160 samples at about 625,000 chunks, and takes longer above 2 million chunks, where its floor of 50 samples reads more than its budget, or when chunks are larger. From 00:00 to 01:03 UTC it read about 6,000 IOPS and 204 MB/s, while both consumed metrics stayed at 0 to 10 %.

### Stages

`KNOWLEDGE_SERVER_STAGE`, a GitHub variable read by `infra.yml` and `deploy.yml`, set on the environment or, without access to environment settings, as a repository variable (then prod's environment needs `none` set, since a repository variable reaches every environment and an environment's own value wins): `none` (the default, and what an unset variable means: nothing of the knowledge server), `server` (the network, the server, the identities, the job, and Storage Blob Data Contributor on the container `conversions` for the knowledge worker identity), `apps` (also the API and worker settings: `KNOWLEDGE_PGHOST`, `KNOWLEDGE_PGDATABASE`, `KNOWLEDGE_READ_PGHOST` on the same server, each app's own `KNOWLEDGE_PGUSER` and `KNOWLEDGE_AZURE_CLIENT_ID`, and the worker's `KNOWLEDGE_VCORES`, `CONVERSIONS_BLOB_URL` and its readiness probe on `/readyz`). The worker stops at start while it has no login, so `apps` waits until the job has set up the database.

Per environment, test first. The steps infra cannot do run in the `knowledge-server` workflow (`.github/workflows/knowledge-server.yml`), as the deploy identity, so they need GitHub access only:

0. **A release with the setup script:** run `deploy.yml` with this change, stage still `none`. The job runs `scripts/knowledge-server-setup.ts` from the worker image, and `infra.yml` reuses the image that runs.
1. **`server`:** set `KNOWLEDGE_SERVER_STAGE=server`, run infra with what-if, read it, then without. Then run `knowledge-server` with `restart`, which restarts the server only while `shared_preload_libraries` waits for it.
2. **The database:** run `knowledge-server` with `setup`. It starts the job `genai-<env>-knowledge-setup`, waits for it and prints its log (below), and fails when the job does.
3. **`apps`:** set `KNOWLEDGE_SERVER_STAGE=apps` and run infra. Then run `knowledge-server` with `check`: the server, its settings and Entra admins, both sides of the peering, the last job run, the apps' revisions and the API's `/health`. It fails on a server that is not ready, a restart still waiting, a peering side that is not `Connected`, an unhealthy revision or a `/health` other than 200.
4. **The peering through a redeploy:** run infra once more, then `check` again: both sides of the peering stay `Connected`. Infra redeploys `genai-<env>-vnet` without its peerings, and from `apps` on the apps reach the knowledge server only through them.

A job run is safe to repeat: logins that exist are kept, and the setup changes nothing it already set.

### What the job's log shows

After setup the job prints the server's settings, extensions, logins, memberships and who may connect, so the checks need no way into the private network:

- `settings.azure_extensions` lists `VECTOR` and `PG_PREWARM`, `settings.shared_preload_libraries` includes `pg_prewarm`, and `extensions` names the `vector` version.
- `logins` holds no `genai-<env>-api-id`: the shared app identity has no role on the knowledge server.
- `memberships` lists every role the two logins are members of: the API's login only `genai_knowledge_reader`, the worker's only `genai_knowledge_owner` and `genai_knowledge_writer`, all with `inherit_option` false. Any other role there needs a look.
- `connect` lists only the two logins, `azure_pg_admin` and the database's owner, never `public`.
- `members` lists the roles that hold one of the two logins: the role that created it, with `admin_option` only, and possibly the setup's own admin or an `azure_pg_admin` member with inherit or set. The setup fails on any other role that may inherit or set a login.

### Restore drill

A restore always creates a new server; the source is left as it is ([Azure: backup and restore](https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore)). Time one before a service depends on the server, and again with Kudos loaded (issue 148): run `knowledge-server` with `restore-drill`, which restores to `genai-<env>-knowledge-restore-drill` as of ten minutes earlier, prints the time and deletes the restored server, also when a step fails. It runs:

```sh
time az postgres flexible-server restore -g <resource group> -n genai-<env>-knowledge-restore-drill \
  --source-server <server> --restore-time <a UTC time a few minutes ago, such as 2026-11-04T09:00:00Z> \
  --vnet genai-<env>-knowledge-vnet --subnet postgres \
  --private-dns-zone <server>.private.postgres.database.azure.com
az postgres flexible-server show -g <resource group> -n genai-<env>-knowledge-restore-drill --query state
az postgres flexible-server delete -g <resource group> -n genai-<env>-knowledge-restore-drill --yes
```

The restored server keeps neither the source's parameters nor its network rules, so a real restore sets `azure.extensions` and `shared_preload_libraries` again, and the template must then name the new server. Test's empty server took 615 s (10 min 15 s) to restore, on 2026-11-04.

### Checked on test

Test went through the stages on 2026-11-04. What the documentation left open:

- **The peering survives an infra run:** after the second run at `apps`, `check` showed both sides `Connected`. The what-if lists changes under `virtualNetworkPeerings` that the deploy does not make ([arm-template-whatif #278](https://github.com/Azure/arm-template-whatif/issues/278)), so read `check`, not the what-if.
- **The readiness probe reaches the worker without ingress:** the worker's revision with the probe is Healthy.
- **The knowledge admin may revoke `CONNECT` on the database the template created:** the first `setup` left `connect` with only the two logins and `azure_pg_admin`.
- **Two servers can share the delegated subnet and the private DNS zone:** the restore drill's server reached Ready in them.
- **`setup` reads a finished job's log** from the job's log stream (`az containerapp job logs show`).

### Open

- Whether the peering drops for a moment during a run: `check` sees only the state after it. A `deploy.yml` run, which deploys the same template, has not been checked at `apps` yet.
- The `setup` action's fallback to the `ContainerAppConsoleLogs` table in Log Analytics has not run, since the log stream answered.

## Settings and secrets

Plain settings come from the GitHub environment's variables (Settings → Environments → test or prod → Variables), read by the parameter file with `readEnvironmentVariable`:

| Variable                                                                   | For                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANSATTPORTEN_ISSUER`                                                      | Login for people, API and apps. Required: the API does not start without it                                                                                                                                                                                                                                                                                                           |
| `PORTAL_CLIENT_ID`, `WORKSPACE_CLIENT_ID`                                  | Ansattporten client ids of the portal and workspace. With `CONSOLE_CLIENT_ID` they also make up the API's `EMPLOYEE_CLIENT_IDS`, the only clients besides tenant-registered ones whose Ansattporten logins the API accepts; `main.bicep` sets it, so it needs no variable of its own. The API refuses to start with it empty                                                          |
| `CONSOLE_CLIENT_ID`, `CONSOLE_TOKEN_ENDPOINT`                              | The console's login (its issuer defaults to `ANSATTPORTEN_ISSUER`)                                                                                                                                                                                                                                                                                                                    |
| `ALTINN_PDP_URL`                                                           | The Altinn decision point. Required: the API does not start without it                                                                                                                                                                                                                                                                                                                |
| `ALTINN_PDP_MASKINPORTEN_CLIENT_ID`                                        | The Maskinporten client that asks the decision point                                                                                                                                                                                                                                                                                                                                  |
| `MASKINPORTEN_ISSUER`, `MASKINPORTEN_TOKEN_URL`                            | Maskinporten, for the decision point and for systems calling the API                                                                                                                                                                                                                                                                                                                  |
| `OPERATOR_SUBJECTS`                                                        | People with the operator role: comma-separated `issuer\|subject` pairs of Ansattporten logins. The API refuses to start with a bare subject or without `OPERATOR_CLIENT_IDS`. A listed person is an operator only when logging in through one of those clients. Maskinporten clients never become operators                                                                           |
| `ALTINN_PEOPLE_URL`                                                        | Test only. Altinn's platform address for the Tilgang people list, `https://platform.tt02.altinn.no` in test. Unset leaves the list off: Tilgang says Altinn is not connected. Once set, the API needs `access-person-key-secret` in Key Vault and does not start without it. See [Tilgang people list](#tilgang-people-list)                                                          |
| `ALTINN_PEOPLE_MASKINPORTEN_CLIENT_ID`, `ALTINN_PEOPLE_MASKINPORTEN_SCOPE` | Test only, optional. The people list's own Maskinporten client, which then needs `altinn-people-maskinporten-key` in Key Vault, and its scope. Unset, the list uses the decision point's client and `altinn:accessmanagement/enduser:connections:toothers.read`                                                                                                                       |
| `ALTINN_RESOURCE`                                                          | Test only. The Altinn resource whose rights count in genki                                                                                                                                                                                                                                                                                                                            |
| `PLATFORM_TENANT`                                                          | Test only. The organisation that plays Digdir, for test organisations. Empty means Digdir                                                                                                                                                                                                                                                                                             |
| `FOUNDRY_OPENAI_BASE_URL`, `FOUNDRY_CLAUDE_BASE_URL`, `TYPESENSE_URL`      | Models and search                                                                                                                                                                                                                                                                                                                                                                     |
| `LANGFUSE_BASE_URL`, `LANGFUSE_INSTANCE_RECEIVES_CONTENT`                  | Digdir's Langfuse, offered in the portal's Langfuse connection form; `true` once it may receive text (ADR 0011). Unset: the form asks only for an agency's own Langfuse. Test sets the URL in `test.bicepparam`, and the content flag is `true` there unless the variable is set                                                                                                      |
| `TRACES_ENDPOINT`, `TRACES_RESIDENCY`                                      | Test only. Where genki sends its own traces (`https://<host>/api/public/otel`) and where that store is (`norway`, `eu` or `global`). Needs the two Langfuse keys in Key Vault                                                                                                                                                                                                         |
| `CUSTOM_DOMAINS_STAGE`                                                     | `none`, `hostnames` or `certificates`; see Host names below                                                                                                                                                                                                                                                                                                                           |
| `KNOWLEDGE_SERVER_STAGE`                                                   | `none`, `server` or `apps`; unset or empty means `none`. On the test environment, or a repository variable when environment settings are out of reach. See [Knowledge server](#knowledge-server)                                                                                                                                                                                      |
| `LOCKDOWN_ENTRA_GROUPS`                                                    | Test only. Entra group object ids, comma separated, whose members get the whole platform in lockdown                                                                                                                                                                                                                                                                                  |
| `LOCKDOWN_USER_GROUPS`                                                     | Test only. Entra group object ids, comma separated, whose members get every right in `PLATFORM_TENANT` in lockdown, as `LOCKDOWN_ENTRA_GROUPS` does, but never the operator role. Same client and email checks; `LOCKDOWN_ENTRA_GROUPS` wins for a login in both                                                                                                                      |
| `LOCKDOWN_SERVICE_GROUPS`                                                  | Test only. Entra group object ids, comma separated, meant for Digdir's all-employees group. A member who logs in through a client in `LOCKDOWN_SERVICE_CLIENT_IDS` may invoke that client's service and use their own conversations and feedback, and nothing else: no platform rights, models only through that service. Same email check; the two groups above win where they apply |
| `LOCKDOWN_SERVICE_CLIENT_IDS`                                              | Test only. The Ansattporten client ids, comma separated, through which `LOCKDOWN_SERVICE_GROUPS` members may log in, such as Kunnskapsassistenten's. Each must be registered in `PLATFORM_TENANT` as a frontend of its service, and none may be a platform client. In lockdown the API refuses to start with `LOCKDOWN_SERVICE_GROUPS` and without it                                 |
| `LOCKDOWN_ENTRA_EMAIL_DOMAIN`                                              | Test only. Extra guard for those Entra logins: the email must be at this domain. Set it to `digdir.no`; empty turns it off                                                                                                                                                                                                                                                            |
| `OPERATOR_CLIENT_IDS`                                                      | Test only. The Ansattporten client ids, comma separated, whose Entra logins count for `LOCKDOWN_ENTRA_GROUPS` and `LOCKDOWN_USER_GROUPS`: the portal, workspace and console clients (each app's `OIDC_CLIENT_ID`). Set it before deploying: in lockdown the API refuses to start with either group setting and without it                                                             |
| `ALERT_EMAILS`                                                             | Email addresses that get the alerts, comma separated. Set it per environment, test and prod; never in the repository. Empty means the alerts fire in the portal without notifying anyone. See the [runbook](../docs/runbook.md#alerts)                                                                                                                                                |

`test.bicepparam` also sets `GATEWAY_USAGE_URL` and `GATEWAY_USAGE_APP_*` in `appEnv`, so the API and the worker read the AI gateway's usage as genki's app `genki-test-ai-gateway`, with no secret ([gateway.md](../docs/api/gateway.md#operator-steps-for-genki-test)). Prod has none yet.

`test.bicepparam` also sets `GENAI_LOCKDOWN=true` in `appEnv`, not from a variable: genki-test is always locked. In lockdown only API keys from configuration and people who log in through Ansattporten with Entra ID and are in one of `LOCKDOWN_ENTRA_GROUPS` may use models or run ingestion. Those Entra logins, only from the clients in `OPERATOR_CLIENT_IDS` and never through a client a tenant registered, get every right in `PLATFORM_TENANT` and the operator role. The `operator: true` persons in the image's `identity.yaml` count only for the dev-mode mock login and are ignored, with a log line, everywhere else. TestID logins and operators can only read and search; API keys and Maskinporten clients created by such an Entra login may use models and run ingestion within their own bindings; other keys made through the API can read, search and change configuration, but not run anything that reaches a model, fetches documents or writes new embeddings, and scheduled ingestion is skipped. `appEnv` reaches the worker too, which then runs no triggers. See [ADR 0033](../docs/adr/0033-locked-test-environment.md).

The API audience (`digdir:genai`) has a default in `main.bicep`. genki-test reads the Altinn resource from `ALTINN_RESOURCE` and uses `urn:altinn:resource:digdir-genai-platform-test`. `prod.bicepparam` fixes the resource to `urn:altinn:resource:digdir-genai-platform` and the platform tenant to Digdir, and sets no `GENAI_LOCKDOWN`, so neither variable has any effect in prod.

Secrets live only in Key Vault. Each name in `keyVaultSecretNames` becomes an environment variable in the API and worker, which the platform reads as `secret://env/<name>`:

| Key Vault secret                 | Env var in the app                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `content-master-key`             | `CONTENT_MASTER_KEY`                                                                                                                 |
| `content-master-key-<n>`         | `CONTENT_MASTER_KEY_<n>`, only while rotating the content master key ([ADR 0070](../docs/adr/0070-versioned-content-master-keys.md)) |
| `platform-login-subject-key`     | `PLATFORM_LOGIN_SUBJECT_KEY`, the derived subject key, needed with the platform login on once `content-master-key` is removed        |
| `altinn-pdp-maskinporten-key`    | `ALTINN_PDP_MASKINPORTEN_KEY`                                                                                                        |
| `altinn-subscription-key`        | `ALTINN_SUBSCRIPTION_KEY`                                                                                                            |
| `foundry-openai-key`             | `FOUNDRY_OPENAI_KEY`                                                                                                                 |
| `foundry-claude-key`             | `FOUNDRY_CLAUDE_KEY`                                                                                                                 |
| `typesense-key`                  | `TYPESENSE_KEY` (search only)                                                                                                        |
| `langfuse-public-key`            | `LANGFUSE_PUBLIC_KEY` (test)                                                                                                         |
| `langfuse-secret-key`            | `LANGFUSE_SECRET_KEY` (test)                                                                                                         |
| `access-person-key-secret`       | `ACCESS_PERSON_KEY_SECRET` (test, once `ALTINN_PEOPLE_URL` is set)                                                                   |
| `altinn-people-maskinporten-key` | `ALTINN_PEOPLE_MASKINPORTEN_KEY` (test, once `ALTINN_PEOPLE_URL` and `ALTINN_PEOPLE_MASKINPORTEN_CLIENT_ID` are set)                 |

`docling-api-key` is not in `keyVaultSecretNames`: the template gives it only to the worker (`DOCLING_API_KEY`) and the Docling server (`DOCLING_SERVE_API_KEY`), see [Docling server](#docling-server). Create it like the others.

Create every secret in Key Vault before the first deploy, or remove its name from the parameter file. A name listed without a secret behind it stops the revision from starting. `CONTENT_MASTER_KEY` is 32 random bytes, base64: `openssl rand -base64 32`. To rotate it, follow [ADR 0070](../docs/adr/0070-versioned-content-master-keys.md#rotation-procedure): the new key is one more name in `keyVaultSecretNames` and `CONTENT_MASTER_KEY_ACTIVE` in `appEnv`, with no template change.

Development mode is off: the image sets `NODE_ENV=production`, and the API refuses `GENAI_DEV_MODE=true` there.

## Host names and DNS

| Host name                           | Container app          |
| ----------------------------------- | ---------------------- |
| `api.genki-test.digdir.cloud`       | `genai-test-api`       |
| `portal.genki-test.digdir.cloud`    | `genai-test-portal`    |
| `workspace.genki-test.digdir.cloud` | `genai-test-workspace` |
| `console.genki-test.digdir.cloud`   | `genai-test-console`   |
| `assistant.genki-test.digdir.cloud` | `genai-test-assistant` |

`genki-test.digdir.cloud` is delegated to an Azure DNS zone the team controls. The template creates the zone (`createDnsZone`) with, per host name:

- `CNAME <name>` → the container app's generated host name (output `appUrls`)
- `TXT asuid.<name>` → the environment's verification id (output `customDomainVerificationId`)

The owner of `digdir.cloud` delegates the zone once: an `NS` record for `genki-test` in `digdir.cloud` with the four name servers from the output `dnsNameServers`.

Custom domains are added in three runs, because Azure only issues a managed certificate for a host name already on the app:

1. `CUSTOM_DOMAINS_STAGE=none` (default): the first run works before DNS exists. The apps answer on their generated host names.
2. `CUSTOM_DOMAINS_STAGE=hostnames`, once the delegation is in place: adds the host names without certificates.
3. `CUSTOM_DOMAINS_STAGE=certificates`: creates the managed certificates (validated by CNAME) and binds them. Leave it at this value from then on.

Certificates created outside the template, for example in the Azure portal, go in `existingCertificates` in the parameter file, by app. The certificates stage then binds them as they are and creates none of its own; Azure allows only one managed certificate per host name in an environment. genki-test uses this.

Without the DNS zone, create the same CNAME and TXT records wherever `genki-test.digdir.cloud` is hosted.

`assistant.genki-test.digdir.cloud` is the assistant host's (ADR 0061), bound only while `assistantHostEnabled` is on. Its app runs in its own environment, `<name>-hosted-env`, so its `TXT asuid.assistant` record carries that environment's verification id (output `assistantHost.verificationId`), and its managed certificate is created in that environment. Its stage is `assistantHostnameStage`, the same stages as `CUSTOM_DOMAINS_STAGE` and the same value unless set, bound on the host alongside the hosted hostnames below; a new host starts it at `none`, since Azure binds a name only once its DNS points at the host. The template sets `GENAI_ASSISTANT_HOSTNAME` on the API to it and opens it to `PLATFORM_TENANT` in `GENAI_HOSTED_HOSTNAMES`; it is not an entry in `hostedHostnames`.

### Hosted hostnames

A hosted service is served by the assistant host (`<name>-assistant`, ADR 0061) on a name genki assigns in its own zone, `<subdomain>.apps.<zone>` such as `kunnskap.apps.genki-test.digdir.cloud`, or on a custom domain the service owns, such as `qa.kunnskap.digdir.cloud`. Either is added with a pull request to the environment's parameter file, and one entry in `hostedHostnames` does every part:

```bicep
param hostedHostnames = [
  { subdomain: 'kunnskap', tenant: '991825827', stage: 'certificates' }
  { hostname: 'qa.kunnskap.digdir.cloud', tenant: '991825827', stage: 'certificates' }
  { hostname: 'kunnskap.digdir.cloud', tenant: '991825827', stage: 'hostnames', apex: true }
]
```

- **A subdomain is the default.** It is one lowercase DNS label (letters, digits and hyphens, no dots, at most 63 characters) and becomes `<subdomain>.apps.<dnsZoneName>`. genki assigns these names; nothing is claimed in its zone. The template writes the CNAME to the host's generated host name and the `TXT asuid.<subdomain>.apps` record in genki's own DNS zone, as it does for the four app hostnames, so no one else touches DNS. The `apps.` level holds these names alone: no app hostname and no custom domain may sit there. Each name gets its own managed certificate; there is no wildcard.
- **A custom domain is the option** for a service that has its own: `hostname` instead of `subdomain`.
- The API gets every entry as `GENAI_HOSTED_HOSTNAMES` (`host=tenant,host=tenant`), which opens the hostname to that organisation: only its hosted Clients may then name it in `spec.hostnames`, and only then does `GET /v1/hosts/{hostname}` answer.
- The assistant host binds every entry whose `stage` is past `none`, with a managed certificate in `<name>-hosted-env`. The stages are those of `CUSTOM_DOMAINS_STAGE`, per hostname, since a new hostname must be on the app before Azure issues its certificate: `none` (the API only), then `hostnames` once DNS points at the host, then `certificates`. Each step is its own pull request and deploy. The four app hostnames above keep `hostnames` and `CUSTOM_DOMAINS_STAGE` as before.
- `apex: true` is for a zone apex, which can have no CNAME: an A record to the host environment's static IP, and a certificate validated over HTTP instead of CNAME.
- The records a custom domain needs are in the output `assistantHost.dnsRecords`: a CNAME to the host's generated host name (an A record to `assistantHost.staticIp` for an apex), and `TXT asuid.<hostname>` with `assistantHost.verificationId`. They go in the owner's DNS zone, which the template does not write. A CAA record on the domain, if any, must allow `digicert.com`.
- A subdomain's records are written by the deploy that applies the whole template, while its stage is still `none`; move it to `hostnames` in the next pull request.
- Nothing binds while `assistantHostEnabled` is off, but the API still opens the hostname.
- `scripts/hosted-hostnames-infra.test.ts` checks every entry in both parameter files: either a subdomain that is one valid label or a lowercase hostname outside genki's own zones, a nine-digit organisation number, a known stage, and no name twice; and that none of the four app hostnames sits under `apps.`.

Removing an entry unbinds the hostname and closes it in the API at the next deploy; the certificate stays in the environment until deleted by hand (`az containerapp env certificate delete`). Moving a team's existing domain is in [docs/runbook.md](../docs/runbook.md#moving-a-teams-domain-to-genki).

### Turning on the assistant host

genki-test runs the assistant host with its BFF (`assistantHostEnabled`, `assistantBffEnabled`), with genki's own `assistant.genki-test.digdir.cloud` (`assistantHostnameStage`) and Kunnskapsassistenten's `kunnskap.apps.genki-test.digdir.cloud` starting at stage `none`. The template cannot do these steps itself; they are for an operator with Azure access (Azure), a genki-test platform operator (genki), and whoever holds the service's Ansattporten client in Samarbeidsportalen (Ansattporten). In order:

1. **Proxy key, before the deploy** (Azure). The host's Key Vault is created by the template, but the host's app reads `genai-proxy-key` from it in the same deploy, so create the vault first with the template's settings and put the same key in both vaults:

   ```sh
   RG=rg-genki-test-weu
   KEY=$(openssl rand -hex 32)
   GENKI_KV=$(az keyvault list -g $RG --query "[?starts_with(name, 'genai-test-kv-')].name" -o tsv)
   az keyvault secret set --vault-name "$GENKI_KV" -n genai-proxy-key --value "$KEY" -o none
   az keyvault create -g $RG -n genai-test-hostkv -l westeurope --enable-rbac-authorization true \
     --enable-purge-protection true --retention-days 90 --public-network-access Enabled -o none
   az role assignment create --role "Key Vault Secrets Officer" --assignee "$(az ad signed-in-user show --query id -o tsv)" \
     --scope "$(az keyvault show -n genai-test-hostkv --query id -o tsv)" -o none
   az keyvault secret set --vault-name genai-test-hostkv -n genai-proxy-key --value "$KEY" -o none
   unset KEY
   ```

   A new role assignment can take a few minutes before the last command is let through.

2. **Deploy** (Azure). After the merge, run **deploy** by hand (`gh workflow run deploy.yml --ref main -f environment=test`); it applies the whole template since `infra/` changed, or tick **infrastructure** if it does not. It creates `genai-test-assistant` in `genai-test-hosted-env` and writes `CNAME` and `TXT asuid` for `assistant` and `kunnskap.apps` in genki's zone. `az deployment group show -g $RG -n main --query properties.outputs.assistantHost.value` shows the host's address and records.
3. **The client secret as a tenant secret** (genki). The service's existing confidential Ansattporten client logs in through the BFF, so its threads stay (`docs/runbook.md`, "Moving a team's domain to genki"). Kunnskapsassistenten's secret is `ansattporten-client-secret` on `ka-app` (`az containerapp secret show --subscription Altinn-AI-Assistant -g rg-ka-test-weu -n ka-app --secret-name ansattporten-client-secret --query value -o tsv`), or a new one from Samarbeidsportalen. Bind it to the issuer only:

   ```sh
   API=https://api.genki-test.digdir.cloud
   curl -fsS -X PUT "$API/tenants/312521172/secrets/kunnskapsassistenten-login" -H "authorization: Bearer $GENKI_TOKEN" \
     -H 'content-type: application/json' -H 'change-reason: Klienthemmeligheten BFF-en logger inn med' \
     -d "{\"value\": \"$CLIENT_SECRET\", \"allowedHosts\": [\"https://test.ansattporten.no\"]}"
   ```

4. **The hosted Client** (genki, an operator, since lockdown lets only an operator mark a Client hosted). Take the service's existing Client, keep its client id, and add the hostname, the secret and the URIs:

   ```sh
   H=kunnskap.apps.genki-test.digdir.cloud
   curl -fsS "$API/tenants/312521172/clients?service=kunnskapsassistenten" -H "authorization: Bearer $GENKI_TOKEN" |
     jq '.clients[0].definition' > client.json   # check that this is the Client with the service's Ansattporten client id
   jq --arg h $H '.spec.hosted = true | .spec.hostnames = [{hostname: $h, environment: "prod"}]
     | .spec.oidc.secret = "kunnskapsassistenten-login"
     | .spec.oidc.redirectUris += ["https://\($h)/auth/callback"] | .spec.oidc.postLogoutRedirectUris += ["https://\($h)/"]' \
     client.json > hosted.json
   curl -fsS -X PUT "$API/tenants/312521172/clients/$(jq -r .metadata.id hosted.json)" -H "authorization: Bearer $GENKI_TOKEN" \
     -H 'content-type: application/json' -H 'change-reason: Kunnskapsassistenten på genkis assistentvert' -d @hosted.json
   ```

5. **Ansattporten** (the client's holder, Samarbeidsportalen for Ansattporten test). On the same client: redirect URI `https://kunnskap.apps.genki-test.digdir.cloud/auth/callback`, post-logout URI `https://kunnskap.apps.genki-test.digdir.cloud/`, `authorization_details` of type `ansattporten:altinn:resource` for `urn:altinn:resource:digdir-genai-platform-test` (the BFF asks for genki's `ALTINN_RESOURCE`), client authentication `client_secret_basic`, and the refresh token grant, without which a session ends when the five-minute access token does.
6. **The layout** (genki). The host draws only a published `spec.interface.layout`: publish it from the portal's Grensesnitt tab. A document link that is a path on the site, such as `/api/api/datasets/kudos/documents/{id}/file`, opens through the BFF on whatever hostname draws the assistant. `curl -s https://api.genki-test.digdir.cloud/v1/hosts/kunnskap.apps.genki-test.digdir.cloud` answers 200 once steps 4 and 6 are done.
7. **Stages** (a pull request each, then its deploy). Move the `kunnskap` entry and `assistantHostnameStage` to `hostnames`, then to `certificates`. After the second, `https://kunnskap.apps.genki-test.digdir.cloud/` signs people in.
8. **Who gets in.** In lockdown, an Entra login in `LOCKDOWN_ENTRA_GROUPS` passes on any Client; anyone else needs an Entra group in `LOCKDOWN_SERVICE_GROUPS` (GitHub variable in the test environment, then **deploy**), which a hosted Client in the platform tenant admits.

Kunnskapsassistenten's own `qa.kunnskap.digdir.cloud` follows later, with the steps in [docs/runbook.md](../docs/runbook.md#moving-a-teams-domain-to-genki): lower the TTLs, add `{ hostname: 'qa.kunnskap.digdir.cloud', tenant: '312521172', stage: 'none' }`, put `TXT asuid.qa` with `assistantHost.verificationId` in the `kunnskap.digdir.cloud` zone, take the name off `ka-app`, point `CNAME qa` at the host, and move the entry through the stages; add the hostname and its URIs to the Client and the Ansattporten client as in steps 4 and 5.

### Platform login

A hosted Client without its own `oidc` logs in through genki's platform login ([ADR 0061](../docs/adr/0061-genki-hosts-a-services-assistant.md)): one Ansattporten client that genki owns, with one callback on `login.apps.<zone>`, served by the assistant host. The service's hostname sends the browser there, and the login host hands the session back with a one-time code. The same client is meant to sign in to the portal and the console later; for now it signs in only to hosted assistants. genki-test turns it on with `platformLoginClientId` and `platformLoginStage` in `infra/env/test.bicepparam`; an empty client id turns it off. In order:

1. **The Ansattporten client** (Samarbeidsportalen for Ansattporten test; done for genki-test, client id `dde98722-c952-4172-a5d6-10bdf721680f`). A web application with `client_secret_basic`, the grants `authorization_code` and `refresh_token`, PKCE `S256`, and:
   - redirect URI `https://login.apps.genki-test.digdir.cloud/auth/callback`
   - post-logout redirect URI `https://login.apps.genki-test.digdir.cloud/auth/logged-out`
   - scopes `openid profile`, and the resource the portal client asks for, the API audience (`API_AUDIENCE`, `digdir:genai` unless set)
   - `authorization_details` of type `ansattporten:altinn:resource` for the environment's `ALTINN_RESOURCE`, the same resource the portal client asks for (on genki-test, the value of the GitHub variable, `urn:altinn:resource:digdir-genai-platform-test` above)
   - access token 300 s, refresh token one-time use with a lifetime of 28800 s, authorization lifetime 28800 s, the 8 hours a session lasts at most
2. **The secret, before the deploy** (Azure). The API reads `platform-login-client-secret` from genki's Key Vault in the same deploy that turns the platform login on, so a revision without it does not start. Copy the secret in Samarbeidsportalen, then run this; it reads the clipboard, never prints the secret, and clears the clipboard:

   ```sh
   pbpaste | az keyvault secret set --vault-name genai-test-kv-q63pldec6l -n platform-login-client-secret --file /dev/stdin -o none; pbcopy </dev/null
   ```

3. **Deploy** (Azure), as in step 2 of "Turning on the assistant host". It writes `CNAME` and `TXT asuid` for `login.apps` in genki's zone and gives the API `PLATFORM_LOGIN_CLIENT_ID`, `PLATFORM_LOGIN_HOSTNAME` and the secret.
4. **Stages** (a pull request each, then its deploy). Move `platformLoginStage` to `hostnames`, then to `certificates`. After the second, `https://login.apps.genki-test.digdir.cloud/auth/logged-out` answers a signed-out page.

**A service moves to the platform login** (genki, an operator in lockdown, since only an operator changes the client id of a hosted Client). Take its hosted Client, remove `oidc`, and save it:

```sh
curl -fsS "$API/tenants/312521172/clients?service=kunnskapsassistenten" -H "authorization: Bearer $GENKI_TOKEN" |
  jq '.clients[0].definition | del(.spec.oidc)' > shared.json
curl -fsS -X PUT "$API/tenants/312521172/clients/$(jq -r .metadata.id shared.json)" -H "authorization: Bearer $GENKI_TOKEN" \
  -H 'content-type: application/json' -H 'change-reason: Kunnskapsassistenten logger inn med genkis felles innlogging' -d @shared.json
```

The next login on its hostname goes through `login.apps`. People's threads start fresh, since the platform login gives each person a subject of its own on every Client (ADR 0061). The service's own Ansattporten client, its redirect URIs on the hostname and its tenant secret are no longer used; delete them once the login works. To go back, put `oidc` back as it was. A Client that keeps `oidc` logs in with its own client as before.

## Login registrations

Register one Ansattporten integration per app and environment: in Ansattporten's test environment for genki-test, in production Ansattporten (`https://ansattporten.no`) for prod. `<zone>` is `genki-test.digdir.cloud` or `genki.digdir.cloud`:

| App       | Redirect URI                        | Post-logout redirect URI    |
| --------- | ----------------------------------- | --------------------------- |
| Portal    | `https://portal.<zone>/callback`    | `https://portal.<zone>/`    |
| Workspace | `https://workspace.<zone>/callback` | `https://workspace.<zone>/` |
| Console   | `https://console.<zone>/callback`   | `https://console.<zone>/`   |

A service drawn by the assistant host logs in through genki's platform login (see "Platform login"), unless its hosted Client names its own Ansattporten client in `oidc`. Such a service logs in with its own Ansattporten client, registered with `https://<hostname>/auth/callback` and `https://<hostname>/` (for genki-test's own name, `https://assistant.genki-test.digdir.cloud/auth/callback`). It asks for `openid profile`, the Client's audience (its `oidc.audience`, or its client id) and the same `authorization_details`.

The three apps each ask for `openid profile`, the API audience `digdir:genai`, and `authorization_details` of type `ansattporten:altinn:resource` for the environment's Altinn resource: `urn:altinn:resource:digdir-genai-platform-test` in test, `urn:altinn:resource:digdir-genai-platform` in prod. Put the client ids in `PORTAL_CLIENT_ID`, `WORKSPACE_CLIENT_ID` and `CONSOLE_CLIENT_ID` of the matching GitHub environment.

The decision point needs, per environment, the Altinn resource, a Maskinporten client owned by Digdir with the scope `altinn:authorization/authorize`, and an Altinn subscription key: in tt02 and Maskinporten test for genki-test, in Altinn production (`https://platform.altinn.no`) and production Maskinporten (`https://maskinporten.no/`) for prod. Issues #42 and #43 describe them.

### Tilgang people list

Tilgang lists who in an organisation holds the platform's rights by reading Altinn access management as that organisation's system user ([ADR 0060](../docs/adr/0060-people-and-service-access-from-altinn.md)). Until it is set up, Tilgang says Altinn is not connected and shows only the signed-in person's own rights. For genki-test, in tt02 and Maskinporten test:

1. **Maskinporten client** owned by Digdir, with the system user scopes (`altinn:authentication/systemregister.write`, `altinn:authentication/systemuser.request.write`, `altinn:authentication/systemuser.request.read`) and `altinn:accessmanagement/enduser:connections:toothers.read`. The decision point's client can carry them, or a client of its own.
2. **System in the Altinn system register** (`https://platform.tt02.altinn.no/authentication/api/v1/systemregister/vendor`), linked to that client id, offering the access package that lets a system user read the organisation's access management.
3. **System user** for each test organisation that uses Tilgang: request it as the vendor and approve it in Altinn as the organisation's access manager, with that access package. `PLATFORM_TENANT`'s organisation first.
4. **Key Vault secrets**: `access-person-key-secret` (`openssl rand -base64 32`, at least 32 characters; never change it afterwards, since every stored service limit points at hashes made with it) and, only with a client of its own, `altinn-people-maskinporten-key` (the client's private JWK as JSON). `altinn-subscription-key` is the decision point's.
5. **GitHub variables** in the test environment, last, after the secrets exist: `ALTINN_PEOPLE_URL` = `https://platform.tt02.altinn.no`, and with a client of its own `ALTINN_PEOPLE_MASKINPORTEN_CLIENT_ID`. Then run **deploy**.

The secret names join `keyVaultSecretNames` only once those variables are set, so the order above never stops a revision. The API refuses to start if `ALTINN_PEOPLE_URL` is set and a setting is missing. Still to confirm with the Altinn team (ADR 0060): that the connections API accepts a system user token, the exact scope (set `ALTINN_PEOPLE_MASKINPORTEN_SCOPE` if it differs) and which access package the system user needs. Prod is not set up.

## What the platform owner creates once

1. **Resource group** for test, in `westeurope`, e.g. `rg-genki-test-weu`. Burstable Postgres is not available to the subscription in Sweden Central.
2. **Deploy identity**: an Entra app registration (or user-assigned identity) with a federated credential for GitHub OIDC:
   - issuer `https://token.actions.githubusercontent.com`
   - subject `repo:digdir/genki:environment:test`, and the ID form `repo:digdir@51157288/genki@1411915404:environment:test` (the organisation uses ID-based OIDC subjects)
   - audience `api://AzureADTokenExchange`
3. **Roles for the deploy identity** on the resource group: `Contributor`, plus `Role Based Access Control Administrator` limited to the roles AcrPull, AcrPush, Key Vault Secrets User and Storage Blob Data Contributor (the template assigns those; the last on the container `conversions` for the knowledge worker identity, with stage `server` or `apps`). An environment set up before Storage Blob Data Contributor was added needs its condition widened with `ba92f5b4-2d11-453d-a403-e96b0029c9fe` in both of its role lists (`az role assignment update`) before the next `infra.yml` or `deploy.yml`, since both deploy `main.bicep`.
4. **Entra group for database admins**, e.g. `genai-test-pg-admins`, with the people who may administer Postgres.
5. **GitHub environment `test`** with these variables (none are secrets), plus the settings in the table above:

   | Variable                   | Value                                                 |
   | -------------------------- | ----------------------------------------------------- |
   | `AZURE_CLIENT_ID`          | Client id of the deploy identity                      |
   | `AZURE_TENANT_ID`          | Entra tenant id                                       |
   | `AZURE_SUBSCRIPTION_ID`    | Subscription id                                       |
   | `AZURE_RESOURCE_GROUP`     | The resource group from step 1                        |
   | `DEPLOY_PRINCIPAL_ID`      | Object id of the deploy identity's service principal  |
   | `PG_ADMIN_GROUP_OBJECT_ID` | Object id of the group from step 4                    |
   | `PG_ADMIN_GROUP_NAME`      | Display name of that group                            |
   | `ACR_NAME`                 | Set after the first infra run (output `registryName`) |

6. **Key Vault secrets** from the table above, after the first infra run creates the vault (output `keyVaultName`).
7. **DNS delegation** of `genki-test.digdir.cloud`, from the output `dnsNameServers`.

## First deploy

1. Run the **infra** workflow with `what-if` on, read the plan, then run it again with `what-if` off. It deploys placeholder images and creates the registry, vault and DNS zone.
2. Set `ACR_NAME` from the run's output `registryName`, add the Key Vault secrets, and ask for the DNS delegation.
3. Run the **deploy** workflow on `main` (`gh workflow run deploy.yml`). It deploys the `api`, `worker`, `apps` and `docling` images by digest, after the checks passed (see [How a deploy stays short](#how-a-deploy-stays-short)). While `ALTINN_PDP_URL` is not set, it deploys the worker and the apps only: the API keeps its current image, since it refuses to start without the real Altinn decision point, and the run summary says so. Once it is set, the deploy also waits until the API's `/health` reports the commit with `modelDiscovery.state` `ok` and no entry in `catalog.skipped` without `unused: true`, so a revision whose model listing has not succeeded yet, or that left a stored catalog entry out, never takes traffic. Only a skipped model or reranker that no published service and no dataset uses carries `unused: true`; a skipped dataset or endpoint always holds the deploy back.
4. When the delegation works, set `CUSTOM_DOMAINS_STAGE=hostnames` and run infra, then `certificates` and run it again.

After that, run the deploy workflow whenever `main` should go to test; merges do not deploy on their own. Infra changes ride along with the next deploy, or run the infra workflow by hand.

## How a deploy stays short

A deploy to test took about 39 minutes (runs on 2026-11-17): it ran the checks again, built the four images, applied the whole template twice and ran the gate's model checks one at a time. The target is five minutes or less when the commit has been on `main` a few minutes and nothing under `infra/` or its settings changed; estimated from the measured steps, such a deploy takes about 7 to 9 minutes, and 10 to 12 right after a merge, while the push's `ci` run finishes; not yet measured on deploys. What it does now:

- **Checks.** The `ci` job takes a green `ci` run on this exact commit: the merge queue's run, or the run on its push to `main`. The merge queue fast-forwards `main` to the commit it tested, so a merged commit's SHA is the SHA of a `merge_group` run on a `gh-readonly-queue/main/` branch, and the deploy starts at once without waiting for the push run. A merge queue run runs every check in full, as the push run does, never only the tests a change affects, so it is the whole gate for that commit. Only a `merge_group` or `push` run counts, since a `pull_request` run tests a merge of the head, not the head itself. Without a green merge queue run, as for a commit pushed to `main` directly, the job waits for the push run. Only when that did not succeed, is still running after 10 minutes, or is missing, or GitHub does not answer, does the deploy run `ci.yml` itself.
- **Images.** `images.yml` builds the API, worker and apps images once per commit when it lands on `main`, pushes them as `genai-<image>:<commit>` and signs a build attestation for each. The deploy calls the same workflow, which reuses an image only when its attestation verifies as built by `images.yml` on `main` from that commit, and builds it again otherwise, with a warning on the run. A deploy that starts while the push's run is still building builds the missing images itself, at the same time; both builds are attested, and the tag keeps the last one, so the Docling image can have two digests in a week. The Docling image is tagged by the tree of `docker/docling` and the week, so it is built when that tree changes and at least weekly. Every commit on `main` now leaves images in the test registry, not only the deployed ones.
- **Template.** See [Deploys that skip the infrastructure](#deploys-that-skip-the-infrastructure). Applying the whole template took 7.5 minutes, nearly four of them re-applying the unchanged Postgres servers and their administrators; the container apps' own part of it took 44 seconds.
- **Gate.** The smoke test runs its model checks three at a time ([docs/smoke-tests.md](../docs/smoke-tests.md)), and the health checks ask every five seconds.

A deploy that applies the whole template still takes about 7.5 minutes more. One whose images are not built yet builds them: about 6.5 minutes when the Docling image is built too (about 4.5 of them), an estimated 2 when it is not. The run summary's Images table says for each image whether it was built in the run or reused; a second deploy of a commit that reuses nothing means the attestation check is failing.

## Deploys that skip the infrastructure

`main.bicep` takes `deployInfrastructure`. With `false` it deploys the identities and the container apps alone: the network, monitoring, registry, Key Vault, storage, both Postgres servers, the alerts and the DNS zone are left as they are, and the container apps read the registry's login server, the vault's address, the servers' host names and the storage endpoint from the resources that exist.

`scripts/infra-state.sh` decides which. It hashes what a full deploy applies beyond a deploy of the container apps alone (`scripts/infra-fingerprint.jq`): the compiled template and the environment's settings, as `az bicep build-params` resolves them, without the Bicep version. The container apps module is deployed either way, so the hash keeps only its outputs, which the alerts and DNS read, each container app's ingress, which decides the host those outputs name, and the settings these depend on; a setting only the container apps read, or a change inside `modules/containerapps.bicep` that leaves its outputs alone, does not apply the whole template. The first deploy after this narrowing applies it once, since the hash changed. Every deploy to test and every infra run keeps that hash in its parameters and outputs (`infraFingerprint`, and `infrastructureDeployed`); a deploy to prod always applies the whole template and keeps no hash. A deploy skips the infrastructure only when the newest deploy that applied, or tried to apply, the whole template succeeded with the same hash. So a change under `infra/` or to a variable the parameter file reads applies the whole template once, in the candidate job; after a full deploy that failed, the next deploy applies it again, whatever its hash; and a deploy from before the hash counts as full with no hash, so the first deploy after this change is full. Each attempt of a run names its deployment apart (`genki-<run>-<attempt>`), so a re-run never replaces the record of a full deploy.

The infra workflow's what-if now lists the alert rules as `Ignore`, not evaluated, where it listed them as `NoChange` before: it skips them since the monitoring module became conditional (checked on test on 2026-11-17; leaving their inputs out of monitoring's outputs did not change it). Everything else it lists as before. The alerts are still applied by a full deploy.

To apply the whole template anyway, for example after a change by hand in the portal, run the deploy with `infrastructure` ticked (`gh workflow run deploy.yml -f infrastructure=true`), which applies it once, or run the infra workflow with `what-if` off (`gh workflow run infra.yml -f what-if=false`), which applies it and records the hash. What a change by hand in Azure did is not seen by the hash: it stays until the next full deploy. Values the workflows pass with `--parameters` (the images, revisions and versions) are not in the hash either, so a setting of the infrastructure belongs in the `.bicepparam` file. A new Bicep version that compiles the template differently changes the hash and applies the whole template once.

## Deploys users do not notice

The API runs several revisions at once (issue 465). Each revision is labelled in the API's traffic list: `live` gets all requests, `candidate` and `previous` none. A deploy runs in three jobs:

1. `candidate` applies the whole template when the infrastructure changed ([Deploys that skip the infrastructure](#deploys-that-skip-the-infrastructure)), and starts a new API revision, `genai-test-api--r<run id>-<attempt>`, labelled `candidate` with no traffic, and waits until its `/health` at `https://genai-test-api---candidate.<environment domain>` reports the commit. The worker, the web apps and Docling keep their images, and the worker its `APP_VERSION`. Before it starts the candidate it takes the other labels off and stops every API revision but the live one, so at most two API revisions run at any time and the gate's smoke test runs beside `live` alone.
2. `gate` runs the smoke test (`scripts/smoke/run.ts`) against the candidate's address, without the model review and without a browser, since the web apps still run the old version. It ignores the daily cap on smoke runs, and passes only when no check failed and at least one model check ran. A failed check stops the deploy here: users keep the `live` revision, and the `discard` job stops the candidate, so code that failed runs no schedules on the shared data. It keeps its label until the next deploy.
3. `deploy-test` moves all traffic to the candidate, labels it `live` and the old one `previous`, deploys the new worker, web apps and Docling, stops the API revisions no label names any more, and waits until `/health` reports the commit. The `smoke` workflow then tests the whole platform as before.

The old revision keeps its replicas, so requests and streams it was serving finish there; it stops when the next deploy starts its candidate. Until then it also runs the schedules, as a second replica of the live revision would. So only `live` and `previous` run between deploys, and only `live` and `candidate` during one. The worker and the database are shared by both revisions, and the candidate's API runs the schema migrations at start, so a migration must leave the old code working: add tables and nullable columns or columns with a default, and drop or rename only in a later release.

**Roll back** with the `rollback` workflow (`gh workflow run rollback.yml`). `scripts/rollback-api.sh` starts the revision labelled `previous` if it is stopped and waits until it runs, then swaps the `live` and `previous` labels with their traffic. With no `previous` label, as after a failed gate, it takes the newest revision a deploy or infra run gave users (the `apiLiveRevision` of the resource group's succeeded `genki-*` and `infra-*` deployments, never a `-candidate` one), starts it and labels it `previous` first. So it never rolls back to a candidate that failed its gate. Users get the previous API revision within seconds when it runs, a minute or two when it had to start; running it again moves them forward. It rolls back the API only: for the worker or the web apps, run the deploy workflow on the previous good commit.

`infra.yml` keeps the labels, the API revision and the worker's `APP_VERSION` as they are; after a rollback the template still names the revision now labelled `previous`, and it keeps that label. After a failed gate the template names the stopped candidate: whether `infra.yml` starts it again is not checked in Azure, so run the deploy workflow first. A change to the API's settings reaches users only through the deploy workflow; whether Azure refuses such a change from `infra.yml`, since it reuses the revision's suffix, is not checked in Azure. Prod still runs one revision of each app: it deploys without revision parameters.

## Validate locally

```sh
az bicep build --file infra/main.bicep --stdout > /dev/null
az bicep lint --file infra/main.bicep
PG_ADMIN_GROUP_OBJECT_ID=00000000-0000-0000-0000-000000000000 PG_ADMIN_GROUP_NAME=x \
  az bicep build-params --file infra/env/test.bicepparam --stdout > /dev/null
PG_ADMIN_GROUP_OBJECT_ID=00000000-0000-0000-0000-000000000000 PG_ADMIN_GROUP_NAME=x \
  az bicep build-params --file infra/env/prod.bicepparam --stdout > /dev/null
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest
docker build --target api -t genai-api:local .
docker build --target worker -t genai-worker:local .
docker build --target apps -t genai-apps:local .
docker build -t genai-docling:local docker/docling
docker/smoke.sh genai-api:local genai-apps:local
docker run --rm -p 127.0.0.1:18091:8080 -e APP=portal -e API_UPSTREAM=https://api.genki-test.digdir.cloud genai-apps:local
```

None of these log in to Azure or deploy anything. Without the Azure CLI, run the `az` lines in `mcr.microsoft.com/azure-cli` (`docker run --rm -v "$PWD:/repo" -w /repo mcr.microsoft.com/azure-cli sh -c 'az bicep install && az bicep build --file infra/main.bicep --stdout > /dev/null'`). `docker run --rm genai-worker:local node scripts/knowledge-server-setup.ts` prints the setup script's usage from the image the principals job runs.

## Prod

Prod runs the same template from `env/prod.bicepparam` in the resource group `rg-genki-prod-weu` (`westeurope`), in the same subscription as test, on `api`, `portal`, `workspace` and `console.genki.digdir.cloud`. It differs from test in:

| Setting                     | Prod                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| Replicas                    | 1 to 3                                                                                          |
| Postgres                    | General Purpose `Standard_D2ds_v5`, 64 GB, backups kept 30 days and copied to North Europe      |
| Address space               | `10.41.0.0/16` (test is `10.40.0.0/16`), so the two networks can be peered later                |
| Altinn resource             | `urn:altinn:resource:digdir-genai-platform`, fixed in the parameter file                        |
| Platform tenant             | Digdir, fixed in the parameter file                                                             |
| Lockdown                    | Off: no `GENAI_LOCKDOWN`                                                                        |
| Login, Maskinporten, Altinn | Production: `https://ansattporten.no`, `https://maskinporten.no/`, `https://platform.altinn.no` |
| Images                      | Copied from the test registry into prod's own registry, by digest                               |

Geo-redundant backup can only be chosen when Azure creates the server. Prod gets it on its first infra run; turning it on later means a new server and a restore. Retention can change at any time (7 to 35 days).

### Images

`images.yml` builds the images once and pushes them to the test registry. `deploy-prod` copies the exact digests that went to test into prod's registry with `az acr import` (tagged with the commit), and deploys prod from there. Prod's app identity pulls only from its own registry, so prod keeps running if test or its registry is gone. The import needs the prod deploy identity to read the test registry; it signs in with its own identity, no registry passwords.

`deploy-prod` needs `build` and `deploy-test`: prod only gets a commit that test took first, including test's health check.

### What the owner creates once for prod

`rg-genki-prod-weu` and the DNS zone `genki.digdir.cloud` in it already exist. The template manages the zone's records (`createDnsZone = true`); creating the zone again changes nothing.

1. **Deploy identity for prod**, separate from test's, with federated credentials for GitHub OIDC (issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`) for both subjects:
   - `repo:digdir/genki:environment:prod`
   - `repo:digdir@51157288/genki@1411915404:environment:prod` (the ID form the organisation uses)
2. **Roles for the prod deploy identity**:
   - on `rg-genki-prod-weu`: `Contributor`, plus `Role Based Access Control Administrator` limited to AcrPull, AcrPush, Key Vault Secrets User and Storage Blob Data Contributor
   - on the test registry: `Container Registry Data Importer and Data Reader` (the role Azure documents for `az acr import` between registries in one tenant; `AcrPull` is the older equivalent for registries without repository permissions)
3. **Entra group** `genai-prod-pg-admins`, with the people who may administer prod's Postgres.
4. **GitHub environment `prod`** with required reviewers, and these variables:

   | Variable                                                              | Value                                                                                                           |
   | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
   | `AZURE_CLIENT_ID`, `DEPLOY_PRINCIPAL_ID`                              | Client id and service principal object id of the prod deploy identity                                           |
   | `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`                            | Same as test                                                                                                    |
   | `AZURE_RESOURCE_GROUP`                                                | `rg-genki-prod-weu`                                                                                             |
   | `PG_ADMIN_GROUP_OBJECT_ID`, `PG_ADMIN_GROUP_NAME`                     | The group from step 3                                                                                           |
   | `ACR_NAME`                                                            | Set after the first infra run (output `registryName`)                                                           |
   | `ANSATTPORTEN_ISSUER`                                                 | `https://ansattporten.no`                                                                                       |
   | `PORTAL_CLIENT_ID`, `WORKSPACE_CLIENT_ID`, `CONSOLE_CLIENT_ID`        | The production Ansattporten clients                                                                             |
   | `CONSOLE_TOKEN_ENDPOINT`                                              | Production Ansattporten's token endpoint                                                                        |
   | `ALTINN_PDP_URL`                                                      | Altinn production's decision point, under `https://platform.altinn.no`                                          |
   | `ALTINN_PDP_MASKINPORTEN_CLIENT_ID`                                   | The production Maskinporten client                                                                              |
   | `MASKINPORTEN_ISSUER`, `MASKINPORTEN_TOKEN_URL`                       | `https://maskinporten.no/`, `https://maskinporten.no/token`                                                     |
   | `OPERATOR_SUBJECTS`                                                   | The prod operators as `https://ansattporten.no\|<sub>` pairs. Personal data: only here, never in the repository |
   | `FOUNDRY_OPENAI_BASE_URL`, `FOUNDRY_CLAUDE_BASE_URL`, `TYPESENSE_URL` | Models and search for prod                                                                                      |
   | `CUSTOM_DOMAINS_STAGE`                                                | `none`, then `hostnames`, then `certificates`                                                                   |
   | `KNOWLEDGE_SERVER_STAGE`                                              | `none` while test's value is a repository variable, otherwise unset; later `server`, then `apps`                |
   | `PROD_READY`                                                          | `true` once everything above is in place; until then `deploy-prod` is skipped                                   |

   `PLATFORM_TENANT` and `ALTINN_RESOURCE` stay unset; prod fixes both.

5. **Registrations**: production Ansattporten clients with `genki.digdir.cloud` addresses, the Altinn production resource `urn:altinn:resource:digdir-genai-platform`, a production Maskinporten client owned by Digdir with `altinn:authorization/authorize`, and an Altinn production subscription key. See [Login registrations](#login-registrations).
6. **Key Vault secrets** from the table in [Settings and secrets](#settings-and-secrets), with production values and a new `content-master-key`, after the first infra run creates the vault.

### First prod deploy

1. Run **infra** with environment `prod` and `what-if` on, read the plan, then again with `what-if` off. It creates the registry, vault, Postgres server (with geo-redundant backup) and the DNS records, with placeholder images.
2. Set `ACR_NAME` in the prod environment from the output `registryName`, and add the Key Vault secrets (output `keyVaultName`).
3. Make sure `digdir.cloud` delegates `genki` to the zone's name servers (output `dnsNameServers`), as for test. Set `CUSTOM_DOMAINS_STAGE=hostnames` and run infra for prod, then `certificates` and run it again.
4. Set `PROD_READY=true`.
5. Run **deploy** with environment `prod` (`gh workflow run deploy.yml -f environment=prod`). It takes the commit's images from the test registry (building any it cannot reuse), deploys to test, waits for the required reviewers, copies the images into prod's registry, deploys prod, and waits until the API's `/health` reports the commit. It stops early if `ACR_NAME`, `ANSATTPORTEN_ISSUER` or `ALTINN_PDP_URL` is missing.

## Before prod

Done with the prod environment:

- Postgres: General Purpose SKU, 30 days of backups, geo-redundant backup.
- Images: prod pulls only from its own registry.
- Prod's own address space, login, Maskinporten and Altinn settings, without lockdown.

Still open:

- Postgres: set `appIdentityIsPostgresAdmin` to false, give the app identity its own role with `pgaadauth_create_principal`, run by a member of the admin group, and run migrations from a separate identity, so the running app cannot change the schema. Prod starts with the app identity as Postgres admin, as test does.
- Key Vault: a private endpoint, then `keyVaultPublicNetworkAccess = 'Disabled'`. The template has no private endpoint yet, so prod keeps the vault public (RBAC only); disabling it now would cut the apps off from their secrets.
- Storage: a private endpoint for the file share and the container `conversions`, and uploads on Blob storage behind the blob port. The file share mount needs the account key, so shared-key access stays on and the key also opens the container (ADR 0042, Open).
- Ingress: Application Gateway with WAF in front.
- Postgres high availability: `postgresHighAvailability` (`SameZone` or `ZoneRedundant`) exists but prod leaves it `Disabled` for now. It can be turned on later on a General Purpose server.
