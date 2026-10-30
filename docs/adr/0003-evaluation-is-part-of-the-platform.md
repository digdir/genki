# 0003 Evaluation is part of the platform

Status: accepted, 2026-10-12 (built; amendment accepted with ADR 0040, 2026-10-29, partly built, 2026-10-30). Proposed 2026-10-06

## Decision

- An evaluation run is a task. It invokes the service under test for each case, like any other caller.
- Evaluators are a plugin type next to strategies: deterministic, model-based or human.
- Test sets are versioned records owned by a tenant, with cases split into train, validation and holdout. Optimisers never see the holdout split.
- Scores and feedback are `kernel.score` and `kernel.feedback` events on the task they judge, added with `Kernel.annotate`.
- Publishing gates live in the service definition. A version with a failing gate cannot be published to production.
- Every result records the code version, the data, the served model and the judge, so only like is compared with like.

## Accepted with ADR 0040 (partly built)

These rules replace or extend the decision above once they are built. The ones marked built are:

- **One kind of run** (built). A run started in the portal ("Kjør test") is an eval run (`platform.eval.run`), and `EvalRun` is the only run record. Publishing gates, calibration and run comparisons read it.
- **Evaluators may answer later** (built). An evaluator returns its scores at once or later (`evaluator@2`, ADR 0040).
- **Holdout stays in the platform** (built). Holdout cases never leave the platform for a trace sink.
- **`expected.criteria`.** A test case carries the named fields judges read in `expected.criteria`, such as `criteria` or `supporting_quotes`. A `criteria` case's criteria move there from `referenceAnswer`, which then holds only a reference answer. Existing test sets are upgraded when they are read, so stored versions keep their numbers (built).
- **Calibration for every model-based judge.** A judge, built in or a plug-in, blocks a publish only when both hold:
  - its agreement with human calibration labels is a Cohen's kappa of at least 0.6, over at least 30 labels with both verdicts among the judge's own;
  - its model is from another family than every model that wrote the answer. An embedder that only searches does not count.

  Until then its gates are advisory. A Langfuse judge is advisory whatever its calibration (ADR 0040).

- **Calibration details.** Numeric verdicts are split at 0.5 into good and bad first. A gate checks the calibration of the judge that produced its metric, not of every judge in the run.
- **Judge identity** (built for `judge:criteria`). A judge's identity includes its version and its model, and every result records it. Labels and calibration are kept per evaluator.
- **Labels outlive judge versions.** Calibration labels are human verdicts on cases. When a judge's identity changes, the platform has the new identity score the labelled cases again, while their text is kept, and computes its kappa from those pairs. A new identity takes over only the labels of the same judge: for a Langfuse judge, the same tenant, connection and name, so its labels never come from another tenant.
- **Re-running the baseline.** When a judge changes, the last published version's eval run is run again with the new judge before a no-regression comparison.

## Why

headless-rag's golden sets, judge and findings are the most valuable thing it has, and its worst measurement errors came from silent fallbacks and comparing runs taken on different code or models.

The rules accepted with ADR 0040 follow from the same lesson. Calibration has to cover every judge that can block, not only metrics whose name starts with `judge.`, and two agreeing labels are not evidence. A second runner without judges or provenance cannot feed gates or calibration.

## Consequences

- The parity gate, publishing gates and the improvement loop share one mechanism.
- A judge cannot block a publish until it has been calibrated against human ratings.
- The harness fails loudly when anything it needs is missing.
- With the rules accepted with ADR 0040, the portal's run history shows scores and confidence intervals, not only pass or fail.
- The calibration rule accepted with ADR 0040 also governs skill publishing (ADR 0024).
- Not built yet from the amendment: calibration for every model-based judge (kappa over at least 30 labels, plug-ins too), labels that outlive judge versions, and re-running the baseline when a judge changes.
