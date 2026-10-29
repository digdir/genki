# Platform HTTP API

Everything the portal, the console and the workspace do goes through this API. Your own systems can do the same.

## Where the reference is

- `GET /openapi.json`: the OpenAPI 3.1 document for every route, with request and response schemas. Each operation has one tag for its area.
- `GET /reference`: the same document as a browsable page with search. Locally: http://localhost:8080/reference.
- `GET /api/tools/openapi.json`: a tool document with one call operation per service the caller may use.

Both are open to everyone and need no credential.

## Authenticate

Send one of these with every call.

| Caller                | Header                                                | Notes                                                                                                                                      |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A person              | `Authorization: Bearer <Ansattporten access token>`   | Rights come from Altinn for each organisation (tenant). Add `GenAI-Acting-For: <org number>` to pick the organisation on `/v1` and `/api`. |
| A system with a key   | `X-API-Key: <key>` (or `Authorization: Bearer <key>`) | Create keys in the portal or with `POST /tenants/{tenant}/api-keys`. A server serving end users adds `X-User-Id: <pseudonymous id>`.       |
| A system with a token | `Authorization: Bearer <Maskinporten token>`          | Only when Maskinporten is configured and the client is registered with `POST /tenants/{tenant}/maskinporten-clients`.                      |

**In local development** the API runs a mock Ansattporten. Get a token for a test person without the browser flow:

```sh
TOKEN=$(curl -s -X POST http://localhost:8080/mock/dev-login -H 'content-type: application/json' -d '{}' | jq -r .token)
curl -s http://localhost:8080/tenants/991825827/services -H "Authorization: Bearer $TOKEN"
```

`{"as":"operator"}` gives an operator token, and `{"pid":"<test person>"}` a given person from `apps/api/config/local/identity.yaml`. The `/mock` routes do not exist when real identity settings are configured.

## Rights

Tenant routes check two things, in order ([ADR 0027](../adr/0027-platform-rights.md)):

1. May the caller act for this tenant at all? If not: `404`.
2. Does the caller have the right for this action? If not: `403` with `errors: [{ "path": "right", "message": "<right>" }]`.

Every tenant route follows this order, so a tenant the caller cannot reach never answers `403`. An operator without a support session cannot reach a tenant either, unless Altinn gives the operator rights in that organisation: then the operator acts there as an ordinary employee, with those rights only. A resource that does not exist (a client, a key, a pipeline, a run) answers `404`, not `400` or `403`.

The five rights are `use-services`, `manage-services`, `manage-datasets`, `register-building-blocks` and `view-usage`. The summary or description of each operation names the right it needs. Operators have every right, but reach a tenant's data only inside a support session: send `support-session: <id>` (see [Operations](operations.md)). In an organisation where Altinn gives them rights, operators act as employees with exactly those rights. Rights count for the Altinn resource in `ALTINN_RESOURCE` (default `urn:altinn:resource:digdir-genai-platform`).

## Changes: reason and audit

Every change is a platform task, and the audit log is the event log ([ADR 0010](../adr/0010-admin-operations-and-audit.md)).

- Every audited change requires `change-reason: <why>`, at least 10 characters. URL-encode it when it has characters outside ASCII (`æøå`). One check in front of all routes enforces it (`apps/api/src/change-reason.ts`), so no route stores a default text any more.
- A missing or short reason answers `400` problem+json with `errors: [{ "path": "change-reason", ... }]`, before the route changes anything. A request without a valid credential still gets `401` first.
- The header is not needed on writes that change nothing an administrator owns: runs and calls (`/v1`, `/api/mcp`, `/api/tools/call`, A2A, playground, assistant turns, test and eval runs), checks and previews, a person's own preferences and conversations, feedback, and an access application (`POST /onboarding/requests`, whose `purpose` is its reason). The list is `reasonFreeWrites` in `change-reason.ts`, and `/openapi.json` marks the header as required on every other write.
- `POST /support-sessions` also accepts the reason as `reason` in the body, because the console sends it there and the session stores it. No other route reads a reason from the body.
- Read the log with `GET /tenants/{tenant}/audit` and one entry with `GET /tenants/{tenant}/audit/{task}`. Each entry has actor, action, target, outcome and reason. Operators see all tenants with `GET /operator/audit`.

