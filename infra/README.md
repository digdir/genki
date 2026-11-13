# Infrastructure

The test environment is deployed from `main` by running `.github/workflows/deploy.yml` by hand (`gh workflow run deploy.yml`), after the checks in `ci.yml` pass. Infrastructure changes run by hand with `.github/workflows/infra.yml`, `what-if` first.

Bicep for genki's Azure environments: test (`env/test.bicepparam`, `genki-test.digdir.cloud`) and prod (`env/prod.bicepparam`, `genki.digdir.cloud`, see [Prod](#prod)). Both use the same template and the same host names under their own zone.

## What gets created (one resource group per environment)

| Resource                                   | Notes                                                                                                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Virtual network                            | `apps` subnet (/23, delegated to Container Apps), `postgres` subnet (delegated to Postgres Flexible Server)                                                       |
| Container Apps environment                 | The five container apps below, the shared `data` volume, managed certificates                                                                                     |
| Container registry (Basic)                 | No admin user; the apps pull with their identity (AcrPull), the deploy identity pushes (AcrPush)                                                                  |
| Key Vault                                  | RBAC only, purge protection; the apps read secrets with Key Vault Secrets User                                                                                    |
| Postgres Flexible Server 17                | Private networking only, Entra ID auth only (no passwords), database `genai`                                                                                      |
| Storage account with the file share `data` | Mounted at `/data` in the API and worker: uploads and other blobs (`BLOB_DIR=/data/blobs`)                                                                        |
| Blob container `conversions`               | In the same account: converters' native output (ADR 0042), blob versioning, earlier versions deleted 30 days after they were written, the knowledge worker writes |
| Log Analytics and Application Insights     | The environment's managed OpenTelemetry agent sends traces and logs to Application Insights                                                                       |
| Alerts (`alertsEnabled`)                   | Action group `<name>-alerts`, an availability test on the API's `/health` and six alert rules, see the [runbook](../docs/runbook.md#alerts)                       |
| DNS zone (optional, `createDnsZone`)       | `genki-test.digdir.cloud` or `genki.digdir.cloud` with a CNAME and a validation TXT record per host name                                                          |

From `KNOWLEDGE_SERVER_STAGE=server` on, also the environment's knowledge server in a network of its own, the knowledge identities and the principals job: see [Knowledge server](#knowledge-server).

## The containers

One `Dockerfile`, three targets:

| Container app          | Target   | Ingress | What it runs                                          |
| ---------------------- | -------- | ------- | ----------------------------------------------------- |
| `genai-test-api`       | `api`    | Public  | The API, on `api.genki-test.digdir.cloud`             |
| `genai-test-worker`    | `worker` | None    | Triggers, ingestion and batch jobs. One replica       |
| `genai-test-portal`    | `apps`   | Public  | The portal, on `portal.genki-test.digdir.cloud`       |
| `genai-test-workspace` | `apps`   | Public  | The workspace, on `workspace.genki-test.digdir.cloud` |
| `genai-test-console`   | `apps`   | Public  | The console, on `console.genki-test.digdir.cloud`     |

In prod the names are `genai-prod-*` and the host names end in `genki.digdir.cloud`.

The `api` and `worker` images hold each package's `dist` and the folders in `docker/runtime-assets`: the files the code reads from disk next to itself, such as eval judges, test sets and the seeded services. A test (`scripts/runtime-assets.test.ts`) fails when the code reads such a folder that is not listed.

They also hold `/app/genki-docs`: the documentation the GenKI guide answers from, collected at build time by `scripts/docs-bundle.ts` with the include list of `apps/api/config/local/pipelines/genki-docs.yaml`, so the guide always matches the deployed code. `INGEST_FOLDER_ROOT` points there, which makes it the only folder that folder pipelines can read.

The `apps` image holds all three app builds; `APP` picks which one a container serves. Settings are read at start, not at build: the container writes `/config.js` from its environment (`ANSATTPORTEN_ISSUER`, `OIDC_CLIENT_ID`, `API_AUDIENCE`, `ALTINN_RESOURCE`, `PUBLIC_API_BASE`, `PORTAL_URL`, and for the console `OIDC_ISSUER`, `OIDC_TOKEN_ENDPOINT`, `ENVIRONMENT`), so one image runs in every environment. It proxies `/api/` to the API (`API_UPSTREAM`), so the browser talks to one origin and the API needs no CORS. The proxy drops `/api` and forwards the rest of the request URI as the browser sent it, so encoded slashes in ids such as `digdir%2Fkudos` reach the API still encoded. The Azure ingress in front of the API decodes `%2F` anyway, so the API also accepts these ids with a plain slash (`/operator/datasets/digdir/kudos/pipelines`) and reads them as the encoded form (`apps/api/src/decoded-ids.ts`). It sends a Content Security Policy that allows connections to the login issuer only.

