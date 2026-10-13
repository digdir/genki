# 0003 Evaluation is part of the platform

Status: accepted, 2026-10-12 (built). Proposed 2026-10-06

## Decision

- An evaluation run is a task. It invokes the service under test for each case, like any other caller.
- Evaluators are a plugin type next to strategies: deterministic, model-based or human.
- Test sets are versioned records owned by a tenant, with cases split into train, validation and locked. Optimisers never see the locked split.
- Scores and feedback are `kernel.score` and `kernel.feedback` events on the task they judge, added with `Kernel.annotate`.
- Publishing gates live in the service definition. A version with a failing gate cannot be published to production.
- Every result records the code version, the data, the served model and the judge, so only like is compared with like.

## Why

headless-rag's golden sets, judge and findings are the most valuable thing it has, and its worst measurement errors came from silent fallbacks and comparing runs taken on different code or models.

## Consequences

- The parity gate, publishing gates and the improvement loop share one mechanism.
- A judge cannot block a publish until it has been calibrated against human ratings.
- The harness fails loudly when anything it needs is missing.
