# 0039 Evaluating with Langfuse

Status: proposed, 2026-10-22

Amends 0003, 0011 and 0024. Touches 0015, 0022, 0023 and 0027.

## Context

The platform runs, judges and gates its own evaluations (ADR 0003). Some teams already judge answers in Langfuse, and a proposal asked to let Langfuse run evaluations and experiments while the results and runs stay available in the platform. Langfuse 4.4.0, the version the self-hosted instance runs, scores a trace a few seconds after it arrives, cannot be asked to run a judge on request and announces no new scores. Its trace deletion leaves copies of the text behind. The behaviour this record relies on was measured against a local Langfuse 4.4.0.

## Decision

**The platform stays the default and the record.**

- Every eval run is started by the platform, answered by the service under test and recorded as an `EvalRun`. Publishing gates read only the platform's records.
- Langfuse is optional and chosen per judge. An eval run lists its judges, and any of them may be a Langfuse judge, for example `contract`, `retrieval` and `langfuse:kudos_quotes_covered`.

**Connections per tenant.**

- A tenant has one or more Langfuse connections. Each has a host, a public key, a secret key as a `secret://` reference (ADR 0015), the services it covers and whether it receives content, and points to one Langfuse project.
- The default host is Digdir's instance. There each tenant has its own Langfuse organisation and sets up the organisation, projects and keys itself. Without an enterprise licence the organisation is the only access boundary Langfuse enforces. A tenant may instead enter its own Langfuse.
- Every call to a connection's host (export, score reads, snapshots, dataset reads and deletes) goes through the isolated egress path of ADR 0015, with the host as the tenant's allow list: HTTPS only, no private or link-local addresses, no access to the platform's network, and limits on response size and time.
- The platform-wide exporter (`TRACES_ENDPOINT`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`) carries Digdir's operational traces with metadata only. `TRACES_CONTENT` is honoured only in development mode (`GENAI_DEV_MODE=true`). Eval runs and judging use only a tenant's connection.

**Deferred judges: `evaluator@2`.**

- The evaluator contract becomes `evaluator@2` and replaces `evaluator@1`. An evaluator returns its scores at once or answers `pending`, and the runner collects pending scores later. One contract suite tests both paths.
- A Langfuse judge is a built-in evaluator of this kind. Its identity is `langfuse:<name>@v<version>+<model>`.
- A Langfuse judge must name its model. A judge that falls back to the project's or the organisation's default model is refused when it is added to a run, because a default cannot be read through Langfuse's API. Like every model-based judge (ADR 0003), it can block a publish only when that model is from another family than every model that wrote the answer.
- A judge whose mapping reads a field the platform does not send, such as tool calls or a metadata key the platform does not produce, is refused when it is added to a run.
- At the start of a run the platform takes a snapshot of the Langfuse evaluation rule, its variable mapping, the evaluator version it points to and the named model (`GET /api/public/unstable/evaluation-rules/{id}`, `GET /api/public/unstable/evaluators/{id}`). If any of them differs when the scores are collected, those scores are marked `judge changed` and cannot block a publish.

**What an eval run sends.**

- A run goes to the tenant's Langfuse when it uses a Langfuse judge. Otherwise it goes only when the run asks for it with `trace: true`, which the portal shows as a checkbox, unticked by default.
- A run is one Langfuse experiment (Langfuse's word for a single run), with no Langfuse dataset. Each case of each repeat is its own Langfuse trace and experiment item, with the item id `<case>#<repeat>`: the exporter starts a new trace at a case's task, although that task is a sub-task of the run's task.
- The evaluation context (run, case, repeat, split and what the case expects) is recorded beside the case task's input, not in it. The kernel keeps it as its own audit field. The strategy never receives it, and the trace input, the timeline and every other reader of the task's input leave it out. The exporter sends from it only what the judges map.
- Only train and validation cases are sent. A Langfuse judge's score on a holdout case is not applicable, never pending, so a run never waits for it. A gate on the holdout split (`split: holdout`) cannot use a Langfuse judge's metric: the service definition is refused.
- Text is sent only on a connection that receives content, and only the fields the run's Langfuse judges map, read from the snapshot of their rules: the question and the answer, and the cited sources, the retrieved documents, the case's `expected.criteria` or the case's metadata when a judge maps them. A field no judge maps is not sent, so a run whose judges only check the answer key sends no documents.

**Collecting scores.**

- While scores are pending, the run is `waiting for scores`. The platform reads the run's scores in pages (`GET /api/public/v3/scores?experimentId=…&fields=details,subject`) and maps each one to its case and repeat by trace id.
- Only scores whose `metadata.job_configuration_id` is the snapshotted rule count. A score with the same name from another rule is ignored.
- The wait lasts at most 5 minutes from when the run's last case was sent. A score still missing then makes the gate fail with a reason, such as `no score from langfuse:kudos_quotes_covered for 20 of 84 cases`. The platform never averages over the scores that arrived and never falls back to another judge.
- A boolean score becomes 1 or 0. A numeric score is scaled to the range 0 to 1 with its score config's minimum and maximum. A categorical score, or a numeric one without both bounds, is shown but cannot block.
- A score is not applicable when a field the judge's mapping reads is empty for the case, or when the connection does not receive content. Langfuse fills a missing variable with empty text and still scores it.
- Scores are written as `kernel.score` events on the case's task (`Kernel.annotate`) and into the `EvalRun`, whose provenance lists the judge's identity. The judge's reason may quote the answer, so it follows the case's retention (ADR 0011).

**Labels from Langfuse.**

- A score with source `ANNOTATION` whose score config has a judge's exact name and type becomes a calibration label: a `JudgeLabel` record with the annotation as `humanLabel` and that judge's own score on the same case as `judgeLabel`. Numeric scores are split at 0.5 into good and bad first. A label with no matching judge score is counted as unpaired, never guessed.
- Labels from Langfuse arrive as pending. They count only after a person with the labelling right (`platform.judge.label`) accepts the batch with a reason, which is written to the audit log.
- The labeller is stored as a pseudonym per tenant, derived from the Langfuse user id. Labels on traces that are not cases of an eval run are ignored. The console's label queue stays, and both feed the same label store.

**Importing a Langfuse dataset.**

- An import reads the dataset as it stood at one time (`GET /api/public/dataset-items?datasetName=…&version=…`), and only into the tenant that owns the connection.
- Every item goes through the candidate review of ADR 0011 (anonymisation, human review, expiry). The import is reviewed as one batch and becomes one new test set version, whose provenance names the dataset and the time. Nothing is kept in sync.
- Imported cases go to train or validation, never holdout, since the items have been visible in Langfuse. The items' `expectedOutput` fields become the cases' `expected.criteria`. The portal's import of test cases from a file is not affected.

**Erasure.**

- The platform records the id of every trace it sends to a sink, and of every judge trace it finds for them. The ids are metadata and are kept until each delete is confirmed.
- When the nightly purge or any other erasure removes a case's task, the platform queues the deletion of its traces in the sink. For each case trace it first finds the judges' execution traces, then deletes them, then deletes the case's trace (`DELETE /api/public/traces/{traceId}`).
  - It finds judge traces through the scores on the case's trace (`metadata.job_execution_id`, whose trace id is the first 32 hex characters of `sha256(job_execution_id)`) and through traces whose metadata names the case's trace (`target_trace_id`), so a judge call that wrote no score is found too.
  - After the deletes it checks that no trace with the case's trace as target remains.
- A failed delete is retried and does not hold back the purge in the platform. A delete that keeps failing, for example because the connection was removed or its secret rotated, is reported to operators.
- A connection receives content only when ADR 0011's conditions for content-receiving sinks hold. In development mode a Langfuse on the developer's own machine is exempt from the 7-day rule, for made-up test sets only.

## Why

- Teams get Langfuse's judges, comparison views and annotation queues, while the publishing decision, the run record and the holdout stay in the platform.
- Langfuse's API cannot delete its raw ingestion files or the judge's input copies, so only a storage lifecycle rule removes them. That is why a sink that receives content must keep them at most 7 days (ADR 0011).
- Turned down:
  - **Langfuse runs the evaluations on its own model connections.** It would judge a prompt and a model, not the service with its search and steps, and the gate would depend on a second source of truth.
  - **Langfuse's experiment runner calls the platform as the task.** The platform would no longer start, record or gate its own runs.
  - **Mirroring test sets into Langfuse datasets.** A second copy drifts.
  - **One Langfuse project for every tenant.** Without an enterprise licence every member of an organisation sees all its projects, and an experiment judge scores every experiment in its project.
  - **Judges on runs without text.** A Langfuse judge with no input answers `true` on nothing.
  - **A separate plug-in kind for deferred judges.** That makes two contracts for one idea, while the platform is not in production and can change `evaluator@1`.
  - **Langfuse labels counting at once.** Anyone in a Langfuse organisation can annotate, so labels that decide whether a judge may block need the platform's labelling right.

## Consequences

- Not built. Building it needs:
  - `evaluator@2` and its contract suite, and the `waiting for scores` state in `EvalRun`
  - the tenant connections through the egress path
  - the kernel change that records the evaluation context beside the input, and readers that leave it out
  - per-case traces under a run
  - the experiment export, the score collector, the label import with approval and the dataset import
  - the sink deletion queue
  - limiting `TRACES_CONTENT` to development mode
- Plug-ins registered as `evaluator@1` are refused until they are registered again under `evaluator@2`. The platform is not in production, so no stored registration is migrated.
- It depends on Langfuse's `unstable` evaluator API in version 4.4.0, which Langfuse says may change. Version 4.67.0 no longer has it: it has `/api/public/v2/evaluators` and `/api/public/v2/evaluation-rules` instead. The instance's UI already offers 4.67.0, so the judge snapshot moves to the new API before or with an upgrade, and the rest of this record is checked against the new version.
- Two Langfuse internals were seen in 4.4.0 but are not documented: the judge trace id rule and `target_trace_id` in a judge trace's metadata. Finding judge traces by `target_trace_id` through the public API is not yet verified. Both are checked against each Langfuse version.
- An experiment judge in Langfuse can only be limited to a dataset, so it scores every experiment in its project. A tenant whose services need different judges uses one connection and project per service.
- Labelling is an operator right today (ADR 0027). Whether agencies get it is not decided here.
- The portal changes:
  - the Tracing screen manages a tenant's connections and brings labels back as pending calibration labels, not feedback
  - the Quality screen shows Langfuse scores and links to the experiment
  - a run started in the portal can be sent to Langfuse with a checkbox
- The operator of a Langfuse that receives content must meet ADR 0011's conditions.
- Langfuse hides deleted rows in ClickHouse at once and removes them from disk later. The platform cannot speed that up.
- Every rule gets a test that names it when it is built.
