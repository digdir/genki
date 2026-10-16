---
name: adr
description: Write, amend or check an architecture decision record in docs/adr. Use when a change touches a contract, a boundary or a security property, when asked to write or update an ADR, or to check that ADR statuses match the code.
---

# Architecture decision records

ADRs live in `docs/adr` as `NNNN-short-title.md`, with an index in `docs/adr/README.md`. CONTRIBUTING.md says when one is needed: a change to a contract, a boundary or a security property. Each record says honestly what is built.

## First, read

1. `docs/adr/README.md`, to see what exists and its status.
2. Every ADR the change touches. Search by topic, not only by title: `grep -ril "<term>" docs/adr`.
3. One recent record as a style reference, for example `0029-language-instructions.md` (short) or `0033-locked-test-environment.md` (long).

Then decide:

- **Amend** an existing record when the change extends or adjusts the same decision. Edit the text in place so it describes what holds now, and add the change to the status line (below).
- **New record** when it is a new decision, or reverses one. When it replaces an earlier decision, change the old record's status to `superseded by ADR NNNN, YYYY-MM-DD` and link to the new one.
- **No record** for an implementation detail that changes no contract, boundary or security property. Say so instead of writing one.

## Number and file

Take the highest number in `docs/adr` plus one. Never reuse a missing number: 0009, 0012 to 0014, 0016, 0018 and 0019 were withdrawn. The file name is the number and a short lowercase title in kebab case, e.g. `0034-tabular-datasets.md`.

## Shape

```markdown
# 0034 Short title in sentence case

Status: proposed, 2026-10-16

## Context

Optional. What forces the decision, in a few sentences, when Decision would not make sense without it.

## Decision

What we do, stated as rules. Name the concrete things: settings, env vars, routes, file paths, problem types (`urn:genai:problem:...`), tables. Bullets for parallel rules.

## Why

The reasons, and the alternatives we turned down and why.

## Consequences

What follows: what is now required of new code, what an operator must do, what is not covered, what is not built yet.
```

Extra `##` sections may sit between Decision and Why when one part needs room, as in ADR 0033.

## Status line

- New: `Status: proposed, YYYY-MM-DD`.
- Accepted: `Status: accepted, YYYY-MM-DD (built)`, `(partly built)` or `(not built)`. With partly or not built, Consequences names what is missing.
- Later changes go inside the parentheses, each with its date: `(built, 2026-10-14; ingestion locked, 2026-10-15)`.
- Older records end with `Proposed YYYY-MM-DD`, `Amended ...` or `Extended ...` after the parentheses. They are valid; new records use the parentheses instead.
- A `Left:` paragraph under the status line lists what a decision deliberately leaves out. It is fine on a built record as long as the decision itself does not promise what it lists; if it does, the record is partly built.
- Use today's date. Never mark something built that the code does not do; check the code and the tests first.

## Style

- English, plain sentences, present tense: "The API refuses", not "The API will refuse".
- No em-dashes. Use a comma, a colon or a new sentence.
- Refer to other records as `ADR 0027`, and link with a relative path when it helps.
- Platform-generic: Kunnskapsassistenten and Kudos are examples, never the reason a rule is shaped the way it is.
- No secrets, personal data, real test persons' national identity numbers or local paths.
- A rule worth stating is worth a test whose name states it. Mention the test or add it in the same change.

## Update alongside

- The table in `docs/adr/README.md`: a row with link, title and a short status (`Accepted, built`, `Proposed`). Run `npx prettier --write docs/adr/README.md` afterwards, since the table is aligned.
- `docs/architecture/modules/*.yaml` if a module's contract or boundary changed.
- Docs that describe the behaviour, usually `docs/development.md`, `docs/frontend-contract.md` or `docs/api/*`, so they do not contradict the record.
- The PR text names the ADR under "What and why".

## Checking statuses

When asked to check the records rather than write one, change nothing unless asked. For each record:

1. List its claims: every rule in Decision and every "not built yet" item in Consequences or `Left:`.
2. Find the evidence by the names the record uses: routes, setting keys, env vars, problem types, file paths. Quote the glob in zsh and skip build output, e.g. `grep -rn --include='*.ts' --exclude-dir=node_modules --exclude-dir=dist "languageInstructions" apps packages`. Then find the test that covers it.
3. Sort each claim as built and tested, built but untested, or not built. A "not built" item that the code now does means the record claims less than is built.
4. Compare the record's status with its row in `docs/adr/README.md`, and with what `docs/api/*` and `docs/development.md` say about the same behaviour.

Report per record: the status verdict, the claims that are built but untested, and every mismatch with the file and line that shows it. Dates in the status line are not checked unless asked.

## Finally

Run `npm run format:check` (or `npx prettier --check docs/adr`). Do not commit, push or stage; hand over the changed files and a suggested commit message.
