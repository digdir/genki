# Platform HTTP API

Everything the portal, the console and the workspace do goes through this API. Your own systems can do the same.

## Where the reference is

- `GET /openapi.json`: the OpenAPI 3.1 document for every route, with request and response schemas. Each operation has one tag for its area.
- `GET /reference`: the same document as a browsable page with search. Locally: http://localhost:8080/reference.
- `GET /api/tools/openapi.json`: a tool document with one call operation per service the caller may use.

Both are open to everyone and need no credential.

## Authenticate

Send one of these with every call.

| Caller                | Header                                                | Notes                                                                                                                                                                              |
| --------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A person              | `Authorization: Bearer <Ansattporten access token>`   | Rights come from Altinn for each organisation (tenant). Add `GenAI-Acting-For: <org number>` to pick the organisation on `/v1` and `/api`.                                         |
| A system with a key   | `X-API-Key: <key>` (or `Authorization: Bearer <key>`) | Create keys in the portal or with `POST /tenants/{tenant}/api-keys`. A server serving end users adds `X-User-Id: <pseudonymous id>`.                                               |
| A system with a token | `Authorization: Bearer <Maskinporten token>`          | Only when Maskinporten is configured and the client is registered with `POST /tenants/{tenant}/maskinporten-clients`. It reaches the registered services, never the tenant routes. |

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

### 2026-11-12: only operators change the limits Digdir sets

- `PUT` and `DELETE /tenants/{tenant}/settings/{key}`, `PUT /tenants/{tenant}/pins/{key}` and `POST /tenants/{tenant}/import` answer 403 `urn:genai:problem:operator-only-setting` when someone other than an operator in a support session sets, removes or pins `usage.monthlyTokens`, `usage.tenantCallsPerMinute`, `assistant.dailyTokens` or `batch.approvalLimitNok` for a tenant. A dry run of `PUT /tenants/{tenant}/settings/{key}` or of the import answers the same 403. Importing a bundle that keeps a limit at its current value is fine.
- `GET /settings` marks these settings with `operatorOnly: true`. Reading the effective value is unchanged.

### 2026-11-11: no ingest date as a publish date

- A source without a known publish date has no `published_at` (`publishedAt` in the native and table shapes) on `/v1/chat/completions` and its table cells, in MCP `structuredContent` and in a step flow's document list. It used to carry the date the document was indexed. The field was already optional, so the shape is unchanged.

### 2026-11-11: only operators change sharing

- `POST /definitions` and `POST /tenants/{tenant}/import` answer 403 `urn:genai:problem:share-operator-only` when someone other than an operator changes `spec.availableTo` of a service, compared with its published version. A dry run of the import lists the same error with 422. The console route `PUT /operator/shared-services/{tenant}/{id}` is unchanged.

### 2026-11-10: connection settings and signing modules

- `POST` and `PUT /operator/model-endpoints` take `settings` (non-secret values a descriptor reads as `$connection.<name>`) and `keys` (named platform secrets only a module reaches). Only an operator sets them, and a change is audited with its reason. `GET /tenants/{tenant}/catalog` lists a shared connection without `settings` and `keys`.
- A descriptor module may set `Authorization` when the descriptor's `auth` is `{ signedBy: module }`, reads `host`, `headers`, `header_names`, `header.<name>`, `body_sha256` and `connection.<setting>`, may sign binary, multipart and streamed requests, takes `connection.<key name>` keys and can derive keys with `hmac_sha256_derive`. A fixture may carry `settings`.

### 2026-11-10: polls, retries and uploads in parts from descriptors

- A descriptor's `until` takes `after`, the wait an answer asks for, from a field or a declared header; an error rule takes `retry: true`, which retries its status within the step's `retry`; a step takes `parts: { of, bytes, most }`, which sends a media input in byte ranges and binds the answers as lists (ADR 0049, [operations.md](operations.md)). Descriptors without them load and run as before.

