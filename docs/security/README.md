# Security

What genki protects, what it does not, and what an operator must set up so it holds. The argument for why it holds, with the threat model and trust boundaries, is in the [assurance case](assurance-case.md). To report a vulnerability, see [SECURITY.md](../../SECURITY.md).

genki is under development and not in production. Only `main` is supported.

## What genki protects

When genki runs outside development mode, with the settings below:

- **Organisations are kept apart.** A person, API key or Maskinporten client acts for one organisation at a time, and reads only that organisation's services, conversations, documents, datasets, keys and secrets. Postgres enforces this again with row-level security ([ADR 0022](../adr/0022-tenant-isolation-in-postgres.md)).
- **People get the rights Altinn gives them.** Five rights per organisation, looked up in the Altinn decision point. When Altinn does not answer, the person gets no rights ([ADR 0027](../adr/0027-platform-rights.md)). In the locked test environment, the Entra groups under [Settings](#settings) also give rights in the platform organisation.
- **API keys are a ceiling.** A key reaches only its own organisation and at most what its grants and the service allow. A key bound to a service reaches only that service ([ADR 0008](../adr/0008-principal-model-and-api-key-bridge.md)).
- **Content is encrypted at rest.** Prompts, answers, tool results and tenant secrets are encrypted with a key per organisation and scope. Erasing that key erases the content ([ADR 0011](../adr/0011-retention-erasure-and-archiving.md)).
- **Secrets go only where they are allowed.** A tenant secret used by a tool is sent only to the hosts it is bound to, and tool calls never go to a private or reserved address ([ADR 0015](../adr/0015-tenant-tools-and-secrets.md)). A database connector's password can reach a private address only when the organisation has allowed that private network.
- **Every change is audited.** Who changed what, when and why, including changes by operators and by the builder assistant ([ADR 0010](../adr/0010-admin-operations-and-audit.md), [ADR 0020](../adr/0020-changes-made-by-ai.md)).
- **Operators need a reason to see content.** An operator reaches an organisation's content only through a support session with a reason and a time limit, which shows in that organisation's own log. The exception is the locked test environment, where an operator has every right in the platform organisation without a support session.
- **Where data is.** The Azure resources genki deploys are in EU/EEA regions: test and prod in West Europe. A service's residency (`norway`, `eu` or `global`) limits which model endpoints it may use, and a `global` endpoint may process data outside the EU/EEA. A promise that everything genki stores stays in the EU/EEA is proposed, not decided ([ADR 0045](../adr/0045-data-stays-in-the-eu-eea.md)).

## What genki does not protect

- **Development mode is insecure by design.** `GENAI_DEV_MODE=true` allows the mock login, which can issue operator tokens, the mock Altinn rights and in-memory storage, used when the real settings are empty. Never turn it on outside a developer's machine. The API refuses it when `GENAI_ENV` or `NODE_ENV` is `production`.
- **Model answers can be wrong.** genki marks every answer as made with AI and shows its sources, but it does not guarantee that an answer is correct.
- **Masking is not anonymisation.** The PII guardrails catch Norwegian ids, phone numbers, email, account numbers and ICD-10 codes. They do not catch names or free-text health data.
- **Prompt injection is reduced, not removed.** A model can only use the tools and datasets the service grants. Every strategy marks documents, search hits and tool output as untrusted data and tells the model not to follow instructions in them. A document can still steer an answer within those limits.
- **The services genki calls** (Azure AI Foundry, Altinn, Ansattporten, Maskinporten, Typesense, Langfuse) are secured by their owners.
- **Classified information** and systems under sikkerhetsloven are out of scope.
- **Not production-ready yet.** Before real people log in, genki needs a backend-for-frontend so tokens leave the browser ([ADR 0034](../adr/0034-tokens-in-the-browser.md), proposed), and operators recognised by Entra group outside the locked test environment ([ADR 0035](../adr/0035-operator-login.md), proposed, not built). The [assurance case](assurance-case.md#known-gaps) lists the other known gaps.

## What operators must configure

[`infra/README.md`](../../infra/README.md) has the full setup, and [`.env.example`](../../.env.example) describes the settings and their defaults. These are the ones security depends on.

### Settings

| Setting                                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GENAI_DEV_MODE` unset, `NODE_ENV=production`                                                    | The image sets `NODE_ENV=production`, and the API then refuses dev mode. Never set dev mode in a deployed environment                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DATABASE_URL`, or `PGHOST` with a managed identity                                              | Without a database the API refuses to start. In Azure, Postgres uses Entra ID only and private networking                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ANSATTPORTEN_ISSUER`, or `MASKINPORTEN_ISSUER` and `MASKINPORTEN_JWKS_URI`                      | Where tokens come from. Without them the API refuses to start                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `API_AUDIENCE`                                                                                   | The audience tokens must carry. Default `digdir:genai`. A token for a client an organisation registered may carry that client's audience instead, and is then confined to that client                                                                                                                                                                                                                                                                                                                                                                               |
| `ALTINN_PDP_URL`, `ALTINN_RESOURCE`, `ALTINN_SUBSCRIPTION_KEY`, `ALTINN_PDP_MASKINPORTEN_*`      | Rights per organisation. Without `ALTINN_PDP_URL` the API refuses to start. With it, the API also needs `ALTINN_SUBSCRIPTION_KEY`, `ALTINN_PDP_MASKINPORTEN_CLIENT_ID`, `ALTINN_PDP_MASKINPORTEN_KEY` and `MASKINPORTEN_ISSUER`, and the URL must use HTTPS. `ALTINN_RESOURCE` defaults to `urn:altinn:resource:digdir-genai-platform`                                                                                                                                                                                                                              |
| `PLATFORM_TENANT`                                                                                | The organisation that runs the platform. A nine-digit organisation number; empty means Digdir                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `OPERATOR_CLIENT_IDS`                                                                            | The only clients whose logins can become operators. The API refuses to start without it when `OPERATOR_SUBJECTS` lists pairs, or when `LOCKDOWN_ENTRA_GROUPS` or `LOCKDOWN_USER_GROUPS` is set in lockdown                                                                                                                                                                                                                                                                                                                                                          |
| `OPERATOR_SUBJECTS`                                                                              | Operators as `issuer\|subject` pairs. They count only for Ansattporten logins through `OPERATOR_CLIENT_IDS`. Outside dev mode the API refuses a bare subject. Personal data: keep it in the deploy settings, never in the repository                                                                                                                                                                                                                                                                                                                                |
| `GENAI_LOCKDOWN`, `LOCKDOWN_ENTRA_GROUPS`, `LOCKDOWN_USER_GROUPS`, `LOCKDOWN_ENTRA_EMAIL_DOMAIN` | For test environments ([ADR 0033](../adr/0033-locked-test-environment.md)). In lockdown, Entra logins through `OPERATOR_CLIENT_IDS` in a `LOCKDOWN_ENTRA_GROUPS` group are operators with every right in the platform organisation, and those in a `LOCKDOWN_USER_GROUPS` group get the same rights without the operator role. `LOCKDOWN_ENTRA_EMAIL_DOMAIN` also requires their email to be at that domain. Other people can only read. Besides these logins, only API keys and clients they create, and keys from configuration, may use models and run ingestion |
| `CONTENT_MASTER_KEY`                                                                             | 32 random bytes, base64 (`openssl rand -base64 32`). Wraps every content key. Required when a database is set: the API and worker do not start without it. A new one per environment                                                                                                                                                                                                                                                                                                                                                                                |
| `TRACES_CONTENT`                                                                                 | Leave it unset or `false`, so traces carry no prompts or answers. Outside dev mode the API refuses to start with `TRACES_CONTENT=true`                                                                                                                                                                                                                                                                                                                                                                                                                              |

When the API refuses to start, its log names the missing or unsafe setting.

### Groups and identities

- **Entra groups** decide who may operate a locked environment, and who may administer Postgres. genki reads group membership from the login token, so removing someone takes effect when their current token expires.
- **Managed identities.** The apps reach Key Vault, the registry and Postgres with their own managed identity, never with a password. The file share for app data is mounted with the storage account key. The deploy identity uses GitHub's OIDC federation; `infra/README.md` lists the roles it should have.
- **Ansattporten clients**, one per app and environment, with only that app's callback as redirect URI.

### Key Vault

Platform secrets live in Key Vault, which uses Azure role-based access only and has purge protection. Each name in `keyVaultSecretNames` becomes an environment variable in the API and worker, and definitions refer to it as `secret://env/<name>`. Create every secret before the first deploy: a listed name with no secret behind it stops the revision from starting. Keep secrets out of the repository, chat and issues.

## Cryptography

| Use                                | Algorithm                                                                                                                                                                                                                 | Where                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Content and tenant secrets at rest | AES-256-GCM, random 96-bit IV, authenticated data that binds each value to the record it belongs to                                                                                                                       | [`packages/providers-postgres/src/crypto.ts`](../../packages/providers-postgres/src/crypto.ts) |
| Content keys                       | 256-bit random key per organisation and scope, stored in Postgres wrapped with AES-256-GCM by `CONTENT_MASTER_KEY`                                                                                                        | [`packages/providers-postgres/src/keys.ts`](../../packages/providers-postgres/src/keys.ts)     |
| API keys                           | 192 random bits. The SHA-256 digest is stored, with the first seven and last four characters for display                                                                                                                  | [`packages/identity/src/api-keys.ts`](../../packages/identity/src/api-keys.ts)                 |
| Tokens                             | RS256 signatures verified against the issuer's published keys, with issuer, audience and expiry checked                                                                                                                   | [`packages/identity/src/verify.ts`](../../packages/identity/src/verify.ts)                     |
| Transport                          | HTTPS at Azure Container Apps ingress, with insecure HTTP turned off. TLS with certificate verification to Postgres and on the apps' `/api/` proxy. Tool calls must use HTTPS. No code turns off certificate verification | [`infra/modules/containerapps.bicep`](../../infra/modules/containerapps.bicep)                 |

No security mechanism uses MD5 or SHA-1.

### Rotating credentials

Credentials are kept apart from code and configuration. Most can be replaced without a rebuild:

| Credential                                           | How to rotate                                                                                                                                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model, search, reranker and Altinn keys in Key Vault | Add a new version of the secret in Key Vault, then restart the API and worker revisions, or deploy, so they read it. Revoke the old key at the provider afterwards                                                   |
| The Maskinporten key for the Altinn decision point   | Add a new key to the Maskinporten client, put the private JWK in Key Vault as a new version of `altinn-pdp-maskinporten-key`, restart, then remove the old key from the client                                       |
| An organisation's API key                            | In the portal under **Utviklerverktøy**, **Nøkler**, or `POST /tenants/{tenant}/api-keys/{id}/rotate`, with the right to manage services. The new key keeps the old one's grants, and the old one is revoked at once |
| A tenant secret                                      | `PUT /tenants/{tenant}/secrets/{name}` with the new value. Values are write-only and never returned                                                                                                                  |
| Signing keys of Ansattporten and Maskinporten        | Nothing to do: genki reads the issuers' published keys and fetches them again when a token names a key it does not know                                                                                              |
| `CONTENT_MASTER_KEY`                                 | **Not supported yet.** Content keys are wrapped with it, and there is no re-wrap step, so replacing it makes stored content unreadable. Keep it in Key Vault and do not replace it                                   |

### Changing algorithms

The algorithms are fixed in code, not chosen in configuration. Content encryption sits behind one pair of functions (`seal` and `open`) and one `KeyWrapper` interface in `packages/providers-postgres`. A new cipher is a change there; a key-wrapping service is a new `KeyWrapper` plus the line in the API and worker that creates it. Stored values carry no algorithm tag, so a switch today means a migration that re-encrypts what is stored. Running two algorithms side by side would need a version tag on sealed values, which does not exist.

## Input validation

Input from people, systems, tools and documents is checked against what is allowed, and the rest is refused:

- Service definitions, settings and flows are parsed with zod schemas before they are stored or published, and publishing checks models, residency and strategy configuration against the catalogues.
- A service's input is checked against the input fields it declares, in the MCP, A2A and OpenAI-compatible channels and in batch runs.
- Admin routes check fields by hand, against a pattern, a type or a known id, not with zod. When they refuse, the answer is a problem document that names the field.
- Tokens are verified before their claims are trusted. Only the issuer and client id are read first, to choose the keys and audience.
- Uploads and Parquet files have size limits.

## Hardening

| Measure                     | Where                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP security headers, apps | [`docker/apps/headers.conf`](../../docker/apps/headers.conf): `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`, `Permissions-Policy`, and a CSP with `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'` and `connect-src` limited to the app's own origin, which proxies `/api/`, and the login issuer. `/system-atlas.html` may be framed by the same origin |
| HTTP security headers, API  | [`apps/api/src/hardening.ts`](../../apps/api/src/hardening.ts): `nosniff`, `X-Frame-Options: DENY`, `Permissions-Policy`, a CSP for the API's own pages, `Referrer-Policy: no-referrer`, and HSTS over HTTPS                                                                                                                                                                                                                            |
| nginx                       | `server_tokens off`, a request body limit, and certificate verification on the `/api/` proxy ([`docker/apps/default.conf.template`](../../docker/apps/default.conf.template))                                                                                                                                                                                                                                                           |
| Rate limits                 | Service calls are limited per API key (120 a minute unless the key sets its own) and per organisation (600 a minute unless set), with a monthly token quota per organisation ([`apps/api/src/rate-limit.ts`](../../apps/api/src/rate-limit.ts))                                                                                                                                                                                         |
| Containers run as non-root  | The API and worker run as `node` ([`Dockerfile`](../../Dockerfile)); the apps run on `nginx-unprivileged`, whose default user is uid 101                                                                                                                                                                                                                                                                                                |
| Small images                | Multi-stage builds; production dependencies only, installed with `--ignore-scripts`                                                                                                                                                                                                                                                                                                                                                     |
| Egress guard                | HTTPS only, only the connection's allowed hosts, no private or reserved addresses, no redirects to another host, size and time limits ([`packages/providers-mcp-client/src/egress.ts`](../../packages/providers-mcp-client/src/egress.ts))                                                                                                                                                                                              |
| Database roles              | The runtime role has no `BYPASSRLS` and owns nothing ([ADR 0022](../adr/0022-tenant-isolation-in-postgres.md))                                                                                                                                                                                                                                                                                                                          |
| Fails closed at startup     | The API refuses to start with missing identity, database or Altinn settings, without `CONTENT_MASTER_KEY` when a database is set, with `TRACES_CONTENT=true`, or with dev mode in production                                                                                                                                                                                                                                            |
| TypeScript strict           | `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` ([`tsconfig.base.json`](../../tsconfig.base.json)), and ESLint's strict rules                                                                                                                                                                                                                                                                                     |
| Supply chain                | GitHub Actions pinned by commit SHA, a lockfile, Renovate, Dependabot alerts, CodeQL code scanning (GitHub default setup), gitleaks in CI and the OpenSSF Scorecard workflow                                                                                                                                                                                                                                                            |

## Checking an image against the source

The deploy workflow builds the images reproducibly: with `SOURCE_DATE_EPOCH` set to the commit time, file timestamps rewritten to it, no build cache and a pinned BuildKit. Anyone can rebuild a deployed commit and get the same image digest.

Compare the linux/amd64 image digest, not the digest the container apps run. That one names an index that also holds the provenance and SBOM attestations, which record the workflow run and differ on every build.

**The deployed digest.** The summary of the deploy run lists each image's linux/amd64 digest. With access to Azure, read it from the running app (prod: `rg-genai-prod`, `genai-prod-api`):

```sh
image=$(az containerapp show -g rg-genai-test -n genai-test-api --query 'properties.template.containers[0].image' -o tsv)
az acr login --name "${image%%.*}"
docker buildx imagetools inspect --raw "$image" |
  jq -r '.manifests[] | select(.platform.architecture == "amd64") | .digest'
```

The API's `/health` reports the commit it was built from.

**The rebuild.** In a fresh clone, so file times and modes come from the checkout, with Docker Buildx and a `docker-container` builder (Docker Desktop's default builder cannot export OCI):

```sh
umask 022
git clone https://github.com/digdir/genki.git genki-check && cd genki-check
git checkout <commit>
docker buildx create --name repro --driver docker-container \
  --driver-opt "image=$(grep -o -m1 'moby/buildkit:[^ ]*' .github/workflows/deploy.yml)"
for target in api worker apps; do
  docker buildx build --builder repro --no-cache --platform linux/amd64 --target "$target" \
    --build-arg SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" --provenance=false --sbom=false \
    --output "type=oci,dest=$target.tar,oci-mediatypes=true,rewrite-timestamp=true" .
  echo "$target $(tar -xOf "$target.tar" index.json | jq -r '.manifests[0].digest')"
done
docker buildx rm repro
```

The digests it prints should equal the deployed ones. On an arm64 machine `--platform linux/amd64` runs under emulation and takes a while.
