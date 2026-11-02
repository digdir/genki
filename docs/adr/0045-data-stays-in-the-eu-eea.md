# 0045 Data stays in the EU/EEA; the region is an operating detail

Status: proposed, 2026-10-31

## Context

ADR 0001 put genki in Azure Norway East. In October 2026 Azure had capacity limits there: new Azure Firewall deployments were blocked ([Azure Firewall known issues](https://learn.microsoft.com/en-us/troubleshoot/azure/firewall/firewall-known-issues)), and a stopped D-series server could not start again in zone 1 for lack of capacity ([Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/6043112/subject-vm-allocation-capacity-unavailable-in-norw)). Norway West, the only other Norwegian region, is limited to disaster recovery for Norway East customers and needs an access request ([Azure regions](https://learn.microsoft.com/en-us/azure/reliability/regions-list)). Digdir's management asked the lab to move its Azure resources out of Norway East. Sweden Central was the first choice, but the subscription is not offered the smallest PostgreSQL sizes there (Burstable B1ms and B2s were refused with `SkuNotAvailable`), so genki test moved to West Europe on 31 October 2026, next to the lab's Langfuse.

A promise tied to one region cannot survive a move like this. The residency levels in genki (`norway`, `eu`, `global`, ADR 0021) describe where an endpoint processes data, and publishing refuses an endpoint wider than the service allows. They say nothing about where genki itself stores what it keeps.

The satsingsforslag asks for national infrastructure that Digdir operates, with sovereignty through the gateway and Norwegian or open models. It does not ask for the platform itself to be hosted in Norway.

Archive rules are not settled. The new arkivlova, in force from 1 January 2026, lets the ministry set conditions for storing digital archives abroad, and those conditions are left to a later hearing ([lovvedtak 79](https://www.stortinget.no/no/Saker-og-publikasjoner/Vedtak/Beslutninger/Lovvedtak/2024-2025/vedtak-202425-079/?all=true), [høyringsnotat](https://www.regjeringen.no/contentassets/7dad1aecaf0c45f08c000ff71c0b1791/hoyringsnotat_ny-arkivforskrift.pdf)). Arkivverket's guidance still expects an updated copy in Norway ([Skytjenester i et arkivperspektiv](https://www.nasjonalarkivet.no/content/uploads/2025/11/Skytjenester-i-et-arkivperspektiv_for-toppledere_veiledning-1.pdf)).

## Decision

- **Genki promises the EU/EEA, not a data centre.** Everything genki stores itself is stored and processed in data centres in the EU/EEA that Digdir chooses, Azure today: the platform database and its backups, uploaded files, datasets genki indexes itself (`pgvector` on the `platform` connection, and the knowledge server of ADR 0042 once built) and their backups, logs and metrics in Log Analytics and Application Insights, and traces on Digdir's Langfuse instance (ADR 0040). A tenant's own Langfuse connection keeps the residency it declares. Text for users says "i EU/EØS", never a region or a data centre.
- **A service's residency covers the endpoints it calls.** `norway`, `eu` or `global` on a service limits which models, rerankers, tools and search engines it may use (ADR 0021, ADR 0028). What genki stores for a service, such as its questions, answers, sources and feedback, is kept in the EU/EEA whatever the service's residency. A service that needs stored data in Norway cannot be promised that today.
- **What genki stores takes the residency of where genki runs, `eu` today.** A dataset on an engine genki runs cannot be declared `norway`, and creating or changing one with residency `norway` is refused. Moving genki to Norway needs a new record, which can raise this to `norway`.
- **`norway` stays for endpoints that can keep it.** A model, reranker, tool or search engine outside genki may still be declared `norway` when its host runs in Norway and says so. Publishing checks it against the service's residency as before (ADR 0021, ADR 0028). A dataset on an engine genki does not run, such as the shared Typesense cluster, keeps the residency its operator declares.
- **The region is an operating detail.** Test runs in West Europe, in the resource group `rg-genki-test-weu`. Prod is set up in the same region, so test proves prod's network, latency and quotas, once operations has confirmed that the database size prod needs is available there. The models genki calls are separate endpoints with their own residency. Today they run on an Azure AI Foundry resource in Sweden Central as GlobalStandard deployments, declared `global`. DataZone deployments in the EU give `eu` for every model there except Claude, the planned AI gateway gives `norway` with models hosted in Norway, and a tenant can bring its own endpoint. The region is the `location` parameter in `infra/env/test.bicepparam` and `infra/env/prod.bicepparam`, and `infra/README.md` says where each environment runs.
- **Moving within the EU/EEA needs no new record, but agencies are told.** Digdir's platform owner decides a region change. The data processing agreement lists the regions and the sub-processors, Microsoft and each model host, with their locations. Service owners are told in good time before a planned move, and as soon as possible after a forced one, so they can update their DPIA and risk assessment. Leaving the EU/EEA needs a new record.
- **Backups and copies stay inside the promise.** Geo-redundant backups go to the region Azure pairs with the primary; for West Europe that is North Europe. A region whose pair is outside the EU/EEA is not used, and no replication setting copies data outside the EU/EEA.
- **Out of scope.** Genki is not an archive system. Records that are archive material belong in the agency's own systems, in Norway where its rules require it. Genki is not approved for classified information or for systems designated under sikkerhetsloven.

## Why

- **A promise that holds through a move.** Capacity forced the move out of Norway East, and also decided where genki landed: Sweden Central does not offer the subscription the database size genki test uses. Promising the EU/EEA lets operators move genki inside it without telling every service owner that the platform broke its word.
- **It matches the rules for personal data.** The GDPR and the EEA agreement treat the EU/EEA as one area for personal data. Sector rules on archives and security, which each agency assesses itself, are out of scope above. Agencies that need processing in Norway can still choose endpoints that guarantee it.
- **A residency promise, not a sovereignty claim.** Genki runs on a US provider. Sovereignty comes from the gateway and Norwegian or open models, which services choose as `norway` endpoints. This record does not change that path, and Norway stays inside the promise if genki later runs there.
- **One parameter, not a project.** The infrastructure already takes the region as a parameter, so the promise costs nothing to keep.
- Turned down:
  - **Keeping a Norway-only promise.** Norway East has capacity limits, and Norway West is not open as a primary region. The promise binds genki to the one region that just failed it.
  - **Norway East with a Norway West request.** Norway West is granted only for disaster recovery of Norway East, so it gives no way out of a capacity problem in Norway East.
  - **Promising a named region.** The promise breaks on the next move, as Norway East's did.
  - **A larger PostgreSQL size in Sweden Central.** General Purpose costs about 1,200 kr more a month for a test environment.
  - **Test and prod in different regions.** Test then stops proving prod's network, latency and quotas.
  - **Region per tenant.** Every region doubles the infrastructure, and the EU/EEA promise already covers what tenants are owed.
  - **Running in two regions now.** It doubles cost and operations for a platform that is not yet in production. Geo-redundant backups give a way back after losing a region.

## Consequences

- Not built:
  - The refusal of `norway` for datasets on engines genki runs, with a test that a `pgvector` dataset on the `platform` connection cannot be saved as `norway`, and one that a `norway` model can still be published.
  - The connector flow's default. `apps/api/src/connectors.ts` creates connector datasets on `platform-pg` as `norway`; that becomes `eu`. The portal's dataset form still offers "I Norge" for genki's own engines.
  - Prod in West Europe. `infra/env/prod.bicepparam` and the prod section of `infra/README.md` change when prod is set up in `rg-genki-prod-weu`.
  - A move procedure in `infra/README.md`: copy the database, files and secrets, re-index `pgvector` if the embedding model changes, switch DNS and certificates, and delete the old resources and backups after verification. Genki test's move on 31 October 2026 followed these steps.
- Datasets declared `norway` on genki's own engines are reclassified as `eu` only after their owner accepts it. Kudos, planned for the knowledge server in ADR 0042, is the known case. Until the owner accepts, a `norway` service that uses such a dataset is unpublished rather than widened silently.
- ADR 0001 now says genki runs in Azure Container Apps in the EU/EEA, with the region set by operations (this record). ADR 0042 keeps the knowledge server in the platform's region.
- The portal's page on how data is handled says that what genki stores is kept in the EU/EEA. The portal and the console say that a service "only allows processing in Norway", not that it "requires data to stay in Norway".
- Models deployed as Azure AI Foundry GlobalStandard stay `global`. Operations can declare DataZone deployments in the EU as `eu`; ADR 0021 does not cover DataZone yet. A service that needs Claude is `global` until Claude is offered in an EU data zone.
- Revisit this record when Norway East or Norway West opens for new primary deployments, or when a tenant needs stored data in Norway.
