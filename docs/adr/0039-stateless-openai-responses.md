# 0039 Stateless OpenAI Responses behind the model port

Status: accepted, 2026-10-23 (built; live Foundry verification pending)

## Decision

Keep the existing `openai-chat` endpoint registration and select its wire API with per-model `options.api`. `responses` explicitly selects `/v1/responses`; `chat-completions` pins the old path. Omitting the option starts on Chat Completions and permits a learned switch only on the exact HTTP 400 tools/reasoning incompatibility that directs callers to Responses. The failed request is retried with the same history, tools and reasoning effort. The choice is scoped to one deployment on one endpoint connection and survives discovery refresh, but is reset on connection rebuild or restart.

This extends ADR 0021's one-protocol registration with a compatibility path inside the OpenAI provider package. A separate endpoint protocol would require manual routing or duplicate discovery for deployments that only disclose the restriction when called. We retain one discovered catalog ID and one set of credentials, limits and classification rules.

Responses is stateless: send full input history with `store: false`, never `previous_response_id`. Preserve encrypted reasoning through the existing opaque continuation field so tool results can be followed by another reasoning turn without server-side storage. Function calls and outputs correlate by `call_id`. Keep the generic model request and result contract unchanged.

Add an optional, vendor-neutral `ModelConnection.describe(model)` hook returning the selected transport API and whether selection was default, configured or learned. The router exposes it as optional `ModelDescription.transport`. This makes runtime routing visible without putting vendor logic into the port or persisting learned transport state in operator classifications.

## Why

Foundry's discovered `gpt-6.1-sol` rejects function tools with reasoning on Chat Completions and also rejects the suggested reasoning effort `none`. Responses supports the needed request while preserving the requested reasoning effort. Guessing from a model name would couple discovery to vendor naming; the precise refusal provides evidence for that deployment.

## Consequences

- Existing Chat Completions models and explicit token-parameter choices retain their wire behavior.
- Explicit API selection is deterministic. Learned recovery adds one failed upstream request on first use and is remembered only within the connection.
- Temperature refusals are learned independently for each API and deployment; successful calls retain the existing parameter reporting and single metering behavior.
- Only the provider depends on the vendor SDK. The port gains optional transport inspection; strategies keep their current history and continuation handling.
- Fake HTTP rules and the model port contract cover both APIs. The orchestrator verifies the deployment live before release.

See [provider and catalog option documentation](../providers.md) for the full mapping and configuration.
