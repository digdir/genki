# 0004 Service, capability and version

Status: accepted, 2026-10-12 (built). Proposed 2026-10-06

## Decision

- A **service** is what a tenant defines. A **capability** is what the kernel invokes.
- A service has one or more **variants**, which replace headless-rag's modes. Each variant becomes one capability with id `<tenant>/<service>/<variant>`. A variant may have its own way of working (ADR 0031).
- A **fellestjeneste** is a service owned by Digdir and shared with other tenants. It is not a separate kind.
- A service has one version scheme: an integer that increases by one on every publish. Published versions are immutable.
- All capabilities from one service version carry that version.
- Each variant has a public name, `<service>__<variant>` unless the definition sets one, and may keep extra names as aliases.
- A caller may pin a version with the `GenAI-Version` header, or `metadata.version` on the OpenAI-compatible API. If both are sent they must agree. MCP and REST read the header; A2A takes no pin. Without a pin, the name resolves to the version published to that environment.
- Every task records the capability and service version, the strategy and its version, a hash of the resolved configuration, each model deployment it called, and each dataset it read with the index generation the engine served. An engine without generations, such as the shared read-only Typesense, records the collection names instead. [ADR 0042](0042-the-knowledge-database.md), proposed, adds the generation's data version for datasets updated in place.

## Why

The plan had services, agents, modes and capabilities with no defined mapping, and three version schemes. A task must be able to answer "which version decided this".

## Consequences

- `InvokeOptions` gets an optional version.
- The parity harness calls each side by its own names: headless-rag by its agent names, the platform by `<service>__<variant>`. Since the headless-rag aliases were removed on 2026-10-09, the harness's MCP and REST scenarios still need that per-side mapping (ADR 0017, open items).
- Rolling back means publishing an earlier version as a new one, so history stays linear.
