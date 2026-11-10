# Smoke tests on genki-test

After every deploy to genki-test, the `smoke` workflow calls the running platform the way a client does and checks that it still works: the API answers with the deployed version, published services run on every model in use, answers cite sources, and the run's timeline shows its steps. Unit tests use fakes; this is the one place the deployed system, the real providers and the real data are checked together.

It exists because the manual smoke test of 96305c01 on 2026-11-10 found four bugs unit tests had missed (a timeline that never showed provider status, a playground refusal, a model that failed every call and an organisation the auto-filter did not detect).

## What runs, and what it would have caught

Checks run in three tiers by cost. A check's question and expectations live in `scripts/smoke/plan.json`; the assertions are structural only. Answer wording is never asserted.

| Tier  | Check               | What it asserts                                                                                                                                                                           | Cost                                    |
| ----- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| free  | `health`            | `/health` is `ok` and reports the deployed SHA                                                                                                                                            | 0                                       |
| free  | `openapi`           | `/openapi.json` has the same version and the `/v1/chat/completions` route                                                                                                                 | 0                                       |
| free  | `portal`, `console` | Both answer 200                                                                                                                                                                           | 0                                       |
| free  | `models`            | `GET /v1/models` with the key lists every variant of the smoke service, none paused                                                                                                       | 0                                       |
| free  | `facets`            | Each organisation the detection questions name is a facet value of the dataset                                                                                                            | 0                                       |
| cheap | `model:<model>`     | One short agent run per model the smoke service reaches, with the service's temperature and tools: completes, answers, uses tokens, and when `genai-model` names one model it is that one | 0.04 to 0.2 kr each                     |
| core  | `question:<id>`     | A fixed question on the agent variant (streamed, with steps) or the retrieve-only variant: completes, a streamed run has steps, and it cites or lists at least N sources                  | 0.2 kr (agent), 0.02 kr (retrieve-only) |
| core  | `feedback`          | `POST /api/feedback` on a smoke run twice (up, then down) answers 201 both times                                                                                                          | 0                                       |
| core  | `timeline:<id>`     | The run's timeline is `completed`, has steps and input tokens, and has (or lacks) the expected "Found in the search" tags. Skipped while a key cannot read a timeline (see Auth)          | 0                                       |

| Failure on 2026-11-10                                                                     | Caught by                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude-haiku-5-5 fails every call (`temperature: Extra inputs are not permitted`)         | Yes: `model:foundry-claude/claude-haiku-5-5` fails twice with `model_error`                                                                                                                                             |
| Auto-filter detects "Datatilsynet" but not "DFØ"                                          | No. Kudos stores DFØ only by its full name and has no short names, so "DFØ" cannot be detected until #442 adds aliases. Then add DFØ to the expected detections in `plan.json`                                          |
| #434 provider status never reaches the timeline (`apps/api/src/timeline.ts:81`)           | No. The provider status is shown only to those with `manage-services` (`apps/api/src/platform.ts:838`), and a failure cannot be provoked safely on a shared environment. The fix branch's route-level test is the guard |
| Portal playground refuses a published service on residency (`apps/api/src/playground.ts`) | No. The playground routes take a person's token, never a key (`apps/api/src/app.ts:66-71`). It stays a manual browser check until the scripted browser step below exists                                                |

## Trigger

Deploys are manual: `deploy.yml` runs only on `workflow_dispatch` (`.github/workflows/deploy.yml:3-10`), deploys genki-test in `deploy-test` (`:112-116`) and then, when asked, prod (`:206-208`). Its own `smoke` step only waits for `/health` to report the SHA (`:196-204`).

`smoke.yml` runs on `workflow_run` when `deploy` completes, and on `workflow_dispatch`:

