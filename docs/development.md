# Development

You need [mise](https://mise.jdx.dev) (pins Node 24.21.0 in `mise.toml`) and Docker.

```sh
mise trust         # once per clone, or mise ignores mise.toml and runs whatever Node is on PATH
mise install       # Node 24.21.0
npm start          # setup, then API, portal, console and workspace; stop all with Ctrl-C
```

`npm start` is `npm run setup` followed by `npm run dev:all`; run them separately when you only need one.

`npm run setup` is safe to run again: it starts `docker compose up -d postgres` (pgvector on `127.0.0.1:55432`), waits until it answers, and creates `.env.local` from `.env.example` only when it does not exist. The new file gets the local `DATABASE_URL`, a generated `CONTENT_MASTER_KEY`, `DEV_API_KEY` and `DEV_SERVICE_API_KEY`, and the local test model. An existing `.env.local` is never changed; setup names the settings it lacks.

`npm run dev:all` runs everything with prefixed, coloured output and refuses to start if a port is taken:

| Process   | Address               | For                                                                 |
| --------- | --------------------- | ------------------------------------------------------------------- |
| API       | http://localhost:8080 | The platform, with database migrations and seeded definitions       |
| Portal    | http://localhost:5173 | Agencies: build, test and publish services, datasets and API keys   |
| Console   | http://localhost:5174 | Digdir operators: tenants, shared services, models, platform health |
| Workspace | http://localhost:5176 | Employees: chat with published services, with sources and approvals |
| Model     | http://127.0.0.1:8095 | Local test model, only when `LOCAL_MODEL_URL` points there          |

**Other ports.** To run a second copy next to one that already runs, give it its own compose project, Postgres port, model port and app ports:

```sh
COMPOSE_PROJECT_NAME=genai-second GENAI_POSTGRES_PORT=8110 GENAI_MODEL_PORT=8104 npm run setup
GENAI_API_PORT=8100 GENAI_PORTAL_PORT=8101 GENAI_CONSOLE_PORT=8102 GENAI_WORKSPACE_PORT=8103 npm run dev:all
```

Setup writes the ports into the new `.env.local`, and `dev:all` points the Vite proxies and the login issuer at the moved API. Login only works when each app's `http://localhost:<port>/callback` is listed for its client in `apps/api/config/local/identity.yaml`; `dev:all` names the missing ones at start. Stop the copy's database with `COMPOSE_PROJECT_NAME=genai-second docker compose down -v`.

The apps talk to the live API through a Vite proxy on `/api`. To run one against in-browser mock data instead: `VITE_API=mock npm run dev -w apps/portal`. `npm run dev` starts only the API.

**Dev mode.** The API refuses to start without `DATABASE_URL`, without `ANSATTPORTEN_ISSUER` (or `MASKINPORTEN_ISSUER` plus `MASKINPORTEN_JWKS_URI`) and without `ALTINN_PDP_URL`, and names the missing settings, unless `GENAI_DEV_MODE=true`; the worker refuses to start without `DATABASE_URL` under the same rule. Dev mode allows in-memory storage, the mock Altinn rights and the mock login below, which can issue operator tokens, so it is for local development only; the API logs a warning at startup when it is on, and refuses it under `GENAI_ENV=production` or `NODE_ENV=production`. `npm run setup` writes `GENAI_DEV_MODE=true` into a new `.env.local`, and `npm run dev:all` sets it for the API unless you set it yourself. An `.env.local` made before dev mode existed works with `npm start` and `npm run dev:all`; add `GENAI_DEV_MODE=true` to it to run the API alone with `npm run dev`.

**Logging in.** In dev mode without `ANSATTPORTEN_ISSUER`, the API runs a mock Ansattporten at `/mock/ansattporten` with a person picker, and a mock Altinn at `/mock/altinn`. Test persons are in `apps/api/config/local/identity.yaml`:

| Person          | Use it for                                    |
| --------------- | --------------------------------------------- |
| Kari Testansatt | Every right in Digdir                         |
| Ola Drift       | Platform operator (console)                   |
| Ingrid Berg     | Limited rights: use services, datasets, usage |
| Erik Larsen     | Rights in other organisations                 |
| Hensynsløs Måke | No access                                     |

**Real Ansattporten locally.** To log in through Ansattporten TEST instead of the mock, as genki-test does, the API and each app need their own settings. None of the values are in the repository; ask the team for them and keep them out of chat.

In `.env.local`:

| Setting                                                                  | Value                                                                                     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `ANSATTPORTEN_ISSUER`                                                    | `https://test.ansattporten.no`. With it set, the mock login is not mounted                |
| `ALTINN_PDP_URL`, `ALTINN_SUBSCRIPTION_KEY`                              | `https://platform.tt02.altinn.no` and the APIM subscription key                           |
| `MASKINPORTEN_ISSUER`, `MASKINPORTEN_TOKEN_URL`                          | `https://test.maskinporten.no/` and `https://test.maskinporten.no/token`                  |
| `ALTINN_PDP_MASKINPORTEN_CLIENT_ID`, `ALTINN_PDP_MASKINPORTEN_KEY`       | The Maskinporten client that asks the PDP, and its private JWK                            |
| `ALTINN_RESOURCE`                                                        | `urn:altinn:resource:digdir-genai-platform-test`                                          |
| `PLATFORM_TENANT`                                                        | The synthetic organisation that plays Digdir in TT02, as in genki-test                    |
| `GENAI_LOCKDOWN`, `LOCKDOWN_ENTRA_GROUPS`, `LOCKDOWN_ENTRA_EMAIL_DOMAIN` | `true`, the Entra group, `digdir.no`: needed to log in with Entra ID (below)              |
| `OPERATOR_CLIENT_IDS`                                                    | Your local portal, workspace and console client ids: the clients whose Entra logins count |

In `apps/portal/.env.local` and `apps/workspace/.env.local`: `VITE_ANSATTPORTEN_ISSUER`, `VITE_OIDC_CLIENT_ID` and `VITE_ALTINN_RESOURCE`. In `apps/console/.env.local`: `VITE_OIDC_ISSUER`, `VITE_OIDC_TOKEN_ENDPOINT` (`https://test.ansattporten.no/token`), `VITE_OIDC_CLIENT_ID` and `VITE_ALTINN_RESOURCE`. Each app has its own client, and Ansattporten only accepts the login when that client lists `http://localhost:<the app's port>/callback` as a redirect URI. A git worktree does not get these files; copy or link them from your main checkout.

Who gets in: a TestID person gets the rights Altinn TT02 gives them for the resource, so outside lockdown a general manager of `PLATFORM_TENANT` gets the platform rights; in lockdown TestID logins can only read. An Entra ID login (choose Entra ID in Ansattporten) is refused outside lockdown; with `GENAI_LOCKDOWN=true` and `LOCKDOWN_ENTRA_GROUPS`, a member of the group who logs in through one of `OPERATOR_CLIENT_IDS` gets the whole platform, as in genki-test (ADR 0033); without `OPERATOR_CLIENT_IDS` the API refuses to start. In lockdown only such a login may use models and run ingestion, so this is the setup for working as a Digdir employee. Operators: `operator: true` in `identity.yaml` and the console's dev login count only with the mock login, so with real Ansattporten list yourself in `OPERATOR_SUBJECTS` as `issuer|subject` (the issuer as in the token's `iss`, and the token's `sub`). A bare subject counts only for the mock login, and outside dev mode the API refuses to start with one. A listed subject counts only when the login comes through one of `OPERATOR_CLIENT_IDS`, so set that too; the API refuses to start with `OPERATOR_SUBJECTS` but no `OPERATOR_CLIENT_IDS`.

To check it: `curl localhost:8080/health` reports `lockdown`, the API log at startup has `altinn pdp` with the TT02 address, and the lockdown lines when it is on, and the login button goes to `login.test.ansattporten.no`, not `/mock/ansattporten`. A 404 on `/mock/ansattporten/...` means an app has no `.env.local` and still uses the mock while the API does not.

**API keys for local clients.** In dev mode with the mock login active, `DEV_API_KEY` registers a general dev key, and `DEV_SERVICE_API_KEY` registers a key bound to one service: `DEV_SERVICE_API_KEY_SERVICE`, `kunnskapsassistenten` by default. Both keys are in `.env.local` after setup.

**Locked environment.** `GENAI_LOCKDOWN=true` turns on what genki-test runs with: only the keys above, registered from configuration at startup, may run anything that reaches a model or run ingestion (pipeline runs, connector syncs, engine switches, applying hypothetical questions). People, operators and keys made through the API get a 403 problem that says the environment is locked, and scheduled runs and worker triggers are skipped. People can only read and search; keys made through the API can still change configuration. `LOCKDOWN_ENTRA_GROUPS` (Entra group object ids) and `LOCKDOWN_ENTRA_EMAIL_DOMAIN` let an Entra ID login through Ansattporten in one of those groups work with the whole platform, as operator with every right in the platform organisation; the mock login cannot issue such tokens. API keys and Maskinporten clients such a login creates may use models and run ingestion too, within their own bindings. `/health` reports `lockdown`, and the portal, console and workspace show a banner. See [ADR 0033](adr/0033-locked-test-environment.md).

**Frontend clients.** `apps/api/config/local/clients/kunnskapsassistenten.yaml` registers an example client: a separate frontend for Kunnskapsassistenten on `http://localhost:5177`, allowed to call the platform from the browser. Nothing in this repository runs on that port; it shows how a frontend of your own is registered.

**What needs your own settings.** Every setting is listed in `.env.example`, with what happens when it is empty. Integrations with missing settings are skipped and logged at startup, not fatal, and so are the services that need them.

| Works on a fresh clone, no secrets                                  | Needs your own settings in `.env.local`                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Login with test persons, rights, portal, console, workspace         | Real models: `FOUNDRY_OPENAI_*`, `FOUNDRY_CLAUDE_*`                      |
| Postgres storage, migrations, API keys, conversations, audit        | Kudos and public-docs search: `TYPESENSE_*` (the key may only search)    |
| "Lokal testchat" in the workspace, answered by the local echo model | Reranking: `COLBERT_API_*`; embeddings for vector search: Foundry        |
| Your own single-call services on the local model (`local/echo`)     | Traces in Langfuse, Maskinporten, the real Altinn PDP, real Ansattporten |

Without the Foundry and Typesense settings, the seeded services (Kunnskapsassistenten, Klarspråk, Nynorsk and the rest) are skipped, so "Lokal testchat" is the only service until you add them.

Only `.env.local` is loaded automatically. Secrets in config are referenced as `secret://env/<name>`, which reads the environment variable `<NAME>` (`foundry-openai-key` reads `FOUNDRY_OPENAI_KEY`). At startup the API publishes the flows and services in `apps/api/config/local` (definitions that already exist are skipped) and runs database migrations. Services in `apps/api/config/local/dev-services`, such as "Lokal testchat" on `local/echo`, are published only with `GENAI_DEV_MODE=true`, so the test and production environments never see them. A variant whose model is not configured is left out and logged, so the service still starts with its other variants. Test sets in `packages/eval/testsets` and `packages/jobs/examples/testsets` that belong to a local service (by `spec.service` or the service's `evaluation.testSets`) are created the same way when absent. The quality screens show scores only after a test run, so on a fresh clone they stay empty.

**Ingestion pipelines from configuration.** Each file in `apps/api/config/local/pipelines` names a platform dataset, a pipeline id and its spec. At startup the API creates a pipeline that is missing and updates one that only the seed has saved; a pipeline someone changed through the API, portal or console is left alone. Seeding only saves the pipeline. Running it is ingestion, which needs a person or key with the right, and which lockdown limits like any other run.

**The GenKI guide.** The service `genki-guide` (GenKI-guiden) answers questions about GenKI itself, with sources, from the dataset `digdir/genki-docs` on the `platform-pg` endpoint, embedded with `foundry/text-embedding-3-small`. Its pipeline `genki-docs` (`apps/api/config/local/pipelines/genki-docs.yaml`) is a folder source with this include list: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/**/*.md` (ADRs, this file, the frontend contract, the API docs), `packages/*/README.md`, `apps/*/README.md`, `examples/*/README.md` and the System Atlas module files `docs/architecture/modules/*.yaml` (without `order.yaml`). Folder sources read `.md`, `.txt`, `.html` and `.htm` by default; this pipeline sets `extensions: [.md, .yaml]` so the module files are read too. Every document is titled by its first heading (a YAML file by its top-level `name:`) and links to its file on GitHub (`https://github.com/digdir/genki/blob/main/<path>`). The images build the same list into `/app/genki-docs` (`scripts/docs-bundle.ts`), and the containers set `INGEST_FOLDER_ROOT` there, so the guide in an environment answers from the docs of the code it runs. The pipeline runs only when started, and documents change only when it runs again: after a change to the docs, deploy and run it once more.

- Locally: set `INGEST_FOLDER_ROOT` in `.env.local` to the absolute path of your clone, so the pipeline path `.` is the repository root, and have the Foundry settings (embeddings and the model the guide answers with). Start the API, log in to the console as Ola Drift, open Katalog, then Datasett, choose GenKI-dokumentasjon, and press Kjør on the pipeline. With an operator token: `POST /operator/datasets/digdir%2Fgenki-docs/pipelines/genki-docs/execute` with a `change-reason` header, then follow `GET .../executions`.
- In genki-test: deploy, then a person in one of `LOCKDOWN_ENTRA_GROUPS` logs in to the console with Entra ID and starts the pipeline the same way, or calls the same route with that login's token. Scheduled runs are skipped in lockdown, so nothing reindexes by itself.
- In the console, Systematlas (`#/atlas`) shows the System Atlas on the whole window, with a link back to the console in its topbar. The guide is the chat panel under the details panel. Each module offers prepared questions (explain it, how it connects, where it is in the code, how to change it), each connection and each traced request has its own ask, and an answer lists the atlas modules it mentions so you can jump to them. The atlas page only sends the question to the console; the console asks the guide through `POST /v1/chat/completions` (model `genki-guide__default`) with its login's token and sends the answer back, so the token never reaches the atlas page. The login needs the right to use services in the platform organisation, so in genki-test that is the Entra ID login. Opened on its own, the atlas shows the chat panel with a note and no input.

**Durable jobs.** Work that must outlive a process runs as jobs on pg-boss ([ADR 0041](adr/0041-durable-jobs-on-pg-boss.md)). The worker installs them: at startup, as the owner role, it creates and migrates schema `pgboss` on the platform database, creates every queue in `platformQueues` (`packages/jobs/src/platform-queues.ts`) with its dead-letter queue `<queue>.dead`, grants `genai_runtime` what sending and working need, and then works the queues as `genai_runtime`. `npm run dev:all` does not start the worker, so run it beside the API with `npm run dev -w apps/worker` when you need jobs; in dev mode without `DATABASE_URL` it keeps an in-memory queue of its own. A queue is defined with `defineQueue`: its policy, an expiry of at most 24 hours, a heartbeat of at least 10 seconds, retries, whether failed jobs become dead letters, and a payload schema. Payload values are keys, such as ids and organisation numbers; a value with whitespace or longer than 128 characters is refused. A finished job is deleted after 7 days, and one nobody takes, a dead letter included, after 14 days. There are no platform queues yet.

**Tests.** `npm run check` runs prettier, eslint, the type check, dependency boundaries, the apps' size budgets and every test. `npm run size` builds the portal, console and workspace and fails when an app's first load, its entry and the chunks that entry imports up front, grows past its gzip budget in `scripts/size-budget.ts`. Docker must be running: the Postgres, pgvector and Typesense-writer suites start containers with Testcontainers. Run a part with `npx vitest run <paths>`. Tests never call real models; the live suites skip themselves unless their settings are set.

## Repository layout

| Area              | Packages                                                                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core              | `contracts` (shared types), `kernel` (tasks, event log, access, budgets), `definitions` (schema, layered settings, definition store), `composition` (builds the kernel from config), `plugins` (manifests and contract suites), `i18n`                                                                               |
| Ports             | `port-model`, `port-knowledge`, `port-embedding`, `port-rerank`, `port-tools`, `port-blob`                                                                                                                                                                                                                           |
| Providers         | `providers-openai`, `providers-anthropic`, `providers-typesense`, `providers-typesense-writer`, `providers-pgvector`, `providers-postgres`, `providers-postgres-source`, `providers-colbert`, `providers-documents`, `providers-mcp-client`, `providers-openapi-tools`, `providers-a2a-client`, `providers-langfuse` |
| Strategies        | `strategy-single-call`, `strategy-rag`, `strategy-agent-loop`, `strategy-step-flow`, `strategy-remote`, `strategy-builder`; `retrieval` (search stages)                                                                                                                                                              |
| Adapters          | `adapter-openai`, `adapter-mcp`, `adapter-a2a`, `adapter-rest`, `conversations`                                                                                                                                                                                                                                      |
| Platform services | `identity` (principals, Ansattporten, Maskinporten, Altinn), `guardrails`, `hooks`, `eval` (test sets, judges, publishing gates), `jobs` (triggers and batch), `ingest` (Kudos, websites, folders), `valuehash`                                                                                                      |
| Client            | `client` (`@genai/client`, typed client for your own frontend), `schema-forms` (forms and results drawn from a service's JSON Schema)                                                                                                                                                                                |
| Apps              | `api`, `worker`, `portal`, `workspace`, `console`, `parity` (records headless-rag and compares against it)                                                                                                                                                                                                           |

Model provider APIs and catalog options are documented in [providers.md](providers.md).

Vendor SDKs live only in `packages/providers-*`, and only composition roots may import those providers. `npm run boundaries` enforces both.

## Quality

```sh
npm run check   # prettier, eslint, typecheck, dependency boundaries, size budgets, all tests
```

Tests use Vitest; the Postgres, pgvector and Typesense-writer suites start containers with Testcontainers, so Docker must be running. CI (`.github/workflows/ci.yml`) runs the same steps as `npm run check`, with the tests split over four runners, plus a gitleaks scan and a Docker image build, without pushing.

Quality of answers is measured, not assumed: `packages/eval` runs test sets with judges and publishing gates, and `apps/parity` compares the platform with headless-rag on the same questions ([apps/parity/README.md](../apps/parity/README.md)).

## Building blocks today

Step flow blocks today: `model`, `extract`, `classify`, `retrieve`, `rerank`, `synthesize`, `evidence-gate`, `overview-finalize`, `answer`, `template`, `route`, `approval`, `agent`, `documents`, `read-document`, `table`, `tool`. Guardrails: `pii-before-model`, `pii-out-of-log`, `require-sources`, `language`, `refuse-topics`, `human-approval`, `custom-rules`.
