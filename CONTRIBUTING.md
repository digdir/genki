# Contributing

Thank you for helping. The platform is under development and not in production, so expect things to move. Read the [README](README.md) first, and follow the [Code of Conduct](https://github.com/digdir/.github/blob/main/CODE_OF_CONDUCT.md). If you work with a coding agent, point it at [AGENTS.md](AGENTS.md).

## Run it locally

You need [mise](https://mise.jdx.dev) and Docker.

```sh
mise trust && mise install   # Node 24.21.0, pinned in mise.toml
npm start                    # setup, then API, portal, console and workspace
```

`npm start` runs `npm run setup` (starts Postgres with pgvector and the knowledge server in Docker, creates `.env.local` if it is missing or adds the knowledge settings it lacks, and sets up the knowledge server) and then `npm run dev:all`. Setup turns on dev mode (`GENAI_DEV_MODE=true`), which gives you the mock login with test persons and lets the API run without real identity settings. Never turn it on anywhere else. [docs/development.md](docs/development.md) lists the ports, test persons and the settings that need your own model and search accounts; everything works without them on the local test model.

Never commit `.env.local` or any secret, and never paste one into an issue or pull request. Tests use fakes and never call real models.

## Checks

```sh
npm run check   # prettier, eslint, type check, dependency boundaries, size budgets and all tests
```

The code follows these standards, and CI refuses a change that breaks them:

- **Formatting:** [Prettier](https://prettier.io), with the settings in `.prettierrc.json`.
- **Linting:** [ESLint](https://eslint.org) with `@eslint/js` recommended and `typescript-eslint` strict (`eslint.config.js`). `any` is an error.
- **Types:** TypeScript in `strict` mode, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (`tsconfig.base.json`).
- **Boundaries:** dependency-cruiser rules in `.dependency-cruiser.cjs` (`npm run boundaries`).

Docker must be running: the Postgres, pgvector and Typesense-writer suites start containers with Testcontainers. While you work, run a part with `npx vitest run <paths>`, plus `npx tsc -b` and `npx eslint <files>`. CI runs the same steps as `npm run check`, with the tests split over four runners, plus a gitleaks secret scan and a Docker image build on every pull request.

## Repository rules

- **Ports and adapters.** The kernel and the ports know only contracts. Models, search engines, rerankers and tools sit behind ports in `packages/port-*`; providers plug in at the edge.
- **Vendor SDKs only in `packages/providers-*`,** and only composition roots import providers. `npm run boundaries` enforces both.
- **Configuration and API first.** A new service, variant, prompt, dataset or guardrail is a definition, not code. Anything the portal or console can do goes through the API, so other frontends can do it too. New code is a package behind a contract, wired in `packages/composition`. The README's "Configuration or code?" table says which is which.
- **Generic platform.** Kunnskapsassistenten and Kudos are examples. Do not build behaviour that only one service can use.
- **English in code, two languages for users.** Code, config keys, routes and API fields are English. Text a user sees goes through the i18n catalogues ([packages/i18n/README.md](packages/i18n/README.md)), with bokmål as the source and English beside it, including error texts the apps show. A bokmål screen never shows English, and the other way round.
- **No em-dashes** in user-facing copy or docs.
- **Tests are required.** New functionality comes with automated tests in the same pull request, and every rule gets a test whose name states it, for example `refuses to start without a database unless dev mode is on`. A bug fix comes with the regression test that would have caught it. No check enforces this; the maintainer who merges is responsible for it.
- **Few comments.** Let names explain the code. Add at most one short line where something is genuinely unclear; the reason for a change belongs in the commit message or a test.
- **Architecture decisions** live in [docs/adr](docs/adr) as numbered files (`NNNN-short-title.md`) with a status line, the decision and why. Add one when you change a contract, a boundary or a security property, and keep its status honest about what is built.
- **Atlas.** If you add a module or a cross-package import, update `docs/architecture/modules/*.yaml` and run `npm run atlas:build`.

## Commits and pull requests

- Branch from `main` and keep each pull request to one change.
- Write commit subjects as a plain sentence that says what changes and why, for example "Refuse to start without a database unless dev mode is on".
- Fill in the pull request template: what changes, why, how you tested it, and which ADRs, docs or i18n catalogues you touched.
- `npm run check` must pass before review.

### Risk and undo

The pull request says how risky it is and how to undo it.

- **Low:** everything that does not touch the parts below. Merge when the checks pass and every review thread is answered.
- **Sensitive:** auth, identity, tenancy, the model gate, personal data handling, migrations, `infra/`, `.github/` or the `Dockerfile`. These also get the security review in [.github/review-security.md](.github/review-security.md), and the maintainers are told in the lab's Slack channel for sensitive changes before the merge. No approval is required.
- **Undo** says whether a revert is enough, or which data or infra step it needs.

### Automated review

Every pull request from this repository gets one review by a model when it opens, following [REVIEW.md](REVIEW.md) and the procedure in [.claude/skills/review-change/SKILL.md](.claude/skills/review-change/SKILL.md). It never approves, blocks or merges.

- **One summary comment** at the top of the pull request: what it changes, every finding with its status, and a prompt you can give your coding agent to fix the open ones.
- **One review** with all findings at once, as Important, Nit or Pre-existing, each naming the rule in REVIEW.md it rests on. Most have a suggestion you can commit from the pull request. When the change alters what CI runs, the review reads the pull request's own CI run to confirm the intended checks ran.
- **After each push**, a cheaper model checks the open findings against the new code. Fixed ones are answered with the commit and resolved, and the summary is updated. A push never brings new findings.

Run the same review before you open the pull request, so the one in CI finds nothing: `/review-change` in Claude Code, or ask another agent to follow that procedure.

Answer every open thread before you merge: fix it, or say why not ("not fixing, because ..."), which marks it dismissed. A reply is enough; no second person is needed. When a finding is wrong because a rule is missing or unclear, fix REVIEW.md in a separate pull request, so the next review knows. To have new commits reviewed, add the label `review again`. Pull requests from forks are not reviewed automatically; a maintainer runs the review locally.

Each review run also uploads `review-run.json` as a workflow artifact: cost, duration, model, the kind of author and the findings, with no names. The review dashboard reads these. A daily workflow also uploads `review-snapshot.json` with the CodeQL alerts and the shadow percent, which the dashboard cannot read with its own token. The repository variable `REVIEW_SHADOW_PERCENT` puts that share of pull requests, chosen by number, in a silent group: the review runs and is recorded but posts nothing, so the dashboard can compare. It is 0 unless set.

## Who maintains genki

genki is maintained by [Digdir R&D Lab](https://baksia.digdir.no/teams/lab/), the team exploring generative AI in Digdir's products, services and shared solutions. Write access is given through the GitHub team [@digdir/team-ai-lab](https://github.com/orgs/digdir/teams/team-ai-lab), whose members can merge pull requests. Who is in the team is managed there, not in this file.

- **Everyday changes** are pull requests, merged by a maintainer when the required checks pass. Human approval is not required: the checks, the tests and the ADRs carry the rules.
- **Contracts, boundaries and security properties** are decided in an ADR in [`docs/adr`](docs/adr/). Anyone can propose one, and the maintainers discuss and decide it together in the pull request.
- **Nothing is tied to a personal account.** The repository is in Digdir's GitHub organisation, the Azure environments and their Key Vault are in a Digdir Azure tenant, and deploys run from GitHub Actions with a federated identity (OIDC), not a stored Azure secret.

## Questions

Open an issue for questions, bugs and ideas. For a vulnerability, follow [docs/security](docs/security/README.md#reporting-a-vulnerability) and never use a public issue.
