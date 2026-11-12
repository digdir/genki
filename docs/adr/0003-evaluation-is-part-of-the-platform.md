# 0003 Evaluation is part of the platform

Status: accepted, 2026-10-12 (built; component comparisons partly built, 2026-10-26; amendment accepted with ADR 0040, 2026-10-29, not built; portal runs for deterministic gates, 2026-11-02, built). Proposed 2026-10-06

## Decision

- An evaluation run is a task. It invokes the service under test for each case, like any other caller.
- Evaluators are a plugin type next to strategies: deterministic, model-based or human.
- Test sets are versioned records owned by a tenant, with cases split into train, validation and holdout. Optimisers never see the holdout split.
- Scores and feedback are `kernel.score` and `kernel.feedback` events on the task they judge, added with `Kernel.annotate`.
- Publishing gates live in the service definition. A version with a failing gate cannot be published to production.
- Every result records the code version, the data, the served model and the judge, so only like is compared with like.

## Component comparisons

A component behind a port (a document converter, an embedding model, a search engine, an index, a reranker) is compared with a candidate for replacing it in a benchmark under `benchmarks/`, with the shared code in `benchmarks/benchlib`:

- Every side is graded on the same items against a reference: the known-right answers. The reference never comes from a side's output.
- Every run records what it used, as service results do: commit and uncommitted changes, hashes of the code, the reference and the items, each side's settings and the package versions. Runs on different references or items are not compared.
- Differences are paired, with intervals from resampling whole documents. The verdict is against a margin stated before the candidate runs: "not worse" needs the whole interval above minus the margin, which is stricter than a `no-regression` gate.
- A change of document converter, embedding model or search engine on a dataset cites a current-vs-candidate result on that dataset's reference. The verdict must be "not worse" or "better"; "inconclusive" needs more items or an acceptance recorded with the change. Review checks this; nothing in the platform enforces it.

## Accepted with ADR 0040 (not built)

These rules replace or extend the decision above once they are built:

- **One kind of run.** A run started in the portal ("Kjør test") is an eval run (`platform.eval.run`), and `EvalRun` is the only run record. Publishing gates, calibration and run comparisons read it.

  Until it is built, a test run started in the portal (`ServiceRun`) also counts for a threshold gate whose metric a deterministic evaluator computes, `nynorsk.chrf` or `klarsprak.overall` today. It counts only when it succeeded and ran on exactly the validated definition being published: the run records that definition's subject, the same hash publishing computes. The subject leaves out `spec.riskConfirmation`, which publishing stamps with who confirmed and when, so confirming the risk class does not make a run stale. The platform scores the stored answers with the gate's evaluator (`nynorskReference`, `klarsprakChecklist`) and calls no model. An `EvalRun` of the candidate wins over a portal run. Gates that need a judge, and no-regression gates, read only `EvalRun`, so a run without a judge can never make them advisory. Without this, the portal's "Kjør testsettet" could never satisfy these gates, and services with them could not be published again (`apps/api/src/gate-runs.ts`, tested in `gate-runs.test.ts`, `packages/eval/src/platform.test.ts` and `integration.test.ts`).

- **Evaluators may answer later.** An evaluator returns its scores at once or later (`evaluator@2`, ADR 0040).
- **Holdout stays in the platform.** Holdout cases never leave the platform for a trace sink.
- **`expected.criteria`.** A test case carries the named fields judges read in `expected.criteria`, such as `criteria` or `supporting_quotes`. A `criteria` case's criteria move there from `referenceAnswer`, which then holds only a reference answer. Existing test sets are migrated.
- **Calibration for every model-based judge.** A judge, built in or a plug-in, blocks a publish only when both hold:
  - its agreement with human calibration labels is a Cohen's kappa of at least 0.6, over at least 30 labels with both verdicts among the judge's own;
  - its model is from another family than every model that wrote the answer. An embedder that only searches does not count.

  Until then its gates are advisory. A Langfuse judge is advisory whatever its calibration (ADR 0040).

- **Calibration details.** Numeric verdicts are split at 0.5 into good and bad first. A gate checks the calibration of the judge that produced its metric, not of every judge in the run.
- **Judge identity.** A judge's identity includes its version and its model, and every result records it.
- **Labels outlive judge versions.** Calibration labels are human verdicts on cases. When a judge's identity changes, the platform has the new identity score the labelled cases again, while their text is kept, and computes its kappa from those pairs. A new identity takes over only the labels of the same judge: for a Langfuse judge, the same tenant, connection and name, so its labels never come from another tenant.
- **Re-running the baseline.** When a judge changes, the last published version's eval run is run again with the new judge before a no-regression comparison.

## Why

headless-rag's golden sets, judge and findings are the most valuable thing it has, and its worst measurement errors came from silent fallbacks and comparing runs taken on different code or models.

The rules accepted with ADR 0040 follow from the same lesson. Calibration has to cover every judge that can block, not only metrics whose name starts with `judge.`, and two agreeing labels are not evidence. A second runner without judges or provenance cannot feed gates or calibration.

Components change more often than services are published, and a service's test set is too small to show a few points lost in text extraction or retrieval. A reference built from a side's output would grade that side against itself. "No significant difference" on a small sample is not evidence that a candidate is as good, so the margin and the whole-interval rule make that evidence explicit.

## Consequences

- The parity gate, publishing gates and the improvement loop share one mechanism.
- A judge cannot block a publish until it has been calibrated against human ratings.
- The harness fails loudly when anything it needs is missing.
- With the rules accepted with ADR 0040, the portal's run history shows scores and confidence intervals, not only pass or fail.
- The calibration rule accepted with ADR 0040 also governs skill publishing (ADR 0024).
- `benchmarks/README.md` sets the shape of a benchmark folder and its report. Each report rebuilds byte for byte from its committed verdicts and reference, and checks its own instrument with an A/A run and a known loss.
- Partly built: one benchmark follows the shape so far, and the rule on citing a result is checked in review, not by code. Tests: `refuses_to_compare_records_with_different_references` and `not_worse_needs_the_whole_interval_above_minus_margin` (`benchmarks/benchlib`), `no_reference_test_is_derived_from_a_side_output` (`benchmarks/ingestion/opb`).