- It runs only when the deploy succeeded, was itself dispatched, and ran on `main`. A `workflow_run` workflow always runs from the default branch's file, so neither a fork nor a pull request can start it or change what it runs. It never runs on `pull_request`. A dispatch runs only from `main` too.
- A separate workflow keeps the deploy workflow, which holds the Azure identity, unchanged, and keeps a red smoke test from painting a finished deploy red. The cost: after a prod deploy it runs once the whole deploy workflow is done, a few minutes later than it could.
- Dispatch takes `tiers` (`free`, `cheap` or `all`) and an optional `sha`. Without `sha` it tests whatever `/health` reports.
- The `smoke` job has `concurrency: smoke-genki-test`: one run at a time, and a running one is never cancelled. GitHub keeps only one waiting run per group, so when deploys come faster than the smoke test, an older waiting run is replaced by the newer one, which tests the newer deploy. The concurrency sits on the job, so a run skipped after a failed deploy never takes a place in the queue.
- If a deploy succeeds without deploying the API (`deploy.yml:188-194`, when `ALTINN_PDP_URL` is unset), `/health` keeps the old SHA, `health` fails and the run is red on the deployed commit. That is on purpose: genki-test does not run that commit.

Jobs and permissions:

| Job      | Environment  | Permissions                                          | Holds the key |
| -------- | ------------ | ---------------------------------------------------- | ------------- |
| `smoke`  | `genki-test` | `contents: read`, `actions: read` (daily cap)        | yes           |
| `report` | none         | `contents: read`, `issues: write`, `statuses: write` | no            |

The `genki-test` environment is a new one that holds only `SMOKE_API_KEY`, limited to `main`. The existing `test` environment is not reused: it is the subject the Azure deploy identity trusts, and a secret there would be readable by the deploy jobs too.

## Auth: one service key

The smoke test needs one API key bound to the smoke service on genki-test, stored as the environment secret `SMOKE_API_KEY`. Never an operator token.

What a key reaches, from the code:

| Route                                                  | Key                                                                                                       | Evidence                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `POST /v1/chat/completions`, `GET /v1/models`          | Yes, only its own service                                                                                 | `packages/identity/src/api-keys.ts:148`, `packages/identity/src/policy.ts:101-115` |
| `GET /api/facets`                                      | Yes, datasets its service searches                                                                        | `apps/api/src/composition.ts:1346-1355`                                            |
| `POST /api/feedback`                                   | Yes, on runs the same key made                                                                            | `docs/frontend-contract.md`, Feedback                                              |
| `GET /tenants/{t}/tasks/{task}`, `.../timeline`, usage | No: definition and platform routes drop API keys, and `/tenants/*` refuses keys without the `admin` scope | `apps/api/src/app.ts:66-71,118`, `apps/api/src/tenant-gate.ts:16-20,56-57`         |
| `POST /definitions/validate`                           | No, same reason                                                                                           | `apps/api/src/definitions.ts:327-329`                                              |
| Playground                                             | No                                                                                                        | as above                                                                           |
| Operator routes                                        | No                                                                                                        | operator principals only                                                           |

A key made in the portal always has scope `query` (`apps/api/src/routes/portal-routes.ts:260`), so there is no `admin` key to fall back on, and none is wanted.

So two of the checks the design asks for cannot run with one key today: the timeline checks (steps, token counts, detection tags) and definition validation. For validation nothing is lost: the refusals are pure code paths covered by `packages/definitions` tests, and `scripts/smoke/smoke-service.test.ts` validates the smoke definition offline. For the timeline the narrowest option is a small API change, not a second credential: let a key read `GET /tenants/{t}/tasks/{task}/timeline` for a run it started, the rule the route already applies to people (`startedBy`, `apps/api/src/platform.ts:827-828`) and the one feedback already uses for keys. Provider details would stay behind `manage-services`. That changes what an API key may read, so it needs an amendment to ADR 0008 and its own pull request. Until then `timeline:*` reports `skip` with the reason, and turns itself on when the route answers 200.

Lockdown: genki-test reports `"lockdown": true`. Lockdown is about credentials, not networks: `infra/` has no IP restrictions, and GitHub-hosted runners reach the API like anyone. In lockdown a run that reaches a model needs a credential that may use models (`apps/api/src/lockdown.ts:62-73,110-118`, `packages/composition/src/lockdown.ts:24-28`). A key gets that mark only when a trusted Entra login creates it (`apps/api/src/routes/portal-routes.ts:273`, ADR 0033). So the key must be created by someone signed in to the portal with Entra ID in one of the lockdown groups, not with a TestID person. A key without the mark gets `403 urn:genai:problem:locked-environment` on every model check; the summary shows the 403 and the start of the problem text. As ADR 0033 says, removing the creator from the Entra group does not revoke the key: rotate or revoke it when the person leaves.