### 2026-11-10: provider errors are kept for the audit, and a non-streamed descriptor step answers with its text

- When a provider answers a model's descriptor call (chat, decide or an operation step, not embeddings) with an error, the run's audit `kernel.error` event carries `provider: { status, body }`: the HTTP status and the first 500 characters of the error body, JSON or plain text, with the connection's key, its named keys, bound secrets and the headers a module signed replaced by `[redacted]`. For a built-in provider (OpenAI, Anthropic) `body` is the SDK's error message. The run timeline shows it to those who manage the service. The caller's `kernel.error` and answer are unchanged.
- A `call-operation@1` step without `stream` outputs `{ result, text }` when `result` is text or has a text field `text`, so a flow that ends on it answers with that text instead of the JSON of `result`.

### 2026-11-06: a streamed descriptor step answers with its text

- A `call-operation@1` step with `stream: true` now outputs `{ result, text }`, and a flow that ends on it answers with `text` instead of the JSON of `result`. Deltas reach `/v1/chat/completions` only with `genai_stream: "live"`; without it the text comes as one piece.

### 2026-11-06: any provider API by descriptor

- Descriptors gain the classes `issued` and `url`, per-step `credential` placements (`header`, `query`, `form`, `basic`), multipart `filenames`, `request.follow`, `until.fail`, the mapping functions `$dataUrl`, `$add`, `$sub`, `$mul` and `$coalesce`, several media types in one output, and `response.stream` (`sse`, `ndjson`, `lines`) with `resources`, `modules` and `websocket` steps (ADR 0049, [operations.md](operations.md)).
- `GET /v1/sessions?model=<service>` with an upgrade to WebSocket opens a live session on a service whose way of working is `live-session@1`. A request without an upgrade answers `426 upgrade_required`; `/v1/chat/completions` answers `400 live_only` for such a service. The close codes are 1000, 1001, 4001 (longest duration), 4002 (kind moved back to test) and 1011.
- `/v1/chat/completions` with `stream: true` streams the deltas of a `call-operation@1` step with `stream: true`.
- `PUT /operator/model-endpoints/{id}/processor-record` takes `providerState: { allowed, retention: { days, note } }`; `GET /operator/processor-records` shows it. `allowedHosts` on a model connection is set by operators only.
- `PUT /operator/operation-descriptors/{id}` takes `modules: { <name>: <base64 WebAssembly> }`; the answer lists `modules: [{ name, sha256 }]`. A fixture may carry `at` and `session`.
- A provider object that cannot be deleted becomes the audit action `platform.provider-object.incident` (rejected) in the tenant's log.
- Usage totals carry `units` for open units wherever usage is returned.
- A caller can send audio and images to a service that lists the media type in `spec.input.accepts` (`audio/*` is not a valid entry; name each type, such as `audio/wav` or `image/png`). `/v1/chat/completions` takes `input_audio` (`{ data, format }`, `wav` or `mp3`) and `image_url` with a base64 data URL in the last user message; `GET /v1/models` shows the accepted types as `_media: { accepts, max_bytes, max_count }`. Errors: `400 invalid_documents`, `400 documents_not_accepted`, `413 document_too_large`, `415 unsupported_document_type`. In a step flow the files are `{{input.files.0}}`, `{{input.files.1}}` and so on, media references that a `call-operation@1` step passes as a descriptor's `media` input. The consent rule is unchanged.
- A descriptor is refused at load when a mapped request field, nested ones included, has no class in `wire.request`, or when an `opaque` request field is filled from input instead of an earlier step.

### 2026-11-05: descriptors from primitives and media input with consent

