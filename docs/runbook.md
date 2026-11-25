# Runbook

What to do when genki alerts, and how to prove each alert works. Infrastructure is described in [infra/README.md](../infra/README.md).

## Alerts

`infra/modules/alerts.bicep` creates them when `alertsEnabled` is on, which both `test.bicepparam` and `prod.bicepparam` set. The rules are named `genai-<env>-<key>` and send to the action group `genai-<env>-alerts`.

### Receivers

The action group emails the addresses in the GitHub environment variable `ALERT_EMAILS` (Settings → Environments → test or prod → Variables), comma separated. They are never written in the repository. The next infra or deploy run applies a change. Without the variable the alerts still fire and show under Monitor → Alerts in the portal, but nobody is told.

### What each alert means

All log alerts read the Container Apps tables in the environment's Log Analytics workspace (`genai-<env>-logs`). The apps log one JSON object per line, so `parse_json(Log).msg` is the message.

| Rule                     | Severity | Signal                                                                                                                                                                                                                                                                                                                                                                                                                                              | Fires when                                                                             |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `api-down`               | 1        | Application Insights standard availability test `genai-<env>-api-health`: `GET /health` from West Europe, North Europe and UK West, expecting 200 and a certificate valid for at least 7 days                                                                                                                                                                                                                                                       | Two of the three locations fail. The test runs every 5 minutes                         |
| `db-down`                | 1        | Azure Monitor metric `is_db_alive` (Maximum) on the platform Postgres server. `/health` never touches the database, so `api-down` does not see this                                                                                                                                                                                                                                                                                                 | Below 1 for 5 minutes                                                                  |
| `api-errors`             | 2        | `ContainerAppHTTPLogs` for the API: share of responses with status 500 or above. Status 0 (the client went away) does not count                                                                                                                                                                                                                                                                                                                     | At least 5 % over 30 minutes, with at least 100 requests and 10 failures               |
| `api-latency`            | 3        | `ContainerAppHTTPLogs` for the API: 95th percentile of `RequestDuration`, leaving out `/health` and paths that wait for a model or carry files (the `slowByDesignPaths` list in `infra/modules/alerts.bicep`: chat completions, uploads, playground runs, definition test runs and completion, assistant turns, skill test runs, diagnostics plan and retrieve, tool calls, A2A, MCP; the conversation list, eval runs and batch runs stay counted) | Over 5 s in 2 of the last 3 half hours, each with at least 100 requests                |
| `model-provider`         | 2        | `model call failed` (a chat or embedding call) with `code` `unavailable` or `rate_limited`, from the API and the worker                                                                                                                                                                                                                                                                                                                             | At least 5 in 15 minutes                                                               |
| `worker-jobs`            | 3        | `ingestion run failed`, `knowledge job refused`, `knowledge server unreachable` or `knowledge reconciler failed`, from the API and the worker; `state register stale` (ADR 0058); or a queue in a `queue stats` line whose `oldestQueuedSeconds` is over 30 minutes, except `knowledge.convert`, whose bulk backlogs drain for hours by design (`bulkQueues` in `infra/modules/alerts.bicep`)                                                       | At least 3 failures in an hour, or one stale or waiting line, checked every 15 minutes |
| `catalog-skipped`        | 3        | `catalog entry skipped`, from the API and the worker: a catalog rebuild left a stored entry out. `/health` reports `degraded` with `catalog.skipped` meanwhile, and the deploy waits on it unless it is a model or reranker nothing uses (infra/README.md, "Deploys users do not notice")                                                                                                                                                           | At least 1 in 15 minutes, checked every 5 minutes                                      |
| `altinn`                 | 2        | `altinn actions failed` (a decision point lookup, including its Maskinporten and Altinn token exchange) and `altinn token not fetched at boot`, from the API                                                                                                                                                                                                                                                                                        | At least 3 in 15 minutes                                                               |
| `login-keys`             | 1        | `login keys not fetched`: the API could not fetch the signing keys (JWKS) of Ansattporten or Maskinporten                                                                                                                                                                                                                                                                                                                                           | At least 1 in 15 minutes                                                               |
| `docling-out-of-memory`  | 3        | `ContainerAppSystemLogs` for `genai-<env>-docling`: `ContainerTerminated` with exit code `137`, a replica killed, usually for its memory (issue 922)                                                                                                                                                                                                                                                                                                | At least 3 in 15 minutes, since the worker submits a lost conversion again             |
| `postgres-connections`   | 2        | Azure Monitor metric `active_connections` (Maximum) on the platform Postgres server; the threshold is 80 % of the user connections of the server's SKU in `infra/postgres-connections.json`                                                                                                                                                                                                                                                         | Above it in a 5 minute window: 331 on the B2s server in test                           |
| `platform-backup`        | 3        | `platform backup uploaded` from the job `genai-<env>-pg-backup` (see Backups)                                                                                                                                                                                                                                                                                                                                                                       | None in the last day, checked every hour                                               |
| `hostname-binder-writes` | 2        | Activity Log: an administrative write in the resource group by the hostname binder's identity (see Hostname binder)                                                                                                                                                                                                                                                                                                                                 | Every write; while the binder is on                                                    |
| `hostname-fence`         | -        | Activity Log: Azure Policy refused a write in the resource group, such as one outside the assistant host's fence                                                                                                                                                                                                                                                                                                                                    | Every refusal; mails whatever `alertMailMaxSeverity` says                              |
| `service-health`         | -        | Azure Service Health for Postgres flexible servers, Container Apps, Key Vault, Storage, Foundry Models and Azure OpenAI in West Europe, Sweden Central or Global: incidents, planned maintenance, advisories and security notices. Only with `serviceHealthAlertEnabled` (infra/README.md, "Backups")                                                                                                                                               | Azure posts an event                                                                   |