## The smoke service

`scripts/smoke/smoke-service.yaml` is a definition the maintainers publish once on genki-test. It is an ordinary agent service over one dataset with a retrieve-only variant and one variant per model. Nothing about it is specific to Kunnskapsassistenten: the dataset (`digdir/kudos`) and the questions are data in the definition and the plan, not code.

- Id `smoke`, risk class minimal, exposed only on `openai`, not in chat. No other service, frontend or key may depend on it; it is changed only together with `plan.json`.
- `default` runs `agent-loop` on a mini model with a small budget (2 searches, 3 reads, 6000 characters, 6 iterations) and temperature 0.3, the parameters a real agent service sends.
- `retrieve-only` runs `rag-single-shot` without generation; its query planner still makes one small model call.
- `model-*` variants set the model and shrink the run (1 search, 1 read, 2000 characters, 3 iterations). Temperature, tools and the request shape stay those of the service, which is what broke Haiku on 2026-11-10. A run costs 0.04 kr (mini) to 0.2 kr (gpt-5.6-terra).
- Models today: `foundry-openai/gpt-5.4-mini`, `foundry-openai/gpt-5.6-terra` and `foundry-claude/claude-haiku-5-5` (the Anthropic path), the chat models published services on genki-test use. Add a variant, and a row in `plan.json`, for each model a published service uses; `smoke-service.test.ts` fails if the two disagree.

## Cost and caps

Prices are from `apps/api/config/local/prices.yaml` (Sweden Central). Claude Haiku has no price there; the plan assumes 0.0000105 kr per input and 0.0000525 kr per output token.

| Part                                      | Estimate per run |
| ----------------------------------------- | ---------------- |
| free tier                                 | 0                |
| cheap: 3 models, one short agent run each | about 0.35 kr    |
| core: 2 agent questions on the mini model | about 0.4 kr     |
| core: 3 retrieve-only questions           | about 0.06 kr    |
| A full run, by the plan's estimates       | about 0.8 kr     |
| Worst case, every model check rerun       | about 1.6 kr     |

At about 3 deploys per weekday, about 65 runs a month: about 50 kr a month, about 105 kr if every model check were rerun. The estimates are deliberately high. The summary's figure is what the budget counted: the measured cost from token counts where a run reports them, and never less than the estimate. A streamed run reports no tokens, so the two agent questions count at their estimate.

Caps, so a loop cannot burn money:

1. **Per run**: every model check has an estimate in `plan.json`. Before each attempt the runner adds it to what the run has counted so far and skips the check (`skip: budget`) when the total would pass `maxKrPerRun` (2.5 kr). A retry that would pass it is not made, and the check fails. The free tier always runs.
2. **Per day**: the runner counts this workflow's runs since midnight UTC that were not skipped, this one included. Past `SMOKE_MAX_RUNS_PER_DAY` (variable, default 6) it runs the free tier only and says so; if GitHub does not answer the count, it does the same. Six runs at the per-run cap is 15 kr. Run from a laptop without `GITHUB_TOKEN`, there is no daily cap.
3. **Per minute**: create the key with `callsPerMinute: 30`, so genki itself refuses a runaway loop.
4. Deploys are manual and `workflow_run` fires once per deploy, so nothing retriggers itself.

## Flakiness

- Every request has a timeout: 30 s for the free tier, 150 s for a model run. Model checks must finish within 14 minutes of the start: one that could not is skipped (`skip: time`), so a hanging genki-test still leaves time to write the report inside the job's 20 minutes.
- `/health` is polled up to 10 times, 15 s apart, until it reports the expected SHA; the deploy already waits for the same, so this normally passes at once. If it never does, no model check runs: they would test another version and cost money for nothing.
- Requests never follow a redirect, so the key cannot be sent to another host.
- Only model-dependent checks are retried, once, 20 s later: network errors, timeouts, `429`, `502`, `503`, `504`, a `500` with `model_failed: true`, and a run that completed but missed a structural expectation (no citation, say). A key, routing or validation error (`401`, `403`, `404`, `400`) is never retried.
- Pass on the first try is `pass`. Fail then pass is `flaky`: it counts as passed, and the summary marks it so a pattern shows. Fail twice is `fail`. A model that refuses its parameters, like Haiku on 2026-11-10, fails twice.