- Operation descriptors may be a list of `steps` with `bind`, `until`, `finally`, request encodings `multipart`, `form`, `binary`, `text` and `ndjson`, answer encodings `binary`, `text` and `ndjson`, classified query parameters and headers, open usage units, `errors` and `checks` (ADR 0049, [operations.md](operations.md)). One-request descriptors and their fixtures are read unchanged; a fixture may record `steps: [{ step, request, response }]`.
- An answer whose content type is not the one its descriptor declares fails the call. This includes a JSON answer sent as `text/plain`.
- Image, audio and file input to a descriptor call is let through when the service's confirmed risk assessment records it, `spec.riskConfirmation.unmaskedInput: [{ mediaType, reason }]`, and otherwise refused as before (#326). `kernel.gate.call` adds `mediaInput` with each input's type, size and SHA-256.
- A price may name any unit a descriptor names, such as `page`, besides the eight built-in units; a unit name is lowercase letters, digits and hyphens. `GET /operator/apis` lists such units in `units`.

### 2026-11-05: embedders, rerankers and prices per unit

- Embedding models are models in the model catalogue with `apis: { embed: openai/embeddings@1 }` and `embed: { dimensions, maxBatch? }`; the embedding catalogue and the schemas `Embedding` and `EmbeddingEndpoint` are gone. A reranker on an engine with an API is a model with `apis: { rerank: colbert/rerank@1 }` and `rerank: { onFailure }`. Ids do not change, and neither model is listed in `GET /models` as a chat model.
- The descriptor `openai/embed@1` is `openai/embeddings@1`; the old id is still read, and a model bound to it moves to the new one.
- `PUT /operator/models/{id}/price` takes `{ <kind>: { <unit>: <kroner per unit> } }` with the units `input-token`, `output-token`, `cached-input-token`, `audio-second`, `image`, `video-second`, `character` and `request`. `{ inputPerThousand, outputPerThousand }` is still accepted and holds for every kind the model binds. The answer adds `prices`, and keeps `inputPerThousand` and `outputPerThousand` as the per-1,000-token view. A unit not in the list answers `400`.
- `GET /operator/apis` adds `units`, the units each API reports.
- `GET /operator/processor-records` adds `typedCalls`: `warn` or `enforce`, what a typed chat or decide call does on a connection without a processor record (`GENAI_PROCESSOR_RECORDS`).

### 2026-11-05: connections serve many APIs

- A model connection (`model-endpoint`) takes `baseURL`, `auth`, `families: { <family>: <base> }` and `discovery: [<rule>]`, and no longer `protocol` or `options`. A base is a path under `baseURL` or a full URL. `POST /operator/model-endpoints` takes the new shape, and `PUT /operator/model-endpoints/{id}` (operators, audited, `change-reason`) edits a connection in place; a `PUT` without `discovery` keeps the stored rules. A family no API is in answers `400` (`errors[0].path: "families.<family>"`).
- A model binds one API per kind: `apis: { <kind>: <API id> }`, such as `{ chat: openai/responses@1, decide: openai/decide@1 }`. It replaces `operations`, `descriptors` and `options.api` in the catalogue, `PUT /operator/models/{id}` and `PATCH /operator/models/{id}`, where `operations` now answers `400`. A binding to an unknown API, an API of another kind, an API in a family the connection does not offer, or a `chat` API without a built-in implementation answers `422` (`errors[0].path: "apis.<kind>"`). `GET /operator/models` adds `apis` and keeps `operations`, the kinds it binds.
- `GET /operator/apis` (operators): every API a model can bind, `{ id, kind, family, source, status, summary?, models }`, with `source` one of `built-in`, `bundled` or `uploaded`.
- Each descriptor in `GET /operator/operation-kinds` and `GET /operator/operation-descriptors` names its `family` instead of `protocol`. A stored descriptor that names `protocol` is read with that protocol's family.
- Stored connections, models, processor records and classifications move to the new shape once at start; see [Model providers](../providers.md). Model ids do not change.

### 2026-11-04: fixtures recorded from tries

