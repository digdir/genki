# genki for coding agents

genki is Digdir's shared platform for AI services: an organisation describes a service in a definition, and the platform runs it with its models, datasets, tools, guardrails, rights and audit log. It is under development and not in production. Kunnskapsassistenten and Kudos are examples, not the product.

This file is for any coding agent (Claude Code, Copilot, Codex, Cursor and others) and for the people steering them. It does not replace [CONTRIBUTING.md](CONTRIBUTING.md): read that first, its rules apply to agents as they do to people. [REVIEW.md](REVIEW.md) is what every pull request is reviewed against; write the change so the review finds nothing.

## Commands

```sh
npm start                      # setup, then API, portal, console and workspace
npx vitest run <paths>         # the tests you touched, while you work
npx tsc -b && npx eslint <files>
npm run boundaries             # dependency rules
npm run atlas:build            # after adding a module or a cross-package import
npm run check                  # everything CI runs; must pass before a pull request
```

Docker must run for the Postgres, pgvector and knowledge server suites. Without it those suites fail to start; that is not your change failing, but say in the pull request that you could not run them.

## Where things are

- `apps/api`: the platform API. `apps/portal`, `apps/console`, `apps/workspace`: the three frontends. `apps/worker`: durable jobs.
- `packages/kernel` and `packages/port-*`: contracts only. `packages/providers-*`: the only place a vendor SDK is imported. `packages/composition`: wires them.
- `packages/definitions`: the service definition schema. `packages/i18n` and each app's `src/i18n`: user-facing text.
- `docs/adr`: decisions. `docs/security`: what genki protects and the assurance case. `docs/architecture/modules`: the module atlas.
- The code of conduct and other community health files come from [digdir/.github](https://github.com/digdir/.github) for every Digdir repository. Do not add a copy here. That includes `SECURITY.md`: genki's reporting scope is in [docs/security](docs/security/README.md#reporting-a-vulnerability).

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
- **Tests that depend on the clock, the order or leftovers.** See Tests.
- **Screens that reset what the user just did.** A tab, panel or choice reset when data reloads or the screen finishes appearing.
- **Docs and ADRs that claim more than the code does.** An ADR marked built when part of it is not, or a doc describing a route or setting that is not there. Keep the status honest and change the doc in the same pull request.
- **Work that blocks the server.** A heavy request that stalls every other request, or a job that runs outside its window. Move long work to a job.
- **Patterns code scanning flags.** Regular expressions that are not linear time, unquoted shell input, and actions not pinned to a full commit SHA.

## Before you open a pull request

1. `npm run check` passes, or the pull request says which part you could not run and why.
2. Run the review CI will run, and fix or answer what it finds: `/review-change` in Claude Code, or ask another tool to follow `.claude/skills/review-change/SKILL.md`. The goal is a CI review that finds nothing.
3. Fill in the template, with Risk and Undo, and tick only the boxes that are true.
4. One change per pull request.

After you open it, the model review posts all its findings at once within minutes. Answer every thread: fix it, or say why not.

## When the same mistake comes back

Add the rule here or in REVIEW.md, with a test if a test can hold it. Do not rely on a reminder in a prompt.
