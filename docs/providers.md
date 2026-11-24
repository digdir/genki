# Model providers

Strategies use `ModelPort.chat` and `chatStream`; the router handles credentials, capabilities, residency, token ceilings and metering. Connections and models belong in the model catalog. See [ADR 0021](adr/0021-model-access-through-protocol-adapters.md), [ADR 0044](adr/0044-stateless-openai-responses.md) and ADR 0048 (connections serve many APIs).

## Connections, families and APIs

A connection (`model-endpoint`) is one address and one credential, plus, for descriptors that sign requests, named keys and non-secret settings (see [operations.md](api/operations.md)). It offers one or more API families, each at a base: a path under `baseURL`, or a full URL of its own. One Azure AI Foundry resource is therefore one connection, even when it serves OpenAI models under `/openai/v1` and Claude under `/anthropic`:

```yaml
endpoints:
  foundry:
    baseURL: https://my-resource.services.ai.azure.com
    auth: { kind: api-key, secret: secret://platform/foundry-key }
    families:
      openai: /openai/v1
      anthropic: /anthropic
    discovery:
      - source: azure-deployments
        idPrefix: foundry-openai
        exclude: ['claude-*']
        apis: { chat: openai/chat-completions@1 }
      - source: azure-deployments
        idPrefix: foundry-claude
        include: ['claude-*']
        apis: { chat: anthropic/messages@1 }
```

A discovery rule names its `source`. `azure-deployments` reads the deployment list of an Azure resource, from the root of `baseURL`. `openai-models` reads `GET {openai family base}/models`, for any other connection that speaks the OpenAI API, such as the AI gateway; the connection must offer the `openai` family. The source sends the connection's own credential: a bearer token or an api-key without a header as `Authorization: Bearer`, an api-key with a header in that header. `include` and `exclude` match the listed id as the provider writes it:

```yaml
endpoints:
  ai-gateway:
    baseURL: https://api.aivar.no/v1
    auth: { kind: bearer, secret: secret://platform/ai-gateway-key }
    families: { openai: '' }
    discovery:
      - source: openai-models
        include: ['aivar:*', 'sigma2:*']
        apis: { chat: openai/chat-completions@1 }
```

A discovered model gets the id `<idPrefix>/<deployment>` with the deployment slugged as the console does when a model is added by hand: lower case, characters other than letters, digits, `_`, `.` and `-` replaced by `-`, and leading and trailing separators removed. `aivar:borealis` becomes `ai-gateway/aivar-borealis`, and `meta-llama/Llama-3.1-8B` becomes `ai-gateway/meta-llama-llama-3.1-8b`. A deployment that is already a model on the connection is not listed again. A discovered model is a candidate until an operator confirms it, and the OpenAI list says nothing of residency or family, so the operator sets them then. Capabilities a `/models` entry names (`capabilities`, `supported_parameters`, or `supports_*` flags, also under `model_info`) are taken as learned, and genki checks the rest with a few small calls (ADR 0021). A listing that fails is reported for its connection in the refresh result.

### How discovered models are kept

The last good listing of each connection is stored in the platform database (`discovered_models`, one row per connection and discovery source), and every API replica and the worker serve the models built from it with the connection's current rules. A listing that succeeds is merged into the row: each model it names gets `lastSeenAt` set to now, and a model it leaves out is kept until it has been missing for the grace period, 24 hours by default (`MODEL_DISCOVERY_GRACE_HOURS`). A listing that fails changes no model; it records only the kind of failure (`unauthorized`, `not-found`, `rate-limited`, `provider-error`, `timeout`, `unreachable`, `misconfigured` or `error`) and when. A replica that cannot list at startup serves the stored set, not only the catalogue's own models. The row remembers the address it listed: a connection moved to another address serves none of the old address's models and starts a new listing. A listing that cannot be stored is still served by the replica that made it, and its refresh reports `the listing was not stored`.

One replica lists again every 30 minutes by default (`MODEL_RELIST_MINUTES`): each API replica tries four times an interval, jittered, to claim the interval in `model_discovery_claims`, and only the one that claims it lists; a replica that cannot reach the claim lists anyway. A replica that starts within an interval of the last claimed re-list loads the stored set and does not list; an operator's refresh takes no claim. Every write to `discovered_models` announces `model-classifications` on the change feed, and the other replicas then load the stored set without listing anything. An operator's refresh (`POST /operator/models/refresh`) still lists every connection at once, on the replica that takes it, and answers with `discovered` and `failed` as before.

