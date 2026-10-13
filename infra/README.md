# Infrastructure

Parked: nothing deploys yet. The deploy and infra workflows live in `parked-workflows/` and run only once moved back to `.github/workflows/`. CI only checks the code and that the image builds.

Bicep for the platform's Azure environments. Test exists now; prod gets its own parameter file later.

## What gets created (one resource group per environment)

| Resource                                     | Notes                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Virtual network                              | `apps` subnet (/23, delegated to Container Apps), `postgres` subnet (delegated to Postgres Flexible Server) |
| Container Apps environment and the `api` app | Public HTTPS ingress, image pinned by digest, user-assigned managed identity, probes on `/health`           |
| Container registry (Basic)                   | No admin user; the app pulls with its identity (AcrPull), the deploy identity pushes (AcrPush)              |
| Key Vault                                    | RBAC only, purge protection; the app reads secrets with Key Vault Secrets User                              |
| Postgres Flexible Server 17                  | Private networking only, Entra ID auth only (no passwords), database `genai`                                |
| Log Analytics and Application Insights       | The environment's managed OpenTelemetry agent sends traces and logs to Application Insights                 |

## Secrets

Secrets live only in Key Vault. List a secret's name in `keyVaultSecretNames` and the app gets it as an environment variable, which the platform reads as `secret://env/<name>`:

| Key Vault secret     | Env var in the app   | Reference in config               |
| -------------------- | -------------------- | --------------------------------- |
| `typesense-key`      | `TYPESENSE_KEY`      | `secret://env/typesense-key`      |
| `foundry-openai-key` | `FOUNDRY_OPENAI_KEY` | `secret://env/foundry-openai-key` |

Create the secret in Key Vault first, then add its name to the parameter file. A name listed without a secret behind it stops the revision from starting.

## What the platform owner creates once

1. **Resource group** for test, in `norwayeast`, e.g. `rg-genai-test`.
2. **Deploy identity**: an Entra app registration (or user-assigned identity) with a federated credential for GitHub OIDC:
   - issuer `https://token.actions.githubusercontent.com`
   - subject `repo:<owner>/<repo>:environment:test`
   - audience `api://AzureADTokenExchange`
3. **Roles for the deploy identity** on the resource group: `Contributor`, plus `Role Based Access Control Administrator` limited to the roles AcrPull, AcrPush and Key Vault Secrets User (the template assigns those).
4. **Entra group for database admins**, e.g. `genai-test-pg-admins`, with the people who may administer Postgres.
5. **GitHub environment `test`** with these variables (Settings → Environments → test → Variables; none are secrets):

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

6. **GitHub environment `prod`** with required reviewers, and the variable `PROD_READY` left unset until prod is ready.
7. **Repository settings**: secret scanning and push protection on, branch protection on `main` requiring the `ci` checks, and the Renovate app installed.

## First deploy

1. Run the **infra** workflow with `what-if` on, read the plan, then run it again with `what-if` off. It deploys a placeholder image and creates the registry.
2. Set `ACR_NAME` from the run's output `registryName`.
3. Merge to `main`. The **deploy** workflow runs the checks, builds the image, pushes it, deploys it by digest and waits until `/health` reports the commit.

After that, every merge to `main` deploys to test. Infra changes ride along with the next deploy, or run the infra workflow by hand.

## Validate locally

```sh
az bicep build --file infra/main.bicep --stdout > /dev/null
PG_ADMIN_GROUP_OBJECT_ID=00000000-0000-0000-0000-000000000000 PG_ADMIN_GROUP_NAME=x \
  az bicep build-params --file infra/env/test.bicepparam --stdout > /dev/null
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest
docker build -t genai-api:local .
```

None of these log in to Azure or deploy anything.

## Before prod

- Postgres: set `appIdentityIsPostgresAdmin` to false and give the app identity its own role with `pgaadauth_create_principal`, run by a member of the admin group. Migrations create the `genai_runtime` role (no login, no table ownership, no BYPASSRLS); grant it to the app identity (`grant genai_runtime to "<app identity>"`) and point `DATABASE_RUNTIME_URL` at that login, so only the migration step connects as the owner (ADR 0022).
- Key Vault: private endpoint and `keyVaultPublicNetworkAccess = 'Disabled'`.
- Ingress: Application Gateway with WAF in front.
- Postgres: a General Purpose SKU, high availability and geo-redundant backup.
