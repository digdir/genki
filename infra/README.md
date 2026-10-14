# Infrastructure

The test environment is deployed from `main` by running `.github/workflows/deploy.yml` by hand (`gh workflow run deploy.yml`), after the checks in `ci.yml` pass. Infrastructure changes run by hand with `.github/workflows/infra.yml`, `what-if` first.

Bicep for genki's Azure environments. Test exists now; prod gets its own parameter file later, under `genki.digdir.cloud` with the same host names.

## What gets created (one resource group per environment)

| Resource                                   | Notes                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Virtual network                            | `apps` subnet (/23, delegated to Container Apps), `postgres` subnet (delegated to Postgres Flexible Server) |
| Container Apps environment                 | The five container apps below, the shared `data` volume, managed certificates                               |
| Container registry (Basic)                 | No admin user; the apps pull with their identity (AcrPull), the deploy identity pushes (AcrPush)            |
| Key Vault                                  | RBAC only, purge protection; the apps read secrets with Key Vault Secrets User                              |
| Postgres Flexible Server 17                | Private networking only, Entra ID auth only (no passwords), database `genai`                                |
| Storage account with the file share `data` | Mounted at `/data` in the API and worker: uploads and other blobs (`BLOB_DIR=/data/blobs`)                  |
| Log Analytics and Application Insights     | The environment's managed OpenTelemetry agent sends traces and logs to Application Insights                 |
| DNS zone (optional, `createDnsZone`)       | `genki-test.digdir.cloud` with a CNAME and a validation TXT record per host name                            |

## The containers

One `Dockerfile`, three targets:

| Container app          | Target   | Ingress | What it runs                                          |
| ---------------------- | -------- | ------- | ----------------------------------------------------- |
| `genai-test-api`       | `api`    | Public  | The API, on `api.genki-test.digdir.cloud`             |
| `genai-test-worker`    | `worker` | None    | Triggers, ingestion and batch jobs. One replica       |
| `genai-test-portal`    | `apps`   | Public  | The portal, on `portal.genki-test.digdir.cloud`       |
| `genai-test-workspace` | `apps`   | Public  | The workspace, on `workspace.genki-test.digdir.cloud` |
| `genai-test-console`   | `apps`   | Public  | The console, on `console.genki-test.digdir.cloud`     |

The `apps` image holds all three app builds; `APP` picks which one a container serves. Settings are read at start, not at build: the container writes `/config.js` from its environment (`ANSATTPORTEN_ISSUER`, `OIDC_CLIENT_ID`, `API_AUDIENCE`, `ALTINN_RESOURCE`, `PUBLIC_API_BASE`, `PORTAL_URL`, and for the console `OIDC_ISSUER`, `OIDC_TOKEN_ENDPOINT`, `ENVIRONMENT`), so one image runs in every environment. It proxies `/api/` to the API (`API_UPSTREAM`), so the browser talks to one origin and the API needs no CORS. It sends a Content Security Policy that allows connections to the login issuer only.

## Database

The API and worker log in to Postgres with the app's managed identity and an Entra ID token as the password (`PGHOST`, `PGUSER`, `PGDATABASE`, `PGSSLMODE`, `AZURE_CLIENT_ID`). The token is fetched when a connection opens and reused until five minutes before it expires. `DATABASE_URL` still wins when set, which is how local development connects.

The app identity owns the schema and runs migrations. Queries run as `genai_runtime` (no BYPASSRLS), switched per connection with the `role` option, so row-level security applies (ADR 0022).

## Settings and secrets

Plain settings come from the GitHub environment's variables (Settings → Environments → test → Variables), read by `test.bicepparam` with `readEnvironmentVariable`:

