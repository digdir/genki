# 0045 Data stays in the EU/EEA; the region is an operating detail

Status: proposed, 2026-10-30

## Context

ADR 0001 put genki in Azure Norway East. In October 2026 Azure had capacity limits there: new Azure Firewall deployments were blocked ([Azure Firewall known issues](https://learn.microsoft.com/en-us/troubleshoot/azure/firewall/firewall-known-issues)), and a stopped D-series server could not start again in zone 1 for lack of capacity ([Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/6043112/subject-vm-allocation-capacity-unavailable-in-norw)). Norway West, the only other Norwegian region, is limited to disaster recovery for Norway East customers and needs an access request ([Azure regions](https://learn.microsoft.com/en-us/azure/reliability/regions-list)). Digdir's management asked the lab to move its Azure resources out of Norway East. Sweden Central was the first choice, but the smallest PostgreSQL sizes (Burstable B1ms and B2s) are not available to the subscription there, so genki moved to West Europe.

A promise tied to one region cannot survive a move like this. The residency levels in genki (`norway`, `eu`, `global`, ADR 0021) describe where an endpoint processes data, and publishing refuses an endpoint wider than the service allows. They say nothing about where genki itself stores what it keeps.

## Decision

- **Genki promises the EU/EEA, not a data centre.** Everything genki stores itself is stored and processed in Azure regions in the EU/EEA that Digdir chooses: the platform database and its backups, uploaded files, datasets genki indexes itself (`pgvector`, the knowledge server of ADR 0042) and their backups, and the platform's logs and traces. Text for users says "i EU/EØS", never a region or a data centre.
- **The region is an operating detail.** Genki runs in West Europe, in test and in prod. The models it calls are separate endpoints, in Sweden Central today, and keep their own residency. The region is the `location` parameter in `infra/env/test.bicepparam` and `infra/env/prod.bicepparam`, and `infra/README.md` says where each environment runs. Moving to another EU/EEA region is an operations change that needs no new record; leaving the EU/EEA needs one.
- **What genki stores is declared `eu`.** A dataset on an engine genki runs (`pgvector` with the `platform` or `knowledge` connection) cannot be declared `norway`, because genki does not promise that. Creating or changing such a dataset with residency `norway` is refused.
- **`norway` stays for endpoints that can keep it.** A model, reranker, tool or search engine outside genki may still be declared `norway` when its host runs in Norway and says so. Publishing checks it against the service's residency as before (ADR 0021, ADR 0028). A dataset on an engine genki does not run, such as the shared Typesense cluster, keeps the residency its operator declares.
- **Backups and copies stay inside the promise.** Geo-redundant backups go to the region Azure pairs with the primary; for West Europe that is North Europe. A region whose pair is outside the EU/EEA is not used.

## Why

- **A promise that holds through a move.** Capacity forced this move, and capacity also decided where genki landed: Sweden Central had no room for the database size genki uses. Promising the EU/EEA lets operators move genki inside it without telling every service owner that the platform broke its word.
- **It matches the rules that apply.** The GDPR and the EEA agreement treat the EU/EEA as one area for personal data. Agencies that need data to stay in Norway can still choose endpoints that guarantee it.
- **One parameter, not a project.** The infrastructure already takes the region as a parameter, so the promise costs nothing to keep.
- Turned down:
  - **Keeping a Norway-only promise.** Norway East has capacity limits, and Norway West is not open as a primary region. The promise would bind genki to the one region that just failed it.
  - **Promising a named region.** The promise would break on the next move, as Norway East's did.
  - **Running in two regions now.** It doubles cost and operations for a platform that is not yet in production. Geo-redundant backups give a way back after losing a region.

## Consequences

- Not built:
  - The refusal of `norway` for datasets on engines genki runs, with a test that a `pgvector` dataset on the `platform` connection cannot be saved as `norway`, and one that a `norway` model can still be published.
  - Prod in West Europe. Test runs in West Europe in the resource group `rg-genki-test-weu`; `infra/env/prod.bicepparam` and the prod section of `infra/README.md` change when prod is set up in `rg-genki-prod-weu`.
- ADR 0001 now says genki runs in Azure Container Apps in the EU/EEA, with the region set by operations (this record). ADR 0042 keeps the knowledge server in the platform's region.
- The portal's page on how data is handled says that what genki stores is kept in the EU/EEA.
- Datasets created as `norway` on genki's own engines before the refusal is built are changed to `eu` when they move to the new region.
- Models deployed as Azure AI Foundry GlobalStandard stay `global`, and DataZone deployments in the EU are `eu`, as ADR 0021 describes.
