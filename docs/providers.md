# Model providers

Strategies use `ModelPort.chat` and `chatStream`; the router handles credentials, capabilities, residency, token ceilings and metering. Model endpoints and deployments belong in the model catalog. See [ADR 0021](adr/0021-model-access-through-protocol-adapters.md) and [ADR 0039](adr/0039-stateless-openai-responses.md).

## OpenAI-compatible endpoints

The `openai-chat` endpoint protocol supports Chat Completions and Responses on the same base URL, including Azure AI Foundry's `/openai/v1` endpoint. Credentials, SDK retries, timeouts and cancellation apply to both paths.

Model `options` are validated strictly:

| Option       | Values                                | Behavior                                                                                                                           |
| ------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `api`        | `chat-completions`, `responses`       | Omit to start with Chat Completions and learn Responses from the specific tools/reasoning refusal. An explicit value pins the API. |
| `tokenParam` | `max_completion_tokens`, `max_tokens` | Defaults to `max_completion_tokens`; applies only to Chat Completions. Responses always uses `max_output_tokens`.                  |

For a known Responses deployment, add a model entry such as:

```yaml
models:
  - id: foundry-openai/gpt-6.1-sol
    endpoint: foundry-openai
    deployment: gpt-6.1-sol
    residency: global
    capabilities: [stream, tools, json-schema, reasoning]
    options:
      api: responses
```

Foundry discovery lists deployments and gives each model default options. A discovered model therefore needs no hand configuration to recover from HTTP 400 with the exact message `Function tools with reasoning_effort are not supported for <deployment> in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.` When a request contains tools, the adapter retries through Responses and remembers that deployment for the lifetime of its endpoint connection. Refresh preserves the choice; catalog reload or process restart resets it. Other errors retain their usual handling. Explicit `api: chat-completions` disables the switch.

`ModelRouter.describe()` and the operator model listing expose `transport: { api, source }`, where `source` is `default`, `configured` or `learned`. A temperature refusal causes one retry without temperature and is remembered separately for each deployment and API. The existing rejected-parameter reporting still applies.

## Responses mapping

The adapter uses `client.responses.create` and always sends full history in `input`, with `store: false` and no `previous_response_id`. System messages become developer messages in place. Assistant text and `function_call` items precede tool `function_call_output` items; `call_id` is the port tool-call ID. Function definitions use `type: function`, `name`, `description` and `parameters`. They set `strict: false` to preserve existing tool schemas without requiring strict-schema normalization.

`reasoning` maps to `reasoning.effort`, `maxTokens` to `max_output_tokens`, and `jsonSchema` to `text.format: { type: json_schema, name, schema, strict: true }`. Temperature is sent unless omitted or learned unsupported. `include: [reasoning.encrypted_content]` requests opaque reasoning state. Completed encrypted reasoning travels through the port's existing `continuation` and is replayed before the assistant text and calls on subsequent turns.

Output text becomes `content`; function calls become port tool calls using `call_id`. Completed tool responses finish with `tool_calls`, plain text with `stop`, `max_output_tokens` truncation with `length`, and filtering or refusal with `content_filter`. Usage maps `input_tokens`, `output_tokens` and `input_tokens_details.cached_tokens` directly, with one metered request and the response's served model. Cached tokens are already included in input tokens.

Streaming emits `response.output_text.delta` as text chunks. Tool items and argument deltas are assembled by output index; done events replace partial values. Terminal completed or incomplete events supply final usage and status. Failed, error or truncated streams fail without a successful done chunk. Tool and reasoning events stay internal because the port exposes only text deltas and a final result.

The provider runs the same port contract suite for both APIs, plus fake HTTP tests for the mappings and learned recovery. Wire details follow the [official Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses) and [streaming event reference](https://developers.openai.com/api/reference/resources/responses/streaming-events).