The API writes one JSON line to its console log for each request slower than `SLOW_REQUEST_MS` (500 ms by default): `{"msg":"request","method":"GET","route":"/tenants/:tenant/overview","status":200,"ms":1234}`. It names the route pattern, never the ids in the path or the query string. `LOG_REQUESTS=true` logs every request the same way.

## Database

The API and worker log in to Postgres with the app's managed identity and an Entra ID token as the password (`PGHOST`, `PGUSER`, `PGDATABASE`, `PGSSLMODE`, `AZURE_CLIENT_ID`). The token is fetched when a connection opens and reused until five minutes before it expires. `DATABASE_URL` still wins when set, which is how local development connects.

The app identity owns the schema and runs migrations. Queries run as `genai_runtime` (no BYPASSRLS), switched per connection with the `role` option, so row-level security applies (ADR 0022). The worker switches to `genai_worker` instead: a member of `genai_runtime` with the same row-level security, and of the roles the apps run queries as, the only one with rights on the `pgboss` job tables (ADR 0041). The migration creates both roles and lets the app identity switch to them.

The server allows the `vector` extension through its `azure.extensions` setting (`VECTOR`, in `modules/postgres.bicep`, for test and prod alike). Azure Postgres refuses `create extension` for any extension not on that list, and the pgvector engine creates `vector` when it first migrates. To allow more extensions later, add them to the same comma-separated value.

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
- **Connections:** `max_connections` stays at Azure's default, 859 on `Standard_D2ds_v5` with 15 reserved ([Azure: limits](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-limits)). Prod's pools need at most 102: the API's reader pool takes 10 per replica (`pg`'s default), the worker's owner and writer pools 20, pg-boss uses those pools (ADR 0041), counted twice for a deploy, for 3 API replicas, plus 2 for the job. Test's need at most 82, for 2 replicas.
- **pgvector:** Azure lists 0.8.2 for PostgreSQL 17 ([Azure: extension versions](https://learn.microsoft.com/en-us/azure/postgresql/extensions/concepts-extensions-versions)); the job's log shows the version the server runs (`extensions`). The VACUUM workaround of ADR 0042 holds until it is 0.8.4 or later.
- **Only its own logins connect:** the setup revokes `CONNECT` from `PUBLIC` and grants it to the environment's two logins and `azure_pg_admin`, since roles are global to a server. It fails when a grant it cannot remove is left, or while another role holds one of the logins with inherit or set.

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

| Variable                                                                                 | For                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANSATTPORTEN_ISSUER`                                                                    | Login for people, API and apps. Required: the API does not start without it                                                                                                                                                                                                                                                  |
| `PORTAL_CLIENT_ID`, `WORKSPACE_CLIENT_ID`                                                | Ansattporten client ids of the portal and workspace. With `CONSOLE_CLIENT_ID` they also make up the API's `EMPLOYEE_CLIENT_IDS`, the only clients besides tenant-registered ones whose Ansattporten logins the API accepts; `main.bicep` sets it, so it needs no variable of its own. The API refuses to start with it empty |
| `CONSOLE_CLIENT_ID`, `CONSOLE_TOKEN_ENDPOINT`                                            | The console's login (its issuer defaults to `ANSATTPORTEN_ISSUER`)                                                                                                                                                                                                                                                           |
| `ALTINN_PDP_URL`                                                                         | The Altinn decision point. Required: the API does not start without it                                                                                                                                                                                                                                                       |
| `ALTINN_PDP_MASKINPORTEN_CLIENT_ID`                                                      | The Maskinporten client that asks the decision point                                                                                                                                                                                                                                                                         |
| `MASKINPORTEN_ISSUER`, `MASKINPORTEN_TOKEN_URL`                                          | Maskinporten, for the decision point and for systems calling the API                                                                                                                                                                                                                                                         |
| `OPERATOR_SUBJECTS`                                                                      | People with the operator role: comma-separated `issuer\|subject` pairs of Ansattporten logins. The API refuses to start with a bare subject or without `OPERATOR_CLIENT_IDS`. A listed person is an operator only when logging in through one of those clients. Maskinporten clients never become operators                  |
| `ALTINN_RESOURCE`                                                                        | Test only. The Altinn resource whose rights count in genki                                                                                                                                                                                                                                                                   |
| `PLATFORM_TENANT`                                                                        | Test only. The organisation that plays Digdir, for test organisations. Empty means Digdir                                                                                                                                                                                                                                    |
| `FOUNDRY_OPENAI_BASE_URL`, `FOUNDRY_CLAUDE_BASE_URL`, `TYPESENSE_URL`, `COLBERT_API_URL` | Models, search and reranking                                                                                                                                                                                                                                                                                                 |
| `LANGFUSE_BASE_URL`, `LANGFUSE_INSTANCE_RECEIVES_CONTENT`                                | Digdir's Langfuse, offered in the portal's Langfuse connection form; `true` once it may receive text (ADR 0011). Unset: the form asks only for an agency's own Langfuse. Test sets the URL in `test.bicepparam`                                                                                                              |
| `TRACES_ENDPOINT`, `TRACES_RESIDENCY`                                                    | Test only. Where genki sends its own traces (`https://<host>/api/public/otel`) and where that store is (`norway`, `eu` or `global`). Needs the two Langfuse keys in Key Vault                                                                                                                                                |
| `CUSTOM_DOMAINS_STAGE`                                                                   | `none`, `hostnames` or `certificates`; see Host names below                                                                                                                                                                                                                                                                  |
| `KNOWLEDGE_SERVER_STAGE`                                                                 | `none`, `server` or `apps`; unset or empty means `none`. On the test environment, or a repository variable when environment settings are out of reach. See [Knowledge server](#knowledge-server)                                                                                                                             |
| `LOCKDOWN_ENTRA_GROUPS`                                                                  | Test only. Entra group object ids, comma separated, whose members get the whole platform in lockdown                                                                                                                                                                                                                         |
| `LOCKDOWN_USER_GROUPS`                                                                   | Test only. Entra group object ids, comma separated, whose members get every right in `PLATFORM_TENANT` in lockdown, as `LOCKDOWN_ENTRA_GROUPS` does, but never the operator role. Same client and email checks; `LOCKDOWN_ENTRA_GROUPS` wins for a login in both                                                             |
| `LOCKDOWN_ENTRA_EMAIL_DOMAIN`                                                            | Test only. Extra guard for those Entra logins: the email must be at this domain. Set it to `digdir.no`; empty turns it off                                                                                                                                                                                                   |
| `OPERATOR_CLIENT_IDS`                                                                    | Test only. The Ansattporten client ids, comma separated, whose Entra logins count for `LOCKDOWN_ENTRA_GROUPS` and `LOCKDOWN_USER_GROUPS`: the portal, workspace and console clients (each app's `OIDC_CLIENT_ID`). Set it before deploying: in lockdown the API refuses to start with either group setting and without it    |
| `ALERT_EMAILS`                                                                           | Email addresses that get the alerts, comma separated. Set it per environment, test and prod; never in the repository. Empty means the alerts fire in the portal without notifying anyone. See the [runbook](../docs/runbook.md#alerts)                                                                                       |

`test.bicepparam` also sets `GENAI_LOCKDOWN=true` in `appEnv`, not from a variable: genki-test is always locked. In lockdown only API keys from configuration and people who log in through Ansattporten with Entra ID and are in one of `LOCKDOWN_ENTRA_GROUPS` may use models or run ingestion. Those Entra logins, only from the clients in `OPERATOR_CLIENT_IDS` and never through a client a tenant registered, get every right in `PLATFORM_TENANT` and the operator role. The `operator: true` persons in the image's `identity.yaml` count only for the dev-mode mock login and are ignored, with a log line, everywhere else. TestID logins and operators can only read and search; API keys and Maskinporten clients created by such an Entra login may use models and run ingestion within their own bindings; other keys made through the API can read, search and change configuration, but not run anything that reaches a model, fetches documents or writes new embeddings, and scheduled ingestion is skipped. `appEnv` reaches the worker too, which then runs no triggers. See [ADR 0033](../docs/adr/0033-locked-test-environment.md).

The API audience (`digdir:genai`) has a default in `main.bicep`. genki-test reads the Altinn resource from `ALTINN_RESOURCE` and uses `urn:altinn:resource:digdir-genai-platform-test`. `prod.bicepparam` fixes the resource to `urn:altinn:resource:digdir-genai-platform` and the platform tenant to Digdir, and sets no `GENAI_LOCKDOWN`, so neither variable has any effect in prod.

Secrets live only in Key Vault. Each name in `keyVaultSecretNames` becomes an environment variable in the API and worker, which the platform reads as `secret://env/<name>`:

| Key Vault secret              | Env var in the app            |
| ----------------------------- | ----------------------------- |
| `content-master-key`          | `CONTENT_MASTER_KEY`          |
| `altinn-pdp-maskinporten-key` | `ALTINN_PDP_MASKINPORTEN_KEY` |
| `altinn-subscription-key`     | `ALTINN_SUBSCRIPTION_KEY`     |
| `foundry-openai-key`          | `FOUNDRY_OPENAI_KEY`          |
| `foundry-claude-key`          | `FOUNDRY_CLAUDE_KEY`          |
| `typesense-key`               | `TYPESENSE_KEY` (search only) |
| `colbert-api-key`             | `COLBERT_API_KEY`             |
| `langfuse-public-key`         | `LANGFUSE_PUBLIC_KEY` (test)  |
| `langfuse-secret-key`         | `LANGFUSE_SECRET_KEY` (test)  |

Create every secret in Key Vault before the first deploy, or remove its name from the parameter file. A name listed without a secret behind it stops the revision from starting. `CONTENT_MASTER_KEY` is 32 random bytes, base64: `openssl rand -base64 32`.

Development mode is off: the image sets `NODE_ENV=production`, and the API refuses `GENAI_DEV_MODE=true` there.

## Host names and DNS

| Host name                           | Container app          |
| ----------------------------------- | ---------------------- |
| `api.genki-test.digdir.cloud`       | `genai-test-api`       |
| `portal.genki-test.digdir.cloud`    | `genai-test-portal`    |
| `workspace.genki-test.digdir.cloud` | `genai-test-workspace` |
| `console.genki-test.digdir.cloud`   | `genai-test-console`   |

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

## Login registrations

Register one Ansattporten integration per app and environment: in Ansattporten's test environment for genki-test, in production Ansattporten (`https://ansattporten.no`) for prod. `<zone>` is `genki-test.digdir.cloud` or `genki.digdir.cloud`:

| App       | Redirect URI                        | Post-logout redirect URI    |
| --------- | ----------------------------------- | --------------------------- |
| Portal    | `https://portal.<zone>/callback`    | `https://portal.<zone>/`    |
| Workspace | `https://workspace.<zone>/callback` | `https://workspace.<zone>/` |
| Console   | `https://console.<zone>/callback`   | `https://console.<zone>/`   |

Each asks for `openid profile`, the API audience `digdir:genai`, and `authorization_details` of type `ansattporten:altinn:resource` for the environment's Altinn resource: `urn:altinn:resource:digdir-genai-platform-test` in test, `urn:altinn:resource:digdir-genai-platform` in prod. Put the client ids in `PORTAL_CLIENT_ID`, `WORKSPACE_CLIENT_ID` and `CONSOLE_CLIENT_ID` of the matching GitHub environment.

The decision point needs, per environment, the Altinn resource, a Maskinporten client owned by Digdir with the scope `altinn:authorization/authorize`, and an Altinn subscription key: in tt02 and Maskinporten test for genki-test, in Altinn production (`https://platform.altinn.no`) and production Maskinporten (`https://maskinporten.no/`) for prod. Issues #42 and #43 describe them.

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
3. Run the **deploy** workflow on `main` (`gh workflow run deploy.yml`). It runs the checks, builds the `api`, `worker` and `apps` images, pushes them and deploys them by digest. While `ALTINN_PDP_URL` is not set, it deploys the worker and the apps only: the API keeps its current image, since it refuses to start without the real Altinn decision point, and the run summary says so. Once it is set, the deploy also waits until the API's `/health` reports the commit.
4. When the delegation works, set `CUSTOM_DOMAINS_STAGE=hostnames` and run infra, then `certificates` and run it again.

After that, run the deploy workflow whenever `main` should go to test; merges do not deploy on their own. Infra changes ride along with the next deploy, or run the infra workflow by hand.

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

The deploy workflow builds the images once and pushes them to the test registry. `deploy-prod` copies the exact digests that went to test into prod's registry with `az acr import` (tagged with the commit), and deploys prod from there. Prod's app identity pulls only from its own registry, so prod keeps running if test or its registry is gone. The import needs the prod deploy identity to read the test registry; it signs in with its own identity, no registry passwords.

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

   | Variable                                                                                 | Value                                                                                                           |
   | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
   | `AZURE_CLIENT_ID`, `DEPLOY_PRINCIPAL_ID`                                                 | Client id and service principal object id of the prod deploy identity                                           |
   | `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`                                               | Same as test                                                                                                    |
   | `AZURE_RESOURCE_GROUP`                                                                   | `rg-genki-prod-weu`                                                                                             |
   | `PG_ADMIN_GROUP_OBJECT_ID`, `PG_ADMIN_GROUP_NAME`                                        | The group from step 3                                                                                           |
   | `ACR_NAME`                                                                               | Set after the first infra run (output `registryName`)                                                           |
   | `ANSATTPORTEN_ISSUER`                                                                    | `https://ansattporten.no`                                                                                       |
   | `PORTAL_CLIENT_ID`, `WORKSPACE_CLIENT_ID`, `CONSOLE_CLIENT_ID`                           | The production Ansattporten clients                                                                             |
   | `CONSOLE_TOKEN_ENDPOINT`                                                                 | Production Ansattporten's token endpoint                                                                        |
   | `ALTINN_PDP_URL`                                                                         | Altinn production's decision point, under `https://platform.altinn.no`                                          |
   | `ALTINN_PDP_MASKINPORTEN_CLIENT_ID`                                                      | The production Maskinporten client                                                                              |
   | `MASKINPORTEN_ISSUER`, `MASKINPORTEN_TOKEN_URL`                                          | `https://maskinporten.no/`, `https://maskinporten.no/token`                                                     |
   | `OPERATOR_SUBJECTS`                                                                      | The prod operators as `https://ansattporten.no\|<sub>` pairs. Personal data: only here, never in the repository |
   | `FOUNDRY_OPENAI_BASE_URL`, `FOUNDRY_CLAUDE_BASE_URL`, `TYPESENSE_URL`, `COLBERT_API_URL` | Models, search and reranking for prod                                                                           |
   | `CUSTOM_DOMAINS_STAGE`                                                                   | `none`, then `hostnames`, then `certificates`                                                                   |
   | `KNOWLEDGE_SERVER_STAGE`                                                                 | `none` while test's value is a repository variable, otherwise unset; later `server`, then `apps`                |
   | `PROD_READY`                                                                             | `true` once everything above is in place; until then `deploy-prod` is skipped                                   |

   `PLATFORM_TENANT` and `ALTINN_RESOURCE` stay unset; prod fixes both.

5. **Registrations**: production Ansattporten clients with `genki.digdir.cloud` addresses, the Altinn production resource `urn:altinn:resource:digdir-genai-platform`, a production Maskinporten client owned by Digdir with `altinn:authorization/authorize`, and an Altinn production subscription key. See [Login registrations](#login-registrations).
6. **Key Vault secrets** from the table in [Settings and secrets](#settings-and-secrets), with production values and a new `content-master-key`, after the first infra run creates the vault.

### First prod deploy

1. Run **infra** with environment `prod` and `what-if` on, read the plan, then again with `what-if` off. It creates the registry, vault, Postgres server (with geo-redundant backup) and the DNS records, with placeholder images.
2. Set `ACR_NAME` in the prod environment from the output `registryName`, and add the Key Vault secrets (output `keyVaultName`).
3. Make sure `digdir.cloud` delegates `genki` to the zone's name servers (output `dnsNameServers`), as for test. Set `CUSTOM_DOMAINS_STAGE=hostnames` and run infra for prod, then `certificates` and run it again.
4. Set `PROD_READY=true`.
5. Run **deploy** with environment `prod` (`gh workflow run deploy.yml -f environment=prod`). It builds, deploys to test, waits for the required reviewers, copies the images into prod's registry, deploys prod, and waits until the API's `/health` reports the commit. It stops early if `ACR_NAME`, `ANSATTPORTEN_ISSUER` or `ALTINN_PDP_URL` is missing.

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