Every rule up to `alertMailMaxSeverity` (all of them unless the environment sets it) sends to the one email group; there is no SMS or paging. Test sets it to 1, so there only `api-down`, `db-down`, `login-keys`, `hostname-fence` and the budgets mail, and the other rules fire under Monitor → Alerts in the portal without telling anyone. The rules are stateful: an incident sends one mail when it fires and one when it resolves, however long it lasts, so no rule fires on a single line that a passing problem writes (`login-keys` aside, since every login fails meanwhile). The thresholds are the parameter `alertThresholds` in `main.bicep`. The log alerts resolve themselves when the condition clears. Application Insights' own Failure Anomalies rule is declared in the template with state Disabled: `api-errors` covers it, and the rule Azure makes on its own mails everyone with Monitoring Contributor or Monitoring Reader on the subscription.

The worker logs `queue stats` every 5 minutes: for every queue on the platform server and, with the knowledge server on, on that server, the jobs waiting and how long the oldest one that may start now has waited (`oldestQueuedSeconds`); a job sent to start later, such as a night window job, and dead letters do not count. The line's own `oldestQueuedSeconds` is the largest of them.

### First steps

Open the alert in the portal and choose **View query results** to see the lines that fired it. To read around them:

```kusto
ContainerAppConsoleLogs
| where ContainerAppName in ('genai-test-api', 'genai-test-worker')
| where TimeGenerated > ago(1h)
| project TimeGenerated, ContainerAppName, Log
| order by TimeGenerated desc
```

