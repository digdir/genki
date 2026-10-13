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

**API keys for local clients.** In dev mode with the mock login active, `DEV_API_KEY` registers a general dev key, and `DEV_SERVICE_API_KEY` registers a key bound to one service: `DEV_SERVICE_API_KEY_SERVICE`, `kunnskapsassistenten` by default. Both keys are in `.env.local` after setup.

**Frontend clients.** `apps/api/config/local/clients/kunnskapsassistenten.yaml` registers an example client: a separate frontend for Kunnskapsassistenten on `http://localhost:5177`, allowed to call the platform from the browser. Nothing in this repository runs on that port; it shows how a frontend of your own is registered.

**What needs your own settings.** Every setting is listed in `.env.example`, with what happens when it is empty. Integrations with missing settings are skipped and logged at startup, not fatal, and so are the services that need them.

| Works on a fresh clone, no secrets                                  | Needs your own settings in `.env.local`                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Login with test persons, rights, portal, console, workspace         | Real models: `FOUNDRY_OPENAI_*`, `FOUNDRY_CLAUDE_*`                      |
| Postgres storage, migrations, API keys, conversations, audit        | Kudos and public-docs search: `TYPESENSE_*` (the key may only search)    |
| "Lokal testchat" in the workspace, answered by the local echo model | Reranking: `COLBERT_API_*`; embeddings for vector search: Foundry        |
| Your own single-call services on the local model (`local/echo`)     | Traces in Langfuse, Maskinporten, the real Altinn PDP, real Ansattporten |

Without the Foundry and Typesense settings, the seeded services (Kunnskapsassistenten, Klarspråk, Nynorsk and the rest) are skipped, so "Lokal testchat" is the only service until you add them.

Only `.env.local` is loaded automatically. Secrets in config are referenced as `secret://env/<name>`, which reads the environment variable `<NAME>` (`foundry-openai-key` reads `FOUNDRY_OPENAI_KEY`). At startup the API publishes the flows and services in `apps/api/config/local` (definitions that already exist are skipped) and runs database migrations. A variant whose model is not configured is left out and logged, so the service still starts with its other variants. Test sets in `packages/eval/testsets` and `packages/jobs/examples/testsets` that belong to a local service (by `spec.service` or the service's `evaluation.testSets`) are created the same way when absent. The quality screens show scores only after a test run, so on a fresh clone they stay empty.

**Tests.** `npm run check` runs prettier, eslint, the type check, dependency boundaries and every test. Docker must be running: the Postgres, pgvector and Typesense-writer suites start containers with Testcontainers. Run a part with `npx vitest run <paths>`. Tests never call real models; the live suites skip themselves unless their settings are set.

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

Vendor SDKs live only in `packages/providers-*`, and only composition roots may import those providers. `npm run boundaries` enforces both.

## Quality

```sh
npm run check   # prettier, eslint, typecheck, dependency boundaries, all tests
```

Tests use Vitest; the Postgres, pgvector and Typesense-writer suites start containers with Testcontainers, so Docker must be running. CI (`.github/workflows/ci.yml`) runs the same steps as `npm run check`, with the tests split over four runners, plus a gitleaks scan and a Docker image build, without pushing.

Quality of answers is measured, not assumed: `packages/eval` runs test sets with judges and publishing gates, and `apps/parity` compares the platform with headless-rag on the same questions ([apps/parity/README.md](../apps/parity/README.md)).

## Building blocks today

Step flow blocks today: `model`, `extract`, `classify`, `retrieve`, `rerank`, `synthesize`, `evidence-gate`, `overview-finalize`, `answer`, `template`, `route`, `approval`, `agent`, `documents`, `read-document`, `table`, `tool`. Guardrails: `pii-before-model`, `pii-out-of-log`, `require-sources`, `language`, `refuse-topics`, `human-approval`, `custom-rules`.
