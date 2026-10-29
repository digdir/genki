# 0015 Tenant-provided tools and secrets

Status: accepted, 2026-10-12 (built; secrets bound to hosts, 2026-10-16). Proposed 2026-10-06

## Decision

- Agencies extend the platform with their own MCP or OpenAPI servers, never with code inside the platform.
- Each tool connection is registered by a tenant admin with its domain. Calls go through an isolated egress path with an allowlist per tenant, no access to the platform's network, and limits on response size and time.
- A tool call carries a credential for that tenant's connection. It never carries the user's inbound token or any platform credential.
- Tool results are marked as untrusted content. Guardrails and the strategy treat them like retrieved documents, not like instructions. The agent loop gives untrusted tool results and the chunks it reads to the model inside `<untrusted_data>` framing.
- Tool descriptions are pinned at registration. A changed description must be approved again before it is used.
- Secrets are written through a write-only API into a tenant namespace, referenced as `secret://tenant/<orgnr>/<name>`. The resolver refuses a reference to another tenant's secret.
- A tenant secret is used only for the hosts it is set for. Each secret stores `allowedHosts`, a list of origins (scheme, host and port), in `tenant_secrets.allowed_hosts`. A new secret needs them. Changing them needs `manage-services` (`PUT /tenants/{tenant}/secrets/{name}/hosts`, action `platform.secrets.hosts`); `register-building-blocks` may set a new secret or replace a value, not move one to other hosts.
- The check sits where a connection resolves its secret for an outbound request (`TenantSecrets.resolveFor` in `providers-mcp-client`). It covers MCP, A2A, OpenAPI and remote agents, and for OAuth client credentials both the token address and the call address. A secret without hosts is sent nowhere. Redirects to another origin are never followed, so the secret does not travel with one.
- Registration refuses a connection whose endpoint, document address or token address is outside the secret's hosts, before any contract test sends a request.
- Tenant catalog endpoints (model, embedding, rerank and knowledge) check the same hosts against their `baseURL` when they resolve a tenant secret (`credentialFor` in the kernel). Cached OAuth access tokens are keyed by connection, endpoint, token address and secret, so a token is only reused for the connection it was issued to.
- A database pipeline may name the secret its connector created. Naming any other tenant secret as the database password needs `manage-services` as well as `manage-datasets`.

## Why

"Out of process" is not a sandbox. Without these rules a tenant's tool could reach the platform's network, exfiltrate another dataset through its arguments, or inject instructions through its results.

## Consequences

- Adding a tool is a registration with review, not a free-form URL in a definition.
- The builder assistant can only suggest tools that are already registered.
- Secrets that existed before 2026-10-16 were bound once, by migration, to the origins of the tool connections, service definitions and tenant catalog endpoints that already used them, so those keep working. Review the bound hosts after the migration, since an origin already in use was kept as it was. Secrets no one used get no hosts until someone with `manage-services` sets them.
- Not covered by the host binding: database passwords (sent to a database, not over HTTP; guarded by the right rule above) and operator plug-in endpoints, which use platform secrets.
