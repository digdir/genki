# Model providers

Strategies use `ModelPort.chat` and `chatStream`; the router handles credentials, capabilities, residency, token ceilings and metering. Connections and models belong in the model catalog. See [ADR 0021](adr/0021-model-access-through-protocol-adapters.md), [ADR 0044](adr/0044-stateless-openai-responses.md) and ADR 0048 (connections serve many APIs).

## Connections, families and APIs

A connection (`model-endpoint`) is one address and one credential. It offers one or more API families, each at a base: a path under `baseURL`, or a full URL of its own. One Azure AI Foundry resource is therefore one connection, even when it serves OpenAI models under `/openai/v1` and Claude under `/anthropic`:

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

An API has the id `<provider>/<api>@<version>`, a kind (`chat`, `decide`, `embed` and so on) and a family. `GET /operator/apis` lists every API Genki can bind: built-in implementations and operation descriptors, under one id each. The built-in APIs are:

| API                         | Kind     | Family      | Notes                                                  |
| --------------------------- | -------- | ----------- | ------------------------------------------------------ |
| `openai/chat-completions@1` | `chat`   | `openai`    | Default for the family; learns Responses when it must. |
| `openai/responses@1`        | `chat`   | `openai`    | Always Responses.                                      |
| `openai/decide@1`           | `decide` | `openai`    | Structured decisions.                                  |
| `anthropic/messages@1`      | `chat`   | `anthropic` | Default for the family; option `defaultMaxTokens`.     |

A model binds one API per kind with `apis`. A binding is valid when the API exists, is of that kind, and is in a family the model's connection offers. A model without `apis` on a connection with one family binds that family's default chat API. A discovery rule binds the APIs of the models it finds, and `idPrefix` sets the first part of their ids, so ids stay the same when two connections become one.

## OpenAI-compatible APIs

`openai/chat-completions@1` and `openai/responses@1` run on the same base, including Azure AI Foundry's `/openai/v1`. Credentials, SDK retries, timeouts and cancellation apply to both.

Model `options` are validated strictly against the options the bound APIs declare:

| Option       | Values                                | Behavior                                                                                                   |
| ------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `tokenParam` | `max_completion_tokens`, `max_tokens` | Defaults to `max_completion_tokens`; applies only to Chat Completions. Responses uses `max_output_tokens`. |

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
- a seed connection whose rules name a former id with `idPrefix` takes over its models and processor records.

Every rewrite is a config entry by `genki` with the reason `ADR 0048: ...`, so it shows in the audit history. A catalog file in the old shape is read in the new one.

`ModelRouter.describe()` and the operator model listing expose `transport: { api, source }`, where `source` is `default`, `configured` or `learned`. A temperature refusal causes one retry without temperature and is remembered separately for each deployment and API. The existing rejected-parameter reporting still applies.

## Responses mapping

The adapter uses `client.responses.create` and always sends full history in `input`, with `store: false` and no `previous_response_id`. System messages become developer messages in place. Assistant text and `function_call` items precede tool `function_call_output` items; `call_id` is the port tool-call ID. Function definitions use `type: function`, `name`, `description` and `parameters`. They set `strict: false` to preserve existing tool schemas without requiring strict-schema normalization.

`reasoning` maps to `reasoning.effort`, `maxTokens` to `max_output_tokens`, and `jsonSchema` to `text.format: { type: json_schema, name, schema, strict: true }`. Temperature is sent unless omitted or learned unsupported. `include: [reasoning.encrypted_content]` requests opaque reasoning state. Encrypted reasoning and assistant message phases travel through the port's existing opaque `continuation`. Subsequent turns replay the reasoning, assistant messages and function calls in their original output order, preserving `commentary` and `final_answer` phases. Older continuations containing only reasoning remain supported.

Output text becomes `content`; function calls become port tool calls using `call_id`. Completed tool responses finish with `tool_calls`, plain text with `stop`, `max_output_tokens` truncation with `length`, and filtering or refusal with `content_filter`. Usage maps `input_tokens`, `output_tokens` and `input_tokens_details.cached_tokens` directly, with one metered request and the response's served model. Cached tokens are already included in input tokens.

Streaming emits `response.output_text.delta` as text chunks. Tool items and argument deltas are assembled by output index; done events replace partial values. Terminal completed or incomplete events supply final usage and status. Failed, error or truncated streams fail without a successful done chunk. Tool and reasoning events stay internal because the port exposes only text deltas and a final result.

The provider runs the same port contract suite for both APIs, plus fake HTTP tests for the mappings and learned recovery. Wire details follow the [official Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses) and [streaming event reference](https://developers.openai.com/api/reference/resources/responses/streaming-events).
