# 0006 Configuration layers and resolution

Status: accepted, 2026-10-12 (built; operator-only limits, 2026-11-12). Proposed 2026-10-06

## Decision

Every setting is defined once, with a schema, a default, a category, a sensitivity, a description and the layers where it may be set (`settableAt`). Settings belong to one of two axes:

- **Dataset settings** (source, chunking, embedding, collection naming) are set only by the dataset's owner. A tenant that uses a shared dataset can never override them, and the owner's settings never override the consuming tenant's service.
- **Service settings** resolve along the consumer path: platform default, then tenant, then service version, then call. The later layer wins.

The resolver supports the dataset axis, but no registered setting uses it yet: source, chunking, embedding and collection naming live in the dataset's and pipeline's own definitions, owned by the dataset's tenant.

Rules:

- Platform locks and policy rules are ceilings that no lower layer can pass. A locked setting shows why it is locked.
- Call-level overrides are allowed only for settings on both the credential's list and the service's allowlist for that entry point (`spec.callOverrides.mcp`, `openai`, `rest`, `a2a`). An entry point the service does not list is limited by the credential alone. The conversation routes take no overrides. The old aliases `retrieve-top-k` and `retrieve-auto-filter` pass the same lists as the settings they stand for.
- Lists replace, objects merge.
- Resolution returns the value with its provenance: the winning layer, what it overrode, and any pinned version.
- A tenant may pin a platform default to a version. Pins are visible to operators when a default changes.
- A setting marked `operatorOnly` is a limit that protects Digdir's cost and capacity: `usage.monthlyTokens`, `usage.tenantCallsPerMinute`, `assistant.dailyTokens` and `batch.approvalLimitNok`. At the tenant layer only an operator in a support session sets, removes or pins it, on every path: the settings and pin routes and a tenant import, dry runs included. Everyone else gets 403 `urn:genai:problem:operator-only-setting`; the tenant still reads the effective value. `SettingsRegistry` holds the rule, so a new limit gets it by setting the flag.
- A test fails if a defined setting is never read, or is read only on some entry points.

## Why

"Rightmost layer wins" would let the owner of a shared dataset like Kudos override every consuming tenant's service. headless-rag's 43 `skills.*` settings were honoured on some entry points and not others.

## Consequences

- The settings screen and operator diagnostics use the same resolution and the same layer names.
- Changing a live service's setting creates a new service version. Only tenant-level and platform-level settings change without one, with a preview of affected services.
