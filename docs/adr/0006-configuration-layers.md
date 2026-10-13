# 0006 Configuration layers and resolution

Status: accepted, 2026-10-12 (built). Proposed 2026-10-06

## Decision

Every setting is defined once, with a schema, a default, a category, a sensitivity, a description and the layers where it may be set (`settableAt`). Settings belong to one of two axes:

- **Dataset settings** (source, chunking, embedding, collection naming) are set only by the dataset's owner. A tenant that uses a shared dataset can never override them, and the owner's settings never override the consuming tenant's service.
- **Service settings** resolve along the consumer path: platform default, then tenant, then service version, then call. The later layer wins.

Rules:

- Platform locks and policy rules are ceilings that no lower layer can pass. A locked setting shows why it is locked.
- Call-level overrides are allowed only for settings on both the credential's list and the service's allowlist for that entry point (`spec.callOverrides.mcp`, `openai`, `rest`, `a2a`). An entry point the service does not list is limited by the credential alone. The conversation routes take no overrides. The old aliases `retrieve-top-k` and `retrieve-auto-filter` pass the same lists as the settings they stand for.
- Lists replace, objects merge.
- Resolution returns the value with its provenance: the winning layer, what it overrode, and any pinned version.
- A tenant may pin a platform default to a version. Pins are visible to operators when a default changes.
- A test fails if a defined setting is never read, or is read only on some entry points.

## Why

"Rightmost layer wins" would let the owner of a shared dataset like Kudos override every consuming tenant's service. headless-rag's 43 `skills.*` settings were honoured on some entry points and not others.

## Consequences

- The settings screen and operator diagnostics use the same resolution and the same layer names.
- Changing a live service's setting creates a new service version. Only tenant-level and platform-level settings change without one, with a preview of affected services.