- `PUT /operator/operation-descriptors/{id}` takes 0 to 20 fixtures; `fixtures` may be left out. An upload without fixtures stays in review, and `POST /operator/operation-descriptors/{id}/status` with `described` answers `422` (`errors[0].path: "fixtures"`) until it has fixtures that pass `operation@1`.
- `POST /operator/operations/{descriptor}/try` also answers `exchange`: `{ deployment, input, request: { method, path, query?, body }, response: { status, body }, result, usage, dropped }`, with the input masked and media still encoded. The field is additive.
- `POST /operator/operation-descriptors/{id}/fixtures` with `{ task, name, exchange }` and `change-reason` (operators, test only, audited) records a try as a fixture of an upload in review. It answers `201` (`step: "fixture-recorded"`), `403` outside test, `409` for a bundled descriptor or a described upload, and `422` when the task is not a finished try of the descriptor, the exchange is not the one it answered, the name is taken, or `operation@1` fails.
- `GET /operator/operation-descriptors/{id}` adds `usedBy: [{ tenant, service, version }]`, the published services whose step flows call the descriptor, and `input`, its typed input shape.
- Each descriptor in `GET /operator/operation-kinds` adds `protocol`.

### 2026-11-04: media output from operations

- A descriptor marks an output field as media (`{ media: <type/subtype> }`). The gate counts its bytes (`mediaBytes` in `kernel.gate.call`), refuses it whole over the cap for its type (`refusal: "media"`), and keeps it as a blob of the run; the run result, later steps and the timeline hold a reference, never the bytes. Which types are kept and their caps are deployment configuration (`GENAI_MEDIA_OUTPUT_TYPES`, `GENAI_MEDIA_OUTPUT_MAX_BYTES`), see [Operations](operations.md).
- `POST /v1/chat/completions` answers with `attachments: [{ type, id, mediaType, bytes, sha256, step?, url }]` next to `citations` when steps of the run made media; a stream sends them in one frame before `finish_reason: "stop"`. The field is additive; OpenAI clients ignore it.
- `GET /v1/tasks/{task}/media/{id}` serves the bytes, with the media type as `content-type`, to a caller that may read the run (`404` otherwise, `401` without credentials). It is part of the `openai` channel.
- A step-flow step notice carries `media: [{ id, mediaType, bytes }]`, and the task timeline lists media under the step and the answer.

### 2026-11-04: trusted Entra logins create organisation-wide keys

- `POST /tenants/{tenant}/api-keys` answers `201` for an operator who is also one of the organisation's own people, such as a trusted Entra login in the platform organisation ([ADR 0033](../adr/0033-locked-test-environment.md)), as `POST /tenants/{tenant}/services/{service}/api-keys` already did. It used to answer `403`. An operator in a support session still gets `403`, and other operators `404`.

### 2026-11-04: operators upload operation descriptors

- `PUT /operator/operation-descriptors/{id}` (operators, audited, `change-reason`): uploads a descriptor with 1 to 20 recorded fixtures, at most 512 KiB. The loader rules and `operation@1` run first; a failure answers `422` with every reason. It answers `201` (`step: "uploaded"`) or `200` (`step: "replaced"`, while still in review), and `409` for a bundled id or an upload that is already described.
- `POST /operator/operation-descriptors/{id}/status` with `{ "status": "review" | "described" }` and `DELETE /operator/operation-descriptors/{id}` (operators, audited, `change-reason`).
- `GET /operator/operation-descriptors` and `GET /operator/operation-descriptors/{id}`: bundled and uploaded descriptors with `source`, `status`, `fixtures` and `contract`.
- An uploaded descriptor's kind counts as a known operation kind at once, in `PATCH /operator/models/{id}`, `GET /operator/operation-kinds` and the raw and described tiers, without a restart.

### 2026-11-04: new operation kinds from a descriptor, and the last checks on call-operation

