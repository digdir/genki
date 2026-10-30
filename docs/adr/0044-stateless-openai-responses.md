# 0044 Stateless OpenAI Responses behind the model port

Status: accepted, 2026-10-29 (built). Proposed 2026-10-23

## Decision

- **One registration, two wire APIs.** The `openai-chat` endpoint registration stays as it is, and a per-model `options.api` selects the API: `responses` uses `/v1/responses`, `chat-completions` pins the existing path.
- **A learned switch on one refusal only.** Without `options.api`, a deployment starts on Chat Completions. Only the exact HTTP 400 that says function tools with reasoning need `/v1/responses` switches it, and the failed request is sent again through Responses with the same history, tools and reasoning effort. The switch holds for one deployment on one endpoint connection, survives discovery refresh, and is forgotten when the connection is rebuilt or the process restarts.
- **Stateless.** Every request sends the full history with `store: false` and never `previous_response_id`, so the platform owns the conversation. Function calls and their outputs correlate by `call_id`. The model request and result contract of the port is unchanged.
- **Reasoning stays in the run.** The provider asks for encrypted reasoning (`include: ['reasoning.encrypted_content']`) and carries it in the existing opaque `continuation` of the assistant message, so a tool result can be followed by another reasoning turn. It lives only in the run's messages and is not written to the task's events or the database.
- **The choice is visible.** An optional, vendor-neutral `ModelConnection.describe(model)` returns the API in use and whether it was the default, configured or learned. The router exposes it as `ModelDescription.transport`, shown in the operator's model listing and OpenAPI. Learned state is not stored in operator classifications.

This extends ADR 0021's one registration per protocol with a compatibility path inside the OpenAI provider package.

## Why

Some discovered Foundry reasoning deployments, such as `gpt-5.6-sol`, reject function tools with reasoning on Chat Completions and answer that the caller should use `/v1/responses` or set the reasoning effort to `none`, so every agent-loop or tool-using run on them failed. Responses accepts the request with the requested effort.

- **A separate endpoint protocol** was turned down: it would need manual routing or a second discovery for deployments that only reveal the restriction when called, and a second set of credentials, limits and classifications.
- **Guessing from the model name** was turned down: it would tie discovery to vendor naming, while the exact refusal is evidence about that deployment.

## Consequences

- Chat Completions models and explicit token-parameter choices keep their wire behaviour.
- An explicit `options.api` is deterministic. A learned switch costs one failed upstream request per deployment on first use after each start.
- Temperature refusals are learned separately for each API and deployment. Successful calls keep the existing parameter reporting and are metered once.
- Only the provider package depends on the vendor SDK. The port gains the optional transport description, and strategies keep their history and continuation handling.
- Fake HTTP tests and the model port contract suite cover both APIs. See [providers.md](../providers.md) for the full mapping and configuration.
