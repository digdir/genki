# Operations

Operator-only routes, used by the console: tenants and organisations, onboarding decisions, support sessions, platform datasets, pipelines and engine switches, knowledge endpoints, model endpoints, models and prices, the platform catalogue, shared services, platform gates, guardrail rules and hooks, plugins and building blocks, the quality matrix, usage across tenants, the whole audit log, operations health, tracing and running tasks.

## Rights

- Every route here needs an operator. Other callers get `403`.
- Operators reach a tenant's own routes only inside a support session with a reason and a time limit. The session shows in the tenant's audit log. In lockdown an operator also has every right in the platform organisation without a session (ADR 0033).
- Changes need `change-reason` and are audited; the ones that touch a tenant are also in that tenant's log.

## Typical sequence: help a tenant

1. `GET /operator/tenants`: find the tenant.
2. `POST /support-sessions` with `{ "tenant", "reason", "minutes" }`: the response has the session `id`.
3. Call the tenant's routes with `support-session: <id>`, for example `GET /tenants/{tenant}/definitions`.
4. `POST /operator/support-sessions/{id}/extend` if you need more time, and `POST /operator/support-sessions/{id}/end` when done.
5. `GET /operator/audit`: what was done, by whom, and why.

Release a new model: `PUT /operator/models/{id}`, `POST /operator/quality/matrix/estimate`, `POST /operator/quality/matrix/runs` (an audited admin task with `change-reason`), then `POST /operator/quality/matrix/release`.

Let services use a new kind of model API: `GET /operator/operation-kinds` lists each kind with its maturity in this environment and its descriptors. `POST /operator/operation-kinds/{kind}/maturity` with `{ "maturity": "production" }` and `change-reason` asks for production; a second operator sends the same to confirm, and the answer says `step: "requested"` and then `step: "promoted"`. The same operator twice gets `409`. `{ "maturity": "test" }` moves the kind back at once, by one operator. Before a service may use the kind with real data, record the model endpoint's processor record: `PUT /operator/model-endpoints/{id}/processor-record` with `{ "agreement", "subProcessors": [{ "name", "location" }], "retention": { "days", "note" }, "acceptsUnmaskedInput", "unmaskedInputReason" }`. `GET /operator/processor-records` shows every endpoint and `record: null` where none is recorded. Every change is audited.

Try a new kind of model API (test only): `POST /operator/operations/{descriptor}/try` with `{ "model": "<catalogue model id>", "input": <the descriptor's typed input>, "synthetic": true }` and `change-reason`. It is an audited admin task and answers `{ task, descriptor, model, result }` with a `genai-task` header for the run. Outside `GENAI_ENV=test` it answers `403` (`errors[0].path: "environment"`); without `synthetic: true`, `400`; a request with image, audio or file content or a field the descriptor does not allow, `400`; in lockdown, for a login that is not admitted, `403`. Every PII category is masked before the call leaves, whatever the tenant has set.
