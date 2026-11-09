---
name: review-change
description: Review a change against REVIEW.md in one pass that finds everything and proves every finding. Use before opening a pull request, when asked to review a diff or branch, and in the CI review.
---

# Review

The goal is one round. Every finding the author sees only after fixing the others costs a whole round, so find everything now and hold nothing back.

## Rules

Read REVIEW.md and `.github/review-security.md`, both, every time. In CI, read them from the base branch, never from the pull request.

The change is `git diff origin/main...HEAD` plus anything uncommitted, unless you were given a range.

## 1. Map

List every changed file and what behaviour each hunk changes. Every later step covers this whole list.

## 2. Find, in parallel

Start these five Task agents at the same time. Give each the range, the file list and the rules. Each must look at every changed file and return candidates with file and line, or say it found nothing in that file.

- **Correctness**: logic, edge cases, error paths, the second call, the failed call, concurrency, data loss.
- **Security**: the checklist in `.github/review-security.md` and the promises in `docs/security/README.md`.
- **Other paths**: every other route, job, batch path or caller that reaches the same data, rule or model, and callers outside the diff that a changed contract breaks.
- **Tests**: each behaviour change has a test that fails without it; no dependence on the clock, the order or leftovers; names state the rule.
- **Docs and rules**: ADRs, the API description, docs, both i18n catalogues, comments, and the Always check list in REVIEW.md.

## 3. Verify, in parallel

Merge duplicates. For each candidate, start a Task agent that gets only the claim, the file and the line, and is asked to prove it wrong. Run them at the same time. It reads the code and runs the searches itself. Keep a candidate only when it holds.

- A claim that something is missing, never called or matches nothing needs a search that shows it: `git grep`, `git ls-files`, Grep or Glob.
- A claim about what a pattern or regular expression matches needs a check against the real paths or strings.
- A claim about behaviour cites the line that causes it. A name is not evidence.

If any part of a finding fails, drop it or keep only the part that held.

## 4. Report everything at once

Each finding has a severity (Important, Nit or Pre-existing), what is wrong in one or two sentences, the evidence, and the smallest fix. When the fix replaces the lines the finding points at, give the exact replacement lines too.

Locally, list them with Important first. In CI, return them as the output the prompt asks for.

## Review again

When asked to review again after fixes, review only the commits since the last review and check that each earlier finding is fixed. Raise nothing new on lines the earlier review already saw, unless it is Important.