- A catalogue model's `operations` may list `chat`, `decide` or any kind a registered descriptor defines; any other kind is refused in the catalogue and in `PATCH /operator/models/{id}` (`422`, `errors[0].path: "operations"`). `GET /models` lists every kind a model offers.
- A service may name a model used only for an operation kind: `spec.model.operations: { <kind>: <model> }`. The model must offer the kind and lie within the service's residency; a `call-operation@1` step without `params.model` uses it for its descriptor's kind before the main model.
- Publishing a service with a `call-operation` step answers `422` unless it has the `pii-before-model` guardrail, and when the descriptor's kind is `decide` (served only through `purpose-check`).
- A draft (builder, playground, skill test, assistant) cannot run a `call-operation` step; the step fails as refused.
- Image, audio and file input to a descriptor call is always refused. The processor record no longer has `acceptsUnmaskedInput` or `unmaskedInputReason`; a `PUT` with either answers `400`.
- `GET /operator/operation-kinds` lists `chat`, `decide`, `embed` and `rerank` always, with `builtIn: true` and `typed: "production"`, and says `governs: "descriptor-calls"`: maturity governs descriptor calls only.

### 2026-11-03: the described tier, maturity per kind and processor records

- A step flow may use the block `call-operation@1` with `params: { descriptor, model? }` and the descriptor's typed input as the step `input`; `model` is one of the service's models and defaults to its main model. The step answers `{ result }`. Publishing a service whose flow (or a subflow it reaches) has such a step answers `422` unless the descriptor is reviewed (`status` `described` or `typed`, not `review`), its operation kind is `production` in this environment, the model is one of the service's, within the service's residency, and its endpoint has a processor record. The same refusals hold when the step runs, so a kind moved back to test or a removed processor record stops the service at the next call; `kernel.gate.call` names `port: "described"` and the refusal (`maturity`, `processor`, `media`).
- `GET /operator/operation-kinds` and `POST /operator/operation-kinds/{kind}/maturity` with `{ "maturity": "test" | "production" }` (operators, audited, `change-reason`): one operator moves a kind to production or back to test.
- `GET /operator/processor-records`, and `GET`, `PUT` and `DELETE /operator/model-endpoints/{id}/processor-record` (operators, audited, `change-reason` on writes): `{ agreement, subProcessors: [{ name, location }], retention: { days, note? }, acceptsUnmaskedInput, unmaskedInputReason? }`. `acceptsUnmaskedInput: true` needs a reason and lets image, audio and file input through to a described operation on that endpoint; text is still masked. (Removed 2026-11-04.)
- An operation descriptor may have `status: described`: reviewed, served to services through `call-operation@1`, without types of Genki's own.

### 2026-11-03: operation descriptors

- `POST /operator/operations/{descriptor}/try` (operators, test only, audited admin task with `change-reason`): calls a descriptor on a catalogue model with synthetic data, masked and metered. See [operations.md](operations.md).
- A model in the model catalogue may take `descriptors: { "decide": "<descriptor id>" }`, and an embedder in the embedding catalogue `descriptors: { "embed": "<descriptor id>" }`, to run that operation through the descriptor executor instead of the hand-written adapter. `GET /operator/models` shows `descriptors` when set. A catalogue that names an unknown descriptor, one in review, or one for another operation or protocol is refused.

### 2026-11-03: decisions on the governed gate

- A service definition takes `spec.decidesAboutPeople` (boolean). With it, publishing and `POST /definitions/validate` answer `422` unless `spec.riskClass` is `high`, the `human-approval` guardrail is set, and `pii-out-of-log` is not set, so the model input is kept for review.
- The guardrail `purpose-check` asks a decision model whether the input is within the service's purpose: `{ "model", "threshold"?: 0.8, "uncertain"?: "person" | "allow", "refusal"?: "person" | "allow", "message"? }`. Publishing answers `422` when the model does not offer the `decide` operation or runs outside the service's residency. A refusal or an answer below the threshold interrupts the run for a person (`id: "purpose-review"`, resume with `{ "within": true | false }`); it is never turned into a refusal.
- `GET /operator/models` lists `operations` per model, and `PATCH /operator/models/{id}` takes `operations: ["chat", "decide"]`. Without a value a model offers `chat` only.
- `GET /tenants/{tenant}/tasks/{task}/timeline` shows each decision as a step of type `decision`.