| Variable                                                                                 | For                                                                                                         |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ANSATTPORTEN_ISSUER`                                                                    | Login for people, API and apps. Required: the API does not start without it                                 |
| `PORTAL_CLIENT_ID`, `WORKSPACE_CLIENT_ID`                                                | Ansattporten client ids of the portal and workspace                                                         |
| `CONSOLE_CLIENT_ID`, `CONSOLE_TOKEN_ENDPOINT`                                            | The console's login (its issuer defaults to `ANSATTPORTEN_ISSUER`)                                          |
| `ALTINN_PDP_URL`                                                                         | The Altinn decision point. Required: the API does not start without it                                      |
| `ALTINN_PDP_MASKINPORTEN_CLIENT_ID`                                                      | The Maskinporten client that asks the decision point                                                        |
| `MASKINPORTEN_ISSUER`, `MASKINPORTEN_TOKEN_URL`                                          | Maskinporten, for the decision point and for systems calling the API                                        |
| `OPERATOR_SUBJECTS`                                                                      | People with the operator role, comma separated                                                              |
| `ALTINN_RESOURCE`                                                                        | The Altinn resource whose rights count in genki. Empty means `urn:altinn:resource:digdir-genai-platform`    |
| `PLATFORM_TENANT`                                                                        | The organisation that plays Digdir, for a test environment with test organisations only. Empty means Digdir |
| `FOUNDRY_OPENAI_BASE_URL`, `FOUNDRY_CLAUDE_BASE_URL`, `TYPESENSE_URL`, `COLBERT_API_URL` | Models, search and reranking                                                                                |
| `CUSTOM_DOMAINS_STAGE`                                                                   | `none`, `hostnames` or `certificates`; see Host names below                                                 |

The API audience (`digdir:genai`) has a default in `main.bicep`. The Altinn resource comes from `ALTINN_RESOURCE`, default `urn:altinn:resource:digdir-genai-platform`; genki-test uses `urn:altinn:resource:digdir-genai-platform-test`.

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

Create every secret in Key Vault before the first deploy, or remove its name from `test.bicepparam`. A name listed without a secret behind it stops the revision from starting. `CONTENT_MASTER_KEY` is 32 random bytes, base64: `openssl rand -base64 32`.

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

Without the DNS zone, create the same CNAME and TXT records wherever `genki-test.digdir.cloud` is hosted.

## Login registrations

Register one Ansattporten integration per app in the test environment, with these addresses:

| App       | Redirect URI                                         | Post-logout redirect URI                     |
| --------- | ---------------------------------------------------- | -------------------------------------------- |
| Portal    | `https://portal.genki-test.digdir.cloud/callback`    | `https://portal.genki-test.digdir.cloud/`    |
| Workspace | `https://workspace.genki-test.digdir.cloud/callback` | `https://workspace.genki-test.digdir.cloud/` |
| Console   | `https://console.genki-test.digdir.cloud/callback`   | `https://console.genki-test.digdir.cloud/`   |

Each asks for `openid profile`, the API audience `digdir:genai`, and `authorization_details` of type `ansattporten:altinn:resource` for `urn:altinn:resource:digdir-genai-platform`. Put the client ids in `PORTAL_CLIENT_ID`, `WORKSPACE_CLIENT_ID` and `CONSOLE_CLIENT_ID`. The Altinn resource and the decision point's Maskinporten client are described in issues #42 and #43.

## What the platform owner creates once

1. **Resource group** for test, in `norwayeast`, e.g. `rg-genai-test`.
2. **Deploy identity**: an Entra app registration (or user-assigned identity) with a federated credential for GitHub OIDC:
   - issuer `https://token.actions.githubusercontent.com`
   - subject `repo:digdir/genki:environment:test`
   - audience `api://AzureADTokenExchange`
3. **Roles for the deploy identity** on the resource group: `Contributor`, plus `Role Based Access Control Administrator` limited to the roles AcrPull, AcrPush and Key Vault Secrets User (the template assigns those).
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
8. **GitHub environment `prod`** with required reviewers, and the variable `PROD_READY` left unset until prod is ready.

## First deploy

1. Run the **infra** workflow with `what-if` on, read the plan, then run it again with `what-if` off. It deploys placeholder images and creates the registry, vault and DNS zone.
2. Set `ACR_NAME` from the run's output `registryName`, add the Key Vault secrets, and ask for the DNS delegation.
3. Run the **deploy** workflow on `main` (`gh workflow run deploy.yml`). It runs the checks, builds the `api`, `worker` and `apps` images, pushes them and deploys them by digest. While `ALTINN_PDP_URL` is not set, it deploys the worker and the apps only: the API keeps its current image, since it refuses to start without the real Altinn decision point, and the run summary says so. Once it is set, the deploy also waits until the API's `/health` reports the commit.
4. When the delegation works, set `CUSTOM_DOMAINS_STAGE=hostnames` and run infra, then `certificates` and run it again.

After that, run the deploy workflow whenever `main` should go to test; merges do not deploy on their own. Infra changes ride along with the next deploy, or run the infra workflow by hand.

## Validate locally

```sh
az bicep build --file infra/main.bicep --stdout > /dev/null
PG_ADMIN_GROUP_OBJECT_ID=00000000-0000-0000-0000-000000000000 PG_ADMIN_GROUP_NAME=x \
  az bicep build-params --file infra/env/test.bicepparam --stdout > /dev/null
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest
docker build --target api -t genai-api:local .
docker build --target worker -t genai-worker:local .
docker build --target apps -t genai-apps:local .
docker run --rm -p 127.0.0.1:18091:8080 -e APP=portal -e API_UPSTREAM=https://api.genki-test.digdir.cloud genai-apps:local
```

None of these log in to Azure or deploy anything.

## Before prod

- Postgres: set `appIdentityIsPostgresAdmin` to false, give the app identity its own role with `pgaadauth_create_principal`, run by a member of the admin group, and run migrations from a separate identity, so the running app cannot change the schema.
- Key Vault: private endpoint and `keyVaultPublicNetworkAccess = 'Disabled'`.
- Storage: a private endpoint for the file share, or Azure Blob storage behind the blob port.
- Ingress: Application Gateway with WAF in front.
- Postgres: a General Purpose SKU, high availability and geo-redundant backup.
