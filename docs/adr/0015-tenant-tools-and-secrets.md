# 0015 Tenant-provided tools and secrets

Status: accepted, 2026-10-12 (built). Proposed 2026-10-06

## Decision

- Agencies extend the platform with their own MCP or OpenAPI servers, never with code inside the platform.
- Each tool connection is registered by a tenant admin with its domain. Calls go through an isolated egress path with an allowlist per tenant, no access to the platform's network, and limits on response size and time.
- A tool call carries a credential for that tenant's connection. It never carries the user's inbound token or any platform credential.
- Tool results are marked as untrusted content. Guardrails and the strategy treat them like retrieved documents, not like instructions.
- Tool descriptions are pinned at registration. A changed description must be approved again before it is used.
- Secrets are written through a write-only API into a tenant namespace, referenced as `secret://tenant/<orgnr>/<name>`. The resolver refuses a reference to another tenant's secret.

## Why

"Out of process" is not a sandbox. Without these rules a tenant's tool could reach the platform's network, exfiltrate another dataset through its arguments, or inject instructions through its results.

## Consequences

- Adding a tool is a registration with review, not a free-form URL in a definition.
- The builder assistant can only suggest tools that are already registered.