### 2026-11-03: usage from an AI gateway

Only when an AI gateway is configured (`GATEWAY_USAGE_URL` and `GATEWAY_USAGE_CREDENTIAL`, see [gateway.md](gateway.md)); without one every answer is as before.

- `totals`, `daily[].usage` on `GET /tenants/{tenant}/usage`, `usageThisMonth` on `GET /tenants/{tenant}/overview` and each `usage` on `GET /operator/usage` are the sum of genki's own usage and the gateway's. Each gains `bySource: [{ "source": "genki", "usage" }, { "source": "gateway", "usage" }]`.
- `byModel` rows gain `source`, `genki` or `gateway`. The gateway's rows also come as `bySubject`: the owner (`subject`, or `null` for a key without one), `usage` in kroner, the amount the gateway charged as `cost: { currency, micros }`, and the latest `rate` used with its `rateDay`. A gateway amount with no rate counts as unpriced, never as 0 kr.
- `byService`, `byProject`, `testing`, `ingestion` and `daily[].byService`/`daily[].byModel` stay genki's own: the gateway cannot see services, projects or test runs.
- `GET /operator/usage/unassigned` lists this month's gateway rows that belong to no tenant. Operators only.

### 2026-10-30: case types judged as evaluators

- The `contract` evaluator is version 2: it scores an exact case's text (`exact-text`, 0 when the case has no text) and counts an empty answer as a refusal on a must_reject case.
- `judge:criteria` scores criteria cases. A run's provenance names it with its version and model, `judge:criteria@<version>+<model>`; labels and calibration are kept under `judge:criteria`.
- The eval capability (`platform.eval.run`) takes `avoidAsJudge`, models the run's judges must not share a family with; a portal test run's judge also avoids the service's own models.

### 2026-10-30: judges that answer later (evaluator@2)

- Registering an evaluator plug-in under `evaluator@1` answers `400`; one stored under it judges nothing until it is registered again under `evaluator@2`.
- Every score in an eval run has a `state`: `scored`, `not-applicable`, `pending`, `failed` or `missing`. A run stored before reads with the state its value implies.
- `GET /eval-tasks/{task}` can answer `waiting-for-scores` with how many scores are pending, and an eval run has `incomplete`, naming each judge with missing or failed scores.
- A gate fails when its metric has missing or failed scores in its split, in the run or, for a no-regression gate, in its baseline.

### 2026-10-26: rights stay within their scope

- Saving or attaching an API key policy answers `403` when the policy's scopes need a right the person lacks: `admin` needs all five rights, `ingest` needs `manage-datasets`. API keys, machine clients and operators are unchanged.
- `POST /tenants/{tenant}/import` needs `spec.riskConfirmation` for limited and high risk services, like `POST /definitions`, also on a dry run. The stored `by` and `at` are the importing person and the time of import.
- `POST /tenants/{tenant}/tool-connections` stores `writes: false` unless an operator registers it. Write operations are switched on by an operator decision.
- Token counts and cost are left out without `view-usage`:
  - `GET /tenants/{tenant}/overview`: `usageThisMonth` and the `usage` of each recent task.
  - `GET /tenants/{tenant}/tasks` and `GET /tenants/{tenant}/tasks/{task}`: `usage`.
  - `GET /tenants/{tenant}/tasks/{task}/timeline`: `inputTokens`, `outputTokens`, `costOre`, `costMicroNok`, `priced`, the token and cost fields of `stats`, and the tokens of each step. The person who started the task still sees them.
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
- `GET /eval-tasks/{task}` answers the same from every instance, except `waiting-for-scores`, which only the instance running the eval knows.
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
