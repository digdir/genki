# 0048 Connections serve many APIs, models bind one per operation

Status: proposed, 2026-11-05 (partly built, 2026-11-05; the console built, 2026-11-05; plug-in rerank engines, stored rerank entries, processor records on embed and rerank calls, embedders found by discovery on the embedding port, and limits and kind settings through the operator routes are missing)

Supersedes the adapter-per-protocol part of ADR 0021 and the "one registration" bullet of ADR 0044. Amends ADR 0047: a descriptor names an API family instead of an endpoint protocol, its id names the API instead of the kind, and the `descriptors` opt-in on a model is replaced by bindings.

## Context

A model endpoint in the catalogue has one `protocol`, and the protocol picks exactly one hand-written adapter (`packages/port-model/src/catalog.ts`, `router.ts`, the adapter list in `packages/composition/src/runtime.ts`). The operator API and the console allow only `openai-chat` and `anthropic-messages`. Three things follow:

- One Foundry resource is registered three times, as `foundry-openai`, `foundry-claude` and `foundry-embeddings`, with three credentials, three processor records and two catalogues.
- Which wire API a model speaks is hidden inside an adapter: the `openai-chat` adapter speaks Chat Completions, Responses (ADR 0044) and Decisions, and nothing outside it can see or choose between them.
- A descriptor must carry an `api.protocol` equal to the endpoint's, so new kinds borrow `openai-chat` as a label, and a descriptor with any other protocol cannot be given to a model created in the console. The executor never reads the protocol; it is a compatibility label only.

ADR 0047 meant every operation, chat included, to be one governed path. The catalogue still says the opposite: an endpoint is an API.

## Decision

### Four concepts

| Concept                            | What it is                                     | Holds                                                                                                  |
| ---------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Connection (`model-endpoint`)      | Where and how Genki reaches a provider         | Base URL, credential, the API families it offers and their base paths, discovery, the processor record |
| Model                              | One deployment on a connection                 | Deployment, family, residency, limits, prices, and one API per operation kind it offers                |
| API (`<provider>/<api>@<version>`) | One wire API, versioned and reviewed           | Its kind, its family, and either a descriptor (data) or a built-in implementation (code)               |
| Operation kind                     | What a call does: `chat`, `decide`, `embed`, … | Maturity per environment (ADR 0047) and, for built-in kinds, Genki's own types                         |

### A connection has no protocol

