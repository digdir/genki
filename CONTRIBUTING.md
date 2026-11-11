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
- **Component pages.** The building blocks assistants are made from (chat, approach, sources and the rest) each have a page in [docs/components](docs/components/index.html). A PR that changes a component updates its page in the same PR: phase, variants, what we learned and open questions, and a line in the change log on the landing page.
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
- **One review** with all findings at once, as Important, Nit or Pre-existing, each naming the rule in REVIEW.md it rests on. Most have a suggestion you can commit from the pull request. When the change alters what CI runs, the review reads whatever checks have finished and treats pending ones as unknown, not as missing or failed. It reports a CI wiring problem only when it can show it from the workflow file or a finished run.
- **One size note** when the pull request is large: above 3000 changed lines or 50 files, not counting lockfiles, `docs/architecture/system-atlas.html` and snapshots. A step in the workflow measures it, not the model, and the note says what it measured and suggests a split. It is a plain comment, not a finding, and does not block the merge. Of the 200 pull requests merged up to #453, half changed under 300 lines and these limits would have flagged about one in seven.
- **After each push**, a cheaper model checks the open findings against the new code. Fixed ones are answered with the commit and resolved, and the summary is updated. A push never brings new findings.

Run the same review before you open the pull request, so the one in CI finds nothing: `/review-change` in Claude Code, or ask another agent to follow that procedure.

Answer every open thread before you merge: fix it, or say why not ("not fixing, because ..."), which marks it dismissed. A reply is enough; no second person is needed. When a finding is wrong because a rule is missing or unclear, fix REVIEW.md in a separate pull request, so the next review knows. To have new commits reviewed, add the label `review again`. Pull requests from forks are not reviewed automatically; a maintainer runs the review locally.

Each review run also uploads `review-run.json` as a workflow artifact: cost, duration, model, the kind of author, whether the pull request was over the size limit, and the findings, with no names. The review dashboard reads these. A daily workflow also uploads `review-snapshot.json` with the CodeQL alerts and the shadow percent, which the dashboard cannot read with its own token. The repository variable `REVIEW_SHADOW_PERCENT` puts that share of pull requests, chosen by number, in a silent group: the review runs and is recorded but posts nothing, so the dashboard can compare. It is 0 unless set.

### Cross-model review

Most of genki is written and reviewed by Claude, so the two can share blind spots. A pull request whose changed paths are security-sensitive (the same paths the review dashboard counts as sensitive: identity, guardrails, tenancy, the gate, rights, principals, audit, secrets, migrations, `infra/`, `.github/` and the `Dockerfile`) also gets a second review from a model of another family, the `cross-model` job in [`review.yml`](.github/workflows/review.yml). It runs after the first review, assumes the change is wrong, and posts only findings on lines the pull request changes that name who could abuse it, how far it reaches and the file and line, checked against REVIEW.md and [.github/review-security.md](.github/review-security.md). Its comments have the same format as the first review's, so the summary, the follow-up after a push and the dashboard read them, and each says it comes from the cross-model reviewer. A finding on the same lines as one the first review posted is recorded but not posted again. It posts nothing in the silent group, does not run on `review again`, and records each run in `cross-review-run.json`, apart from `review-run.json`.

