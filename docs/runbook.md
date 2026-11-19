# Runbook

What to do when genki alerts, and how to prove each alert works. Infrastructure is described in [infra/README.md](../infra/README.md).

## Alerts

`infra/modules/alerts.bicep` creates them when `alertsEnabled` is on, which both `test.bicepparam` and `prod.bicepparam` set. The rules are named `genai-<env>-<key>` and send to the action group `genai-<env>-alerts`.

### Receivers

The action group emails the addresses in the GitHub environment variable `ALERT_EMAILS` (Settings → Environments → test or prod → Variables), comma separated. They are never written in the repository. The next infra or deploy run applies a change. Without the variable the alerts still fire and show under Monitor → Alerts in the portal, but nobody is told.

### What each alert means

All log alerts read the Container Apps tables in the environment's Log Analytics workspace (`genai-<env>-logs`). The apps log one JSON object per line, so `parse_json(Log).msg` is the message.

| Rule                   | Severity | Signal                                                                                                                                                                                                                                                                                                | Fires when                                                                             |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `api-down`             | 1        | Application Insights standard availability test `genai-<env>-api-health`: `GET /health` from West Europe, North Europe and UK West, expecting 200 and a certificate valid for at least 7 days                                                                                                         | Two of the three locations fail. The test runs every 5 minutes                         |
| `db-down`              | 1        | Azure Monitor metric `is_db_alive` (Maximum) on the platform Postgres server. `/health` never touches the database, so `api-down` does not see this                                                                                                                                                   | Below 1 for 5 minutes                                                                  |
| `api-errors`           | 2        | `ContainerAppHTTPLogs` for the API: share of responses with status 500 or above. Status 0 (the client went away) does not count                                                                                                                                                                       | At least 5 % over 15 minutes, with at least 20 requests                                |
| `api-latency`          | 2        | `ContainerAppHTTPLogs` for the API: 95th percentile of `RequestDuration`, leaving out paths with `/chat/completions` (streaming) and `/uploads` (files)                                                                                                                                               | Over 5 s over 15 minutes, with at least 50 requests                                    |
| `model-provider`       | 2        | `model call failed` (a chat or embedding call) with `code` `unavailable` or `rate_limited`, from the API and the worker                                                                                                                                                                               | At least 5 in 15 minutes                                                               |
| `worker-jobs`          | 3        | `ingestion run failed`, `knowledge job refused`, `knowledge server unreachable` or `knowledge reconciler failed`, from the API and the worker; `state register stale` (ADR 0058); or a `queue stats` line whose `oldestQueuedSeconds` is over 30 minutes                                              | At least 3 failures in an hour, or one stale or waiting line, checked every 15 minutes |
| `altinn`               | 2        | `altinn actions failed` (a decision point lookup, including its Maskinporten and Altinn token exchange) and `altinn token not fetched at boot`, from the API                                                                                                                                          | At least 3 in 15 minutes                                                               |
| `login-keys`           | 1        | `login keys not fetched`: the API could not fetch the signing keys (JWKS) of Ansattporten or Maskinporten                                                                                                                                                                                             | At least 1 in 15 minutes                                                               |
| `postgres-connections` | 2        | Azure Monitor metric `active_connections` (Maximum) on the platform Postgres server; the threshold is 80 % of the user connections of the server's SKU in `infra/postgres-connections.json`                                                                                                           | Above it in a 5 minute window: 331 on the B2s server in test                           |
| `platform-backup`      | 3        | `platform backup uploaded` from the job `genai-<env>-pg-backup` (see Backups)                                                                                                                                                                                                                         | None in the last day, checked every hour                                               |
| `service-health`       | -        | Azure Service Health for Postgres flexible servers, Container Apps, Key Vault, Storage, Foundry Models and Azure OpenAI in West Europe, Sweden Central or Global: incidents, planned maintenance, advisories and security notices. Only with `serviceHealthAlertEnabled` (infra/README.md, "Backups") | Azure posts an event                                                                   |

