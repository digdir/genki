# 0003 Evaluation is part of the platform

Status: accepted, 2026-10-12 (built; test runs as experiments in the trace sink, 2026-10-21). Proposed 2026-10-06

## Decision

- An evaluation run is a task. It invokes the service under test for each case, like any other caller.
- Evaluators are a plugin type next to strategies: deterministic, model-based or human.
- Test sets are versioned records owned by a tenant, with cases split into train, validation and locked. Optimisers never see the locked split.
- Scores and feedback are `kernel.score` and `kernel.feedback` events on the task they judge, added with `Kernel.annotate`.
- Publishing gates live in the service definition. A version with a failing gate cannot be published to production.
- Every result records the code version, the data, the served model and the judge, so only like is compared with like.

## Test runs in the trace sink

- **A case knows which run it belongs to.** A test run of a service passes an evaluation context with each case it invokes (`InvokeOptions.evaluation`, type `EvaluationContext` in `@genai/contracts`): the run's id, a name (test set and version, service and version, start time) and metadata, the case id, what the case expects (`expected` with its type, grounding and language) and the case's metadata (split, tags).
- **The kernel records it with the input, not in it.** It goes on the task's `kernel.task.input` audit event next to the input. The strategy never receives it, so what a case expects cannot reach the model.
- **The trace exporter sends a run as one experiment.** A task with an evaluation context becomes one item of a Langfuse experiment: one experiment per run, one trace and one item per case, and no Langfuse dataset. Every span of the case's trace, including spans of tasks it spawns, carries the experiment and item ids (`langfuse.experiment.*`), so Langfuse counts one item per case. The case's root span carries the item's metadata, and what the case expects only when the connection opts in to content (ADR 0011). A test case is never sampled out, so a run reaches the sink whole.
- **Judges for these experiments live in Langfuse.** The service's owners set them up there. The platform's own grading and its publishing gates are unchanged and do not read scores from the sink.

## Why

headless-rag's golden sets, judge and findings are the most valuable thing it has, and its worst measurement errors came from silent fallbacks and comparing runs taken on different code or models.

Teams already judge answers in Langfuse. Sending a test run as an experiment lets them use those judges on the platform's own test sets, with the test set as the only source of the cases. A dataset mirrored into Langfuse was turned down: it is a second copy that can drift, and linking runs to it needs the API Langfuse has deprecated. Adding the context after the run, with an annotation, was turned down because a task's spans are built when it ends, before an annotation can arrive. Putting the context in the input was turned down because the strategy, and through it the model, would see what the case expects.

## Consequences

- The parity gate, publishing gates and the improvement loop share one mechanism.
- A judge cannot block a publish until it has been calibrated against human ratings.
- The harness fails loudly when anything it needs is missing.
- Experiments are only as complete as the trace export. Without `TRACES_CONTENT=true` an item has no input, answer or expected result, and a judge has nothing to read.
- A Langfuse judge on experiments can only filter on a dataset. A judge set up for these runs, which have none, also runs on every other experiment in the same Langfuse project.
- Only runs started as test runs of a service carry the context. Runs inside the improvement loop, the model matrix and the eval capability are traced as ordinary tasks.
- Tests: `records what a test case expects with the input, without showing it to the strategy` (kernel), `runs each case as a task that records the run and what the case expects, which the model never sees` (quality), and the three tests under `trace exporter for a test case` (trace exporter).
