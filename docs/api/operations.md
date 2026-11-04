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

Let services use a new kind of model API: a kind comes from a descriptor alone; list it in a model's `operations` (`PATCH /operator/models/{id}` or the catalogue), and a kind no descriptor defines is refused. `GET /operator/operation-kinds` lists each kind with its maturity in this environment and its descriptors; the answer says `governs: "descriptor-calls"`, because maturity governs only descriptor calls (the raw and described tiers). The built-in kinds `chat` and `decide` are always listed with `builtIn: true` and `typed: "production"`: Genki's own typed calls of them are production by construction. `POST /operator/operation-kinds/{kind}/maturity` with `{ "maturity": "production" }` and `change-reason` moves the kind to production at once, and `{ "maturity": "test" }` moves it back; one operator does either. The answer says `step: "promoted"`, `"demoted"` or `"unchanged"`, and `by` and `at` name who set the maturity and when. Before a service may use the kind with real data, record the model endpoint's processor record: `PUT /operator/model-endpoints/{id}/processor-record` with `{ "agreement", "subProcessors": [{ "name", "location" }], "retention": { "days", "note" } }`. `GET /operator/processor-records` shows every endpoint and `record: null` where none is recorded. Every change is audited. Image, audio and file input to a descriptor call is always refused; letting unmasked input through on a service's confirmed risk assessment is #326.

Try a new kind of model API (test only): `POST /operator/operations/{descriptor}/try` with `{ "model": "<catalogue model id>", "input": <the descriptor's typed input>, "synthetic": true }` and `change-reason`. It is an audited admin task and answers `{ task, descriptor, model, result }` with a `genai-task` header for the run. Outside `GENAI_ENV=test` it answers `403` (`errors[0].path: "environment"`); without `synthetic: true`, `400`; a request with image, audio or file content, a field the descriptor does not allow, or a URL, `data:` URL or more than 64 base64 characters in a row in a `plain` field, `400`; a model whose catalogue `operations` does not list the descriptor's operation, `400` (`errors[0].path: "unsupported"`); in lockdown, for a login that is not admitted, `403`. Every PII category is masked before the call leaves, whatever the tenant has set.

Every bundled descriptor must pass `operation@1` in CI. A descriptor that is not `typed` may not declare `json` in its input or wire request, and fails `operation@1` when a national id, an email or a phone number in any input string reaches the wire unmasked, so its free input must be `text`.
