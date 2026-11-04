# 0008 Principal model and the API-key bridge

Status: accepted, 2026-10-12 (built; Entra logins in the locked test environment are tenant principals, ADR 0033, 2026-11-03). Proposed 2026-10-06. Amended 2026-10-12: the legacy key flag is removed.

## Decision

- Every caller becomes a `Principal` with a kind, issuer, subject and tenant. The tenant is an organisation number.
- Per issuer:
  - **Ansattporten:** subject is a pseudonymous id. The national identity number is kept only in an identity table, never in events. Tenant is the organisation the person chose, from the Altinn rights in the token.
  - **Maskinporten:** subject is the client id. Tenant is the consumer organisation; a supplier organisation is recorded separately.
  - **Systembruker:** subject is the system user id. Tenant is the customer organisation.
  - **Entra ID:** Digdir operators only, with roles. Never a tenant principal, except in the locked test environment, where a trusted Entra login through Ansattporten is an employee of `PLATFORM_TENANT` (ADR 0033). Operators are also recognised as Ansattporten employees listed in `OPERATOR_SUBJECTS` who log in through `OPERATOR_CLIENT_IDS`; ADR 0035 proposes recognising them by Entra group instead.
- Managed identities are used for platform-internal calls (Key Vault, Blob, Postgres) and are never a principal on the API.
- API keys that work like headless-rag's, so KA could switch without changing how it authenticates (same header, same SHA-256 digest):
  - Every key has a tenant. A key without a tenant is rejected.
  - Key grants are a **ceiling**: effective access is the key's grants intersected with the service's grants. An empty grant list means nothing (skill-graph grants are the exception, ADR 0017); `*` means everything in the key's tenant.
  - A key bound to a service is confined to that service and tenant.
  - Key scopes are enforced, all of them.
  - There are no legacy keys. Since the headless-rag import was removed on 2026-10-09, nothing issues them, so the flag and its "empty grants mean everything" default are gone. Stored keys that relied on that default were given explicit `*` grants. The local development keys are ordinary keys: `DEV_API_KEY` has `*` grants, and `DEV_SERVICE_API_KEY` is bound to one service (`DEV_SERVICE_API_KEY_SERVICE`, default `kunnskapsassistenten`).
- The `X-User-Id` header is accepted only from keys bound to a service, and only for conversation ownership. Without it, the key owns the conversation itself.

## Why

The plan described identity three ways, called the key ceiling a floor, and kept a fail-open default from headless-rag. Once no client needed legacy keys, keeping the flag only kept the fail-open path alive.

## Consequences

- KA switches by changing its base URL, key, tool name and agent id. Existing conversations need an owner mapping when KA moves to Ansattporten.
