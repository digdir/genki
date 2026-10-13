# Work and quality

Running work and measuring it: service runs (tasks) and their timelines, table reviews, projects that follow document selections, batch runs over documents, triggers, test sets and evaluation runs, improvement proposals from the optimiser, test case candidates, publishing gates, guardrail rules, retrieval diagnostics, feedback, usage, the audit log and the tenant overview.

## Rights

- Reading runs, test sets, gates and feedback needs membership in the tenant. A run's timeline is open to whoever started it, or to `manage-services`.
- Projects and their runs need `use-services`; a subscription that runs a service needs `manage-services`.
- Test sets, eval runs, improvements, batch runs, gates, guardrail rules and candidate reviews need `manage-services`.
- Editing and approving a table review (`PUT .../tasks/{task}/review/edits`, `POST .../review/approve`) needs `use-services` and is open only to whoever started the run. Both are audited admin tasks with `change-reason`; an edit that races another answers 409.
- Usage and cost need `view-usage`.
- Starting, cancelling and retrying a batch run (`POST /tenants/{tenant}/services/{id}/batch-runs`, `.../{runId}/cancel`, `.../{runId}/retry`) are audited admin tasks: each needs `change-reason` and answers with a `genai-task` header.
- Changes need `change-reason` and appear in `GET /tenants/{tenant}/audit`.

## Typical sequence: evaluate a draft before publishing

1. `GET /tenants/{tenant}/services/{id}/test-sets`: the service's test sets.
2. `POST /tenants/{tenant}/test-sets/{setId}/cases`: add a case if one is missing.
3. `POST /tenants/{tenant}/services/{id}/eval-runs` for the draft: runs in the background.
4. `GET /tenants/{tenant}/services/{id}/eval-runs`, then `GET /tenants/{tenant}/eval-runs/{runId}` for case results.
5. `GET /eval-runs/compare`: compare with the run of the published version.
6. `GET /tenants/{tenant}/gates`: the gates publishing must pass; then publish (see [Services](services.md)).

To follow one run: `GET /tenants/{tenant}/tasks/{task}` and `GET /tenants/{tenant}/tasks/{task}/timeline`.

## Two kinds of evaluation run

- A service evaluation run starts with `POST /tenants/{tenant}/services/{id}/eval-runs` and is listed by `GET /tenants/{tenant}/services/{id}/eval-runs`.
- An eval capability run starts with `POST /tenants/{tenant}/eval-runs` (capability, test set, evaluators and provenance are required) and is listed by `GET /tenants/{tenant}/eval-runs`. Follow it with `GET /eval-tasks/{task}`; every instance answers the same status, read from the task and the stored run.
- `GET /tenants/{tenant}/eval-runs/{runId}` finds both. `kind` tells them apart: `service` answers the run with its case results, `kernel` answers the same body as `GET /eval-runs/{id}`.
- Neither kind shows its lease (`owner`, `heartbeatAt`).
- `GET /tenants/{tenant}/test-sets`, `GET /tenants/{tenant}/eval-runs` and `GET /tenants/{tenant}/feedback` answer `{ "data": [...] }`, like every other list.