A listing follows every page: `has_more` with `last_id` (or the last entry's `id`) as `?after=`, or a `next` or `nextLink` link. A next page on another origin, a redirect, more than 100 pages, or a page seen twice fails the listing, so the connection's credential goes only to the connection's own origin. `/health` reports per connection under `modelDiscovery.connections`: how many models it serves (`discovered`), how many deployments the stored listing holds (`listed`), when a listing last succeeded (`listedAt`) and the kind and time of the last failure (`lastError`), never a URL, a key or the provider's error text.

An API has the id `<provider>/<api>@<version>`, a kind (`chat`, `decide`, `embed` and so on) and a family. `GET /operator/apis` lists every API Genki can bind: built-in implementations and operation descriptors, under one id each. The built-in APIs are:

| API                         | Kind     | Family      | Notes                                                  |
| --------------------------- | -------- | ----------- | ------------------------------------------------------ |
| `openai/chat-completions@1` | `chat`   | `openai`    | Default for the family; learns Responses when it must. |
| `openai/responses@1`        | `chat`   | `openai`    | Always Responses.                                      |
| `openai/decide@1`           | `decide` | `openai`    | Structured decisions.                                  |
| `anthropic/messages@1`      | `chat`   | `anthropic` | Default for the family; option `defaultMaxTokens`.     |
| `openai/embeddings@1`       | `embed`  | `openai`    | Embeddings; was `openai/embed@1`, still read.          |

A model binds one API per kind with `apis`. A binding is valid when the API exists, is of that kind, and is in a family the model's connection offers; a `chat` binding also needs an API with a built-in implementation. A model without `apis` on a connection with one family binds that family's default chat API. A discovery rule binds the APIs of the models it finds, and `idPrefix` sets the first part of their ids, so ids stay the same when two connections become one.

The bundled descriptor `compatible/rerank@1` (kind `rerank`, family `openai`) sends `POST {base}/rerank` with `model`, `query` and `documents`, and reads `results[].index` and `results[].relevance_score`, the shape Cohere, Jina, vLLM and LiteLLM share.

### What kind a discovered model is

Each discovered model gets a kind, from the first of these that says one:

1. The listing: a `kind` or `mode` on the `/models` entry (also `model_info.mode`, or a `type` genki knows), then the paths in `endpoints`. `chat`, `completion` and `responses` are `chat`, `embedding` is `embed`, `rerank` is `rerank`, `image_generation` is `generate-image`, `audio_transcription` is `transcribe` and `audio_speech` is `generate-speech`; any other mode is kept as the kind, such as `evaluation`. A path ending in `/chat/completions` or `/responses` is `chat`, `/embeddings` is `embed` and `/rerank` is `rerank`; other paths make the kind `unknown`.
2. The rule: `models: { <deployment>: { kind: rerank } }` wins over the listing.
3. The name: a part such as `image`, `dall`, `sora`, `realtime`, `live`, `transcribe`, `whisper`, `tts`, `embedding`, `rerank`, `reranker` or `moderation` gives the kind; a name with none of them is `chat`.

A `chat` model binds the rule's `apis` and its capabilities. A model of another kind binds the rule's API for that kind (`apis: { rerank: compatible/rerank@1 }`), else the kind's default API, else the one API of that kind in the connection's families, and gets no capabilities. With none it binds nothing: it is listed with its kind and listed endpoints, offered for nothing, and needs an operator to bind an API or add a reviewed descriptor. It is never offered for chat. An operator binds a model by hand with `PATCH /operator/models/{id}`, and that binding wins over the next listing.

A rule's `residency` is where the models it finds process data, `global` when left out. An operator's residency on one model still wins.

```yaml
discovery:
  - source: openai-models
    include: ['sigma2:*']
    apis: { chat: openai/chat-completions@1 }
    residency: norway
    models:
      sigma2:qwen-embedding: { embed: { dimensions: 1024 } }
      sigma2:clef-flash: { kind: decide }
```

## Embedding and rerank models

Embedders and rerankers are models in the same catalogue, with a binding for `embed` or `rerank` and the kind's settings under the kind. They are changed like any model, without a deploy, and are not offered as chat models. The one rerank API is the bundled descriptor `compatible/rerank@1` (above), and a service that names no reranker runs with rerank off.

```yaml
models:
  - id: foundry/text-embedding-3-small
    endpoint: foundry
    deployment: text-embedding-3-small
    residency: eu
    apis: { embed: openai/embeddings@1 }
    embed: { dimensions: 1536, maxBatch: 64 }
```

An embedding model must name `embed.dimensions`. A discovered embedding model is served by the embedding port once its rule names its dimensions under `models.<deployment>.embed`, and a discovered reranker as soon as it binds an API; both can then be named by id like any other. A rerank engine without an API would stay in the rerank catalogue, and a model with the same id wins over it; with no such engine in genki, a rerank plug-in cannot be registered yet.

## Prices

A price is per model and kind, in kroner per unit. The units are `input-token`, `output-token`, `cached-input-token`, `audio-second`, `image`, `video-second`, `character` and `request`, and `GET /operator/apis` lists the units each API reports.

```yaml
foundry-openai/gpt-6-luna:
  chat: { input-token: 0.00003, output-token: 0.00012 }
  decide: { input-token: 0.00003, output-token: 0.00012 }
foundry/text-embedding-3-small:
  embed: { input-token: 0.0000002 }
```

A call that reports a unit without a price is metered and left unpriced. A `request` without a price costs nothing, and a `cached-input-token` without a price costs as an input token. A cost the provider reports is kept. A price per 1,000 tokens (`inputPerThousand`, `outputPerThousand`) is still accepted and holds for every kind the model binds; stored ones move to unit prices once at start, and `GET /models` still shows the per-1,000 view as `price`.

## Processor records on typed calls

Typed chat and decide calls carry the connection's processor record to the gate, as descriptor calls do. `GENAI_PROCESSOR_RECORDS` decides what happens on a connection without one: `warn` (the default) logs `model call on a connection without a processor record` once per connection and lets the call through, and `enforce` refuses real data. At start the platform logs `model connections without a processor record` with their ids, and `GET /operator/processor-records` answers `typedCalls` with the setting. Synthetic data in the raw tier needs no record.

## OpenAI-compatible APIs

`openai/chat-completions@1` and `openai/responses@1` run on the same base, including Azure AI Foundry's `/openai/v1`. Credentials, SDK retries, timeouts and cancellation apply to both.

Model `options` are validated strictly against the options the bound APIs declare:

| Option       | Values                                | Behavior                                                                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokenParam` | `max_completion_tokens`, `max_tokens` | Defaults to `max_completion_tokens`; applies only to Chat Completions. Responses uses `max_output_tokens`. A deployment that refuses the configured one by name (HTTP 400 or 422) is retried once with the other, which is remembered for that deployment for the lifetime of its connection. |

For a known Responses deployment, bind the API:

```yaml
models:
  - id: foundry-openai/gpt-5.6-sol
    endpoint: foundry
    deployment: gpt-5.6-sol
    residency: global
    capabilities: [stream, tools, json-schema, reasoning]
    apis: { chat: openai/responses@1 }
```

Foundry discovery lists deployments and binds each model the APIs its rule names. A discovered model therefore needs no hand configuration to recover from HTTP 400 with the exact message `Function tools with reasoning_effort are not supported for <deployment> in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.` When a request contains tools, `openai/chat-completions@1` retries through Responses and remembers that deployment for the lifetime of its connection. Refresh preserves the choice; catalog reload or process restart resets it. Other errors retain their usual handling. Binding `openai/responses@1` uses Responses from the start.

## Moving from one connection per protocol

Before ADR 0048 a connection named one `protocol` and a model listed `operations` and `options.api`. At start the platform rewrites stored entries once, and only when there is something to rewrite:

- connections on the same resource root with the same credential become one connection with one family per former protocol (`foundry-openai` and `foundry-claude` become `foundry`), and each former discovery rule keeps its ids through `idPrefix`;
- models keep their ids, move to the new connection and get `apis` from their former protocol, `operations` and `options.api`;
- processor records and model classifications follow;
- the embedding catalogue's endpoints merge into the connection on the same resource (`foundry-embeddings` into `foundry`) and its models become embedding models with the same ids;
- a reranker whose engine has an API becomes a model with the same id;
- a binding to `openai/embed@1` becomes `openai/embeddings@1`;
- a seed connection whose rules name a former id with `idPrefix` takes over its models and processor records.

Every rewrite is a config entry by `genki` with the reason `ADR 0048: ...`, so it shows in the audit history. A catalog file in the old shape is read in the new one.

`ModelRouter.describe()` and the operator model listing expose `transport: { api, source }`, where `source` is `default`, `configured` or `learned`. A temperature refusal causes one retry without temperature and is remembered separately for each deployment and API. The existing rejected-parameter reporting still applies.

## Responses mapping

The adapter uses `client.responses.create` and always sends full history in `input`, with `store: false` and no `previous_response_id`. System messages become developer messages in place. Assistant text and `function_call` items precede tool `function_call_output` items; `call_id` is the port tool-call ID. Function definitions use `type: function`, `name`, `description` and `parameters`. They set `strict: false` to preserve existing tool schemas without requiring strict-schema normalization.

`reasoning` maps to `reasoning.effort`, `maxTokens` to `max_output_tokens`, and `jsonSchema` to `text.format: { type: json_schema, name, schema, strict: true }`. Temperature is sent unless omitted or learned unsupported. `include: [reasoning.encrypted_content]` requests opaque reasoning state. Encrypted reasoning and assistant message phases travel through the port's existing opaque `continuation`. Subsequent turns replay the reasoning, assistant messages and function calls in their original output order, preserving `commentary` and `final_answer` phases. Older continuations containing only reasoning remain supported.

Output text becomes `content`; function calls become port tool calls using `call_id`. Completed tool responses finish with `tool_calls`, plain text with `stop`, `max_output_tokens` truncation with `length`, and filtering or refusal with `content_filter`. Usage maps `input_tokens`, `output_tokens` and `input_tokens_details.cached_tokens` directly, with one metered request and the response's served model. Cached tokens are already included in input tokens.

Streaming emits `response.output_text.delta` as text chunks. Tool items and argument deltas are assembled by output index; done events replace partial values. Terminal completed or incomplete events supply final usage and status. Failed, error or truncated streams fail without a successful done chunk. Tool and reasoning events stay internal because the port exposes only text deltas and a final result.

The provider runs the same port contract suite for both APIs, plus fake HTTP tests for the mappings and learned recovery. Wire details follow the [official Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses) and [streaming event reference](https://developers.openai.com/api/reference/resources/responses/streaming-events).
