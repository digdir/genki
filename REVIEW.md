# Review instructions

genki is a shared platform for many AI services. Review against that: what holds for one service must hold for all of them. The repository rules are in [CONTRIBUTING.md](CONTRIBUTING.md) and the recurring mistakes in [CLAUDE.md](CLAUDE.md).

## What Important means here

Mark a finding Important only when the change would:

- let a model call skip the gate that applies budgets, guardrails and the audit log
- let one tenant read or change another tenant's data, definitions, runs or keys
- enforce a right, a quota or the tenant on one path and skip it on another path to the same data
- put personal data (national identity numbers, names, prompt or answer text) in logs, traces, error bodies or metrics without masking
- weaken authentication, or let a dev-only setting (dev mode, the mock login, mock rights) take effect outside dev mode
- change a public contract (a `/v1` route, a field, a problem type, the `GenAI-Version` behaviour) without an ADR that says so
- make an ADR, the API docs or `docs/development.md` say something the code does not do
- lose or corrupt data in a migration, or make a revert unsafe

Everything else is Nit at most: naming, structure, style, refactors.

## One round

Report every finding in one review. Never hold one back for a later round: the author should fix once. Report Pre-existing problems in lines the pull request did not touch only when they are Important.

## Do not report

- Anything CI already enforces: Prettier, ESLint, TypeScript, dependency boundaries, size budgets, gitleaks, CodeQL
- `package-lock.json` and files written by a generator, such as `docs/architecture/system-atlas.html` from `npm run atlas:build`
- Portal mock data under `apps/portal/src/mock`
- Test code that breaks production rules on purpose

## Always check

- Every new rule has a test whose name states it. A bug fix has the regression test that would have caught it.
- Tests do not depend on today's date, on test order or on rows another test left behind.
- Text a user sees goes through the i18n catalogues with both bokmål and English. A bokmål screen never shows English.
- Vendor SDKs are imported only in `packages/providers-*`.
- New behaviour is configuration or API first and works for any service, not only one.
- New routes are in the API description and return problem types (`urn:genai:problem:...`) on error.
- No em-dashes in user-facing copy or docs.
- Comments are one short line at most.

## Evidence

Every claim in a finding must hold. Posting nothing is better than posting something wrong.

- A claim about behaviour cites the file and line that causes it. A name is not evidence.
- A claim that something is missing, never called or matches nothing comes with the search that shows it.
- A claim about what a pattern or regular expression matches is checked against the real paths or strings.
- Before posting, try to prove each finding wrong. Drop it, or keep only the part that held, if any part fails.

Each finding says what is wrong, the evidence (a file and line, or the command and what it showed) and the smallest fix. If you cannot point to the evidence, ask a question instead.

## Security

When the pull request changes auth, identity, tenancy, the model gate, personal data handling, migrations, `infra/`, `.github/` or the `Dockerfile`, also follow [.github/review-security.md](.github/review-security.md).

@.github/review-security.md
