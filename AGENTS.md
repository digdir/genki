# genki for coding agents

genki is Digdir's shared platform for AI services: an organisation describes a service in a definition, and the platform runs it with its models, datasets, tools, guardrails, rights and audit log. It is under development and not in production. Kunnskapsassistenten and Kudos are examples, not the product: build nothing only one service can use.

This file is enough to start. [REVIEW.md](REVIEW.md) is what every pull request is reviewed against. The full testing and security rules and the recurring mistakes are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Where things are

- `apps/api`: the platform API. `apps/portal`, `apps/console`: its frontends. `apps/assistant`: the hosted assistant. `apps/worker`: durable jobs.
- `packages/kernel` and `packages/port-*`: contracts only. `packages/providers-*`: the only place a vendor SDK is imported. `packages/composition`: wires them.
- `packages/definitions`: the service definition schema. `packages/i18n` and each app's `src/i18n`: user-facing text, bokmål and English.
- `docs/adr`: decisions. `docs/security`: what genki protects. `docs/architecture/modules`: the module atlas. `docs/components`: the component pages.

## The gate

```sh
mise install && npm start                 # Node 24 from mise.toml, then setup and every app
npx vitest run --changed origin/main      # while you work
npm run typecheck                         # never npx tsc -b alone: it skips the test files CI checks
npm run verify                            # the gate: PR CI's checks, with the tests your change can affect
```

Run every command through the Node that mise pins (`mise exec -- <command>` if your shell has another). Docker must run.

`npm run verify` passes, or the work is not done. There is no "could not run it" escape: if a step cannot run, fix that first or say the work is unfinished. Install gitleaks too; without it verify skips the secret scan with a warning. Verify writes a stamp for the working tree, and any later edit makes it stale. While it is stale, the Claude Code hooks in `.claude/settings.json` block `git push` and `gh pr create`, and block the end of a turn once. The pre-push hook pushes when the stamp matches what you push, runs verify when what you push is the working tree, and refuses otherwise. `git push --no-verify` is for emergencies only. CI still runs every test when a change is more than source; verify runs the related ones and every test that reads files from disk.

## Rules that CI does not catch

- **A test for every rule,** named as the rule: `refuses to start without a database unless dev mode is on`. A bug fix comes with the test that fails before it. Use the fakes and harnesses, a fixed `now`, and your own data.
- **Fake secrets are built at runtime** in tests, for example joined from parts or from `randomBytes`, never written as a literal: gitleaks scans every commit.
- **Tenants, the model gate and dev mode.** Take the tenant from the verified principal on every path to the data. Every model call goes through the gate. Dev-only settings refuse to start outside dev mode. Never log a secret or personal data.
- **Expand, then contract.** The old and new version run side by side during a deploy, so a migration, an API field or a stored shape is only added or made optional in one release, and dropped or renamed in a later one.
- **Component pages.** Each building block (chat, approach, sources and the rest) has a page in `docs/components`. A change to one updates its page in the same pull request: phase, variants, what we learned, open questions, and a line in the landing page's change log.
- **Atlas.** A new module or cross-package import updates `docs/architecture/modules/*.yaml`; run `npm run atlas:build` (verify runs it with `--check`).
- **Docs say only what the code does.** Change the doc or ADR in the same pull request, with an honest status.
- **English in code,** bokmål and English for users, through the i18n catalogues. No em-dashes in copy or docs.

## Before you push

1. `npm run verify` is green on the final tree, after your last edit.
2. The model review runs in CI on the first push and posts everything it finds at once. Run `/review-change` (or `.claude/skills/review-change/SKILL.md`) first in a fresh agent that sees only the diff, REVIEW.md and `.github/review-security.md`, and fix what it finds.
3. Fill in the pull request template with Risk and Undo; tick only what is true. One change per pull request.

When the same mistake comes back, add the rule here or in REVIEW.md, with a test if a test can hold it.
