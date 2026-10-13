# 0021 Model access through protocol adapters

Status: accepted, 2026-10-12 (built). Proposed 2026-10-06

## Decision

Strategies call models through one port (`chat`, `chatStream`). Behind it, three things are kept apart because they change at different rates:

- **The port** changes rarely and is versioned. A breaking change becomes a new port version that runs beside the old one.
- **Adapters, one per wire protocol, not per vendor.** Today: `openai-chat` and `anthropic-messages`. An adapter only translates between the port and one API, and declares schemas for its own endpoint and model options.
- **The model catalog is configuration.** Each endpoint names a protocol, a base URL and how to authenticate (`api-key`, `bearer` or a named `token-provider` such as Entra ID). Each model names an endpoint, a deployment, a residency and its capabilities (`stream`, `tools`, `json-schema`, `reasoning`).

Models are discovered, not configured. The environment holds only endpoints and keys. An endpoint declares where its models are listed (for Azure AI Foundry, the resource's deployment list) and which deployments to include, and the router finds them at startup and on refresh. A discovered model starts with residency `global`, because the listing does not say where a deployment runs, and an operator reclassifies it, sets its capabilities or turns it off in the console. A service picks its model from a dropdown filtered by its residency and by what its strategy needs, and the choice is stored in the versioned service definition.

A router owns everything that is the same for every adapter: catalog lookup, residency, capability checks, credentials and metering. Secrets appear only as `secret://` references and are resolved per request. SDKs never read credentials from the environment.

The request carries generic options (`maxTokens`, `reasoning`, `jsonSchema`) that each adapter maps to its own API. State a provider needs back on the next turn, such as signed reasoning, travels as an opaque `continuation` the strategy passes back unchanged.

Publishing a service checks that its models are in the catalog, run within the service's residency, and can call tools if the service uses tools.

## Why

New API specifications and new providers will keep arriving. A new provider that speaks an existing protocol should be configuration only, and a new protocol should be one package. Residency is chosen per service: some services must stay in Norway, others may use models that run globally.

## Consequences

- Claude on Azure AI Foundry is available today with residency `global`, so only services that allow global residency can use it.
- A gateway such as LiteLLM can be added later as one more `openai-chat` endpoint. It is not required.
- Image and document input to models needs a port extension when the first service needs it.
