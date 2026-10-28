# 0022 Tenant isolation in Postgres

Status: accepted, 2026-10-12 (built; search data on its own server, 2026-10-22). Proposed 2026-10-06

## Decision

- Tables the API reads directly (tenants, conversations, messages, API keys) have forced row-level security on `app.tenant`, set per transaction.
- The kernel's tables (events, tasks, state) do not. The kernel reads by task id across calling and owner tenants and is the component that enforces access. Content in them is encrypted with a key per tenant and scope (ADR 0011).
- The kernel and the API connect as different database roles. The API's role is not a superuser and owns no tables, so row-level security applies to it. Migrations run as the owner.
- Looking up an API key by digest happens before the tenant is known, so it goes through one `SECURITY DEFINER` function. Every other key operation is tenant-scoped.
- Reads that legitimately span tenants (the tenant directory, registered clients, the settings snapshot, support sessions, operator audit, lookups by id) go through `withPlatformAccess(pool, purpose, …)`. It sets `app.platform_access` for one transaction, every cross-tenant `SECURITY DEFINER` function refuses to run without it, and it cannot be combined with a tenant transaction. Each call names its purpose, so all of them can be found in the code.
- The runtime role is `genai_runtime`: no login of its own, no `BYPASSRLS`, owns nothing, and gets DML only on a listed set of tables. The migration creates it and refuses to run if it is a superuser or bypasses RLS. Production connects with `DATABASE_RUNTIME_URL`; without it the store pool sets the role per connection, which is acceptable only for local development.
- Search data, the pgvector tables (`kn_*`), lives on a Postgres server of its own when `KNOWLEDGE_DATABASE_URL` is set: the API and the worker reach it as that server's owner, and everything else stays in the platform database. Without the setting the tables share the platform database, and outside dev mode the API and the worker log a warning at startup. The knowledge server's host is a platform host, so tenant tools cannot reach it.

## Why

Row-level security on the kernel's tables would need the tenant on every kernel read, including cross-tenant ones the kernel decides on. Two roles keep the database enforcing isolation where the application could get it wrong, without moving the kernel's access decisions into SQL.

## Consequences

- Infra creates the two roles and grants them separately.
- A new table the API reads directly gets a tenant column and a policy in the same migration.
- The kernel still shares `genai_runtime` with the API until the deployment has a separate kernel role. The pgvector tables (`kn_*`) have no tenant column and are reached only through an owner pool, the knowledge server's or the platform's, because the knowledge writer runs DDL.
- Search data is kept off the platform database because of its size: Kudos alone is millions of vectors, whose index must stay in memory to be fast. Refusing to start without a knowledge server waits for the infrastructure that creates one; until then a deployment without `KNOWLEDGE_DATABASE_URL` keeps its search data in the platform database.
