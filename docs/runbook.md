# Runbook

What to do when genki alerts, and how to prove each alert works. Infrastructure is described in [infra/README.md](../infra/README.md).

## Alerts

`infra/modules/alerts.bicep` creates them when `alertsEnabled` is on, which both `test.bicepparam` and `prod.bicepparam` set. The rules are named `genai-<env>-<key>` and send to the action group `genai-<env>-alerts`.

### Receivers

The action group emails the addresses in the GitHub environment variable `ALERT_EMAILS` (Settings → Environments → test or prod → Variables), comma separated. They are never written in the repository. The next infra or deploy run applies a change. Without the variable the alerts still fire and show under Monitor → Alerts in the portal, but nobody is told.

### What each alert means

All log alerts read the Container Apps tables in the environment's Log Analytics workspace (`genai-<env>-logs`). The apps log one JSON object per line, so `parse_json(Log).msg` is the message.

| Rule             | Severity | Signal                                                                                                                                                                                        | Fires when                                                                         |
| ---------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `api-down`       | 1        | Application Insights standard availability test `genai-<env>-api-health`: `GET /health` from West Europe, North Europe and UK West, expecting 200 and a certificate valid for at least 7 days | Two of the three locations fail. The test runs every 15 minutes in test, 5 in prod |
| `api-errors`     | 2        | `ContainerAppHTTPLogs` for the API: share of responses with status 500 or above. Status 0 (the client went away) does not count                                                               | At least 5 % over 15 minutes, with at least 20 requests                            |
| `model-provider` | 2        | `model call failed` (a chat or embedding call) with `code` `unavailable` or `rate_limited`, from the API and the worker                                                                       | At least 5 in 15 minutes                                                           |
| `ingestion`      | 3        | `ingestion run failed`, `knowledge job refused`, `knowledge server unreachable`, `knowledge reconciler failed` or `job queue error`, from the API and the worker                              | At least 1 in an hour, checked every 15 minutes                                    |
| `altinn`         | 2        | `altinn actions failed` (a decision point lookup, including its Maskinporten and Altinn token exchange) and `altinn token not fetched at boot`, from the API                                  | At least 3 in 15 minutes                                                           |
| `login-keys`     | 1        | `login keys not fetched`: the API could not fetch the signing keys (JWKS) of Ansattporten or Maskinporten                                                                                     | At least 1 in 15 minutes                                                           |

The thresholds are the parameter `alertThresholds` in `main.bicep`. The log alerts resolve themselves when the condition clears.

### First steps

Open the alert in the portal and choose **View query results** to see the lines that fired it. To read around them:

```kusto
ContainerAppConsoleLogs
| where ContainerAppName in ('genai-test-api', 'genai-test-worker')
| where TimeGenerated > ago(1h)
| project TimeGenerated, ContainerAppName, Log
| order by TimeGenerated desc
```

**API down.** Check whether the API answers at all: `curl -i https://api.genki-test.digdir.cloud/health`. Then look at the revision and its replicas (`az containerapp revision list -n genai-test-api -g <resource group> -o table`) and at `ContainerAppSystemLogs` for `ProbeFailed`, `ContainerTerminated` or a failed revision. A `refusing to start` line in the console log names the missing setting. If the last deploy broke it, run the deploy workflow on the previous good commit. A failing certificate check means the managed certificate on the custom domain did not renew.

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

**Ingestion failures.** The message says where to look:

- `ingestion run failed`: the run's `dataset`, `pipeline` and `execution` id are in the line; the run's error is on the run in the console, under the dataset's pipeline.
- `knowledge job refused`: a job whose run was not admitted, or in lockdown was admitted more than 24 hours ago. Start the run again.
- `knowledge server unreachable`, `knowledge reconciler failed`: the knowledge server or its network. See [Knowledge server](../infra/README.md#knowledge-server).
- `job queue error`: pg-boss lost the platform database. Check the Postgres server.

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

**Altinn unavailable.** The `error` field says which step failed. Logins still work, but people get no rights from Altinn while it lasts, so they see less than they should. Check the Altinn status (tt02 in test), the Maskinporten client and its key (`altinn-pdp-maskinporten-key` in Key Vault) and the subscription key (`altinn-subscription-key`).

**Ansattporten or Maskinporten keys unavailable.** Every login with that issuer fails with 401 until the keys can be fetched. The line has the `issuer`, the `uri` and the `status` or `error`. Check that the URI answers from outside (`curl -i <uri>`) and that `ANSATTPORTEN_ISSUER` or `MASKINPORTEN_JWKS_URI` is right. The API fetches the keys again on the next login, so it recovers by itself once the issuer answers.

### Prove each alert in test

Do this once after the first deploy with alerts, with `ALERT_EMAILS` set, and note the time each email arrives. The resource group is `rg-genki-test-weu`. An infra or deploy run puts every rule and the availability test back as the template says.

The log alerts are proved by writing the line they look for to the container's own log, which reaches Log Analytics as any other line does. Open a shell in the API container:

```sh
az containerapp exec -n genai-test-api -g rg-genki-test-weu --command sh
```

and in it, for the alert you are testing:

```sh
# model-provider: five lines
for i in 1 2 3 4 5; do echo '{"msg":"model call failed","code":"unavailable","model":"drill","drill":true}' > /proc/1/fd/1; done
# ingestion
echo '{"msg":"ingestion run failed","dataset":"drill","pipeline":"drill","execution":"drill","drill":true}' > /proc/1/fd/1
# altinn: three lines
for i in 1 2 3; do echo '{"msg":"altinn actions failed","error":"drill","drill":true}' > /proc/1/fd/1; done
# login-keys
echo '{"msg":"login keys not fetched","issuer":"drill","uri":"drill","status":503,"drill":true}' > /proc/1/fd/1
```

If the shell cannot write to `/proc/1/fd/1`, lower the rule's threshold instead, as for `api-errors` below. The lines take a few minutes to reach the workspace, and the rule fires on its next evaluation: within about 10 minutes, 25 for `ingestion`. The alert resolves by itself once the window has passed.

`api-errors`: there is no safe way to make the API answer 5xx on purpose. In the portal, open the rule `genai-test-api-errors`, set its threshold to 0 and save. Make at least 20 requests (`for i in $(seq 25); do curl -s -o /dev/null https://api.genki-test.digdir.cloud/health; done`) and wait for the email. Then set the threshold back to 5, or run the infra workflow.

`api-down`: in the portal, open Application Insights `genai-test-insights` → Availability → `genai-test-api-health` → Edit, and change the URL to `https://api.genki-test.digdir.cloud/health-drill`, which answers 404. The alert fires after the next test run, within about 30 minutes in test. Then change the URL back, or run the infra workflow.

### Managed by hand

Two cost alerts sit outside the environment's resource group, so the template does not create them:

- The budget `budget-genki` (5,000 kr a month on genki's resource groups, email at 80 % and 100 %) is set on the subscription.
- The metric alert `tokens-genki-test-ai` (more than 3 million tokens in an hour on `genki-test-ai`) is in `rg-genki-test-swc`, with the lab's shared action group `ag-ai-lab-cost`.

Change them in the portal. Application Insights also adds its own Failure Anomalies rule, with the action group `Application Insights Smart Detection`, which has no receivers.

### Cost

About 130 kr a month in test and 250 kr in prod, at list price: the availability test runs from three locations (every 15 minutes in test, every 5 in prod), and each log alert rule costs a little per month by how often it runs.
