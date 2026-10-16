# Infrastructure

The test environment is deployed from `main` by running `.github/workflows/deploy.yml` by hand (`gh workflow run deploy.yml`), after the checks in `ci.yml` pass. Infrastructure changes run by hand with `.github/workflows/infra.yml`, `what-if` first.

Bicep for genki's Azure environments: test (`env/test.bicepparam`, `genki-test.digdir.cloud`) and prod (`env/prod.bicepparam`, `genki.digdir.cloud`, see [Prod](#prod)). Both use the same template and the same host names under their own zone.

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
| DNS zone (optional, `createDnsZone`)       | `genki-test.digdir.cloud` or `genki.digdir.cloud` with a CNAME and a validation TXT record per host name    |

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

## Database

The API and worker log in to Postgres with the app's managed identity and an Entra ID token as the password (`PGHOST`, `PGUSER`, `PGDATABASE`, `PGSSLMODE`, `AZURE_CLIENT_ID`). The token is fetched when a connection opens and reused until five minutes before it expires. `DATABASE_URL` still wins when set, which is how local development connects.

The app identity owns the schema and runs migrations. Queries run as `genai_runtime` (no BYPASSRLS), switched per connection with the `role` option, so row-level security applies (ADR 0022).

The server allows the `vector` extension through its `azure.extensions` setting (`VECTOR`, in `modules/postgres.bicep`, for test and prod alike). Azure Postgres refuses `create extension` for any extension not on that list, and the pgvector engine creates `vector` when it first migrates. To allow more extensions later, add them to the same comma-separated value.

## Settings and secrets

Plain settings come from the GitHub environment's variables (Settings → Environments → test or prod → Variables), read by the parameter file with `readEnvironmentVariable`:

| Variable                                                                                 | For                                                                                                                        |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ANSATTPORTEN_ISSUER`                                                                    | Login for people, API and apps. Required: the API does not start without it                                                |
| `PORTAL_CLIENT_ID`, `WORKSPACE_CLIENT_ID`                                                | Ansattporten client ids of the portal and workspace                                                                        |
| `CONSOLE_CLIENT_ID`, `CONSOLE_TOKEN_ENDPOINT`                                            | The console's login (its issuer defaults to `ANSATTPORTEN_ISSUER`)                                                         |
| `ALTINN_PDP_URL`                                                                         | The Altinn decision point. Required: the API does not start without it                                                     |
| `ALTINN_PDP_MASKINPORTEN_CLIENT_ID`                                                      | The Maskinporten client that asks the decision point                                                                       |
| `MASKINPORTEN_ISSUER`, `MASKINPORTEN_TOKEN_URL`                                          | Maskinporten, for the decision point and for systems calling the API                                                       |
| `OPERATOR_SUBJECTS`                                                                      | People with the operator role, comma separated                                                                             |
| `ALTINN_RESOURCE`                                                                        | Test only. The Altinn resource whose rights count in genki                                                                 |
| `PLATFORM_TENANT`                                                                        | Test only. The organisation that plays Digdir, for test organisations. Empty means Digdir                                  |
| `FOUNDRY_OPENAI_BASE_URL`, `FOUNDRY_CLAUDE_BASE_URL`, `TYPESENSE_URL`, `COLBERT_API_URL` | Models, search and reranking                                                                                               |
| `CUSTOM_DOMAINS_STAGE`                                                                   | `none`, `hostnames` or `certificates`; see Host names below                                                                |
| `LOCKDOWN_ENTRA_GROUPS`                                                                  | Test only. Entra group object ids, comma separated, whose members get the whole platform in lockdown                       |
| `LOCKDOWN_ENTRA_EMAIL_DOMAIN`                                                            | Test only. Extra guard for those Entra logins: the email must be at this domain. Set it to `digdir.no`; empty turns it off |

`test.bicepparam` also sets `GENAI_LOCKDOWN=true` in `appEnv`, not from a variable: genki-test is always locked. In lockdown only API keys from configuration and people who log in through Ansattporten with Entra ID and are in one of `LOCKDOWN_ENTRA_GROUPS` may use models or run ingestion. Those Entra logins get every right in `PLATFORM_TENANT` and the operator role. TestID logins and operators can only read and search; API keys and Maskinporten clients created by such an Entra login may use models and run ingestion within their own bindings; other keys made through the API can read, search and change configuration, but not run anything that reaches a model, fetches documents or writes new embeddings, and scheduled ingestion is skipped. `appEnv` reaches the worker too, which then runs no triggers. See [ADR 0033](../docs/adr/0033-locked-test-environment.md).

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

1. **Resource group** for test, in `norwayeast`, e.g. `rg-genai-test`.
2. **Deploy identity**: an Entra app registration (or user-assigned identity) with a federated credential for GitHub OIDC:
   - issuer `https://token.actions.githubusercontent.com`
   - subject `repo:digdir/genki:environment:test`, and the ID form `repo:digdir@51157288/genki@1411915404:environment:test` (the organisation uses ID-based OIDC subjects)
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
PG_ADMIN_GROUP_OBJECT_ID=00000000-0000-0000-0000-000000000000 PG_ADMIN_GROUP_NAME=x \
  az bicep build-params --file infra/env/prod.bicepparam --stdout > /dev/null
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest
docker build --target api -t genai-api:local .
docker build --target worker -t genai-worker:local .
docker build --target apps -t genai-apps:local .
docker/smoke.sh genai-api:local genai-apps:local
docker run --rm -p 127.0.0.1:18091:8080 -e APP=portal -e API_UPSTREAM=https://api.genki-test.digdir.cloud genai-apps:local
```

None of these log in to Azure or deploy anything.

## Prod

Prod runs the same template from `env/prod.bicepparam` in the resource group `rg-genai-prod` (`norwayeast`), in the same subscription as test, on `api`, `portal`, `workspace` and `console.genki.digdir.cloud`. It differs from test in:

| Setting                     | Prod                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| Replicas                    | 1 to 3                                                                                          |
| Postgres                    | General Purpose `Standard_D2ds_v5`, 64 GB, backups kept 30 days and copied to Norway West       |
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

`rg-genai-prod` and the DNS zone `genki.digdir.cloud` in it already exist. The template manages the zone's records (`createDnsZone = true`); creating the zone again changes nothing.

1. **Deploy identity for prod**, separate from test's, with federated credentials for GitHub OIDC (issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`) for both subjects:
   - `repo:digdir/genki:environment:prod`
   - `repo:digdir@51157288/genki@1411915404:environment:prod` (the ID form the organisation uses)