- A connection holds `baseURL` (the provider resource's root), `auth`, `families` and `discovery`. `protocol` is removed.
- `families` maps each API family the connection offers to its base, a path under `baseURL` or a full URL on the same resource: `families: { openai: /openai/v1, anthropic: https://<resource>.services.ai.azure.com/anthropic }`. A connection offers a family only when it names it.
- The processor record stays keyed on the connection id, so one provider resource has one record.
- `discovery` is a list of rules, each with `include`, `exclude`, `capabilities` and `apis`, the bindings a discovered deployment gets. Two rules on one connection replace the former `foundry-openai` and `foundry-claude`; embedders are listed models, not discovered. A discovered model still starts as a candidate an operator confirms (ADR 0021).
- Connection `options` are removed; both adapters declare an empty schema today.
- A connection may hold non-secret `settings` (such as a key id or a region) and named `keys` (secret references) for descriptors that sign requests (ADR 0049). Only an operator sets them, a tenant connection cannot have them, and a `PUT` without them keeps them.

### A model binds one API per kind

- A model has `apis: { <kind>: <api id> }`, for example `{ chat: openai/responses@1, decide: openai/decide@1 }`. Its operations are the keys. `operations`, `descriptors` and the OpenAI `options.api` are replaced by it.
- A binding is valid when the API exists, its kind is the key, and the model's connection offers the API's family. A `chat` binding also needs an API with a built-in implementation, since chat is not described yet. Nothing else is compared.
- `options` on a model are checked by the implementations its bindings name, so `tokenParam` belongs to `openai/chat-completions@1`.
- A kind with its own settings keeps them under the kind: `embed: { dimensions, maxBatch }`.

### One registry of APIs, data or code

- Every API has an id `<provider>/<api>@<version>`, a kind (`operation`) and a family (`api.family`, which replaces `api.protocol`). A descriptor's id no longer has to repeat its kind, so `openai/chat-completions@1` and `openai/responses@1` are both `chat`.
- An API is either a descriptor (data, run by the one executor of ADR 0047) or a built-in implementation (code, registered under the API id). The built-in ones from day one are `openai/chat-completions@1`, `openai/responses@1` and `anthropic/messages@1` for `chat`, and `openai/embeddings@1` for `embed`. The descriptor that was `openai/embed@1` is `openai/embeddings@1`, and the old id is still read. The ADR 0044 switch from Chat Completions to Responses on the one documented refusal stays inside `openai/chat-completions@1`.
- When an API has both, as `openai/decide@1` does today, the built-in implementation serves the call and the descriptor's fixtures keep proving that they agree (ADR 0047). A built-in implementation is an optimisation of a reviewed API, never a separate path past the gate.
- `ModelAdapter.protocol` becomes `ModelAdapter.apis`, the API ids an adapter implements, each with its model options schema.
- `GET /operator/apis` lists the registry: id, kind, family, source (`built-in`, `bundled`, `uploaded`), status and the models bound to it.

### One catalogue

- Embedding models move into the model catalogue as models with `apis: { embed: … }`. The embedding catalogue file and its separate endpoint go away, and `EmbeddingRouter` resolves from the same catalogue registry, so embedders can be added and changed without a deploy.
- Rerank engines follow the same way: `colbert/rerank@1` is a built-in implementation, and a reranker is a model with `apis: { rerank: … }`.

### Router and gate

- The model router resolves `(model, kind)` to the bound API, then to its implementation or the descriptor executor. The equality checks between `descriptor.api.protocol` and `endpoint.protocol` are removed.
- The gate is unchanged: it already works on Genki's shapes. The port name in `kernel.gate.call` is the kind's port, not a choice between `model` and `decision`.
- Typed chat calls get the same target fields as descriptor calls: the connection's processor record and the kind's maturity (#325). Built-in kinds are `production` by construction, as now.

### Prices per unit

A price is per model and kind, per unit: `input-token`, `output-token`, `cached-input-token`, `audio-second`, `image`, `video-second`, `character` or `request`. An API's usage mapping names the units it reports. A call whose units have no price is metered and shown as not priced, as now. A `request` without a price costs nothing, so a model priced per token stays priced. A `cached-input-token` without a price costs as an input token.

### Operator API and console

- `POST` and `PUT /operator/model-endpoints/{id}` take `baseURL`, `auth`, `families`, `discovery`, `allowedHosts`, `settings` and `keys`. A connection can be edited; one in use cannot be removed.
- `PUT /operator/models/{id}` takes `apis` and `options` next to the deployment, family, residency, capabilities and `enabled`. The classification `PATCH /operator/models/{id}` takes `apis`, `residency`, `capabilities`, `enabled` and `parameters`.
- The console offers an API on a model when the model's connection offers the API's family.

### Migration

A one-time migration of config entries and the YAML seed, with no change to model ids, since services name them:

- `openai-chat` becomes the family `openai`, `anthropic-messages` becomes `anthropic`, and `openai-embeddings` becomes `openai`.
- Connections with the same resource root and credential are merged: `foundry-openai`, `foundry-claude` and `foundry-embeddings` become one connection with two families and two discovery rules, one for OpenAI deployments and one for Claude, and their processor records are merged onto it. The embedders become listed models on that connection.
- `operations`, `descriptors` and `options.api` on a model become `apis`. A model with `chat` and no `options.api` binds `openai/chat-completions@1` or `anthropic/messages@1` by its old protocol.
- Uploaded descriptors are append-only config entries and are not rewritten: the loader reads `api.protocol` as the family by the same mapping.

## Why

Providers ship new APIs on the same resource and the same key. Registering a connection per API copies credentials and governance, and the protocol field cannot describe a resource that serves Chat Completions, Responses, Messages, embeddings, audio and decisions at once. Binding per model and kind makes the choice explicit, visible and auditable, which ADR 0044's hidden switch could not.

Keeping built-in implementations is deliberate. Chat with tools, streaming and reasoning replay cannot be described yet, and a typed implementation is faster to review than a large descriptor. Registering it under an API id puts it in the same list, the same bindings and the same governance as descriptors, so it is a choice of how an API runs, not of what may run.

Turned down:

- Keeping `protocol` and adding more of them: every new API would still need a new endpoint and a new adapter.
- A protocol list on the endpoint: it still ties the API choice to the endpoint, not to the deployment that actually supports it.
- Detecting the API from model names: ADR 0044 turned this down, and it stays turned down. Discovery rules are written by an operator.

## Consequences

- One provider resource is one connection with one processor record. Merging changes no service.
- The console's models area shows connections, the models on each, and the API bound for each kind (ADR 0050).
- ADR 0021's port stays as it is; its adapter and catalogue parts are replaced here. ADR 0044's behaviour stays, as `openai/chat-completions@1` and `openai/responses@1`.
- Typed chat and decide calls carry the connection's processor record. On a connection without one they log a warning once and go through; with `GENAI_PROCESSOR_RECORDS=enforce` they refuse real data. The migration carries the existing records, `GET /operator/processor-records` and a log line at start name the connections without one, and the default turns to `enforce` once the console shows them.
- A price stored per 1,000 tokens is moved to unit prices for every kind its model binds, at start and once. `costMicroNok` and `priced` on a run read as before.
- Built (#383): the console's models area, with connections, models and the API bound for each kind (`apps/console/src/screens/models`).
- Still missing: limits and kind settings such as `embed: { dimensions, maxBatch }` through `PUT` and `PATCH /operator/models/{id}`, so they are set in the catalogue only; plug-in rerank engines without an API stay in the rerank catalogue, and stored `rerank-endpoint` and `reranker` entries are not moved; embed and rerank calls do not yet check the processor record; embedders found by discovery are not served by the embedding port.
- Interaction patterns beyond one JSON request and one JSON answer are ADR 0049.