## Errors

- Every error outside `/v1`, A2A and MCP answers `application/problem+json`: `{ "type", "title", "status", "detail"?, "errors"?: [{ "path", "message" }] }`. Some add a `code` or another member, such as `requirements`. A response that a route did not shape as a problem is turned into one in front of the client (`apps/api/src/problem-responses.ts`), keeping its members.
- `title`, `detail` and `errors[].message` come from the API's bokmål and English catalogues and follow `Accept-Language`.
- `/v1/*` answers OpenAI's shape: `{ "error": { "message", "type", "code", "param" } }`, so OpenAI clients work unchanged. A2A and `/api/mcp` answer JSON-RPC errors.
- `/api/*` (conversations, feedback, datasets, facets, tools) answers problem+json with a `code`. The body also keeps headless-rag's `error` member with the message text, for older clients ([ADR 0017](../adr/0017-parity-scope-and-intentional-divergences.md)).

## Lists

A list answers an object with the items in `data`: `{ "data": [...] }`, sometimes with more members beside it (`total`, `next`). No route answers a bare JSON array.

## API changes

### 2026-10-26: rights stay within their scope

- Saving or attaching an API key policy answers `403` when the policy's scopes need a right the person lacks: `admin` needs all five rights, `ingest` needs `manage-datasets`. API keys, machine clients and operators are unchanged.
- `POST /tenants/{tenant}/import` needs `spec.riskConfirmation` for limited and high risk services, like `POST /definitions`, also on a dry run. The stored `by` and `at` are the importing person and the time of import.
- `POST /tenants/{tenant}/tool-connections` stores `writes: false` unless an operator registers it. Write operations are switched on by an operator decision.
- Token counts and cost are left out without `view-usage`:
  - `GET /tenants/{tenant}/overview`: `usageThisMonth` and the `usage` of each recent task.
  - `GET /tenants/{tenant}/tasks` and `GET /tenants/{tenant}/tasks/{task}`: `usage`.
  - `GET /tenants/{tenant}/tasks/{task}/timeline`: `inputTokens`, `outputTokens`, `costOre`, the token fields of `stats`, and the tokens of each step. The person who started the task still sees them.
  - Batch runs (`GET /tenants/{tenant}/services/{id}/batch-runs`, a run and its export) and project runs: `tokens`, `costMicroNok`, `cap`, `perItem` and `costApproval`, and the token and cost columns of the export. The person who started the run still sees them.
  - Project subscriptions: `spentThisMonth`.
  - Eval runs: `cost` and `tokens`.
  - Trigger runs: `usage` and `costMicroNok`.
  - Pipeline executions: `report.usage`.

### 2026-10-16: tenant secrets are bound to hosts

