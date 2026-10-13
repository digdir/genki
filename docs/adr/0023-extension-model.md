# 0023 Extension model

Status: accepted, 2026-10-12 (built). Proposed 2026-10-07

Built: manifests with declared hosts and secrets, the registry, contract suites, the operator API, a contract run at operator registration that refuses the plug-in when a check fails, operator-registered model, reranker, search endpoint, tool source, agent and evaluator plug-ins feeding the live routers, catalogs and the remote-agent strategy through the change feed, per-tenant adoption of operator plug-ins before a service may use them, tenant registration of MCP, OpenAPI and A2A blocks with a contract test, webhook and built-in hooks with points before and after search and on feedback, Digdir promoting a tenant tool connection to the shared catalog, and manifest permissions enforced at registration, at publish and by the egress guard on every plug-in call.

## Decision

The platform is built to take in new things as they appear, without reworking its architecture each time. Nothing a service can do is hard-coded; what is fixed is how new capabilities are plugged in.

**Plug-in kinds.** Models, embedders, rerankers, search engines, file stores, tool sources, step blocks, hooks, agents and evaluators are each a kind with a versioned contract. A plug-in is registered through configuration and the API, with a manifest that names its kind, version, the capabilities it offers, the hosts and secrets it may use and the contract it claims to meet. A new kind is a core change (see below); a new plug-in of an existing kind is not. Operators register model, reranker, search endpoint, tool source, agent and evaluator plug-ins from outside under `/operator/plugins`; the routers and catalogs pick them up live. A remote-agent service names a registered agent by id (`config.agent`) instead of a URL, and its data location is checked against the service at publish.

Some extension points are not plug-in kinds, because the platform already takes them in another way:

- Strategies and guardrails are code. Custom logic from outside runs as a remote agent, a tool source or a hook endpoint (0028), never as code loaded into the platform. The operator API refuses these kinds and says which route to use.
- Skills use the Agent Skills format under `/tenants/{tenant}/skills`, triggers are part of a service definition (`spec.triggers`), and frontends are registered as clients under `/tenants/{tenant}/clients` with their own contract suite.
- Optimisers and channels are core: the improvement loop and the exposures (chat, REST, MCP, A2A) change through the core lane.

**Contracts are proven, not trusted.** Every kind has a shared contract test suite. A plug-in is accepted when it passes the suite for its kind, in CI for built-in ones and at registration for added ones; a registration whose suite fails is refused and nothing is stored, but the run is recorded. Capabilities are declared, and a call to something a plug-in does not support fails as `unsupported` instead of returning an empty answer.

**Open protocols are built in.** Anything that speaks them plugs in without platform work: MCP for tools and resources, OpenAI-compatible and Anthropic Messages APIs for models (0021), A2A for agents in both directions, OpenAPI for REST tools, OpenTelemetry GenAI conventions for traces, the Agent Skills format for skills, and webhooks for events. A new protocol is one adapter package.

**Hooks.** Defined points in a run (before and after search, before and after the model call, before and after a tool call, when a task completes, on publish, on feedback) accept hooks: built-in functions the platform ships, or a signed call to an endpoint the tenant or operator runs. The platform never runs hook code supplied from outside; such code runs isolated behind its own endpoint.

**Permissions are enforced.** A plug-in may reach only the hosts and read only the secrets its manifest declares. Registration refuses an endpoint, allow list or secret outside them, and the routers only see endpoints that pass that check. Contract runs and evaluators get a secret resolver that refuses undeclared secrets. Every call a model, reranker, tool source or evaluator plug-in makes goes through the egress guard with the declared hosts as the allow list; search and agent endpoints already call out through the guard, limited to their registered host. Built-in endpoints keep their direct path.

**Restrictions are policy.** Residency, personal data, quotas, approved models and tools, and Altinn rights are explicit, configurable policies at the platform and tenant layers (0006). Nothing is impossible because it was not built; it is possible and governed.

**Two lanes for change.**

- The fast lane: configuration and plug-ins. Tenants and operators add them, they are versioned, and a tenant adopts an operator plug-in in Byggeklosser (with Digdir approval where the block policy asks for it) before its services may use it, and every API instance picks them up live through the change feed. Digdir can promote a tenant tool connection to the shared catalog (`POST /operator/plugins/promotions`, audited); services in other tenants then call its tools, which still run with the publishing tenant's connection and secret.
- The core lane: new plug-in kinds, new modalities, changed contracts. These are changes to this repository, with tests and an ADR, reviewed by Digdir developers and released normally. The core is never patched at run time.

**Self-extension follows a ladder,** and the builder assistant and other agents always try the lowest rung that works:

1. Configure what exists.
2. Generate configuration, such as a declarative mapping from an unfamiliar database schema to documents and fields for a generic connector.
3. Generate a plug-in, such as an MCP server or a webhook hook, that someone deploys and runs outside the platform; it is registered as an external endpoint and reaches only what its manifest declares. The platform does not run generated code itself.
4. When none of these fits, propose a core change as a pull request.

Everything an agent produces is a proposal under 0020: it passes the kind's contract suite, the policy checks and the service's test set and gates, and a person with the right to register it approves it. Agents never register plug-ins or change the core themselves.

## Why

New models, protocols and ways of building AI services arrive faster than any roadmap. A platform that needs an architecture change for each of them falls behind; one that takes them in as plug-ins, configuration and, when needed, reviewed core changes keeps up. Public-sector use needs that flexibility to stay versioned, tested, reversible and accountable, which is what the contract suites, the two lanes and 0020 give.

## Consequences

- Vendor names never appear outside `packages/providers-*`. A boundaries rule in `npm run check` enforces it.
- Search is the first kind brought fully in line: a vendor-neutral writer port, declared capabilities, a shared contract suite, and Postgres with pgvector as the built-in engine beside Typesense.
- Plug-in manifests, the hook kind, A2A and a plug-in catalog in the portal (Byggeklosser) are built. There is no sandbox runtime for code in the platform, by decision: hooks and generated plug-ins run as isolated external endpoints under manifest permissions.
- The catalog, skills and playground screens follow the October 2026 design round.
