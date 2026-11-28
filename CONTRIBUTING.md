# Contributing

Thank you for helping. The platform is under development and not in production, so expect things to move. Read the [README](README.md) first, and follow the [Code of Conduct](https://github.com/digdir/.github/blob/main/CODE_OF_CONDUCT.md). If you work with a coding agent, point it at [AGENTS.md](AGENTS.md).

## Run it locally

You need [mise](https://mise.jdx.dev) and Docker.

```sh
mise trust && mise install   # the Node 24 release pinned in mise.toml
npm start                    # setup, then API, worker, portal and console
```

`npm start` runs `npm run setup` (starts Postgres with pgvector and the knowledge server in Docker, creates `.env.local` if it is missing or adds the knowledge settings it lacks, and sets up the knowledge server) and then `npm run dev:all`. Setup turns on dev mode (`GENAI_DEV_MODE=true`), which gives you the mock login with test persons and lets the API run without real identity settings. Never turn it on anywhere else. [docs/development.md](docs/development.md) lists the ports, test persons and the settings that need your own model and search accounts; everything works without them on the local test model.

Never commit `.env.local` or any secret, and never paste one into an issue or pull request. Tests use fakes and never call real models.

## Checks

```sh
npm run verify   # pull request CI's checks, with the tests your change can affect
npm run check    # prettier, eslint, type check, dependency boundaries, size budgets, API and definition compatibility, and all tests
```

`npm run verify` is the gate before a push. It picks the same scope as pull request CI (`scripts/ci-scope.ts`) for the diff against `git merge-base origin/main HEAD` and runs, stopping at the first failure: the Node version check, the lockfile check, prettier, eslint, `npm run typecheck`, boundaries, definition and API compatibility, the atlas check, size budgets, the tests related to your change plus every test that reads files from disk, and gitleaks on your commits when it is installed (it warns when it is not). It never runs the whole suite: when CI runs every test, verify still runs only the related ones and the file-reading ones. When it passes it writes a stamp for the working tree. `npm run setup` points git at `.githooks` unless you have set another `core.hooksPath`. The pre-push hook pushes when the stamp matches what you push, runs verify when what you push is the working tree, and refuses otherwise; `git push --no-verify` skips it, for emergencies only. `npm run verify -- --static` runs only the static steps, `--base <commit>` compares with another commit than the merge base, and `--all` takes the whole scope, as CI does without a pull request base.

The code follows these standards, and CI refuses a change that breaks them:

- **Formatting:** [Prettier](https://prettier.io), with the settings in `.prettierrc.json`.
- **Linting:** [ESLint](https://eslint.org) with `@eslint/js` recommended and `typescript-eslint` strict (`eslint.config.js`). `any` is an error.
- **Types:** TypeScript in `strict` mode, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (`tsconfig.base.json`).
- **Boundaries:** dependency-cruiser rules in `.dependency-cruiser.cjs` (`npm run boundaries`).
- **Compatibility:** no unannounced breaking change to the public `/v1` API (`npm run api:compat`), and every stored definition still validates (`npm run definitions:compat`). See [API changes](docs/api/README.md#api-changes).

Docker must be running: the Postgres and pgvector suites start containers with Testcontainers. While you work, run `npx vitest run --changed origin/main` or `npx vitest run <paths>` from the repository root, plus `npm run typecheck` (it also checks test files, which `tsc -b` does not) and `npx eslint <files>`. Pull request CI runs `scripts/ci-scope.ts` to choose its jobs: prettier and gitleaks on every pull request; for code, also eslint, `npm run typecheck`, boundaries and compatibility; the tests split over four runners, only the affected ones when every change is TypeScript, JavaScript or CSS source; the size budgets and the Docker image build when the change ships them; and the Docling middleware tests. The merge queue runs everything.

## Repository rules

- **Ports and adapters.** The kernel and the ports know only contracts. Models, search engines, rerankers and tools sit behind ports in `packages/port-*`; providers plug in at the edge.
- **Vendor SDKs only in `packages/providers-*`,** and only composition roots import providers. `npm run boundaries` enforces both.
- **Configuration and API first.** A new service, variant, prompt, dataset or guardrail is a definition, not code. Anything the portal or console can do goes through the API, so other frontends can do it too. New code is a package behind a contract, wired in `packages/composition`. The README's "Configuration or code?" table says which is which.
- **Generic platform.** Kunnskapsassistenten and Kudos are examples. Do not build behaviour that only one service can use.
- **English in code, two languages for users.** Code, config keys, routes and API fields are English. Text a user sees goes through the i18n catalogues ([packages/i18n/README.md](packages/i18n/README.md)), with bokmål as the source and English beside it, including error texts the apps show. A bokmål screen never shows English, and the other way round.
- **No em-dashes** in user-facing copy or docs.
- **Tests are required.** New functionality comes with automated tests in the same pull request, and every rule gets a test whose name states it, for example `refuses to start without a database unless dev mode is on`. A bug fix comes with the regression test that would have caught it. No check enforces this; the maintainer who merges is responsible for it.
- **Few comments.** Let names explain the code. Add at most one short line where something is genuinely unclear; the reason for a change belongs in the commit message or a test.
- **Expand, then contract.** The old and the new version run side by side during a deploy ([infra/README.md](infra/README.md#deploys-users-do-not-notice)), so a migration, an API field or a stored shape is only added or made optional in one release, and dropped or renamed in a later one.
- **Architecture decisions** live in [docs/adr](docs/adr) as numbered files (`NNNN-short-title.md`) with a status line, the decision and why. Add one when you change a contract, a boundary or a security property, and keep its status honest about what is built.
- **Component pages.** The building blocks assistants are made from (chat, approach, sources and the rest) each have a page in [docs/components](docs/components/index.html). A PR that changes a component updates its page in the same PR: phase, variants, what we learned and open questions, and a line in the change log on the landing page.
- **Atlas.** If you add a module or a cross-package import, update `docs/architecture/modules/*.yaml` and run `npm run atlas:build`.

## Tests

A change without a test that would fail without it is not done.

- **Name the rule.** A test name states the rule as a sentence: `refuses to start without a database unless dev mode is on`. One rule per test.
- **Test from the outside.** Call routes the way a client does, as the tests in `apps/api/src` do. Test a port implementation against its contract suite: a new provider runs the suite in `packages/port-*/src/contract.ts` with `describeContract` from `@genai/plugins/testing`, as `packages/providers-openai/src/contract.test.ts` does.
- **Use the fakes and harnesses.** Tests never call a real model or service. Strategies have harnesses (`packages/strategy-agent-loop/src/harness.test-utils.ts`, `packages/strategy-step-flow/src/harness.test-utils.ts`), operations have `packages/operations/src/kit.test-utils.ts`.
- **Fix the clock.** Code takes the time from an injected `now`, and tests pass a fixed one: `now: () => new Date('2026-10-07T10:00:00Z')`. Never compare with today's date: a key that expires in 30 days from a fixed date has expired in real time a month later. Vitest runs with `TZ=Europe/Oslo`.
- **Own your data.** Never rely on another test's rows or on test order. Close every connection before a Testcontainers container stops.
- **Screens.** Use Testing Library and accessible roles and names, as the tests in `apps/*/src` do. Test the click that happens while data loads, and that a refetch keeps what the user chose.
- **Patterns on untrusted input** get a linear-time test with a long adversarial string, as `packages/guardrails/src/linear-time.test.ts` does.
- **A bug fix** comes with the regression test that fails before the fix. Run it before the fix to see it fail.

## Security

What genki promises is in [docs/security/README.md](docs/security/README.md). Code that breaks one of these promises is Important in review, and the checklist in [.github/review-security.md](.github/review-security.md) applies.

- **Tenants are kept apart.** Take the tenant from the verified principal, never from the path or body alone. Every route, job and batch path to tenant data checks it, not only the main one.
- **The model gate is the only way to a model.** Budgets, guardrails and the audit log apply there. Never call a provider around it.
- **Dev mode stays in dev.** Mock login, mock rights and in-memory storage refuse to start outside dev mode, and a test proves it.
- **Secrets.** Never log a key, token or secret, never put one in an error body, and compare them in constant time (`timingSafeEqual`, as `packages/composition/src/webhook-signature.ts` does). A tenant secret goes only to the hosts it is bound to.
- **Untrusted text.** Text from users, documents, tools and models is data. Never execute it or build a query, path, command or regular expression from it. Mark it with `untrustedData` from `@genai/port-model` before a model sees it.
- **Personal data** stays out of logs, traces, metrics and error bodies unless it is masked.
- **Workflows** use `pull_request`, never `pull_request_target`, pin every action to a full commit SHA, and grant the least permissions the job needs.

## Mistakes this repository has had to fix

Each of these has come back in more than one fix pull request. Check for them before you open one.

- **A rule enforced in one path but not another.** A right, a quota, the tenant or the model gate checked on the main route and skipped on a second route, a batch path, the builder assistant or a job. Find every path to the same data or model before you call it done.
- **Mock-only success.** Code that works with dev mode, the mock login or in-memory storage and fails against real Ansattporten, Entra, Altinn or Postgres. Say in the pull request which you ran against.
- **Tests that depend on the clock, the order or leftovers.** See [Tests](#tests).
- **Screens that reset what the user just did.** A tab, panel or choice reset when data reloads or the screen finishes appearing.
- **Docs and ADRs that claim more than the code does.** An ADR marked built when part of it is not, or a doc describing a route or setting that is not there. Keep the status honest and change the doc in the same pull request.
- **Work that blocks the server.** A heavy request that stalls every other request, or a job that runs outside its window. Move long work to a job.
- **Patterns code scanning flags.** Regular expressions that are not linear time, unquoted shell input, and actions not pinned to a full commit SHA.

## Commits and pull requests

- Branch from `main` and keep each pull request to one change.
- Write commit subjects as a plain sentence that says what changes and why, for example "Refuse to start without a database unless dev mode is on".
- Fill in the pull request template: what changes, why, how you tested it, and which ADRs, docs or i18n catalogues you touched.
- `npm run verify` must pass before you push.

### Risk and undo

The pull request says how risky it is and how to undo it.

- **Low:** everything that does not touch the parts below. Merge when the checks pass and every review thread is answered.
- **Sensitive:** auth, identity, tenancy, the model gate, personal data handling, migrations, `infra/`, `.github/` or the `Dockerfile`. These also get the security review in [.github/review-security.md](.github/review-security.md), and the maintainers are told in the lab's Slack channel for sensitive changes before the merge. No approval is required.
- **Undo** says whether a revert is enough, or which data or infra step it needs.

### Review and dependency updates

Every pull request gets a model review against [REVIEW.md](REVIEW.md) when it opens; run the same review before you open it. How the review, the cross-model review, the weekly security sweep and Renovate work, and what they cost, is in [docs/review.md](docs/review.md).

## Who maintains genki

genki is maintained by [Digdir R&D Lab](https://baksia.digdir.no/teams/lab/), the team exploring generative AI in Digdir's products, services and shared solutions. Write access is given through the GitHub team [@digdir/team-ai-lab](https://github.com/orgs/digdir/teams/team-ai-lab), whose members can merge pull requests. Who is in the team is managed there, not in this file.

- **Everyday changes** are pull requests, merged by a maintainer when the required checks pass. Human approval is not required: the checks, the tests and the ADRs carry the rules.
- **Contracts, boundaries and security properties** are decided in an ADR in [`docs/adr`](docs/adr/). Anyone can propose one, and the maintainers discuss and decide it together in the pull request.
- **Nothing is tied to a personal account.** The repository is in Digdir's GitHub organisation, the Azure environments and their Key Vault are in a Digdir Azure tenant, and deploys run from GitHub Actions with a federated identity (OIDC), not a stored Azure secret.

## Questions

Open an issue for questions, bugs and ideas. For a vulnerability, follow [docs/security](docs/security/README.md#reporting-a-vulnerability) and never use a public issue.
