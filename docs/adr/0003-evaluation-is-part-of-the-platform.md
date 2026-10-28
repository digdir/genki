# 0003 Evaluation is part of the platform

Status: accepted, 2026-10-12 (built; component comparisons partly built, 2026-10-26). Proposed 2026-10-06

## Decision

- An evaluation run is a task. It invokes the service under test for each case, like any other caller.
- Evaluators are a plugin type next to strategies: deterministic, model-based or human.
- Test sets are versioned records owned by a tenant, with cases split into train, validation and locked. Optimisers never see the locked split.
- Scores and feedback are `kernel.score` and `kernel.feedback` events on the task they judge, added with `Kernel.annotate`.
- Publishing gates live in the service definition. A version with a failing gate cannot be published to production.
- Every result records the code version, the data, the served model and the judge, so only like is compared with like.

## Component comparisons

A component behind a port (a document converter, an embedding model, a search engine, an index, a reranker) is compared with a candidate for replacing it in a benchmark under `benchmarks/`, with the shared code in `benchmarks/benchlib`:

- Every side is graded on the same items against a reference: the known-right answers. The reference never comes from a side's output.
- Every run records what it used, as service results do: commit and uncommitted changes, hashes of the code, the reference and the items, each side's settings and the package versions. Runs on different references or items are not compared.
- Differences are paired, with intervals from resampling whole documents. The verdict is against a margin stated before the candidate runs: "not worse" needs the whole interval above minus the margin, which is stricter than a `no-regression` gate.
- A change of document converter, embedding model or search engine on a dataset cites a current-vs-candidate result on that dataset's reference. The verdict must be "not worse" or "better"; "inconclusive" needs more items or an acceptance recorded with the change. Review checks this; nothing in the platform enforces it.

## Why

headless-rag's golden sets, judge and findings are the most valuable thing it has, and its worst measurement errors came from silent fallbacks and comparing runs taken on different code or models.

Components change more often than services are published, and a service's test set is too small to show a few points lost in text extraction or retrieval. A reference built from a side's output would grade that side against itself. "No significant difference" on a small sample is not evidence that a candidate is as good, so the margin and the whole-interval rule make that evidence explicit.

## Consequences

- The parity gate, publishing gates and the improvement loop share one mechanism.
- A judge cannot block a publish until it has been calibrated against human ratings.
- The harness fails loudly when anything it needs is missing.
- `benchmarks/README.md` sets the shape of a benchmark folder and its report. Each report rebuilds byte for byte from its committed verdicts and reference, and checks its own instrument with an A/A run and a known loss.
- Partly built: one benchmark follows the shape so far, and the rule on citing a result is checked in review, not by code. Tests: `refuses_to_compare_records_with_different_references` and `not_worse_needs_the_whole_interval_above_minus_margin` (`benchmarks/benchlib`), `no_reference_test_is_derived_from_a_side_output` (`benchmarks/ingestion/opb`).