## Reporting

- **Job summary**: one table with every check, its outcome, attempts, tokens and the genki run ids (the `genai-task` header), plus what was skipped and why.
- **Commit status**: `smoke/genki-test` on the tested SHA (the deployed one, even when `/health` reports another), linking the run. A failed check gives `failure`. `success` needs every tier to have run with nothing skipped, except timelines the key cannot read; any other run sets no status, and neither does a run without a known SHA. The status is the "last green" state: no extra store, visible on each commit, and something the AI review experiment can read per commit.
- **Suspect range**: from the tested SHA back to the newest commit with a green `smoke/genki-test` status (one GraphQL history query, 100 commits), with the merged pull requests in it read from the squash-merge titles (`(#123)`).
- **Issue**: on failure, the report job opens one issue labelled `smoke`, or comments on the open one, with the failing checks, run ids, the suspect range and its pull requests. Text from genki is cut to one line and cannot mention anyone. It names a range, never a culprit: tracing the failure is a person's job, and when it lands on a merged pull request the AI review saw, the fix pull request gets the `escaped` label. When a later run is green, the job comments and closes the issue. The `smoke` label is created on first use.

## Where the code lives

| Path                               | What                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/smoke.yml`      | Trigger, environment, the two jobs                                                                                                          |
| `scripts/smoke/smoke-service.yaml` | The definition to publish                                                                                                                   |
| `scripts/smoke/plan.json`          | Variants, models, prices, estimates, questions and expectations                                                                             |
| `scripts/smoke/assess.ts`          | Pure assertions (health, models, facets, completions, the SSE stream, timelines), and the retry, budget and deadline rules of a model check |
| `scripts/smoke/run.ts`             | The runner: HTTP calls in order, the summary, and the report as a job output                                                                |
| `scripts/smoke/report.ts`          | Pure range, pull request, issue text and issue decision, and the GitHub calls for status and issue                                          |
| `scripts/smoke/*.test.ts`          | Tests for the pure parts, and an offline validation of the definition against the plan                                                      |

The scripts use only Node's built-ins and run with `node` like the other workflow scripts, so the job needs no `npm ci`.

Run it from a laptop against genki-test, with the key in your own environment:

```sh
SMOKE_TIERS=free node scripts/smoke/run.ts
```

## What stays manual

These need a person's login and stay in the manual checklist after a deploy:

- Portal playground on a published service, sources rendering, the run in the Log.
- Console: models and connections load, the APIs tab, Diagnostics, the add-model form's dry run.
- Anything that needs `manage-services` or an operator: provider status on a failed run, the tenant catalogue, feedback lists.

The `feedback` check leaves two ratings on a smoke run each time, about 130 a month, all on the `smoke` service in the platform organisation's feedback list.

A later step can script these with a headless browser. On genki-test the Ansattporten test login is a click on a test account with no password, so a Playwright job could sign in as a fixed TestID person without a stored secret. Such a person is read-only in lockdown, which suits a smoke test but cannot run models; a run through the playground would need an Entra login, which does need a secret. That is a separate decision.

## Setting it up

1. Publish `scripts/smoke/smoke-service.yaml` on genki-test in the platform organisation, after checking with `list_models` that each model id exists, with the reason "Smoke test service for the post-deploy CI".
2. Signed in to the portal with Entra ID, create a key bound to the `smoke` service, `callsPerMinute: 30`, no expiry or a long one.
3. In GitHub, create the environment `genki-test` and set its deployment branches to the selected branch `main` (not "protected branches") before adding the key as the secret `SMOKE_API_KEY`. The workflow would otherwise create the environment without that limit on its first run.
4. Optionally set the variables `SMOKE_MAX_RUNS_PER_DAY` and `SMOKE_API_URL`, `SMOKE_PORTAL_URL`, `SMOKE_CONSOLE_URL` (they default to genki-test).
5. Dispatch `smoke` once with `tiers: free`, then `all`.

No ADR: this adds a workflow and a script and changes no contract, boundary or security property. Letting a key read its own run's timeline would, and needs one.
