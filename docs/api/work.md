# Work and quality

Running work and measuring it: service runs (tasks) and their timelines, table reviews, projects that follow document selections, batch runs over documents, triggers, test sets and evaluation runs, improvement proposals from the optimiser, test case candidates, publishing gates, guardrail rules, retrieval diagnostics, feedback, usage, the audit log and the tenant overview.

## Rights

- Reading runs, test sets, gates and feedback needs membership in the tenant. A run's timeline is open to whoever started it, or to `manage-services`.
- Projects and their runs need `use-services`; a subscription that runs a service needs `manage-services`.
- Test sets, eval runs, improvements, batch runs, gates, guardrail rules and candidate reviews need `manage-services`.
- An API key needs the `admin` scope on these routes, also on the ones outside `/tenants/{tenant}` (`/eval-runs/*`, `/eval-tasks/*`, `/testcase-candidates/*`); other keys get 403 `urn:genai:problem:api-key-scope`.
- A rerun of a batch with the same `batchId` skips the items that already succeeded. Their entries in the new result carry status, attempts and the task that produced them, not the answer, which stays with that task and its retention.
- Editing and approving a table review (`PUT .../tasks/{task}/review/edits`, `POST .../review/approve`) needs `use-services` and is open only to whoever started the run. Both are audited admin tasks with `change-reason`; an edit that races another answers 409.
- Usage and cost need `view-usage`.
- Starting, cancelling and retrying a batch run (`POST /tenants/{tenant}/services/{id}/batch-runs`, `.../{runId}/cancel`, `.../{runId}/retry`) are audited admin tasks: each needs `change-reason` and answers with a `genai-task` header.
- Changes need `change-reason` and appear in `GET /tenants/{tenant}/audit`.

## Typical sequence: evaluate a draft before publishing

1. `GET /tenants/{tenant}/services/{id}/test-sets`: the service's test sets.
2. `POST /tenants/{tenant}/test-sets/{setId}/cases`: add a case if one is missing. `expected` is a text, read as a criteria case's criteria and as the reference answer otherwise, or `{ referenceAnswer, criteria }` with named criteria such as `criteria` and `supporting_quotes`, kept as they are. Given as fields, a criteria case needs `criteria` and an exact case `referenceAnswer`.
3. `POST /tenants/{tenant}/services/{id}/eval-runs` for the draft: runs in the background.
4. `GET /tenants/{tenant}/services/{id}/eval-runs`, then `GET /tenants/{tenant}/eval-runs/{runId}` for case results.
5. `GET /eval-runs/compare`: compare with the run of the published version.
6. `GET /tenants/{tenant}/gates`: the gates publishing must pass; then publish (see [Services](services.md)).

To follow one run: `GET /tenants/{tenant}/tasks/{task}` and `GET /tenants/{tenant}/tasks/{task}/timeline`.

## Two kinds of evaluation run

- A service evaluation run starts with `POST /tenants/{tenant}/services/{id}/eval-runs` and is listed by `GET /tenants/{tenant}/services/{id}/eval-runs`. With `trace: true` each case except the holdout is sent to the tenant's trace connection that covers the service, as one experiment with a trace per case and repeat (see [access.md](access.md)); it answers 409 when no connection covers the service, when two do, or when the residency the service runs with, filled from its model when the draft leaves it out, does not allow the connection's. The traces go through the egress guard, pinned to the address it checked. Until judges map fields, the traces carry no text. A draft or version that cannot run answers 422. It is an eval run of the draft or version (`platform.eval.run`), judged by `contract`, by `retrieval` when cases name sources and by `judge:criteria` when there are criteria cases, and it is stored as soon as it starts. Its `status` is `running`, `waiting-for-scores`, `completed`, `failed` or `interrupted`; a run left by an instance that stopped reads as `interrupted`. A case passes on its type's own metric: the criteria judge, the exact text or the refusal. Only completed runs feed publishing gates and comparisons, and a gate finds a run under the spec it tested. Test runs from before this change are no longer listed.
- An eval capability run starts with `POST /tenants/{tenant}/eval-runs` (capability, test set, evaluators and provenance are required) and is listed by `GET /tenants/{tenant}/eval-runs`. Follow it with `GET /eval-tasks/{task}`; every instance answers the same status, read from the task and the stored run, except `waiting-for-scores`, which only the instance running the eval knows.
- An eval capability run names its evaluators: `contract` (answer pattern, an exact case's text, refusal and fields), `retrieval` (recall at 10 and grounded citations), `judge:criteria` and registered evaluator plug-ins. `judge:criteria` scores criteria cases on `expected.criteria`, or on the reference answer when a case has none. Its model is picked for the run's tenant, from another family than the models that wrote the answer (an embedder that only searched does not count) and than the models in `avoidAsJudge`, which a portal test run sets to the service's own models. The run's provenance names it as `judge:criteria@<version>+<model>`, and labels and calibration are kept under `judge:criteria`. An exact case without its text scores 0, and only an `application/json` part counts as a structured answer, so an empty RAG answer is a refusal.
- A score has a `state`: `scored`, `not-applicable`, `pending`, `failed` or `missing`. A judge on `evaluator@2` may answer pending. The run then waits up to 5 minutes from its last case, `GET /eval-tasks/{task}` answers `waiting-for-scores` with how many scores are pending, and what has not arrived is `missing`. The run's `incomplete` names each judge with missing or failed scores, and a gate on a metric with any of them in its split fails.
- `GET /tenants/{tenant}/eval-runs/{runId}` finds both. `kind` tells them apart: `service` answers the run with its metrics, confidence intervals and case results, each answer read from its case's task, `kernel` answers the same body as `GET /eval-runs/{id}`. Cost and tokens cover the answers and the judges, and show only with view-usage.
- No eval run endpoint shows a run's lease (`owner`, `heartbeatAt`), and `usage` shows only with view-usage, also in `GET /tenants/{tenant}/eval-runs` and `GET /eval-runs/{id}`. A failed run keeps the usage of the cases it got through. A run names the service it tested in `provenance.services`, not the draft capability made for it, so two runs of the same configuration can be compared.
- `GET /tenants/{tenant}/test-sets`, `GET /tenants/{tenant}/eval-runs` and `GET /tenants/{tenant}/feedback` answer `{ "data": [...] }`, like every other list.
