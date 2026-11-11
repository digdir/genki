# Smoke tests on genki-test

After every deploy to genki-test, the `smoke` workflow tests the running platform the way its users do: the API with a key, the portal and console in a browser, the playground, run timelines, validation and the operator screens. It then reads the pull requests merged since the last green run, runs the check groups those pull requests touch in full, and lets a model look for what the fixed checks miss. Unit tests use fakes; this is the one place the deployed system, the real providers and the real data are checked together.

It exists because the manual smoke test of 96305c01 on 2026-11-10 found four bugs and three oddities the unit tests had missed. The smoke test must catch every one of them, and the same kind of mistake in any later pull request. Its results also feed the AI review experiment: a failure it traces to a pull request the AI review saw is a candidate for the `escaped` label.

## What it would have caught on 2026-11-10

Each row names the check and why it fails on 96305c01. The Haiku, detection and sources rows need only a key that reaches `smoke`; the timeline and playground rows need the `test-runner` grant (Layer 1); the session checks need no credential. Six of the seven are caught; the console session row is not proven. The playground residency, Haiku temperature and timeline fixes have since merged (#444, #445, #446), so those checks now guard against the same mistake coming back.

| Found on 2026-11-10                                                                  | Check                                                                   | Why it fails on 96305c01                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| claude-haiku-5-5 fails every call (`temperature: Extra inputs are not permitted`)    | `model:foundry-claude/claude-haiku-5-5`                                 | The model variant sends the service's temperature, as a real service does. Anthropic refuses it, twice, so the check fails                                                                                                                                         |
| The run timeline never shows the provider's status, nor any token stats (#434)       | `timeline:<run>` on every run                                           | The timeline reader dropped audit and usage events (`apps/api/src/timeline.ts:81`), so every timeline has no input tokens and no `stats.byModel`, and the failed Haiku run's timeline has no provider block. Both are asserted                                     |
| The portal playground refuses a published service with another model (residency 422) | `playground:<model>` (API) and `screen:portal/playground-run` (browser) | The smoke service is `residency: global` over a global dataset. Tried with the EU model `gpt-5.4-mini`, the playground swapped in the model's residency and answered `422 Invalid setup`                                                                           |
| The auto-filter detects "Datatilsynet" but not "DFØ"                                 | `timeline:agent-detect-dfo` expects DFØ in "Found in the search"        | Not detected. Kudos has DFØ only by its full name, so this stays a known failure (`knownIssue: #442`) until aliases land: reported on every run, not red                                                                                                           |
| Oddity: the playground shows a 422 as "the model did not respond"                    | `screen:portal/playground-run`                                          | The browser sees the API answer 422 and the page say "did not respond / There is nothing wrong with the setup" (`PlaygroundPanel.tsx:177-188`). The check fails when a 4xx is shown with the timeout text                                                          |
| Oddity: sources repeated once per chunk                                              | `sources:<run>` on every cited answer                                   | `answerSourcesOf` returns every cited chunk (`packages/adapter-openai/src/sources.ts:122`), so a document cited from three chunks is listed three times. The check requires one source per `document_id`. It fails on main today: see Decisions                    |
| Oddity: the console's expired session                                                | `session:console-expired`, `session:portal-expired`                     | Not proven. Both load with a token the API refuses and require the signed-out page with no screen error on the way. On 96305c01 both show the signed-out page (dry run, 2026-11-10), so they guard the behaviour but do not reproduce what was seen. See Decisions |

## Layer 1: identity

### What exists today does not reach far enough

The smoke test needs to run services, use the playground on a published service, read run timelines with provider details and token stats, validate definitions, read the console's operator routes, write feedback, and create and remove throwaway `smoke-*` objects. What each credential reaches on genki-test (lockdown on, `GENAI_ENV=test`), proven by route tests run against the code:

| Need                              | Admitted API key (Entra-created) | Maskinporten client        | TestID person (Ansattporten)                             | Operator (Entra) |
| --------------------------------- | -------------------------------- | -------------------------- | -------------------------------------------------------- | ---------------- |
| Run a bound service               | yes                              | yes                        | no, read-only in lockdown                                | yes              |
| Playground on a published service | no (`tenant-gate.ts:56`)         | only if bound to `*`       | no                                                       | yes              |
| Timeline with details and tokens  | no (`app.ts:66-71`)              | yes, any run in the tenant | details with `manage-services`, tokens with `view-usage` | yes              |
| Validate a definition             | no                               | yes                        | yes                                                      | yes              |
| Operator read routes              | no                               | no                         | no                                                       | yes              |
| Feedback                          | yes, its own runs                | yes                        | yes                                                      | yes              |
| Publish and archive `smoke-*`     | no                               | yes, and any other service | no                                                       | yes              |

- A TestID person can be admitted in lockdown only through Entra (`packages/identity/src/verify.ts:186,199`); Ansattporten logins are read-only, so a scripted TestID browser could look but never run a model.
- An operator token has write rights everywhere. It never goes into CI.
- A Maskinporten client reaches every tenant route with every right, whatever services it is bound to. genki-test does not trust Maskinporten logins today (`MASKINPORTEN_JWKS_URI` is unset), so this is latent. It is reported separately and is not a credential to build on.

### The `test-runner` grant (separate pull request)

The narrowest credential that does the whole test is an API key with a new `test-runner` grant, built in its own pull request (branch `smoke-identity`), with amendments to ADR 0033 and ADR 0008:

- Only an admitted Entra login can create it, and only on a server in lockdown on the test tier. A stored grant is ignored anywhere else, so it cannot work in prod.
- In the key's own tenant it reads what a person with every right reads (timelines with details and usage, every portal screen), and it may write only: validation and other checks, feedback, playground runs on its bound services, and publish, lifecycle and drafts of definitions whose id starts with `smoke-`.
- Under `/operator` it reads only an allowlist, as an operator that is not admitted: `GET` on `/operator/tenants`, `operations`, `models`, `apis`, `plugins` (and `/operator/plugins/...`), `catalog` (and `/operator/catalog/...`), `tracing`, `quality` and `knowledge/engines`. Every other operator route, and every other method, answers 403 `urn:genai:problem:test-runner-scope`. It never opens support sessions, reads secrets, makes keys or registers clients.
- Creating it requires `expiresInDays` (1 to 90) and `callsPerMinute`.
- It still runs models only for its bound services.

A non-JWT bearer token is already read as an API key (`packages/identity/src/authenticate.ts:73`), so the browser layer puts the same key into the portal's and console's session storage and the screens load with real data.

The key lives in the GitHub environment `genki-test`, limited to `main`, as `SMOKE_API_KEY`. Writes go only to `smoke-*` objects, and the runner archives what it published in a `finally` step, also when checks fail.

Until the grant is deployed, the runner works with a plain service key: model runs, answers, sources and facets work, and the checks the key cannot reach (timelines, playground, validation, operator reads, screens with data) report `skip: credential` and turn themselves on when the routes answer.

## Layer 2: the deterministic suite

Checks are grouped. Every group has a baseline that runs on every deploy and a full set that runs when a merged pull request touches the group (Layer 3). Assertions are structural; answer wording is never asserted.

| Group         | Baseline                                                                                                                                                                                                                                                                                                                                                 | Full adds                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `platform`    | `/health` reports the deployed SHA and lockdown, `/openapi.json` has the same version, portal and console answer, `/v1/models` lists the plan's models. A closing `/health` that reports another version makes the run `partial`                                                                                                                         | nothing more                                                                          |
| `models`      | `model:<id>`: one short agent run per model on the service's own parameters (temperature, tools, request shape)                                                                                                                                                                                                                                          | the same run streamed                                                                 |
| `runs`        | `question:<id>`: every planned question (agent questions streamed, with steps, and retrieve-only questions); `sources:<id>`: one source per document in each cited answer                                                                                                                                                                                | nothing more                                                                          |
| `retrieval`   | `facets`: the organisations the detection questions name are facet values of the dataset                                                                                                                                                                                                                                                                 | nothing more                                                                          |
| `timeline`    | `timeline:<run>` for each question run and each unstreamed model run: completed, steps, input tokens, `stats.byModel`; a failed run shows the provider's status; detection tags as planned                                                                                                                                                               | timelines of the streamed model runs                                                  |
| `playground`  | `playground:options` lists the smoke service; `playground:<model>`: the playground on the published smoke service with each model, through the API; `screen:portal/playground-run`: the same in the browser, which fails when a `4xx` is shown as a timeout                                                                                              | nothing more                                                                          |
| `definitions` | `validate:smoke`: the published definition validates; `validate:unknown-strategy` gets `422` at the expected path; `lifecycle:throwaway`: publish `smoke-throwaway`, read it back, archive it                                                                                                                                                            | every refusal case (temperature, residency, iterations)                               |
| `portal`      | Overview, services, the smoke service and its test page, playground and log, in a browser                                                                                                                                                                                                                                                                | every listed portal screen                                                            |
| `console`     | The tenants and models screens; operator reads of tenants, models and operations; `/operator/running-tasks` answers 403 `urn:genai:problem:test-runner-scope`                                                                                                                                                                                            | every listed console screen, every allowed operator read, and the other refused reads |
| `access`      | Without a key `/v1` answers 401; the key gets 403 or 404 on another tenant's timeline, 403 publishing an id without `smoke-`, 403 on an operator write; in lockdown the key's own entry in the tenant's key list (`GET /tenants/{tenant}/access`), or its service's key list when it is bound, says `modelsInLockdown: true`; both expired-session pages | nothing more                                                                          |
| `feedback`    | `POST /api/feedback` up and down on a smoke run                                                                                                                                                                                                                                                                                                          | nothing more                                                                          |
| `language`    | A missing route in `nb` and in `en` gives different problem titles, and the `en` one has no Norwegian letters                                                                                                                                                                                                                                            | the portal overview and test page in English, with the same screen checks             |

Browser checks (Playwright, `playwright-core` with Chromium) visit each screen, wait for the network to settle, and fail on: a danger alert on the page, a known error text, a `5xx` from the API, a `4xx` other than `404`, an uncaught page error, or a missing main heading. Each screen leaves a screenshot and its visible text for Layer 4, except screens marked `personal` (the logs, the developer runs and the console's tenants), which show names and emails: those are checked but neither saved nor offered to the model. The access, queue, audit and tracing screens are left out for the same reason. The playground run also fails when the network shows a `4xx` and the page shows the "did not respond" text. A `403` with the problem type `urn:genai:problem:test-runner-scope` is the key's allowlist at work, not a failure, and the screen still fails on anything it shows. Console screens whose main data lies outside the allowlist (operations, policies, building blocks, search engines, shared services, settings) are left out: the console shows that refusal as the same generic load error as a real failure, so a check there could only pass by ignoring errors.

Known failures: a planned question may carry `knownIssue` (an issue number or a short reason). Its timeline check is reported as `known` and does not make the run red; when the check passes, it is reported as a pass, so the entry can be removed. A run that fails outright is never hidden by it.

Flakiness, unchanged from the first version: timeouts per request (30 s, 150 s for model runs), one retry 20 s later only for transient or model-dependent failures, `flaky` when fail-then-pass, `fail` when twice. Model checks stop at 14 minutes so the report always gets written. If `/health` does not report the expected SHA after ten polls, no model check runs; if it changes during the run (a new deploy), the run is `partial` with a note.

## Layer 3: checks targeted by pull request

Before the checks start, the runner finds the commits since the last green `smoke/genki-test` status and the pull requests merged in them (squash titles `(#N)`), and for each one reads its title, body, changed paths and diff from the GitHub API.

`scripts/smoke/groups.json` maps changed paths to groups, by path prefix (`packages/port-model/` to `models`, `apps/portal/` to `portal`, and so on):

- A pull request runs the full set of every group it touches.
- A path no rule maps runs every group in full: an unmapped change is treated as touching everything, so a new package is covered before anyone adds a rule.
- Docs and Markdown map to nothing; the smoke test's own files are ignored.
- A pull request with more files than GitHub lists counts as unmapped.

The summary lists, per group, the pull requests that made it run in full and the unmapped paths, so a missing rule is visible. When a check fails, the pull requests that touched its group are its suspects: a deterministic link, marked as suspected.

## Layer 4: model review

After the deterministic run, a model reviews it in two passes, with Claude on Azure AI Foundry through the same federated identity as the AI review (`anthropics/claude-code-action` with `use_foundry`).

1. **Propose.** The model gets the pull requests (bodies, paths, diffs), the targets and the check report, and proposes up to 8 extra checks for behaviour these pull requests change that the suite does not cover. It can only pick from a fixed toolbox of typed, safe actions:

   | Action          | Arguments                                                                           | What runs                                         |
   | --------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------- |
   | `ask`           | a variant of the smoke service, a question of up to 300 characters, streamed or not | one run of the smoke service, with its timeline   |
   | `playground`    | a listed model, a question                                                          | one playground run on the published smoke service |
   | `validate`      | a definition of up to 8000 characters whose id starts with `smoke-`                 | validation only, never publish                    |
   | `screen`        | portal or console, a listed screen, `nb` or `en`                                    | a browser visit with screenshot and text          |
   | `operator-read` | a listed operator read the key is allowed                                           | one read                                          |

   The runner validates every proposal against this list and the plan, drops anything else and says why. There is no free-form HTTP, no write outside `smoke-*`, and no action can name a URL. Proposed runs have their own budget, `maxKrExtra`, and run only if genki-test still reports the tested SHA.

2. **Judge.** A second pass gets everything: the pull requests, the full report, the timelines, answers, screen texts and screenshots, and the results of the proposed checks. It looks for what a structural check misses: an error in the wrong language, a misleading message, duplicate sources, a number that does not add up, a behaviour a pull request body promises that is not visible. It returns findings, each with evidence, the checks or screens it rests on, and the pull requests it suspects.

The model treats everything it reads as data. Pull request text, page content and answers are written by others and may try to instruct it, so:

- The prompt says so, and each pull request's text sits inside `<pull-request>` tags. The model's tools are `Read`, `Glob` and `Grep`, with reads of the Azure, Claude and system directories denied. It has no shell and no network, and its GitHub token can only read the repository.
- Its output is a fixed JSON schema. The runner validates proposals against the toolbox and keeps only findings whose checks and pull requests exist in this run.
- The model jobs never hold the smoke key, and the jobs that hold the key never run a model of ours.
- Before anything is posted, the report job removes anything shaped like a token or key from the model's text, and cuts each field to a fixed length. Findings never mention anyone.

Model choice: Sonnet (`claude-sonnet-5-5`) for both passes. Reading a long report and diffs and spotting what is off is within its reach, and it costs about 60 percent of Opus per token. Opus would add more reliable reasoning across a large diff and fewer false findings on subtle cases (a promised behaviour that only partly shows). Switching is one variable, `SMOKE_REVIEW_MODEL`.

## Layer 5: the experiment link

- Every finding, deterministic or from the model, carries suspected pull requests.
- A suspected pull request merged on or after 2026-11-09 whose AI review ran is listed in the issue as a candidate for `escaped`. "The AI review ran" means a `review` workflow run on its branch with a successful `review` job, in either arm.
- A person decides and applies the label; the workflow never labels.
- The report counts findings by layer: failed checks (deterministic) and model findings that no failed check already covers. Both counts go into the issue, the job summary and the report artifact (`counts.checks`, `counts.model`), so the experiment can measure each layer.

## Layer 6: cost and safety

Prices: genki's own `apps/api/config/local/prices.yaml` (Sweden Central). Claude on Foundry is assumed at USD 3 per million input tokens and 15 per million output tokens for Sonnet, and 5 and 25 for Opus; confirm on the Azure invoice. USD at 10.5 kr.

| Layer                              | Per run                         | Hard cap and what happens at it                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic, baseline            | about 1.8 kr (genki model runs) | `maxKrPerRun` 4 kr: a model check that would pass it is skipped (`skip: budget`), free checks still run                                                                                                                                                                                                                 |
| Deterministic, every group full    | about 2.2 kr                    | same cap                                                                                                                                                                                                                                                                                                                |
| Extra checks proposed by the model | at most 1 kr                    | `maxKrExtra` 1 kr and 8 checks; the rest are skipped and listed                                                                                                                                                                                                                                                         |
| Model review (Sonnet, two passes)  | about 15 kr (USD 1.4)           | 15 turns to propose, 30 to judge, at most 40,000 characters of diff per pull request and 30 pull requests. Runs only when at least one pull request was merged since the last green run, and on the first `SMOKE_REVIEW_MAX_PER_DAY` (default 3) smoke runs of the day; otherwise it is skipped and the summary says so |
| Model review on Opus instead       | about 25 kr                     | same caps                                                                                                                                                                                                                                                                                                               |
| Daily                              | at most 6 runs                  | `SMOKE_MAX_RUNS_PER_DAY`: past it, or if GitHub does not answer the count, only checks without a model run                                                                                                                                                                                                              |

At about three deploys a weekday (65 a month, about 45 with merged pull requests), the deterministic layer costs about 120 to 145 kr a month and the model review about 700 kr (Sonnet) or 1150 kr (Opus). The real cost of both passes, from the action's own report, is written into `assessment.json` and the job summary.

Concurrency: one `smoke` job at a time (`concurrency: smoke-genki-test`, never cancelled). The `extra` job has no concurrency group, so it can overlap with the next run's `smoke` job; both write only `smoke-*` objects. A deploy during a run is detected by the closing `/health` check and makes the run `partial`, and `extra` runs nothing if `/health` no longer reports the tested SHA. The smoke test never deploys and never blocks a deploy.

Secrets:

| Where                                      | What                                                                                                                                 | Who can use it                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Environment `genki-test` (branch `main`)   | `SMOKE_API_KEY`, the `test-runner` key                                                                                               | the `smoke` and `extra` jobs only                |
| Environment `smoke-review` (branch `main`) | no secrets; the federated credential subject `repo:digdir@51157288/genki@1411915404:environment:smoke-review` on the review identity | the `propose` and `judge` jobs, to reach Foundry |
| Repository                                 | the `AZURE_REVIEW_*` variables the AI review uses                                                                                    | read by the model jobs                           |

The report job gets `issues: write` and `statuses: write`, and no environment.

## Trigger and jobs

`smoke.yml` runs on `workflow_run` when `deploy` completes successfully on `main` after a dispatch, and on `workflow_dispatch` from `main` (inputs `tiers`: `free`, `cheap` or `all`; `sha`; `full`: run every group in full; `review`: run the model layer or not). It never runs on `pull_request`, and a `workflow_run` workflow always runs from the default branch's file.

| Job       | Environment    | Permissions                                                                | Does                                                                              |
| --------- | -------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `smoke`   | `genki-test`   | `contents: read`, `actions: read`, `pull-requests: read`, `statuses: read` | changes and targets, the deterministic suite with the browser, uploads the bundle |
| `propose` | `smoke-review` | `contents: read`, `id-token: write`                                        | the model proposes extra checks                                                   |
| `extra`   | `genki-test`   | `contents: read`                                                           | runs the accepted proposals, uploads their results                                |
| `judge`   | `smoke-review` | `contents: read`, `id-token: write`                                        | the model reviews everything and returns findings                                 |
| `report`  | none           | `contents: read`, `issues: write`, `statuses: write`                       | status, issue, escaped candidates, counts                                         |

## Reporting

- **Job summary**: every check with outcome, attempts, tokens, genki run ids and why it ran (baseline or which pull request), the targets, the model's findings and the counts.
- **Commit status** `smoke/genki-test` on the tested SHA: `failure` when a check failed or the smoke job crashed, `success` when every tier ran and no check failed or was skipped (flaky checks, known failures and checks the credential cannot reach yet do not count against it), none otherwise. It is the "last green" marker.
- **Issue**: one open issue labelled `smoke`. A failure, or a model finding of severity high, opens it or comments on it with the failing checks, the findings with their evidence, the suspect range and its pull requests, the `escaped` candidates and the counts. Suspects are always marked as suspected; the issue names a range and evidence, never a culprit. A green run with no high finding closes it.
- **Artifacts**: `smoke-bundle` (report, timelines, answers, screen texts and screenshots, pull requests), `smoke-proposals` and `smoke-judged` (the model's output and cost), `smoke-extra` (the proposed checks' results) and `smoke-assessment` (findings, counts, escaped candidates and model cost), kept 30 days.

## Where the code lives

| Path                               | What                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `.github/workflows/smoke.yml`      | Trigger, environments and the five jobs                                                   |
| `scripts/smoke/smoke-service.yaml` | The smoke service definition                                                              |
| `scripts/smoke/plan.json`          | Models, prices, questions, screens, operator reads, refusal cases, known issues           |
| `scripts/smoke/groups.json`        | Paths to check groups                                                                     |
| `scripts/smoke/assess.ts`          | Pure assertions and the retry, budget and deadline rules                                  |
| `scripts/smoke/changes.ts`         | The range since the last green run, its pull requests, AI review and targets              |
| `scripts/smoke/review.ts`          | The toolbox, proposal validation, findings, escaped candidates and counts                 |
| `scripts/smoke/browser.ts`         | The browser checks                                                                        |
| `scripts/smoke/run.ts`             | The deterministic run and the bundle                                                      |
| `scripts/smoke/extra.ts`           | Runs the accepted proposals                                                               |
| `scripts/smoke/model-output.ts`    | Takes the model's structured output and cost from the action's execution file             |
| `scripts/smoke/prompts/`           | The instructions for the propose and judge passes                                         |
| `scripts/smoke/report.ts`          | Status, issue and summary                                                                 |
| `scripts/smoke/*.test.ts`          | Tests for the pure parts, the workflow's permissions, and the definition against the plan |

Run it from a laptop against genki-test, with the key in your own environment:

```sh
SMOKE_TIERS=free node scripts/smoke/run.ts
```

## Setting it up

1. Merge the `test-runner` grant pull request and deploy it.
2. Check with `list_models` that each model id in `plan.json` exists on genki-test, then publish `scripts/smoke/smoke-service.yaml` in the platform organisation.
3. Signed in to the portal with Entra ID, create a tenant-wide key under Utvikler, API-nøkler (no service binding) with the `test-runner` grant, `callsPerMinute: 30` and `expiresInDays: 90`. It must reach every service, or the playground checks cannot run. The key expires after 90 days at most, so rotate it by then: create a new one and replace `SMOKE_API_KEY`.
4. Create the environment `genki-test` with deployment branches set to the selected branch `main`, then add the key as `SMOKE_API_KEY`.
5. Create the environment `smoke-review`, branch `main`, and add a federated credential with the subject `repo:digdir@51157288/genki@1411915404:environment:smoke-review` to the managed identity the AI review uses (`id-genki-review`, client id in `AZURE_REVIEW_CLIENT_ID`). The repository issues subjects with owner and repository ids, as the review's existing `pull_request` credential does. Its role on the Foundry resource already covers `claude-sonnet-5-5`.
6. Optionally set `SMOKE_MAX_RUNS_PER_DAY`, `SMOKE_REVIEW_MAX_PER_DAY`, `SMOKE_REVIEW_MODEL` and the URLs.
7. Dispatch `smoke` with `tiers: free` and `review: false`, then `all` with `review: true`.

## Decisions

- The `test-runner` grant changes what an API key may do and amends ADR 0033 and ADR 0008, in its own pull request. This workflow needs no ADR of its own.
- The Maskinporten gap is fixed before anyone sets `MASKINPORTEN_JWKS_URI`.
- Sources repeated per chunk fail on main today. File an issue and put its number in `plan.json` as `knownIssue`, or fix `answerSourcesOf`; until then the first runs are red on `sources:*`.
- The console session oddity: the expired-session checks pass on 96305c01. Say what was seen (a screen error, a blank page, a login loop, the session ending too soon), and the check gets the step that reproduces it.
- The feedback check leaves two ratings on a smoke run each time, about 130 a month, all on the `smoke` service.