- **Cost.** At most 16 model turns, 500,000 input and 40,000 output tokens a run: about 1 USD at GPT-5 class prices, usually much less.
- **Tools.** The model reads tracked files and searches for literal text at the pull request's head. It cannot run commands, and its output reaches only the posted comments and the run record.
- **Off until set up.** The job does nothing until the repository variable `CROSS_REVIEW_DEPLOYMENT` names a deployment. To set it up once:
  1. Deploy a non-Claude model on the review's Foundry resource, for example an OpenAI GPT-5 class reasoning model (the newest full model, not mini, the catalogue offers in the resource's region): `az cognitiveservices account deployment create -g <resource group> -n <resource> --deployment-name <name> --model-format OpenAI --model-name <model> --model-version <version> --sku-name DataZoneStandard --sku-capacity <thousands of tokens per minute>`. Use `GlobalStandard` if the model has no data zone deployment there.
  2. Give the review identity (`AZURE_REVIEW_CLIENT_ID`) the role `Cognitive Services OpenAI User` on the resource, unless it already has `Cognitive Services User` or `Azure AI User` there: `az role assignment create --assignee <client id> --role "Cognitive Services OpenAI User" --scope <resource id>`.
  3. Set the repository variable `CROSS_REVIEW_DEPLOYMENT` to the deployment name. Remove it to turn the review off again.
  4. Set the repository variables `CROSS_REVIEW_PRICE_IN_USD` and `CROSS_REVIEW_PRICE_OUT_USD` to the deployment's list prices in US dollars per million input and output tokens. The run record then carries `cost_usd`; without both, it is null.

### Security sweep

The review reads one diff, so a gap that has been in the code from the start never shows up in it. Every Monday at 03:17 UTC, and by hand from the Actions tab, [`security-sweep.yml`](.github/workflows/security-sweep.yml) has the same model read the security-sensitive code as it is, following [.claude/skills/security-sweep/SKILL.md](.claude/skills/security-sweep/SKILL.md). Three passes (tenancy, rights, secrets and personal data) check the Important bullets in REVIEW.md and the invariants in [.github/review-security.md](.github/review-security.md). A coordinator merges their candidates, drops any without file and line evidence, and keeps only those where it can say who could abuse it and how far it reaches. It runs only in this repository, never in a fork or on a pull request.

- **Cost.** Each of the four model steps stops at about 6 USD, so a run costs at most about 24 USD, roughly 260 kr; a usual run is expected to cost 80 to 150 kr. Each run records its cost and how each pass and the coordinator ended (success, failure, skipped or cancelled) in `security-sweep-run.json`, which holds no findings.
- **Where findings go.** Never to an issue, comment or the job log: the repository is public, and so are its logs and artifacts. The findings are encrypted to the maintainers' public keys in the repository variable `SECURITY_SWEEP_PUBLIC_KEYS` and uploaded as `security-sweep.sealed.json`, kept for 14 days. Without that variable the sweep stops before it calls a model. The workflow token cannot create a security advisory, and a stored token that can is not worth the risk.
- **Reading them.** `gh run download <run id> -n security-sweep-<run id>`, then `node scripts/security-sweep.ts open security-sweep.sealed.json <your private key>`. Open a draft advisory on the Security tab for each finding you confirm.
- **Adding a maintainer key.** `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out sweep.pem`, keep `sweep.pem` to yourself, and add the output of `openssl pkey -in sweep.pem -pubout` to the variable. It takes several keys one after another.

## Who maintains genki

genki is maintained by [Digdir R&D Lab](https://baksia.digdir.no/teams/lab/), the team exploring generative AI in Digdir's products, services and shared solutions. Write access is given through the GitHub team [@digdir/team-ai-lab](https://github.com/orgs/digdir/teams/team-ai-lab), whose members can merge pull requests. Who is in the team is managed there, not in this file.

- **Everyday changes** are pull requests, merged by a maintainer when the required checks pass. Human approval is not required: the checks, the tests and the ADRs carry the rules.
- **Contracts, boundaries and security properties** are decided in an ADR in [`docs/adr`](docs/adr/). Anyone can propose one, and the maintainers discuss and decide it together in the pull request.
- **Nothing is tied to a personal account.** The repository is in Digdir's GitHub organisation, the Azure environments and their Key Vault are in a Digdir Azure tenant, and deploys run from GitHub Actions with a federated identity (OIDC), not a stored Azure secret.

## Questions

Open an issue for questions, bugs and ideas. For a vulnerability, follow [docs/security](docs/security/README.md#reporting-a-vulnerability) and never use a public issue.
