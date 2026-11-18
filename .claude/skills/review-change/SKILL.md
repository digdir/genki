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

Then sweep the diff three times. Each sweep turns the diff into a list of places to check, and the list goes to the finders as candidates.

- **Promises.** From the ADR, docs and pull request body in the diff, list every sentence that states a guarantee: never, only, before, redacted, refused, fails, always. For each, find every code path that must honour it (the main route, the live or streaming path, the batch path, the job, the builder assistant) and the test whose name proves it. A promise without a path that honours it, or a path that skips it, is a candidate.
- **New fields.** For each field added to a stored or shared object (a row, a record, a definition, a response type), list every route and serialiser that returns it and who may read each one. A field that reaches a reader it is not for (a tenant route returning an operator-only field, a public route returning an internal one) is a candidate.
- **New secrets and sinks.** For each new secret-bearing value (a key, a token, a signed header, a named key, a password in a connection setting), list every sink it can reach: a log line, an audit event, a timeline, an error body, a recorded exchange, a fixture, a trace. For each new sink, list every secret kind that can reach it. Any pair where the secret is not redacted is a candidate.

## 2. Find, in parallel

Start these five subagents (the Agent tool) in one message, so they run at the same time. Give each the range, the file list, the rules and the candidates from the sweeps. Each must look at every changed file and every candidate, and return candidates with file and line, or say it found nothing in that file.

- **Correctness**: logic, edge cases, error paths, the second call, the failed call, concurrency, data loss.
- **Security**: the checklist and the Invariants in `.github/review-security.md`, checked on every path the change touches, and the promises in `docs/security/README.md`.
- **Other paths**: every other route, job, batch path or caller that reaches the same data, rule or model, and callers outside the diff that a changed contract breaks.
- **Tests**: each behaviour change has a test that fails without it; no dependence on the clock, the order or leftovers; names state the rule.
- **Docs and rules**: ADRs, the API description, docs, both i18n catalogues, comments, and the Always check list in REVIEW.md.

## 3. Verify, in parallel

Merge duplicates. For each candidate, start a subagent that gets only the claim, the file and the line, and is asked to prove it wrong. Run them at the same time. It reads the code and runs the searches itself. Keep a candidate only when it holds.

- A claim that something is missing, never called or matches nothing needs a search that shows it: `git grep`, `git ls-files`, Grep or Glob.
- A claim about what a pattern or regular expression matches needs a check against the real paths or strings.
- A claim about behaviour cites the line that causes it. A name is not evidence.

If any part of a finding fails, drop it or keep only the part that held.

## 4. Report everything at once

Each finding has a severity (Important, Nit or Pre-existing), the finder it came from as its category (correctness, security, other-paths, tests or docs), the rule in REVIEW.md it rests on, what is wrong in one or two sentences, the evidence, and the smallest fix. When the fix replaces the lines the finding points at, give the exact replacement lines too.

Severity follows the rule. A finding that rests on a bullet under "What Important means here" is Important; one that rests on any other rule is Nit; Pre-existing stays for lines the pull request did not touch. Name the bullet by its first words, so the author can read the two together.

Locally, list them with Important first. In CI, return them as the output the prompt asks for.

## Review again

When asked to review again after fixes, review only the commits since the last review and check that each earlier finding is fixed. Raise nothing new on lines the earlier review already saw, unless it is Important.
