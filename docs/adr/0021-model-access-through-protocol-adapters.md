# 0021 Model access through protocol adapters

Status: accepted, 2026-10-12 (built; Responses API behind `openai-chat`, ADR 0044, 2026-11-03; adapters per protocol and the endpoint protocol superseded by [ADR 0048](0048-connections-serve-many-apis.md), 2026-11-05; discovered models' capabilities checked by genki, 2026-11-20; stored listings, grace period and scheduled re-list, 2026-11-21). Proposed 2026-10-06

## Decision

Strategies call models through one port (`chat`, `chatStream`). Behind it, three things are kept apart because they change at different rates:

- **The port** changes rarely and is versioned. A breaking change becomes a new port version that runs beside the old one.
- **Adapters, one per wire protocol, not per vendor.** Today: `openai-chat` and `anthropic-messages`. An adapter only translates between the port and one protocol family (`openai-chat` speaks Chat Completions and Responses, chosen by `api`, ADR 0044), and declares schemas for its own endpoint and model options.
- **The model catalog is configuration.** Each endpoint names a protocol, a base URL and how to authenticate (`api-key`, `bearer` or a named `token-provider` such as Entra ID). Each model names an endpoint, a deployment, a residency and its capabilities (`stream`, `tools`, `json-schema`, `reasoning`).

Models are discovered, not configured. The environment holds only endpoints and keys. An endpoint declares where its models are listed (for Azure AI Foundry, the resource's deployment list) and which deployments to include, and the router finds them on refresh and on a schedule. The last good listing of each connection is stored, every replica serves the stored set, one replica lists again per interval, and a model a listing leaves out is kept for a grace period ([providers.md](../providers.md#how-discovered-models-are-kept)). A discovered model starts with residency `global`, because the listing does not say where a deployment runs, and an operator reclassifies it, sets its capabilities or turns it off in the console. A service picks its model from a dropdown filtered by its residency and by what its strategy needs, and the choice is stored in the versioned service definition.

genki finds out itself what a discovered model can do beyond what its discovery rule names. It first takes what the connection's model listing says, then checks `json-schema`, `tools` and `stream` with one small synthetic call each (and one plain call when the provider refuses a check, to tell a missing capability from a broken model), through the model gate, after the first discovery at startup and on `POST /operator/models/refresh`. Every replica runs its own startup round. Reasoning is taken only from the listing, since no answer shows it. Each result is stored as learned, with when and how it was found, beside the operator's classification; capabilities an operator sets win over learned ones. A refresh spends at most 12 calls, free models first, and logs and audits their usage; a missing capability is checked again after 7 days, a passed one never, and a check that settles nothing (the model is down, the answer was cut off, the tool was not called) records nothing. A capability that passed once is never taken away by a later check. A strategy still refuses a model that lacks what it needs, and the publish check names what genki checked and on which day.

A router owns everything that is the same for every adapter: catalog lookup, residency, capability checks, credentials and metering. Secrets appear only as `secret://` references and are resolved per request. SDKs never read credentials from the environment.

The request carries generic options (`maxTokens`, `reasoning`, `jsonSchema`) that each adapter maps to its own API. State a provider needs back on the next turn, such as signed reasoning, travels as an opaque `continuation` the strategy passes back unchanged.

Publishing a service checks that its models are in the catalog, run within the service's residency, and can call tools if the service uses tools.

## Why

New API specifications and new providers will keep arriving. A new provider that speaks an existing protocol should be configuration only, and a new protocol should be one package. Residency is chosen per service: some services must stay in Norway, others may use models that run globally.

## Consequences

- Claude on Azure AI Foundry is available today with residency `global`, so only services that allow global residency can use it.
- A gateway such as LiteLLM can be added later as one more `openai-chat` endpoint. It is not required.
- Image and document input to models needs a port extension when the first service needs it.