- A tenant secret is used only for the hosts it is set for. `PUT /tenants/{tenant}/secrets/{name}` takes `allowedHosts`, required for a new secret. `PUT /tenants/{tenant}/secrets/{name}/hosts` changes them and needs `manage-services`. See [access.md](access.md#tenant-secrets).
- `GET /tenants/{tenant}/building-blocks/secrets` lists `allowedHosts` for each secret.
- Registering a tool connection whose secret is not set for its addresses answers `400`.

### 2026-10-12: one consistent API

Changes a client may notice. The rules behind them are in the sections above; tests in `apps/api/src/api-consistency.test.ts`, `admin-tasks.test.ts` and `openapi/coverage.test.ts` check every route against them.

Change reason

- Every audited write requires `change-reason` (at least 10 characters). These accepted none before and stored a fixed text: service drafts, batch-run start, cancel and retry, risk confirmations, skill create, save, copy, import, attachments and fixes, dataset uploads, enrichment apply and revert, connector sync and credentials, block register, adopt, approval request, withdraw and settings, engine-switch start, retry and cancel, test case candidates, plug-in contract-test reruns. Operator plug-in writes now need 10 characters, not just any text.
- Proposal decisions, operator proposal decision and status, engine-switch activate and rollback, and operator block, skill-share and onboarding decisions read the reason from the header only. A `reason` in the body is ignored, except on `POST /support-sessions`.
- Review edits and approve (`/tenants/{tenant}/tasks/{task}/review/*`), `POST /operator/quality/matrix/runs`, `POST /tenants/{tenant}/clients/{id}/webhook/test` and batch-run start, cancel and retry are audited admin tasks: they need `change-reason` and answer with a `genai-task` header. Without a reason, the webhook test sends nothing.
- `/openapi.json` marks `change-reason` as a required header on every audited write.

Status codes

- A tenant the caller cannot reach answers `404`, never `403`, on every tenant route. This changed for proposals, skills, skill tools, building blocks, step-flow blocks, risk confirmations, the definition template, assistant turns, connectors, private networks, tool connections, tenant secrets, definitions, timeline, settings, pins, export, import and audit. An operator without a support session gets `404` too. Building-block rights are checked on the acting principal.
- `404` instead of `400` or `403`: `DELETE /tenants/{tenant}/clients/{id}` for an unknown client; revoke or rotate of an unknown key, and rotate of a revoked key; execute and delete of an unknown pipeline.
- A concurrent review edit answers `409`, not `500`. A refused risk confirmation answers `400` or `403` problem+json, not `500`. `POST /tenants/{tenant}/eval-runs` with missing fields answers `400`, not `500`. `POST /mock/dev-login` for an unknown person answers `404`, not `500`.
- Creating a pipeline answers `201`, like creating a dataset.

Error bodies

- Every error outside `/v1`, A2A and MCP is `application/problem+json`. Changed: config routes (gates, guardrail rules, test sets, datasets, catalogue, pipelines) sent `application/json`; step-flow blocks 401 and 404; playground 502 (was `{ status: "unavailable" }`, now a problem with `type: urn:genai:problem:playground-unavailable`, `setup`, `code`); skill publish 422 (still carries `ok: false` and `requirements`); `/models` (was `{ error }`); `/api/tools/call` and `/api/tools/openapi.json` (one shape that keeps `error`, with a numeric `status` instead of `"error"`); unknown `/api/*` paths (still `error: "API endpoint not found"`).
- Titles and details are translated by `Accept-Language` everywhere, including the tenant-gate refusals and engine-switch refusals.

Lists

- These answer `{ "data": [...] }` instead of a bare array: `GET /tenants/{tenant}/test-sets`, `/tenants/{tenant}/eval-runs`, `/tenants/{tenant}/feedback`, `/tenants/{tenant}/definitions`, `/tenants/{tenant}/audit`, `/operator/tenants`, `/settings`, `/settings/defaults`, `/settings/defaults/{key}/changelog`.

Other

- Service eval runs no longer show the lease fields `owner` and `heartbeatAt`.
- `GET /tenants/{tenant}/eval-runs/{runId}` finds both kinds of run and tells them apart with `kind` (`service` or `kernel`); see [work.md](work.md).
- `GET /eval-tasks/{task}` answers the same from every instance.
- `GET /operator/tasks?status=` filters on every task status; an unknown status answers `400`.
- `GET /operator/tracing` no longer has the always-empty `tenants` member.
- Pipeline `/versions` marks the version that removed the pipeline with `deleted: true`.
- `PUT /tenants/{tenant}/secrets/{name}` is open to `register-building-blocks` as well as `manage-services`, like the admin action.
- `GET /tenants/{tenant}/datasets/{id}/uploads` needs only membership, like reading the dataset; changing uploads still needs `manage-datasets`.
- The hooks reference matches the responses: the tenant hook `PUT` answers without `changedBy` and `changedAt`, a hook test includes `payload`, and built-ins include `description` and `configSchema`.

## Areas

| Tag                      | Guide                          |
| ------------------------ | ------------------------------ |
| Frontend                 | [frontend.md](frontend.md)     |
| Services and definitions | [services.md](services.md)     |
| Datasets and knowledge   | [datasets.md](datasets.md)     |
| Access and extensions    | [access.md](access.md)         |
| Work and quality         | [work.md](work.md)             |
| Operations               | [operations.md](operations.md) |
| Platform                 | [platform.md](platform.md)     |

To build a frontend for end users, read [Build a frontend](../build-a-frontend.md) and the [Frontend contract](../frontend-contract.md) first.
