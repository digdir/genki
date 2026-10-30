# 0040 Evaluating with Langfuse

Status: accepted, 2026-10-29 (partly built, 2026-10-30; the section "Langfuse judges that block" stays proposed). Proposed 2026-10-22

Amends 0003, 0011 and 0024. Touches 0015, 0021, 0022, 0023 and 0027.

## Context

The platform runs, judges and gates its own evaluations (ADR 0003). Some teams already judge answers in Langfuse, and a proposal asked to let Langfuse run evaluations and experiments while the results and runs stay available in the platform. Langfuse 4.4.0, the version the self-hosted instance runs, scores a trace a few seconds after it arrives, cannot be asked to run a judge on request and announces no new scores. Its trace deletion leaves copies of the text behind. The behaviour this record relies on was measured against a local Langfuse 4.4.0.

## Decision

**The platform stays the default and the record.**

- Every eval run is started by the platform, answered by the service under test and recorded as an `EvalRun`. Publishing gates read only the platform's records.
- Langfuse is optional and chosen per judge. An eval run lists its judges, and any of them may be a Langfuse judge, for example `contract`, `retrieval` and `langfuse:kudos_quotes_covered`. A Langfuse judge is named as it is in the project of the connection that covers the service.
- A Langfuse judge is advisory. Its scores are recorded on the run and shown in the portal, and never block a publish: a service definition with a gate whose metric comes from a Langfuse judge is refused. Langfuse judges that block are a separate proposal, below.

**Connections per tenant.**

- A tenant has one or more Langfuse connections. Each has an id, a host, a public key, a secret key as a `secret://` reference (ADR 0015), the services it covers, a residency and whether it receives content, and points to one Langfuse project. A service is covered by at most one connection.
- **Residency.** A connection's residency (`norway`, `eu` or `global`, as for models in ADR 0021) covers both where its host stores what it receives and where its judges' models run, since a judge reads the question, the answer and the sources.
  - A new connection to Digdir's instance starts as `global`, and an operator sets its residency once both places are known. For a Langfuse the tenant runs itself, the tenant's declaration is enough, as for erasure (ADR 0011).
  - A run sends to a connection, and may use its judges, only when the service's residency allows the connection's. Otherwise a Langfuse judge is refused when it is added to the run, and so is `trace: true`.
  - When measured, the judges on Digdir's instance answered from Sweden Central, so a `norway` service cannot use them.
- **Access on Digdir's instance.** The default host is Digdir's instance. There each tenant has its own Langfuse organisation, which is the only access boundary Langfuse enforces without an enterprise licence.
  - A Digdir operator creates the organisation when the tenant asks, and invites the owner the tenant names.
  - The owner sets up the projects, judges and keys, and invites and removes the tenant's other members.
  - Langfuse accounts are separate from the platform's sign-in and are not tied to Altinn rights. Nothing done in Langfuse decides a publish on its own: Langfuse judges are advisory, and labels made there count only after a person with the labelling right accepts them in the platform.
- A tenant may instead enter its own Langfuse.
- Every call to a connection's host (export, score reads, snapshots, dataset reads and deletes) goes through the isolated egress path of ADR 0015, with the host as the tenant's allow list: HTTPS only, no private or link-local addresses, no access to the platform's network, and limits on response size and time.
- **Eval runs only.** A tenant's connection carries eval runs and their judging, never live answers. The platform-wide exporter (`TRACES_ENDPOINT`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`) carries Digdir's operational traces with metadata only. `TRACES_CONTENT` is honoured only in development mode (`GENAI_DEV_MODE=true`).

**Deferred judges: `evaluator@2`.**

- The evaluator contract becomes `evaluator@2` and replaces `evaluator@1`. An evaluator returns its scores at once or answers `pending`, and the runner collects pending scores later. One contract suite tests both paths.
- A Langfuse judge is a built-in evaluator of this kind. Its identity is `langfuse:<tenant>/<connection>/<name>@v<version>+<model>`, for example `langfuse:dfo/kudos/kudos_quotes_covered@v3+gpt-4.1`. Langfuse names judges within a project, so two tenants, or two projects of one tenant, can each have a judge called `kudos_quotes_covered` with its own prompt. With the tenant and the connection in the identity, the results and calibration labels of one never count for the other.
- A Langfuse judge must name its model. A judge that falls back to the project's or the organisation's default model is refused when it is added to a run, because a default cannot be read through Langfuse's API.
- A judge whose mapping reads a field the platform does not send, such as tool calls or a metadata key the platform does not produce, is refused when it is added to a run.
- At the start of a run the platform takes a snapshot of the Langfuse evaluation rule, its variable mapping, the evaluator version it points to and the named model (`GET /api/public/unstable/evaluation-rules/{id}`, `GET /api/public/unstable/evaluators/{id}`). If any of them differs when the scores are collected, those scores are marked `judge changed`.