Every rule sends to the one email group; there is no SMS or paging. The rules are stateful: an incident sends one mail when it fires and one when it resolves, however long it lasts, so no rule fires on a single line that a passing problem writes (`login-keys` aside, since every login fails meanwhile). The thresholds are the parameter `alertThresholds` in `main.bicep`. The log alerts resolve themselves when the condition clears. Application Insights' own Failure Anomalies rule is declared in the template with state Disabled: `api-errors` covers it, and the rule Azure makes on its own mails everyone with Monitoring Contributor or Monitoring Reader on the subscription.

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

**API down.** Check whether the API answers at all: `curl -i https://api.genki-test.digdir.cloud/health`. Then look at the revision and its replicas (`az containerapp revision list -n genai-test-api -g <resource group> -o table`) and at `ContainerAppSystemLogs` for `ProbeFailed`, `ContainerTerminated` or a failed revision. A `refusing to start` line in the console log names the missing setting. If the last deploy broke it, run the `rollback` workflow (`gh workflow run rollback.yml`), which moves users back to the previous API revision; for the worker or the web apps, run the deploy workflow on the previous good commit ([Deploys users do not notice](../infra/README.md#deploys-users-do-not-notice)). A failing certificate check means the managed certificate on the custom domain did not renew.

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
- `queue stats` with `oldestQueuedSeconds` over 1800: jobs wait and nothing takes them. The `queues` list names the server and queue. Check that the worker runs one healthy revision (`az containerapp revision list -n genai-<env>-worker -g <resource group> -o table`), and for the queue's handler in the worker's log.

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

**Altinn unavailable.** The `error` field says which step failed. Logins still work, but people get no rights from Altinn while it lasts, so they see less than they should. Check the Altinn status (tt02 in test), the Maskinporten client and its key (`altinn-pdp-maskinporten-key` in Key Vault) and the subscription key (`altinn-subscription-key`).

**Ansattporten or Maskinporten keys unavailable.** Every login with that issuer fails with 401 until the keys can be fetched. The line has the `issuer`, the `uri` and the `status` or `error`. Check that the URI answers from outside (`curl -i <uri>`) and that `ANSATTPORTEN_ISSUER` or `MASKINPORTEN_JWKS_URI` is right. The API fetches the keys again on the next login, so it recovers by itself once the issuer answers.

**Database connections.** The platform server is close to its user connections; past them pg-pool logs `remaining connection slots are reserved` and the API answers 500. In this order:

1. Stop stale API revisions. Only `live` and `previous` should run, or `live` and `candidate` during a deploy: `az containerapp revision list -g <resource group> -n genai-<env>-api --query "[?properties.active].{name:name,traffic:properties.trafficWeight}" -o table`, then `az containerapp revision deactivate -g <resource group> -n genai-<env>-api --revision <name>` for any revision the traffic list (`az containerapp ingress traffic show`) does not name. The deploy does this itself before the candidate starts and after the traffic switch, so a stale one means a deploy stopped between them.
2. Raise the server's tier (`postgresSkuName` in the environment's `.bicepparam`, and its row in `infra/postgres-connections.json`). Azure keeps the first tier's `max_connections` through a resize, so the template sets it from that row; it takes effect after a restart (`az postgres flexible-server restart`), in a quiet window, since the resize has restarted the server once already ([Limits](https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-limits)). General Purpose tiers also allow the built-in PgBouncer on port 6432; Burstable tiers do not ([PgBouncer](https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-pgbouncer)).
3. Then raise `apiDatabasePoolMax` or `workerDatabasePoolMax`. `scripts/postgres-connections.test.ts` fails when the pools no longer fit the tier.

### Prove each alert in test

Do this once after the first deploy with alerts, with `ALERT_EMAILS` set, and note the time each email arrives. The resource group is `rg-genki-test-weu`. An infra run, or a deploy that applies the whole template, puts every rule and the availability test back as the template says; a deploy that skips the infrastructure leaves them as they are.

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
echo '{"msg":"queue stats","oldestQueuedSeconds":3600,"queues":[],"drill":true}' > /proc/1/fd/1
# altinn: three lines
for i in 1 2 3; do echo '{"msg":"altinn actions failed","error":"drill","drill":true}' > /proc/1/fd/1; done
# login-keys
echo '{"msg":"login keys not fetched","issuer":"drill","uri":"drill","status":503,"drill":true}' > /proc/1/fd/1
```

If the shell cannot write to `/proc/1/fd/1`, lower the rule's threshold instead, as for `api-errors` below. The lines take a few minutes to reach the workspace, and the rule fires on its next evaluation: within about 10 minutes, 25 for `worker-jobs`. The alert resolves by itself once the window has passed.

`api-errors`: there is no safe way to make the API answer 5xx on purpose. In the portal, open the rule `genai-test-api-errors`, set its threshold to 0 and save. Make at least 20 requests (`for i in $(seq 25); do curl -s -o /dev/null https://api.genki-test.digdir.cloud/health; done`) and wait for the email. Then set the threshold back to 5, or run the infra workflow.

`api-down`: in the portal, open Application Insights `genai-test-insights` → Availability → `genai-test-api-health` → Edit, and change the URL to `https://api.genki-test.digdir.cloud/health-drill`, which answers 404. The alert fires after the next test run, within about 10 minutes. Then change the URL back, or run the infra workflow.

`api-latency`: set the rule's threshold to 0 in the portal, make 50 requests as for `api-errors`, wait for the email and set it back to 5.

`db-down`: stop the server in a quiet window (`az postgres flexible-server stop`), wait for the email within about 10 minutes, and start it again. The API and worker are down meanwhile.

### Budgets

`infra/modules/budget.bicep`, with the alerts' email group:

| Budget                | Covers                                                                                                                                                                           | Amount a month | Emails at                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------- |
| `budget-genki-infra`  | the environment's resource group (`rg-genki-test-weu`): Postgres, Container Apps, monitoring, registry, storage, backups. The knowledge server (D2ds_v5) is about 1,600 kr of it | 5,000 kr       | 80 % and 100 % actual, 100 % forecast |
| `budget-genki-models` | `modelsBudgetResourceGroup` (`rg-genki-test-swc`): Foundry                                                                                                                       | 8,000 kr       | 80 % and 100 % actual, 100 % forecast |

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
- **Not backed up:** container images (built again from git) and Typesense, which is the shared headless-rag server, an external dependency genki only searches.

### Restore the platform database

1. Choose the time just before the damage, in UTC.
2. `az postgres flexible-server restore -g <resource group> -n <new server> --source-server <server> --restore-time <time> --vnet genai-<env>-vnet --subnet postgres --private-dns-zone <server>.private.postgres.database.azure.com`. It takes a few minutes; the drill below records how long.
3. Point the apps at the new server: set `PGHOST` on `genai-<env>-api` and `genai-<env>-worker` to the new server's host name (`az containerapp update --set-env-vars`), or swap names so the template's server name holds the restored data. Restart the worker.
4. Keep the old server until the new one is checked, then delete it or lock it.

From a nightly copy, when the server and its backups are gone: download the newest blob from the container `platform` from inside the network (a job in the environment), or after an owner has opened public access to one IP for the restore and closes it again, and run `pg_restore --no-owner --dbname genai` against a new, empty server as a member of the admin group. Roles and grants come from the migrations, which the API runs when it starts.

### Restore drill

`.github/workflows/platform-restore-drill.yml` runs on the first day of each quarter and on demand (`gh workflow run platform-restore-drill.yml`), in test only, in a concurrency group of its own. It restores the platform server as of 10 minutes earlier to `genai-<env>-pg-restore-drill`, writes how long it took to the run's summary, runs the job `genai-<env>-pg-restore-check`, which counts the rows of every table on both servers and fails when a table is missing or the restored server is empty, and deletes the restored server even when a step failed. A drill costs about 5 kr. By hand in the same quarter: restore one uploaded file from the share backup and compare its checksum, and recover a throwaway Key Vault secret. Write the times into issue #44; the target is met while restore plus repointing stays under 4 hours.
