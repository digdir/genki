# Roadmap

What genki intends to do over the next year, and what it does not. It is drawn from the [Status](README.md#status) section, the [ADRs](docs/adr/) that are proposed or not fully built, and the [open issues](https://github.com/digdir/genki/issues). It is a direction, not a promise, and it has no dates: the issues and their `priority` labels say what comes first.

The maintainers keep this file current ([who maintains genki](CONTRIBUTING.md#who-maintains-genki)). When an item is done, or dropped, it changes here in the same pull request.

## Where it stands

genki is under development and not in production. A locked test environment runs in Azure against Ansattporten TEST and Altinn tt02 ([ADR 0033](docs/adr/0033-locked-test-environment.md)). Only `main` is supported, and there are no releases yet.

## What the next year intends

### 1. Run for real

The goal is a production environment that agencies can use with real people and real data ([#38](https://github.com/digdir/genki/issues/38)).

- Real Ansattporten login in the portal, workspace and console, rights from the real Altinn authorisation API, and genki's resource registered in Altinn ([#41](https://github.com/digdir/genki/issues/41), [#42](https://github.com/digdir/genki/issues/42), [#43](https://github.com/digdir/genki/issues/43)).
- A backend-for-frontend, so tokens stay out of the browser before real people log in ([ADR 0034](docs/adr/0034-tokens-in-the-browser.md)).
- Operators recognised by an Entra group, with break-glass access audited ([ADR 0035](docs/adr/0035-operator-login.md)), and a model for how agencies delegate platform rights ([ADR 0036](docs/adr/0036-delegating-platform-rights.md)).
- Monitoring, backups, scaling and a cost frame before production ([#44](https://github.com/digdir/genki/issues/44)), budget limits in money, and rate limits shared across API instances ([#24](https://github.com/digdir/genki/issues/24)).
- Everything genki stores kept in the EU/EEA, with production in the same region as test ([ADR 0045](docs/adr/0045-data-stays-in-the-eu-eea.md)).

### 2. Replace digdir-headless-rag for Kunnskapsassistenten

- Answers at least as good as headless-rag's, shown on a test set that domain experts have reviewed ([#13](https://github.com/digdir/genki/issues/13), [#14](https://github.com/digdir/genki/issues/14), [#15](https://github.com/digdir/genki/issues/15), [#17](https://github.com/digdir/genki/issues/17), [#18](https://github.com/digdir/genki/issues/18)).
- Kudos on genki's own knowledge database, with genki doing the ingestion ([ADR 0042](docs/adr/0042-the-knowledge-database.md), [#29](https://github.com/digdir/genki/issues/29), [#140](https://github.com/digdir/genki/issues/140) to [#151](https://github.com/digdir/genki/issues/151), [#249](https://github.com/digdir/genki/issues/249), [#250](https://github.com/digdir/genki/issues/250)). Typesense then leaves genki's code ([#150](https://github.com/digdir/genki/issues/150)).
- Withdrawing a document on request, and keeping it out ([#178](https://github.com/digdir/genki/issues/178)).

### 3. Govern every model call the same way

- One gate in the kernel for every kind of model call, with closed payload shapes, masking and audit ([ADR 0047](docs/adr/0047-one-governed-path-for-model-operations.md)). The Azure OpenAI Decisions API is the first new kind on it ([#248](https://github.com/digdir/genki/issues/248)).
- Finish the durable jobs of [ADR 0041](docs/adr/0041-durable-jobs-on-pg-boss.md). Knowledge jobs already run on pg-boss; operators still need to see queues and dead letters and send them back ([#181](https://github.com/digdir/genki/issues/181)).
- The AI Gateway as a usage source, key issuer and, later, a model route ([ADR 0038](docs/adr/0038-ai-gateway.md), [#20](https://github.com/digdir/genki/issues/20) to [#23](https://github.com/digdir/genki/issues/23)).

### 4. Quality that can be proven

- Evaluation with Langfuse, where an agency's judges and labels count in genki while genki keeps the record ([ADR 0040](docs/adr/0040-evaluating-with-langfuse.md), [#93](https://github.com/digdir/genki/issues/93) to [#99](https://github.com/digdir/genki/issues/99)).
- A repeatable answer-quality comparison that can gate a publish ([#19](https://github.com/digdir/genki/issues/19)).

### 5. A UI that is a tested product

- The portal tested with service owners, its forms drawn from API schemas, and its structure built on the five nouns ([#2](https://github.com/digdir/genki/issues/2) to [#7](https://github.com/digdir/genki/issues/7)).
- Browser end-to-end tests for the key flows ([#10](https://github.com/digdir/genki/issues/10)), and a WCAG 2.1 AA audit with its findings fixed ([#11](https://github.com/digdir/genki/issues/11)).
- The workspace as the reference chat client ([#8](https://github.com/digdir/genki/issues/8)).

### Later, if there is room

More kinds of services and step blocks ([#45](https://github.com/digdir/genki/issues/45)), more sources than Kudos ([#31](https://github.com/digdir/genki/issues/31)), and personal context and memory in the workspace ([#33](https://github.com/digdir/genki/issues/33)). These are `p2` or `p3` and wait behind the items above.

## What genki will not do

- **Build for one service.** Kunnskapsassistenten is an example and an acceptance test, not a special case. Behaviour only one service can use does not go in.
- **Change services by itself.** The builder assistant and optimisers only propose changes. A person publishes them ([ADR 0020](docs/adr/0020-changes-made-by-ai.md)).
- **Run code an agency sends in.** Agencies extend genki with their own MCP or OpenAPI servers and remote engines, never with code inside the platform ([ADR 0015](docs/adr/0015-tenant-tools-and-secrets.md), [ADR 0028](docs/adr/0028-custom-logic-from-outside.md)).
- **Be an archive.** The agency's case system is the archive. genki exports a task with its provenance ([ADR 0011](docs/adr/0011-retention-erasure-and-archiving.md)).
- **Store data outside the EU/EEA, or handle classified information** (proposed in [ADR 0045](docs/adr/0045-data-stays-in-the-eu-eea.md)).
- **Pass through model features that keep data at the provider,** such as realtime sessions, provider-side files, stored responses or hosted agents, without an ADR of their own ([ADR 0047](docs/adr/0047-one-governed-path-for-model-operations.md)).
- **Support old versions.** Until production, only `main` is supported, with no backports ([docs/security](docs/security/README.md)).