**API down.** Check whether the API answers at all: `curl -i https://api.genki.digdir.cloud/health`. Then look at the revision and its replicas (`az containerapp revision list -n genai-test-api -g <resource group> -o table`) and at `ContainerAppSystemLogs` for `ProbeFailed`, `ContainerTerminated` or a failed revision. A `refusing to start` line in the console log names the missing setting. If the last deploy broke it, run the `rollback` workflow (`gh workflow run rollback.yml`), which moves users back to the previous API revision; for the worker or the web apps, run the deploy workflow on the previous good commit ([Deploys users do not notice](../infra/README.md#deploys-users-do-not-notice)). A failing certificate check means the managed certificate on the custom domain did not renew.

**Docling out of memory.** A Docling replica takes one conversion at a time and restarts itself when it is idle with more than half its memory (`genki_busy.py`, infra/README.md, "Docling server"), so a kill means one file took more than the replica has, or the restart did not happen (a `memory unreadable` line means the replica cannot read its memory, so it never restarts). The worker logs one `docling task` line for each task when it ends, with the file's `sha256`, `pages`, the `replica` that took it, `queuedMs`, `convertingMs` and `result` (`lost` for a killed one); Docling logs `task accepted`, `task ended`, `busy` and `restarting`, each with its replica and the tasks it holds (`running`, `queued`). The tasks each replica held, and the files the worker lost:

```kusto
union
  (ContainerAppConsoleLogs | where ContainerAppName == 'genai-test-docling' and Log has_any ('task accepted', 'task ended', 'busy', 'restarting', 'draining', 'stopping', 'memory source', 'memory unreadable')
    | extend entry = parse_json(extract('{.*}', 0, Log))),
  (ContainerAppConsoleLogs | where ContainerAppName == 'genai-test-worker' and Log has 'docling task'
    | extend entry = parse_json(Log) | where tostring(entry.msg) == 'docling task')
| where TimeGenerated > ago(6h)
| project TimeGenerated, msg = tostring(entry.msg), replica = tostring(entry.replica), task = tostring(entry.task),
    running = toint(entry.running), queued = toint(entry.queued), result = tostring(entry.result), sha256 = tostring(entry.sha256),
    pages = toint(entry.pages), convertingMinutes = toint(entry.convertingMs) / 60000
| order by replica asc, TimeGenerated asc
```

The memory of each replica is the metric `WorkingSetBytes` split by `podName` (`az monitor metrics list --resource <docling app id> --metric WorkingSetBytes --interval PT1M --aggregation Maximum --filter "podName eq '*'"`). A file that alone takes more than the replica has fails the same way every time it is submitted: three `lost` lines a try with the same `sha256`, and a dead letter after the job's last try.

**Smoke test failed.** After each deploy to genki-test the `smoke` workflow tests the API, the playground, timelines and the portal and console screens, runs in full the check groups the merged pull requests touch, and lets a model review the results. It opens or updates one issue labelled `smoke` with the failing checks, the model's findings and the pull requests since the last green run, marked as suspected. The genki run ids are in the run's job summary, and its `smoke-bundle` artifact holds the answers, timelines and screenshots. What each check means and how to rerun it is in [Smoke tests](smoke-tests.md).

**API error rate.** Group the failures to find the route and the cause:

```kusto
ContainerAppHTTPLogs
| where ContainerAppName == 'genai-test-api' and StatusCode >= 500
| where TimeGenerated > ago(1h)
| summarize count() by StatusCode, Path, ResponseCodeDetails
```

502, 503 and 504 with an upstream detail come from the Container Apps proxy: replicas restarting, out of memory or too slow. A 500 comes from the API itself; the console log at the same time shows the error.

**Model provider failures.** The lines carry `model`, `code` and `tenant`. `rate_limited` means the deployment's quota (tokens per minute) is used up: see the deployment in Azure AI Foundry and the token alert below. `unavailable` means the provider did not answer or answered 5xx: check the Azure status page and the endpoint setting (`FOUNDRY_OPENAI_BASE_URL`, `FOUNDRY_CLAUDE_BASE_URL`). Services with a fallback model keep answering; others fail until the provider is back.

Each 429 a model connection gets is logged as `model call throttled`, which no alert counts. It names the connection as `endpoint`, the deployment the request named as `model`, the wait the provider asked for as `retryAfterMs` and the `attempt`. Calls through the OpenAI and Anthropic SDKs are tried up to four times; the OpenAI SDK waits as the provider asks, up to 60 seconds, and uses its own backoff for a longer wait. A rerank call is not tried again, so its 429 fails at once. Knowledge index and fill jobs are the exception: they embed without the SDK's retries, wait as long as the provider asks, and pause the worker's other jobs on the model meanwhile, for up to 20 minutes a try (ADR 0042). Their 429s are logged as `model call throttled` with `attempt` 1, since each wait is the job's own. A 429 or 5xx they retry is not logged as `model call failed`; a job that gives up logs it once, with its code. A throttled knowledge run gets slower, not failed documents; many `model call throttled` lines with a low `stored` in `knowledge run progress` mean the deployment's quota sets the pace. To see how hard a deployment is throttled:

```kusto
ContainerAppConsoleLogs
| where ContainerAppName in ('genai-test-api', 'genai-test-worker')
| where TimeGenerated > ago(1h)
| extend line = parse_json(Log)
| where line.msg == 'model call throttled'
| summarize throttled = count(), waitMs = sum(toint(line.retryAfterMs)) by bin(TimeGenerated, 5m), model = tostring(line.model)
```

**Database down.** The platform server did not answer Azure's liveness check. Look at the server in the portal (`az postgres flexible-server show -g <resource group> -n <server> --query state`) and at Resource health for a restart, maintenance or an Azure incident; the `service-health` alert names Azure's own. Planned maintenance on the platform server runs on Sundays from 02:00 UTC (`postgresMaintenanceWindow`). While it is down the API answers 500 and pg-boss logs `job queue error`, which no alert counts, since this alert covers it. Once it is back, the API and worker reconnect by themselves. If it stays down or its data is damaged, restore it (see Backups).

**Worker jobs failing or waiting.** The message says where to look:

- `ingestion run failed`: the run's `dataset`, `pipeline` and `execution` id are in the line; the run's error is on the run in the console, under the dataset's pipeline.
- `knowledge job refused`: a job whose run was not admitted, or in lockdown was admitted more than 24 hours ago. Start the run again.
- `knowledge server unreachable`, `knowledge reconciler failed`: the knowledge server or its network. See [Knowledge server](../infra/README.md#knowledge-server).
- `state register stale`: see below.
- `queue stats` with a queue other than `knowledge.convert` whose `oldestQueuedSeconds` is over 1800: jobs wait and nothing takes them. The `queues` list names the server and queue. Check that the worker runs one healthy revision (`az containerapp revision list -n genai-<env>-worker -g <resource group> -o table`), and for the queue's handler in the worker's log.

**A slow knowledge run.** Each worker logs `knowledge run progress` once a minute for each run it writes: `stored` documents and their `chunks` in that minute, and `active`, the run's index and fill jobs on that worker as the line is written. A job is active while it embeds and while it waits for its turn to write, since a generation takes one write at a time. `worker started` names the `version`, `knowledgeIndexConcurrency` (how many index jobs, and as many fill jobs, the worker works at once) and `knowledgePoolSize`. Few documents with many jobs active can be throttling or jobs waiting to write: `model call throttled` lines in the same minutes tell them apart.

```kusto
ContainerAppConsoleLogs
| where ContainerAppName == 'genai-test-worker'
| where TimeGenerated > ago(2h)
| extend line = parse_json(Log)
| where line.msg == 'knowledge run progress'
| project TimeGenerated, run = tostring(line.run), dataset = tostring(line.dataset), stored = toint(line.stored), chunks = toint(line.chunks), active = toint(line.active)
| order by TimeGenerated asc
```

**State register stale.** The worker could not read Enhetsregisteret for two nights or more. The line has `lastGood`, `failedNights` and `error`. Answers about which ministry an agency is under keep the register from `lastGood`, and the console's Statens organisering shows the same dates. Check that the register answers from outside (`curl -s 'https://data.brreg.no/enhetsregisteret/api/enheter?organisasjonsform=STAT&size=1'`). The next good night clears it.

**Catalog entry skipped.** A dataset, model or endpoint runs on its seed instead of what was saved last, or is missing when it has no seed. An older stored version is never used, and searches and answers come from the seed. The line names the `kind`, the `id` and the `reason`. `GET /operator/catalog/entries` lists the same under `skipped`, and `GET /operator/catalog/<kind>/<id>/versions` shows what was saved. Fix or delete the entry the reason points at (`DELETE /operator/catalog/<kind>/<id>` also deletes a skipped entry, such as a model whose APIs were removed); every replica rebuilds the catalog on the next change and the entry comes back. Do not save a dataset onto the knowledge database by hand to make it come back: only its engine switch may move it there.

**Altinn unavailable.** The `error` field says which step failed. Logins still work, but people get no rights from Altinn while it lasts, so they see less than they should. Check the Altinn status (tt02 in test), the Maskinporten client and its key (`altinn-pdp-maskinporten-key` in Key Vault) and the subscription key (`altinn-subscription-key`).

**Ansattporten or Maskinporten keys unavailable.** Every login with that issuer fails with 401 until the keys can be fetched. The line has the `issuer`, the `uri` and the `status` or `error`. Check that the URI answers from outside (`curl -i <uri>`) and that `ANSATTPORTEN_ISSUER` or `MASKINPORTEN_JWKS_URI` is right. The API fetches the keys again on the next login, so it recovers by itself once the issuer answers.

**Database connections.** The platform server is close to its user connections; past them pg-pool logs `remaining connection slots are reserved` and the API answers 500. In this order:

1. Stop stale API revisions. Only `live` and `previous` should run, or `live` and `candidate` during a deploy: `az containerapp revision list -g <resource group> -n genai-<env>-api --query "[?properties.active].{name:name,traffic:properties.trafficWeight}" -o table`, then `az containerapp revision deactivate -g <resource group> -n genai-<env>-api --revision <name>` for any revision the traffic list (`az containerapp ingress traffic show`) does not name. The deploy does this itself before the candidate starts and after the traffic switch, so a stale one means a deploy stopped between them.
2. Raise the server's tier (`postgresSkuName` in the environment's `.bicepparam`, and its row in `infra/postgres-connections.json`). Azure keeps the first tier's `max_connections` through a resize, so the template sets it from that row; it takes effect after a restart (`az postgres flexible-server restart`), in a quiet window, since the resize has restarted the server once already ([Limits](https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-limits)). General Purpose tiers also allow the built-in PgBouncer on port 6432; Burstable tiers do not ([PgBouncer](https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-pgbouncer)).
3. Then raise `apiDatabasePoolMax` or `workerDatabasePoolMax`. `scripts/postgres-connections.test.ts` fails when the pools no longer fit the tier.

### Prove each alert in test

Do this once after the first deploy with alerts, with `ALERT_EMAILS` set, and note the time each email arrives; in test only the Sev1 rules mail, so for the others note when the alert shows under Monitor → Alerts. The resource group is `rg-genki-test-weu`. An infra run, or a deploy that applies the whole template, puts every rule and the availability test back as the template says; a deploy that skips the infrastructure leaves them as they are.

The log alerts are proved by writing the line they look for to the container's own log, which reaches Log Analytics as any other line does. Open a shell in the API container:

```sh
az containerapp exec -n genai-test-api -g rg-genki-test-weu --command sh
```

and in it, for the alert you are testing:

```sh
# model-provider: five lines
for i in 1 2 3 4 5; do echo '{"msg":"model call failed","code":"unavailable","model":"drill","drill":true}' > /proc/1/fd/1; done
# worker-jobs: three lines
for i in 1 2 3; do echo '{"msg":"ingestion run failed","dataset":"drill","pipeline":"drill","execution":"drill","drill":true}' > /proc/1/fd/1; done
# worker-jobs, through a waiting queue
echo '{"msg":"queue stats","oldestQueuedSeconds":3600,"queues":[{"server":"drill","queue":"drill","queued":1,"oldestQueuedSeconds":3600}],"drill":true}' > /proc/1/fd/1
# altinn: three lines
for i in 1 2 3; do echo '{"msg":"altinn actions failed","error":"drill","drill":true}' > /proc/1/fd/1; done
# login-keys
echo '{"msg":"login keys not fetched","issuer":"drill","uri":"drill","status":503,"drill":true}' > /proc/1/fd/1
```

If the shell cannot write to `/proc/1/fd/1`, lower the rule's threshold instead, as for `api-errors` below. The lines take a few minutes to reach the workspace, and the rule fires on its next evaluation: within about 10 minutes, 25 for `worker-jobs`. The alert resolves by itself once the window has passed.

`api-errors`: there is no safe way to make the API answer 5xx on purpose. In the portal, open the rule `genai-test-api-errors`, set its threshold to 0, take `and failed >= 10` out of its query and save. Make at least 100 requests (`for i in $(seq 110); do curl -s -o /dev/null https://api.genki-test.digdir.cloud/health; done`) and wait for the alert. Then set the threshold back to 5 and put the condition back, or run the infra workflow.

`api-down`: in the portal, open Application Insights `genai-test-insights` → Availability → `genai-test-api-health` → Edit, and change the URL to `https://api.genki.digdir.cloud/health-drill`, which answers 404. The alert fires after the next test run, within about 10 minutes. Then change the URL back, or run the infra workflow.

`api-latency`: set the rule's threshold to 0 in the portal, make 100 requests as for `api-errors` in each of two half hours, wait for the alert and set it back to 5.

`db-down`: stop the server in a quiet window (`az postgres flexible-server stop`), wait for the email within about 10 minutes, and start it again. The API and worker are down meanwhile.

### Budgets

`infra/modules/budget.bicep`, with the alerts' email group:

| Budget                | Covers                                                                                                                                                                                                   | Amount a month | Emails at                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------- |
| `budget-genki-infra`  | the environment's resource group (`rg-genki-test-weu`): Postgres, Container Apps, monitoring, registry, storage, backups. The knowledge server's compute (E4ds_v5) is about 4,100 kr of it at list price | 5,000 kr       | 80 % and 100 % actual                 |
| `budget-genki-models` | `modelsBudgetResourceGroup` (`rg-genki-test-swc`): Foundry                                                                                                                                               | 8,000 kr       | 80 % and 100 % actual, 100 % forecast |

They replace `budget-genki`, which was made by hand on the subscription and has been deleted. Raise `modelsBudgetAmount` for a while before a planned embedding fill. A budget only mails; it stops nothing. Azure's cost data lags up to a day, and spend through the AI gateway is outside the subscription, so no Azure budget sees it.

### Managed by hand

Application Insights' older smart detection rules (slow responses, dependency duration, trace severity, exceptions, memory leaks, data volume and the weekly digest) mail the subscription's owners by default, outside the action group. Turn that off once in the portal: Application Insights `genai-<env>-insights` → Smart detection → Settings, and for each rule clear "Send email to subscription owners".

The metric alert `tokens-genki-test-ai` (more than 3 million tokens in an hour on `genki-test-ai`) is in `rg-genki-test-swc`, with the lab's shared action group `ag-ai-lab-cost`. Change it in the portal.

### Cost

About 250 kr a month in each environment, at list price: the availability test runs from three locations every 5 minutes, and each log alert rule costs a little per month by how often it runs. Service Health alerts and budgets are free. The backups add about 130 to 150 kr a month in test: about 46 kr for the share backup, about 80 kr for the copies' private endpoint and its DNS zone, a few kroner for the nightly copies and their job, and up to 15 kr for 35 days of point-in-time restore beyond the free backup storage. The B2s platform server is about 540 kr a month, 400 kr more than B1ms.

## Backups

### Recovery targets

| Data                        | Most data lost                            | Back within           | How                                                                                  |
| --------------------------- | ----------------------------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| Platform database           | 15 minutes                                | 4 hours, office hours | Point-in-time restore to a new server, then point the apps at it (below)             |
| Uploads (file share `data`) | 24 hours                                  | 4 hours               | Restore from the daily share backup                                                  |
| Secrets (Key Vault)         | 0                                         | 1 hour                | Soft delete (90 days) and purge protection: recover the secret or the vault          |
| Container images            | 0                                         | 1 hour                | Build again from git (`images.yml`)                                                  |
| Knowledge database          | Set by the knowledge server's maintainers | Set by them           | See [Knowledge server](../infra/README.md#knowledge-server)                          |
| Loss of West Europe         | Accepted                                  | Accepted              | The whole platform runs in one region, so a copy elsewhere alone brings nothing back |

Nobody is on call: the targets count office hours.

### What is kept

- **Platform database:** Azure's point-in-time restore for 35 days (`postgresBackupRetentionDays`), locally redundant in West Europe. Deleting the server deletes these backups, so a CanNotDelete lock should sit on it (`resourceLocksEnabled`, infra/README.md, "Backups").
- **A copy off the server:** the job `genai-<env>-pg-backup` runs `pg_dump` every night at 01:30 UTC as the app identity and writes `genai-<time>.dump` (custom format) to the container `platform` in the storage account `genai<env>bak<suffix>`. The container keeps each copy for 12 weeks under a time-based immutability policy: nobody, the job included, can change or delete it before then, and a lifecycle rule deletes it a day after. The account takes no shared keys and no traffic from the internet: only through its private endpoint in the subnet `endpoints`, from inside the environment's network. Only the backup identity `genai-<env>-backup-id` has a role there (Storage Blob Data Contributor on the container); the API's and worker's identity has none. That role could also read the copies; a custom role that may only write blobs needs `Microsoft.Authorization/roleDefinitions/write`, which the deploy identity lacks, so this is a known gap. Overwriting or deleting a copy is refused by the policy all the same. Azure Backup's long-term retention for PostgreSQL is not used: its v2 does not support Burstable servers ([support matrix](https://learn.microsoft.com/azure/backup/backup-azure-postgresql-flex-server-elastic-cluster-v2-support-matrix)), and v1 is `pg_dump` too, restores only as files, and needs roles the deploy identity cannot assign.
- **Locking the policy:** until it is locked, an owner or Contributor can shorten or remove the policy and then delete the copies. An owner locks it once, after the first deploy with `backupsEnabled`:

  ```sh
  az storage container immutability-policy show --account-name genai<env>bak<suffix> --container-name platform --auth-mode login --query etag -o tsv
  az storage container immutability-policy lock --account-name genai<env>bak<suffix> --container-name platform --if-match '<etag>' --auth-mode login
  ```

  Then set `platformBackupImmutabilityLocked = true` in the environment's parameters, so the template stops sending the policy: Azure refuses most changes to a locked policy, so run `az deployment group what-if` first whenever the policy might change. A locked policy can only be lengthened, never shortened or removed, by anyone, Owner included, and Azure refuses to delete the container or the account while it holds copies. It does not stop anyone with a data role, or an owner who grants one, from reading the copies, nor deleting the whole subscription.

- **Uploads:** the Recovery Services vault `genai-<env>-files-rsv` snapshots the share `data` every day at 01:00 UTC and keeps 30 days; the vault has soft delete, and the share keeps deleted shares for 14 days. The snapshots live in the same storage account, and Azure Backup puts its own delete lock on it.
- **Secrets:** Key Vault soft delete for 90 days, with purge protection.
- **Not backed up:** container images (built again from git), and a Typesense server an organisation registers, which its owner backs up.

### Restore the platform database

1. Choose the time just before the damage, in UTC.
2. `az postgres flexible-server restore -g <resource group> -n <new server> --source-server <server> --restore-time <time> --vnet genai-<env>-vnet --subnet postgres --private-dns-zone <server>.private.postgres.database.azure.com`. It takes a few minutes; the drill below records how long.
3. Point the apps at the new server: set `PGHOST` on `genai-<env>-api` and `genai-<env>-worker` to the new server's host name (`az containerapp update --set-env-vars`), or swap names so the template's server name holds the restored data. Restart the worker.
4. Keep the old server until the new one is checked, then delete it or lock it.

From a nightly copy, when the server and its backups are gone: download the newest blob from the container `platform` from inside the network (a job in the environment), or after an owner has opened public access to one IP for the restore and closes it again, and run `pg_restore --no-owner --dbname genai` against a new, empty server as a member of the admin group. Roles and grants come from the migrations, which the API runs when it starts.

### Restore drill

`.github/workflows/platform-restore-drill.yml` runs on the first day of each quarter and on demand (`gh workflow run platform-restore-drill.yml`), in test only, in a concurrency group of its own. It restores the platform server as of 10 minutes earlier to `genai-<env>-pg-restore-drill`, writes how long it took to the run's summary, runs the job `genai-<env>-pg-restore-check`, which counts the rows of every table on both servers and fails when a table is missing or the restored server is empty, and deletes the restored server even when a step failed. A drill costs about 5 kr. By hand in the same quarter: restore one uploaded file from the share backup and compare its checksum, and recover a throwaway Key Vault secret. Write the times into issue #44; the target is met while restore plus repointing stays under 4 hours.

## Hostname binder

The job `genai-<env>-hostname-binder` binds the hostnames service owners claim on the assistant host, every minute ([ADR 0062](adr/0062-a-service-owner-adds-a-hostname.md), [infra/README.md](../infra/README.md#hostname-binder)). It asks the API what to do, does one step per hostname and reports it.

### Turning it on

Once, in this order, after the deploy that turns on `hostnameBinderEnabled`. Test has it on; a rebuilt resource group has no host app for the template to read yet, so set the GitHub variable `HOSTNAME_BINDER_ENABLED` to `false` in the `test` environment for its first deploy, then delete the variable and deploy again.

1. **The role and the fences** (an owner of the subscription, or one with User Access Administrator and Resource Policy Contributor on it), before the binder has its audience, so it never runs without them. Apply them with `Deny` at once: under `Audit` nothing is refused and the binder is unfenced.

   ```sh
   az deployment sub create -l westeurope -n genki-hostname-binder-access -f infra/hostname-binder-access.bicep \
     -p environmentName=test resourceGroupName=rg-genki-test-weu dnsZoneName=genki.digdir.cloud
   ```

   It reads the host app's `API_UPSTREAM`, `ANSATTPORTEN_ISSUER` and `GENAI_REDIRECT_HOSTS`. Before a deploy that changes any of them, apply it with `policyEffect=Audit`, deploy, then apply it again without, or the policy refuses that deploy.

2. **An app registration for the API** (an Entra admin), no secret, no redirect URI: `az ad app create --display-name genki-test-api --query appId -o tsv`, then `az ad app update --id <appId> --identifier-uris api://<appId>` and `az ad sp create --id <appId>` (without the service principal, the binder's token request fails with AADSTS500011). Once the API serves `/internal/hostnames/*`, set the GitHub variable `HOSTNAME_BINDER_AUDIENCE` in the `test` environment to `api://<appId>` and run **deploy**: the job is deployed only with an audience, and until the API has the routes every run would fail.
3. **The old records in genki's zone.** The `apps.` zone takes over `kunnskap.apps`, `login.apps` and their `asuid` records; the copies in `genki-test.digdir.cloud` stay until removed: `az network dns record-set cname delete -g rg-genki-test-weu -z genki-test.digdir.cloud -n kunnskap.apps --yes`, and the same for `login.apps` and the `txt` sets `asuid.kunnskap.apps` and `asuid.login.apps`. Check first that `dig +short kunnskap.apps.genki-test.digdir.cloud CNAME` answers from the new zone (`dig NS apps.genki-test.digdir.cloud`).

### Seeing its runs

```sh
az containerapp job execution list -g rg-genki-test-weu -n genai-test-hostname-binder -o table
```

Each run logs one `hostname step` line per hostname it took up (`ok` and `message`, `detail` with Azure's full answer when a step failed, or `waiting` when it did nothing this run: a certificate being issued, the host app busy, or a `done` item) and one `hostname binder run` line with the counts; a run that could not reach the API, report a result or read a work item fails. In Log Analytics:

```kusto
ContainerAppConsoleLogs
| where JobName == 'genai-test-hostname-binder'
| extend line = parse_json(Log)
| project TimeGenerated, msg = tostring(line.msg), hostname = tostring(line.hostname), step = tostring(line.step), ok = line.ok, message = tostring(line.message)
| order by TimeGenerated desc
```

The alert `hostname-binder-writes` fires on every write the binder makes, and mails only where `alertMailMaxSeverity` is 2 or more, so not in test; check each against a claim; for a name under `apps.` it writes the records only when they differ. `hostname-fence` mails every write Azure Policy refused in the resource group: a refused binder write means the binder tried to change more than its hostnames, so stop the job (below) and look before anything else. While the policies are in `Audit`, `hostname-fence` stays silent; look at their compliance in the portal instead.

### Retrying

Nothing to do for a step that failed: the binder tries it again the next minute, until the API ends the claim after 48 hours. To run it now: `az containerapp job start -g rg-genki-test-weu -n genai-test-hostname-binder`. A certificate that ended `Failed` is deleted by the binder and asked for again on the next run; it keeps failing while DNS does not point at the host or a CAA record leaves out `digicert.com`.

### Removing a hostname

Remove the claim in genki; the binder unbinds it, deletes its certificate and, for a name under `apps.`, its records. By hand, when the binder is off or a name is stuck (also for a name removed from `hostedHostnames` while the binder is on, which the deploy keeps):

```sh
az containerapp hostname delete -g rg-genki-test-weu -n genai-test-assistant --hostname <hostname> --yes
az containerapp env certificate list -g rg-genki-test-weu -n genai-test-hosted-env --query "[?properties.subjectName=='<hostname>'].name" -o tsv
az containerapp env certificate delete -g rg-genki-test-weu -n genai-test-hosted-env --certificate <name> --yes
```

and for `<label>.apps.<zone>`, `az network dns record-set cname delete` and `txt delete` for `<label>` and `asuid.<label>` in the zone `apps.<zone>`.

A deploy that ran while the binder removed a name can bind it again: the deploy read the host app's domains before the unbind and wrote them after. Nothing takes it off again, since the claim is gone. After such a deploy, check `az containerapp hostname list -g rg-genki-test-weu -n genai-test-assistant` against the claims and remove a name left behind with the commands above.

### Stopping it

At once: `az containerapp job stop -g rg-genki-test-weu -n genai-test-hostname-binder` ends a running execution, and removing the binder's role assignments (`az role assignment list --assignee <principal id> --all`, then `az role assignment delete --ids ...`) takes its rights. Emptying `HOSTNAME_BINDER_AUDIENCE` and a deploy leaves the job as it is, since the template then no longer manages it; delete it with `az containerapp job delete`. Keep `keepBoundDomains = true` in the parameter file when turning `hostnameBinderEnabled` off: the next deploy otherwise drops every domain the binder bound from the host app. Rotate `genai-proxy-key` in both vaults, and remove by hand what it bound, if the binder's identity may have been used by someone else.

## Hostname claims

A service owner's address is a claim (ADR 0062). Read it with `GET /tenants/{tenant}/services/{service}/hostnames`; every change is in the audit log under `platform.client.hostnames.*` and `platform.service.address`.

- **Stuck in `pending-dns`:** the `dns_check` column of the claim's row in `hostname_claims` shows which of the challenge, `asuid` and target records the worker saw at `checkedAt`. The worker asks the zone's own name servers, so a record the owner has just made counts at the next run (every 5 minutes). After 7 days the claim fails with `expired`, and the owner claims again.
- **Stuck in `binding`:** the binder reports each step's result, and the `message` column of the claim's row holds the status and code of Azure's last answer; tenants do not see it. A failure it keeps reporting for 48 hours is unbound when it got past `add`, then ends `failed` with `bind_failed: <step>`; the owner claims again once the cause is fixed. A claim the binder never reports on stays in `binding`: check that the binder runs, and that the API has `GENAI_HOSTNAME_BINDER_PRINCIPAL_ID`, `GENAI_HOSTNAME_BINDER_TENANT_ID` (both GUIDs) and `GENAI_HOSTNAME_BINDER_AUDIENCE`. Without them `/internal/hostnames/*` answers `404` to the binder too.
- **Stuck in `removing`:** the name stays held until the unbind succeeds, however long that takes; the `message` column holds the status and code of the last failure.
- **`failed` with `not_verified`:** another claim holds the name. An operator finds the holder in the `hostname_claims` table.
- **`lapsed`:** the owner's records have been gone 7 days in a row, so the name is no longer served. Putting the records back does not reopen it; the owner claims it again, with new records. 30 days after it lapsed it is unbound.
- **No address at first publish:** `GENAI_DNS_ZONE` is unset, the production version has no `interface.layout`, the service had an assigned name before, a hosted Client of the service has a hostname from the parameter file already, or, in lockdown, the publisher was not an operator. `POST /tenants/{tenant}/services/{service}/address` gives one on request, under the same conditions except the first.

## Moving a team's domain to genki

How a service that runs its own frontend today moves its existing hostname to genki's assistant host (ADR 0061), with Kunnskapsassistenten's `qa.kunnskap.digdir.cloud` as the worked example. How hosted hostnames work in the template is in [infra/README.md](../infra/README.md#hosted-hostnames).

The example as it stood on 2026-11-19: the container app `ka-app` in `ka-app-env` (resource group `rg-ka-test-weu`, subscription `Altinn-AI-Assistant`) has `qa.kunnskap.digdir.cloud` bound with a managed certificate. The zone `kunnskap.digdir.cloud` is an Azure DNS zone in the same resource group, delegated from `digdir.cloud`, with `CNAME qa` (TTL 300) to `ka-app`'s generated host name and `TXT asuid.qa` (TTL 3600).

### First, a name in genki's zone

A service can be drawn on a name genki assigns before its own domain moves, and keep it after. For the example, `kunnskap.apps.genki-test.digdir.cloud`:

1. A pull request adds `{ subdomain: 'kunnskap', tenant: '<organisation number>', stage: 'none' }` to `hostedHostnames` in `infra/env/test.bicepparam`. The deploy that follows applies the whole template (the parameter file changed), which writes `CNAME kunnskap.apps` and `TXT asuid.kunnskap.apps` in genki's zone (in the zone `apps.<zone>`, as `kunnskap` and `asuid.kunnskap`, while the binder is on).
2. Add `kunnskap.apps.genki-test.digdir.cloud` to the service's hosted Client (`spec.hostnames`).
3. Pull requests set the entry's `stage` to `hostnames`, then `certificates`, each merged and deployed.
4. Check that `https://kunnskap.apps.genki-test.digdir.cloud/` draws the service and that sign-in works. On genki's platform login nothing is registered per hostname; a Client with its own `oidc` needs `https://kunnskap.apps.genki-test.digdir.cloud/auth/callback` as a redirect URI and the hostname's root as post-logout URI in its Ansattporten client.

Then move the team's own domain with the steps below.

### Before you start

- The assistant host runs in the environment (`assistantHostEnabled`), and the service draws 1:1 on a genki hostname.
- The service's Client in genki is hosted and has the **same Ansattporten client id** as the old frontend. A thread's owner is the tenant and `issuer|sub` (`userKey` in `packages/conversations/src/routes.ts`), and Ansattporten's `sub` is pairwise per client, so threads stay only if all three match:
  - the client id: the old app's `ANSATTPORTEN_CLIENT_ID` is the Client's `spec.oidc.clientId`;
  - the issuer: the old app's `ANSATTPORTEN_ISSUER` is genki's `ANSATTPORTEN_ISSUER` (`https://test.ansattporten.no` on genki-test), character for character, trailing slash included;
  - the tenant: the organisation the threads are stored under is the one the person lands in on genki. In lockdown that is `PLATFORM_TENANT`, as it was for the old app.

  Compare the values by reading them in the portal or with `az containerapp show ... --query "properties.template.containers[0].env[?name=='ANSATTPORTEN_ISSUER']"` one name at a time; never list all of the app's settings, which include secrets.

- The Ansattporten client has `https://<hostname>/auth/callback` as a redirect URI and `https://<hostname>/` as post-logout URI. The host keeps the old frontend's routes (ADR 0061), so nothing changes for a hostname already registered. The client secret is in genki as the Client's tenant secret (ADR 0061).
- Azure binds a hostname to one app at a time, so the hostname is down from step 4 until the certificate is bound in step 6, about two deploys. Tell its users first if it has any; Kunnskapsassistenten is not in production and has none, so its swap needs no window and can follow the deploy at once.
- A hosted assistant that real people use in production needs the BFF first (ADR 0034). A test service such as Kunnskapsassistenten's does not wait for it.

### Steps

1. **Lower the TTLs** of the hostname's records to 300 seconds, so a rollback reaches people in minutes. For the example, `asuid.qa` is at 3600:

   ```sh
   az network dns record-set txt update --subscription Altinn-AI-Assistant -g rg-ka-test-weu -z kunnskap.digdir.cloud -n asuid.qa --set ttl=300
   ```

2. **Open the hostname in genki.** A pull request adds it to the environment's parameter file at stage `none`, with the organisation number that owns the service in genki:

   ```bicep
   param hostedHostnames = [
     { hostname: 'qa.kunnskap.digdir.cloud', tenant: '<organisation number>', stage: 'none' }
   ]
   ```

   Merge and deploy. Then add the hostname to the service's hosted Client in the portal (or `spec.hostnames` through the API). `GET https://api.genki-test.digdir.cloud/v1/hosts/qa.kunnskap.digdir.cloud` now answers the service. The old app still serves the domain.

3. **Add genki's validation record** beside the old one. Read the values from the deploy's output `assistantHost.dnsRecords`. `asuid.qa` gets genki's verification id as a second value, so both apps validate:

   ```sh
   az network dns record-set txt add-record --subscription Altinn-AI-Assistant -g rg-ka-test-weu -z kunnskap.digdir.cloud -n asuid.qa -v <assistantHost.verificationId>
   ```

4. **Take the hostname off the old app and point it at genki:**

   ```sh
   az containerapp hostname delete --subscription Altinn-AI-Assistant -g rg-ka-test-weu -n ka-app --hostname qa.kunnskap.digdir.cloud --yes
   az network dns record-set cname set-record --subscription Altinn-AI-Assistant -g rg-ka-test-weu -z kunnskap.digdir.cloud -n qa -c <assistantHost.fqdn>
   ```

   Check with `dig +short qa.kunnskap.digdir.cloud @ns1-03.azure-dns.com` that the zone answers genki's host name.

5. **Bind it without a certificate:** a pull request sets the entry's `stage` to `hostnames`; merge and deploy. `az containerapp hostname list -g <genki's resource group> -n <name>-assistant` shows it with binding `Disabled`.

6. **Bind the certificate:** a pull request sets `stage` to `certificates`; merge and deploy. Azure issues the certificate within minutes; the deploy waits for it.

7. **Verify:**
   - `curl -sI https://qa.kunnskap.digdir.cloud/` answers from the host (the generic host's page, not the old app's), with a valid certificate for the hostname.
   - Sign in as a tester who used the old app and see their earlier threads in the list. Ask one tester to open an old thread and send a message.
   - No new requests reach the old app (its console log in `ka-app-logs`).

An apex hostname works the same way, with `apex: true`, an `A` record at `@` to `assistantHost.staticIp` instead of the CNAME, and `TXT asuid` at the apex.

### Rolling back

Point the CNAME back at the old app's generated host name (`ka-app.greenbeach-1657b6b7.westeurope.azurecontainerapps.io` for the example), set the entry's `stage` to `none` by pull request and deploy, which takes the hostname off genki's host, and bind it to the old app again with its certificate, which is still in the old environment:

```sh
az containerapp hostname add --subscription Altinn-AI-Assistant -g rg-ka-test-weu -n ka-app --hostname qa.kunnskap.digdir.cloud
az containerapp hostname bind --subscription Altinn-AI-Assistant -g rg-ka-test-weu -n ka-app --hostname qa.kunnskap.digdir.cloud --environment ka-app-env --certificate mc-ka-app-env-qa-kunnskap-digd-9951
```

Threads made on genki in between stay in genki. The old app keeps running, without the hostname, until it is retired.

## Retiring a team's old hosting

After a domain has moved, the old frontend's Azure resources are removed once the swap is verified (step 7 above) and the team agrees. Nothing here is done by genki's workflows: a person with rights on the old resource group runs the commands, in this order.

**Who decides** is open: #771's decision 8 (ownership) is not settled on 2026-11-19. Whoever agrees for the team records it in the issue before anything is deleted.

### Kunnskapsassistenten's resources

Found read-only on 2026-11-19, subscription `Altinn-AI-Assistant`:

| Resource                                  | Type                       | Where                                          | Retire                                                                 |
| ----------------------------------------- | -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| `ka-app`                                  | Container app              | `rg-ka-test-weu`                               | Yes                                                                    |
| `ka-app-env`                              | Container Apps environment | `rg-ka-test-weu`                               | Yes, after the app and certificate                                     |
| `mc-ka-app-env-qa-kunnskap-digd-9951`     | Managed certificate        | `ka-app-env`                                   | Yes, goes with the environment                                         |
| `ka-app-logs`                             | Log Analytics workspace    | `rg-ka-test-weu`                               | Yes, after any logs that must be kept are exported (30 days retention) |
| `ka-app-id`                               | User-assigned identity     | `rg-ka-test-weu`                               | Yes, after its role assignment                                         |
| AcrPull for `ka-app-id`                   | Role assignment            | registry `sharedregistryswc`                   | Yes, before the identity                                               |
| `ka-app` (16 tags)                        | Image repository           | `sharedregistryswc` (`rg-shared-registry-swc`) | Yes                                                                    |
| `ka-app` (5 tags, last pushed 2026-10-16) | Image repository           | `altinnaicontainers` (`altinn-ai-assistant`)   | Yes, older deploys; the registry's other repositories are not KA's     |
| `kunnskap.digdir.cloud`                   | DNS zone                   | `rg-ka-test-weu`                               | **No**: keep until moved                                               |
| The Ansattporten client                   | Samarbeidsportalen         | not Azure                                      | **No**: genki's BFF uses it                                            |

`rg-ka-test-weu` has no other resources and no role assignments of its own. Because the zone stays, the resource group stays too, until the zone has moved.

### Order

Each step is safe to stop after. Run them only after the decision is recorded.

```sh
SUB=Altinn-AI-Assistant RG=rg-ka-test-weu

# 1. Stop the app, still restorable: proves nothing depends on it.
az containerapp update --subscription $SUB -g $RG -n ka-app --min-replicas 0 --max-replicas 1
az containerapp revision list --subscription $SUB -g $RG -n ka-app --query "[?properties.active].name" -o tsv \
  | xargs -n1 az containerapp revision deactivate --subscription $SUB -g $RG -n ka-app --revision

# 2. Once nothing has missed it: delete the app, then its environment (with the certificate).
az containerapp delete --subscription $SUB -g $RG -n ka-app --yes
az containerapp env delete --subscription $SUB -g $RG -n ka-app-env --yes

# 3. The identity's registry grant, then the identity.
PRINCIPAL=$(az identity show --subscription $SUB -g $RG -n ka-app-id --query principalId -o tsv)
az role assignment delete --assignee "$PRINCIPAL" --role AcrPull \
  --scope "$(az acr show --subscription $SUB -n sharedregistryswc --query id -o tsv)"
az identity delete --subscription $SUB -g $RG -n ka-app-id

# 4. The logs, once exported if needed.
az monitor log-analytics workspace delete --subscription $SUB -g $RG -n ka-app-logs --yes

# 5. The images.
az acr repository delete --subscription $SUB -n sharedregistryswc --repository ka-app --yes
az acr repository delete --subscription $SUB -n altinnaicontainers --repository ka-app --yes
```

Then:

- Remove `asuid.qa`'s old value (the old environment's verification id) from the zone, and leave genki's.
- The old app held the Ansattporten client secret and a Typesense key as Container Apps secrets. Deleting the app deletes them; rotate the client secret in Samarbeidsportalen once and put the new value in genki's tenant secret, since a copy lived outside genki.
- Mark the old frontend's deploy notes as retired in its own repository.

### Moving the DNS zone

The zone stays in `rg-ka-test-weu` until its owner decides where it lives. Azure DNS zones can move to another resource group or subscription with `az resource move`; check that `az network dns zone show ... --query nameServers` is the same before and after, since `digdir.cloud` delegates to those name servers. Once the zone has moved, the empty resource group can be deleted with `az group delete --subscription Altinn-AI-Assistant -n rg-ka-test-weu`.
