# genki

genki is Digdir's shared platform for AI services: an organisation describes a service in a definition, and the platform runs it with its models, datasets, tools, guardrails, rights and audit log. It is under development and not in production. Kunnskapsassistenten and Kudos are examples, not the product.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing anything. Its repository rules apply to agents as they do to people. [REVIEW.md](REVIEW.md) says what a reviewer treats as Important; write the change so it has none of those.

## Commands

```sh
npm start                      # setup, then API, portal, console and workspace
npx vitest run <paths>         # the tests you touched, while you work
npx tsc -b && npx eslint <files>
npm run boundaries             # dependency rules
npm run atlas:build            # after adding a module or a cross-package import
npm run check                  # everything CI runs; must pass before a pull request
```

Docker must run for the Postgres and pgvector suites. Tests use fakes and never call real models.

## Where things are

- `apps/api`: the platform API. `apps/portal`, `apps/console`, `apps/workspace`: the three frontends. `apps/worker`: durable jobs.
- `packages/kernel` and `packages/port-*`: contracts only. `packages/providers-*`: the only place a vendor SDK is imported. `packages/composition`: wires them.
- `packages/definitions`: the service definition schema. `packages/i18n` and each app's `src/i18n`: user-facing text.
- `docs/adr`: decisions. `docs/security`: what genki protects and the assurance case. `docs/architecture/modules`: the module atlas.

## Mistakes this repository has had to fix

Each of these has come back in more than one fix pull request. Check for them before you open one.

- **A rule enforced in one path but not another.** A right, a quota, the tenant or the model gate checked on the main route and skipped on a second route, a batch path, the builder assistant or a job. Find every path to the same data or model before you call it done.
- **Mock-only success.** Code that works with dev mode, the mock login or in-memory storage and fails against real Ansattporten, Entra, Altinn or Postgres. Say in the pull request which you ran against.
- **Tests that depend on the clock, the order or leftovers.** Use a fixed date, not today; never rely on another test's rows or on test order; close every connection before a container stops.
- **Screens that reset what the user just did.** A tab, panel or choice reset when data reloads or the screen finishes appearing. Keep the user's state across a refetch, and test the click that happens while it loads.
- **Docs and ADRs that claim more than the code does.** An ADR marked built when part of it is not, or a doc describing a route or setting that is not there. Keep the status honest and change the doc in the same pull request.
- **Work that blocks the server.** A heavy request that stalls every other request, or a job that runs outside its window. Move long work to a job.
- **Patterns code scanning flags.** Regular expressions that are not linear time, unquoted shell input, and actions not pinned to a full commit SHA.

## Working style

- One change per pull request, with the template filled in and the boxes ticked honestly.
- When a check, a reviewer or a test catches the same kind of mistake twice, add the rule here or in REVIEW.md, not in a reminder.
- Respond to every review finding: fix it, or say in the thread why not.