2. **Roles for the prod deploy identity**:
   - on `rg-genai-prod`: `Contributor`, plus `Role Based Access Control Administrator` limited to AcrPull, AcrPush and Key Vault Secrets User
   - on the test registry: `Container Registry Data Importer and Data Reader` (the role Azure documents for `az acr import` between registries in one tenant; `AcrPull` is the older equivalent for registries without repository permissions)
3. **Entra group** `genai-prod-pg-admins`, with the people who may administer prod's Postgres.
4. **GitHub environment `prod`** with required reviewers, and these variables:

   | Variable                                                                                 | Value                                                                         |
   | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
   | `AZURE_CLIENT_ID`, `DEPLOY_PRINCIPAL_ID`                                                 | Client id and service principal object id of the prod deploy identity         |
   | `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`                                               | Same as test                                                                  |
   | `AZURE_RESOURCE_GROUP`                                                                   | `rg-genai-prod`                                                               |
   | `PG_ADMIN_GROUP_OBJECT_ID`, `PG_ADMIN_GROUP_NAME`                                        | The group from step 3                                                         |
   | `ACR_NAME`                                                                               | Set after the first infra run (output `registryName`)                         |
   | `ANSATTPORTEN_ISSUER`                                                                    | `https://ansattporten.no`                                                     |
   | `PORTAL_CLIENT_ID`, `WORKSPACE_CLIENT_ID`, `CONSOLE_CLIENT_ID`                           | The production Ansattporten clients                                           |
   | `CONSOLE_TOKEN_ENDPOINT`                                                                 | Production Ansattporten's token endpoint                                      |
   | `ALTINN_PDP_URL`                                                                         | Altinn production's decision point, under `https://platform.altinn.no`        |
   | `ALTINN_PDP_MASKINPORTEN_CLIENT_ID`                                                      | The production Maskinporten client                                            |
   | `MASKINPORTEN_ISSUER`, `MASKINPORTEN_TOKEN_URL`                                          | `https://maskinporten.no/`, `https://maskinporten.no/token`                   |
   | `OPERATOR_SUBJECTS`                                                                      | The prod operators. Personal data: only here, never in the repository         |
   | `FOUNDRY_OPENAI_BASE_URL`, `FOUNDRY_CLAUDE_BASE_URL`, `TYPESENSE_URL`, `COLBERT_API_URL` | Models, search and reranking for prod                                         |
   | `CUSTOM_DOMAINS_STAGE`                                                                   | `none`, then `hostnames`, then `certificates`                                 |
   | `PROD_READY`                                                                             | `true` once everything above is in place; until then `deploy-prod` is skipped |

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
- Storage: a private endpoint for the file share, or Azure Blob storage behind the blob port.
- Ingress: Application Gateway with WAF in front.
- Postgres high availability: `postgresHighAvailability` (`SameZone` or `ZoneRedundant`) exists but prod leaves it `Disabled` for now. It can be turned on later on a General Purpose server.
