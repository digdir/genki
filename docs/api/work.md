# Work and quality

Running work and measuring it: service runs (tasks) and their timelines, table reviews, projects that follow document selections, batch runs over documents, triggers, test sets and evaluation runs, improvement proposals from the optimiser, test case candidates, publishing gates, guardrail rules, retrieval diagnostics, feedback, usage, the audit log and the tenant overview.

## Rights

- Reading runs, test sets, gates and feedback needs membership in the tenant. A run's timeline is open to whoever started it, or to `manage-services`.
- Projects and their runs need `use-services`; a subscription that runs a service needs `manage-services`.
- Test sets, eval runs, improvements, batch runs, gates, guardrail rules and candidate reviews need `manage-services`.
- An API key needs the `admin` scope on these routes, also on the ones outside `/tenants/{tenant}` (`/eval-runs/*`, `/eval-tasks/*`, `/testcase-candidates/*`); other keys get 403 `urn:genai:problem:api-key-scope`. A test-runner key in a locked test environment is the exception on `/tenants/{tenant}` (see [Access](access.md#test-runner-keys)).
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

To follow one run: `GET /tenants/{tenant}/tasks/{task}` and `GET /tenants/{tenant}/tasks/{task}/timeline`. Both also read a playground run, and `GET /tenants/{tenant}/tasks?origin=playground` lists the tenant's playground runs instead of its service runs.

A run whose content was erased on purpose carries `erasure: { reason, at }` on the run, in the run list and on its timeline. `reason` is `conversation-deleted` (the conversation was deleted), `retention` (removed after the retention period) or `erased` (erased before the platform recorded why); `at` is when, if known. Such a run has no `excerpt`, and its timeline keeps only what the envelopes hold: start, status, duration, model calls with tokens and cost, and a result step that says the answer was erased.

## Two kinds of evaluation run

- A service evaluation run starts with `POST /tenants/{tenant}/services/{id}/eval-runs` and is listed by `GET /tenants/{tenant}/services/{id}/eval-runs`. It runs every case of the test set, only one split with `split` (`locked` or `open`), or only the cases named in `cases` (case ids); a case id the test set does not have is a 400.
- A service evaluation run saves each case as it finishes: `finished` counts the cases done, and `passed`, `score`, `cost` and `tokens` count only those. If the platform restarts during the run, the run ends `failed` with `interrupted: true` and keeps the cases it finished and what they cost. It does not resume; start it again.
- A service evaluation run runs up to four cases at a time and shares a limited number of case slots with the other test-set runs on its API instance, a fair share per organisation and per run ([development.md](../development.md), "Test-set runs side by side", has the settings). While it has no case in flight and waits for a slot, it carries `queuePlace` (1 is next in line), and it stays `queued` until its first case starts. Cases finish in any order; `cases` is always in test-set order. Before each case the run checks the organisation's monthly token quota; once it is used up, the run starts no new case, lets the ones in flight finish, and ends `failed` with the cases it finished.
- An eval capability run starts with `POST /tenants/{tenant}/eval-runs` (capability, test set, evaluators and provenance are required) and is listed by `GET /tenants/{tenant}/eval-runs`. Follow it with `GET /eval-tasks/{task}`; every instance answers the same status, read from the task and the stored run, except `waiting-for-scores`, which only the instance running the eval knows.
- An eval capability run names its evaluators: `contract` (answer pattern, an exact case's text, refusal and fields), `retrieval` (recall at 10 and grounded citations), `judge:criteria` and registered evaluator plug-ins. `judge:criteria` scores criteria cases on `expected.criteria`, or on the reference answer when a case has none. Its model is picked for the run's tenant, from another family than the models that wrote the answer (an embedder that only searched does not count) and than the models in `avoidAsJudge`; a portal test run's judge also avoids the service's own models. The run's provenance names it as `judge:criteria@<version>+<model>`, and labels and calibration are kept under `judge:criteria`. An exact case without its text scores 0, and a JSON part other than sources, retrieval and the guard's provenance counts as a structured answer, so an empty RAG answer is a refusal.
- A score has a `state`: `scored`, `not-applicable`, `pending`, `failed` or `missing`. A judge on `evaluator@2` may answer pending. The run then waits up to 5 minutes from its last case, `GET /eval-tasks/{task}` answers `waiting-for-scores` with how many scores are pending, and what has not arrived is `missing`. The run's `incomplete` names each judge with missing or failed scores, and a gate on a metric with any of them in its split fails.
- `GET /tenants/{tenant}/eval-runs/{runId}` finds both. `kind` tells them apart: `service` answers the run with its case results, `kernel` answers the same body as `GET /eval-runs/{id}`.
- Neither kind shows its lease (`owner`, `heartbeatAt`).
- `GET /tenants/{tenant}/test-sets`, `GET /tenants/{tenant}/eval-runs` and `GET /tenants/{tenant}/feedback` answer `{ "data": [...] }`, like every other list.
