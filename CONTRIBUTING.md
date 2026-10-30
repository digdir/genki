# Contributing

Thank you for helping. The platform is under development and not in production, so expect things to move. Read the [README](README.md) first, and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

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

Docker must be running: the Postgres, pgvector and Typesense-writer suites start containers with Testcontainers. While you work, run a part with `npx vitest run <paths>`, plus `npx tsc -b` and `npx eslint <files>`. CI runs the same steps as `npm run check`, with the tests split over four runners, plus a gitleaks secret scan and a Docker image build on every pull request.

## Repository rules

- **Ports and adapters.** The kernel and the ports know only contracts. Models, search engines, rerankers and tools sit behind ports in `packages/port-*`; providers plug in at the edge.
- **Vendor SDKs only in `packages/providers-*`,** and only composition roots import providers. `npm run boundaries` enforces both.
- **Configuration and API first.** A new service, variant, prompt, dataset or guardrail is a definition, not code. Anything the portal or console can do goes through the API, so other frontends can do it too. New code is a package behind a contract, wired in `packages/composition`. The README's "Configuration or code?" table says which is which.
- **Generic platform.** Kunnskapsassistenten and Kudos are examples. Do not build behaviour that only one service can use.
- **English in code, two languages for users.** Code, config keys, routes and API fields are English. Text a user sees goes through the i18n catalogues ([packages/i18n/README.md](packages/i18n/README.md)), with bokmål as the source and English beside it, including error texts the apps show. A bokmål screen never shows English, and the other way round.
- **No em-dashes** in user-facing copy or docs.
- **Every rule gets a test whose name states it,** for example `refuses to start without a database unless dev mode is on`. A bug fix comes with the test that would have caught it.
- **Few comments.** Let names explain the code. Add at most one short line where something is genuinely unclear; the reason for a change belongs in the commit message or a test.
- **Architecture decisions** live in [docs/adr](docs/adr) as numbered files (`NNNN-short-title.md`) with a status line, the decision and why. Add one when you change a contract, a boundary or a security property, and keep its status honest about what is built.
- **Atlas.** If you add a module or a cross-package import, update `docs/architecture/modules/*.yaml` and run `npm run atlas:build`.

## Commits and pull requests

- Branch from `main` and keep each pull request to one change.
- Write commit subjects as a plain sentence that says what changes and why, for example "Refuse to start without a database unless dev mode is on".
- Fill in the pull request template: what changes, why, how you tested it, and which ADRs, docs or i18n catalogues you touched.
- `npm run check` must pass before review.

## Questions

Open an issue for questions, bugs and ideas. For a vulnerability, follow [SECURITY.md](SECURITY.md) and never use a public issue.