**What an eval run sends.**

- A run goes to the tenant's Langfuse when it uses a Langfuse judge. Otherwise it goes only when the run asks for it with `trace: true`, which the portal shows as a checkbox, unticked by default.
- A run is one Langfuse experiment (Langfuse's word for a single run), with no Langfuse dataset. Each case of each repeat is its own Langfuse trace and experiment item, with the item id `<case>#<repeat>`: the exporter starts a new trace at a case's task, although that task is a sub-task of the run's task.
- The evaluation context (run, case, repeat, split and what the case expects) is recorded beside the case task's input, not in it. The kernel keeps it as its own audit field. The strategy never receives it, and the trace input, the timeline and every other reader of the task's input leave it out. The exporter sends from it only what the judges map.
- Only train and validation cases are sent. A Langfuse judge's score on a holdout case is not applicable, never pending, so a run never waits for it.
- Text is sent only on a connection that receives content, and only the fields the run's Langfuse judges map, read from the snapshot of their rules: the question and the answer, and the cited sources, the retrieved documents, the case's `expected.criteria` or the case's metadata when a judge maps them. A field no judge maps is not sent, so a run whose judges only check the answer key sends no documents.

**Collecting scores.**

- While scores are pending, the run is `waiting for scores`. The platform reads the run's scores in pages (`GET /api/public/v3/scores?experimentId=…&fields=details,subject`) and maps each one to its case and repeat by trace id.
- The wait runs inside the eval run's background lease, like its cases. A restart during the wait interrupts the run, as a restart during its cases does today.
- Only scores whose `metadata.job_configuration_id` is the snapshotted rule count. A score with the same name from another rule is ignored.
- The wait lasts at most 5 minutes from when the run's last case was sent. A score still missing then is recorded as missing, and the run shows the judge's result as incomplete with a reason, such as `no score from langfuse:kudos_quotes_covered for 20 of 84 cases`. The platform never falls back to another judge.
- A boolean score becomes 1 or 0. A numeric score is scaled to the range 0 to 1 with its score config's minimum and maximum. A categorical score, or a numeric one without both bounds, is shown as it came.
- A score is not applicable when a field the judge's mapping reads is empty for the case, or when the connection does not receive content. Langfuse fills a missing variable with empty text and still scores it.
- Scores are written as `kernel.score` events on the case's task (`Kernel.annotate`) and into the `EvalRun`, whose provenance lists the judge's identity. The judge's reason may quote the answer, so it follows the case's retention (ADR 0011).
- **Judge cost.** In the same pass the platform reads the judges' generations (`GET /api/public/observations?type=GENERATION&environment=langfuse-llm-as-a-judge`, in pages) and keeps those in the judge traces it found for the run's cases, as for erasure. It stores each judge's tokens and Langfuse's cost in USD on the run, with the rate used to show kroner (ADR 0038), marked as reported by Langfuse. The cost is shown beside the platform's own and does not count against the tenant's quota. Langfuse prices a call only when the model name the call reports matches its price table; otherwise only the tokens are stored.

**Labels from Langfuse.**

- A score with source `ANNOTATION` whose score config has a judge's exact name and type becomes a calibration label: a `JudgeLabel` record under that judge's identity, with the annotation as `humanLabel` and that judge's own score on the same case as `judgeLabel`. Numeric scores are split at 0.5 into good and bad first. A label with no matching judge score is counted as unpaired, never guessed.
- Labels from Langfuse arrive as pending. They count only after a person with the labelling right (`platform.judge.label`) accepts the batch with a reason, which is written to the audit log.
- A Langfuse judge's agreement with its accepted labels is shown beside its scores.
- The labeller is stored as a pseudonym per tenant, derived from the Langfuse user id. Labels on traces that are not cases of an eval run are ignored. The console's label queue stays, and both feed the same label store.

**Importing a Langfuse dataset.**

- An import reads the dataset as it stood at one time (`GET /api/public/dataset-items?datasetName=…&version=…`), and only into the tenant that owns the connection.
- Every item goes through the candidate review of ADR 0011 (anonymisation, human review, expiry). The import is reviewed as one batch and becomes one new test set version, whose provenance names the dataset and the time. Nothing is kept in sync.
- Imported cases go to train or validation, never holdout, since the items have been visible in Langfuse. The items' `expectedOutput` fields become the cases' `expected.criteria`. The portal's import of test cases from a file is not affected.

**Erasure.**

- The platform records the id of every trace it sends to a sink, and of every judge trace it finds for them. The ids are metadata and are kept until each delete is confirmed.
- When the nightly purge or any other erasure removes a case's task, the platform records the deletion of its traces in the sink as pending, in the database. The nightly purge works through the pending deletes. For each case trace it first finds the judges' execution traces, then deletes them, then deletes the case's trace (`DELETE /api/public/traces/{traceId}`).
  - It finds judge traces through the scores on the case's trace (`metadata.job_execution_id`, whose trace id is the first 32 hex characters of `sha256(job_execution_id)`) and through traces whose metadata names the case's trace (`target_trace_id`), so a judge call that wrote no score is found too.
  - After the deletes it checks that no trace with the case's trace as target remains.
- A failed delete stays pending and is tried again the next night, without holding back the purge in the platform. A delete that keeps failing, for example because the connection's secret was rotated, is reported to operators, and the connection shows as failing.
- Removing a connection that has received traces first marks every trace sent through it for deletion. While it is being removed it covers no service and nothing is sent to it, and it is gone once the purge has confirmed every delete, so removing a connection never leaves text in the sink. While deletes are owed, its host and project cannot change; a new secret for the same project can be set.
- A connection receives content only when ADR 0011's conditions for content-receiving sinks hold. In development mode a Langfuse on the developer's own machine is exempt from the 7-day rule, for made-up test sets only.

## Langfuse judges that block (proposed separately)

Accepting this record does not let a Langfuse judge block a publish. That needs a decision of its own on these conditions, and the catalog condition has no answer yet:

- **Spend.** The judge's reported cost (see "Judge cost" above) counts against the tenant's quota, and a run does not start once the quota is spent. The platform's own model calls are also metered after each call (ADR 0021), so reported cost is enough as long as every call is priced: a judge whose model Langfuse does not price cannot block. A key per tenant with a budget from the AI Gateway (ADR 0038), set as the project's model connection, is another way.
- **Catalog.** The judge's model is a model in the platform's catalog, so the checks the platform makes on a service's own models (residency, approved models under ADR 0023, model family) apply to it. A model name typed in Langfuse says nothing certain about the deployment behind it.
- **Calibration.** The judge meets ADR 0003's calibration rule on its own identity's accepted labels, and its model is from another family than every model that wrote the answer.
- **Complete, comparable scores.** Only boolean scores and numeric scores with both bounds can block, and only from an unchanged judge (`judge changed` never blocks). A score still missing after the wait makes the gate fail with its reason, and the gate never averages over the scores that arrived.
- **Holdout.** A gate on the holdout split (`split: holdout`) never uses a Langfuse judge's metric, since holdout cases are never sent.
- **A wait that survives restarts.** The wait for scores is a durable job, so a deploy never loses the scores a gate reads (ADR 0041, durable jobs on pg-boss, proposed in [PR 179](https://github.com/digdir/genki/pull/179)).

## Why

- Teams get Langfuse's judges, comparison views and annotation queues, while the publishing decision, the run record and the holdout stay in the platform.
- **Advisory first.** Scores from Langfuse judges can show in the platform now. A judge that blocks also needs its cost counted against the quota and its model checked against the catalog. Langfuse reports the cost, but the catalog check has no answer yet, so blocking waits for its own decision.
- **Residency follows the text.** A judge reads the question, the answer and the sources, so where its model runs and where Langfuse stores the trace are places the service's text goes.
- **The tenant and the connection are part of a judge's identity.** Calibration labels pool by identity, and a name alone would let one tenant's labels decide whether another tenant's judge may block.
- **No durable jobs yet.** While Langfuse judges are advisory, a restart during the wait loses only scores that cannot block, and a restart already interrupts a run during its cases. Deletes must survive restarts, but the nightly purge already runs every night on one worker, so pending deletes in the database need no job queue.
- **Operators create organisations.** The organisation is the only boundary between tenants on Digdir's instance. Whether Langfuse 4.4.0 can create organisations through an API, or limit who creates them without a licence, has not been checked. Creating them by hand keeps Digdir in control of who owns each one.
- Langfuse's API cannot delete its raw ingestion files or the judge's input copies, so only a storage lifecycle rule removes them. That is why a sink that receives content must keep them at most 7 days (ADR 0011).
- Turned down:
  - **Langfuse runs the evaluations on its own model connections.** It would judge a prompt and a model, not the service with its search and steps, and the gate would depend on a second source of truth.
  - **Langfuse's experiment runner calls the platform as the task.** The platform would no longer start, record or gate its own runs.
  - **Mirroring test sets into Langfuse datasets.** A second copy drifts.
  - **One Langfuse project for every tenant.** Without an enterprise licence every member of an organisation sees all its projects, and an experiment judge scores every experiment in its project.
  - **Judges on runs without text.** A Langfuse judge with no input answers `true` on nothing.
  - **A separate plug-in kind for deferred judges.** That makes two contracts for one idea, while the platform is not in production and can change `evaluator@1`.
  - **Langfuse labels counting at once.** Anyone in a Langfuse organisation can annotate, so labels that decide whether a judge may block need the platform's labelling right.
  - **Mapping Altinn rights onto Langfuse membership.** Langfuse has its own accounts and roles. The platform's rights decide what counts in the platform, such as accepting labels and publishing.
  - **Live answers on a tenant's connection.** It would widen the pending deletes from eval cases to every live answer.

## Consequences

- Partly built. Built: `evaluator@2` and its contract suite with the `waiting for scores` state in `EvalRun`; the tenant connections through the egress path, with their residency checked when a run starts; the kernel change that records the evaluation context beside the input, with readers that leave it out; per-case traces under a run and the experiment export; the pending sink deletes and their pass after the nightly purge, and removing a connection by deleting first; limiting `TRACES_CONTENT` to development mode. Not built yet:
  - refusing service definitions whose gates use a Langfuse judge's metric
  - the score collector with judge cost inside the run's lease, the label import with approval and the dataset import
  - pending sink deletes after an erasure other than the nightly purge
- Before agency data goes to Digdir's instance:
  - whose model key an agency's judges use there, and so who pays for their calls, is decided. The cost of each judge call is readable (about USD 0.008 per call on `claude-sonnet-5` at Langfuse's list price, measured on Digdir's instance on 2026-10-29), so Digdir's key with the cost shown per tenant is an option beside each tenant's own key.
  - where the instance stores what it receives is confirmed, so operators can set its connections' residency
  - the judge trace id rule and filtering traces by `target_trace_id` through the public API are verified against the instance's version, so the purge can show that nothing of a case is left. Until then no connection to the instance receives content.
  - the items in [epic 93](https://github.com/digdir/genki/issues/93): the 7-day lifecycle rule on its raw files, confirmed deployment types for its judge models and a data-protection assessment
- Operators create organisations on Digdir's instance by hand. Each organisation's owner manages its members in Langfuse, including removing people who leave the tenant. The platform does not see Langfuse membership.
- Plug-ins registered as `evaluator@1` are refused until they are registered again under `evaluator@2`. The platform is not in production, so no stored registration is migrated.
- It depends on Langfuse's `unstable` evaluator API in version 4.4.0, which Langfuse says may change. Version 4.67.0 no longer has it: it has `/api/public/v2/evaluators` and `/api/public/v2/evaluation-rules` instead. The instance's UI already offers 4.67.0, so the judge snapshot moves to the new API before or with an upgrade, and the rest of this record is checked against the new version.
- Two Langfuse internals were seen in 4.4.0 but are not documented: the judge trace id rule, and `target_trace_id` and `job_configuration_id` in a judge trace's metadata, which the public API returns (seen on Digdir's instance on 2026-10-29). Filtering traces by `target_trace_id` through the public API is not yet verified (see "Before agency data goes to Digdir's instance"). Both are checked against each Langfuse version.
- An experiment judge in Langfuse can only be limited to a dataset, so it scores every experiment in its project. A tenant whose services need different judges uses one connection and project per service.
- Labelling is an operator right today (ADR 0027). Whether agencies get it is not decided here.
- The portal changes:
  - the Tracing screen manages a tenant's connections, shows each one's residency and brings labels back as pending calibration labels, not feedback
  - the Quality screen shows Langfuse scores as advisory, with each judge's agreement with its labels and its reported cost, and links to the experiment
  - a run started in the portal can be sent to Langfuse with a checkbox
- The operator of a Langfuse that receives content must meet ADR 0011's conditions.
- Langfuse hides deleted rows in ClickHouse at once and removes them from disk later. The platform cannot speed that up.
- Every rule gets a test that names it when it is built.
