# Operations

Operator-only routes, used by the console: tenants and organisations, onboarding decisions, support sessions, platform datasets, pipelines and engine switches, knowledge endpoints, model endpoints, models and prices, the platform catalogue, shared services, platform gates, guardrail rules and hooks, plugins and building blocks, the quality matrix, usage across tenants, the whole audit log, operations health, tracing and running tasks.

## Rights

- Every route here needs an operator. Other callers get `403`.
- Operators reach a tenant's own routes only inside a support session with a reason and a time limit. The session shows in the tenant's audit log.
- Changes need `change-reason` and are audited; the ones that touch a tenant are also in that tenant's log.

## Typical sequence: help a tenant

1. `GET /operator/tenants`: find the tenant.
2. `POST /support-sessions` with `{ "tenant", "reason", "minutes" }`: the response has the session `id`.
3. Call the tenant's routes with `support-session: <id>`, for example `GET /tenants/{tenant}/definitions`.
4. `POST /operator/support-sessions/{id}/extend` if you need more time, and `POST /operator/support-sessions/{id}/end` when done.
5. `GET /operator/audit`: what was done, by whom, and why.

Release a new model: `PUT /operator/models/{id}`, `POST /operator/quality/matrix/estimate`, `POST /operator/quality/matrix/runs` (an audited admin task with `change-reason`), then `POST /operator/quality/matrix/release`.
