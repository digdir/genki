# 0062 A service owner adds a hostname

Status: proposed, 2026-11-19 (partly built, 2026-11-19: hostnames from the parameter file)

Left: wildcard hostnames; hostnames on the API, portal, workspace and console, which stay in `hostnames` in `infra/main.bicep`; certificates the owner brings; and Front Door. Each needs its own change.

## Update, 2026-11-19

A maintainer adds a hostname now, through the environment's parameter file and a pull request (`hostedHostnames`, below). A name in genki's own zone, `<subdomain>.apps.<zone>`, is the default: genki assigns it and writes its DNS records, and nothing is claimed in genki's zone. A custom domain the service owns is the option. Kunnskapsassistenten first gets `kunnskap.apps.genki-test.digdir.cloud`, then moves `qa.kunnskap.digdir.cloud` this way. The self-service flow this record first proposed (a claims API, a DNS challenge token, a binder job, a custom role and an Azure Policy fence) is the later step, kept under "Later: self-service claims" as the planned design. It comes when more than a few services need hostnames, or a maintainer's review becomes the bottleneck. The host's own environment and identity hold for both.

## Context

genki's custom domains are four fixed hostnames, one per app, in the `hostnames` parameter of `infra/main.bicep`, bound in three stages by `customDomainsStage` (`none`, `hostnames`, `certificates`) in `infra/modules/containerapps.bicep`. Adding one means a pull request to a param file and an infrastructure deploy by a maintainer. A hosted assistant (ADR 0061) needs a hostname per service and environment, chosen by the service owner, on a domain the owner controls.

Azure Container Apps binds a custom domain to an app in `properties.configuration.ingress.customDomains` and issues a free managed certificate (`Microsoft.App/managedEnvironments/managedCertificates`) once DNS points at the app: a CNAME to the app's FQDN and a TXT record `asuid.<host>` with the app's `customDomainVerificationId` for a subdomain, an A record to the environment's static IP for an apex name. Changing ingress is an application-scope change and makes no new revision. The verification id is the same for every hostname on the app, so it proves that DNS points at genki, not which tenant asked.

Azure has no action for binding a domain alone. Binding needs `Microsoft.App/containerApps/write`, which also changes the app's image, environment variables, secrets and identities, and managed certificates are written with `Microsoft.App/managedEnvironments/managedCertificates/write` on the whole environment. Azure Policy can deny a write by the values it sets, through aliases, but cannot compare a new value with the old one.

genki's apps share one identity today. The web apps carry it (`infra/modules/containerapps.bicep:471-474`), it reads every secret in Key Vault (`infra/main.bicep:239`, Key Vault Secrets User in `infra/modules/keyvault.bicep:25-33`), it is the Postgres login (`containerapps.bicep:157`), the worker carries it (`containerapps.bicep:264-266`), and the managed certificates live in the same environment as the API (`containerapps.bicep:114`). Any identity that can write a container app holding that identity can reach all of it.

## Decision

### The host stands apart

- **The assistant host runs in its own Container Apps environment,** `${baseName}-hosted-env`, with its own managed certificates. genki's API, worker and apps, and their certificates, stay in the existing environment.
- **The host has its own identity,** `${baseName}-assistant-id`. It may pull images from genki's registry and read one secret, `GENAI_PROXY_KEY`, from a Key Vault of its own, `${baseName}-hostkv`, which holds nothing else. It has no role on genki's Key Vault, no Postgres login and no other Azure role. The host reaches the API over HTTPS on the API's public hostname.

### Now: a maintainer adds a hostname through the parameter file

- **One entry adds a hostname end to end.** `hostedHostnames` in `infra/env/<env>.bicepparam` takes `{ subdomain or hostname, tenant, stage, apex? }`, added by pull request and reviewed by a maintainer. The review is where it is checked that the organisation asking owns the service and, for a custom domain, controls the domain.
- **A subdomain is the default.** `subdomain` is one lowercase DNS label and becomes `<subdomain>.apps.<dnsZoneName>` (`genki-test.digdir.cloud` in test, `genki.digdir.cloud` in prod). The template writes its CNAME to the host app's FQDN and its `asuid` TXT record in genki's own Azure DNS zone, as it does for the four app hostnames. Each name has its own managed certificate; there is no wildcard. The `apps.` level holds these names alone: no app hostname and no custom domain may be put there, and the API accepts exactly one label under `apps.` in genki's zones and nothing else in them.
- **The API opens the hostname to that organisation.** Every entry reaches the API as `GENAI_HOSTED_HOSTNAMES` (`host=tenant,host=tenant`). Only a hosted Client of that tenant may name it in `spec.hostnames`, with the environment it draws (ADR 0064), and `GET /v1/hosts/{hostname}` answers only for a hostname that is both opened and named; every other hostname gets the same `404` (`urn:genai:problem:host-not-found`). Any other name under genki's own zones (`genki-test.digdir.cloud`, `genki.digdir.cloud`, `azurecontainerapps.io` and every zone in `GENAI_RESERVED_DOMAINS`) is never opened (`isAssignedName` in `apps/api/src/hosts.ts`).
- **The assistant host binds it in stages,** per hostname, as `CUSTOM_DOMAINS_STAGE` does for the four app hostnames, since Azure issues a managed certificate only for a hostname already on the app: `none` opens it in the API only, `hostnames` adds it to `${baseName}-assistant` with binding `Disabled`, and `certificates` creates a managed certificate in `${baseName}-hosted-env` and binds it `SniEnabled`. Each step is a pull request and a deploy. Nothing binds while `assistantHostEnabled` is off.
- **For a custom domain, the owner creates the DNS records,** in their own zone: a CNAME from the hostname to the host app's FQDN and `TXT asuid.<hostname>` with the host environment's verification id. The deploy's output `assistantHost.dnsRecords` lists them per hostname. genki writes no record in the owner's zone.
- **An apex name works without a CNAME.** With `apex: true` the record is an A record to the static IP of the host's environment (not genki's existing one), and the certificate is validated over HTTP, which Container Apps documents for apex domains.
- **Removing** the entry unbinds the hostname and closes it in the API at the next deploy; its certificate is deleted by hand. **Rolling back** a moved domain is pointing its record back where it was and removing the entry.
- **No identity writes Azure at run time.** Only the deploy binds hostnames, as it binds the rest of the template.
- A test holds every entry in both parameter files to the API's rules: a subdomain that is one valid label or a lowercase hostname outside genki's zones, a nine-digit organisation number, a known stage and no name twice, and keeps the four app hostnames off `apps.` (`scripts/hosted-hostnames-infra.test.ts`). Moving a team's existing domain is in `docs/runbook.md`.

### Later: self-service claims

Planned, not built. It replaces the parameter file for hosted hostnames: each entry becomes a claim, and `hostedHostnames` is removed.

#### Claiming a hostname

- **A hostname belongs to a hosted Client.** `POST /tenants/{tenant}/clients/{client}/hostnames` with `{ hostname, environment, reason }` claims one for a hosted Client (ADR 0061). It needs `manage-services` and goes through the admin action `platform.client.hostnames.add` (ADR 0010).
- **Some names can never be claimed.** A name under genki's own zones (`genki-test.digdir.cloud`, `genki.digdir.cloud` and every zone in `GENAI_RESERVED_DOMAINS`), under `azurecontainerapps.io`, an IP address, a wildcard, and a name longer than 253 characters are refused with `400 hostname_not_allowed`.
- **A hostname may redirect.** A claim with `{ hostname, redirectTo, reason }` names another hostname of the same Client instead of an environment. Once both are `active`, the host answers every request on it with `308` to the same path on `redirectTo`, starts no login there, and registers no redirect URI for it.
- **The owner proves control of the domain with a token only they get.** A claim answers a random token and three records to create: `_genki-challenge.<hostname>` TXT with the token, `asuid.<hostname>` TXT with the host app's verification id, and a CNAME from the hostname to the host app's FQDN (an A record to the static IP for an apex name). The token is per claim, so knowing genki's verification id is not enough.
- **An apex name works without a CNAME.** DNS allows no CNAME at a zone apex, so for a name such as `kunnskap.digdir.cloud` the records are an A record to the static IP of the host's environment, `asuid` and `_genki-challenge` TXT records at the apex itself, and the managed certificate uses HTTP validation, which Container Apps documents for apex domains. The static IP is the host environment's, not genki's existing one, and the portal shows it with the records.
- **The first verified claim owns the hostname.** Claims in `pending-dns` do not block each other: several tenants may claim the same name, and the answer is the same whether or not someone else has. A unique index on the lowercased hostname covers exactly the states `binding`, `active` and `removing`, so the first claim whose challenge verifies takes it. Every other claim on that name ends `failed` with `not_verified`, the same result as records that never appear, so a claim never tells a tenant that a name is held. A later claim can take over only once the holder is `lapsed` or removed.

#### Binding it

- **DNS is checked by genki, Azure is written by a job of its own.** The worker checks the three records through a resolver that asks the authoritative name servers, and moves a verified claim to `binding`. It has no Azure right.
- **The binder is a Container Apps Job,** `${baseName}-hostname-binder`, in the host's environment, with one identity, `${baseName}-binder-id`, and nothing else attached. It runs every minute. It asks the API for the claims in `binding` and `removing` (`GET /internal/hostnames/work`, Entra token for the binder's identity, refused for any other principal), applies them, and reports each result (`POST /internal/hostnames/{id}/result`). It holds no database login, no Key Vault right and no genki secret.
- **The binder's role has only the actions binding needs,** a custom role `genki hostname binder`: `Microsoft.App/containerApps/read`, `Microsoft.App/containerApps/write` and `Microsoft.App/containerApps/listCustomHostNameAnalysis/action` on the assistant host's container app, and `Microsoft.App/managedEnvironments/read`, `managedEnvironments/join/action` and `managedEnvironments/managedCertificates/read|write|delete` on the host's environment. Nothing in genki's own environment, Key Vault, Postgres or registry.
- **Azure Policy fences the rest of the write.** A custom policy with effect `Deny`, assigned on the host app, refuses any write that sets: an image outside genki's registry and the `genki-apps` repository, or not pinned by digest; a user-assigned identity other than the host's; a secret other than `GENAI_PROXY_KEY` from `${baseName}-hostkv`; an API address other than genki's API hostname; external ingress with `allowInsecure`; or any container, init container, volume or scale rule the template does not have. The deploy pipeline writes within the same fence. An Activity Log alert tells the maintainers of every write to the host app that is not by the deploy identity or touches more than `customDomains`.
- **Each step is idempotent.** The binder adds the hostname with binding `Disabled`, creates a managed certificate with CNAME validation (HTTP for an apex name), and switches the binding to `SniEnabled`. It reads the app, changes only `customDomains`, and writes it back; one run at a time. It retries for 48 hours, then the claim is `failed` with the step and Azure's message.
- **States:** `pending-dns`, `binding`, `active`, `failed`, `lapsed`, `removing`. `GET /tenants/{tenant}/clients/{client}/hostnames` shows the tenant's own claims with their records and last check. The portal shows the same, with the records to copy.
- **Only `active` hostnames are served.** `GET /v1/hosts/{hostname}` answers 404 for every other state, so the host draws nothing and starts no login on a hostname that is not verified.
- **The database is the truth, Azure follows.** On each run the binder also compares the app's `customDomains` with the `active` and `binding` hostnames, adds what is missing and removes what no claim holds, and reports each change.
- **The infrastructure deploy keeps them.** The host's module reads the app's current `customDomains` through an `existing` reference and passes them through, so a deploy does not drop them before the binder runs again.

#### Keeping it, and taking it away

- **genki checks each active hostname once a day.** When `_genki-challenge` or the record the claim asked for (the CNAME, or the A record for an apex name) has been gone for 7 days in a row, the hostname is `lapsed`: it is no longer served, and the owner and the audit log are told. After 30 days lapsed it is removed. This keeps a hostname whose domain has changed hands from drawing a service.
- **Removing** (`DELETE .../hostnames/{hostname}` with a reason, action `platform.client.hostnames.remove`) stops sessions on it at once, since the API reads the hostname's state for every session request (ADR 0061); the binder then unbinds it and deletes its certificate. Removing the Client removes its hostnames.
- **Rolling back** is removing the hostname in genki and pointing the CNAME back where it was. genki has no other state for it.
- **Every step is in the audit log:** the claim, each verification result, bind, lapse and removal, with who, when, why and the records seen.

#### Limits

- At most 4 hostnames per Client, 20 per tenant and 200 for the host app, and at most 5 claims per tenant waiting for DNS. The platform limit is under `GENAI_HOSTNAME_LIMIT` and is lowered if Azure's own limit turns out lower.
- A claim not verified in 7 days expires.
- Managed certificates are free. The host is one container app and one environment whatever the number of hostnames.

#### What a stolen binder can do

If the binder's identity is taken, the attacker can, within the policy: bind or unbind hostnames on the host app, create or delete certificates in the host's environment, and roll the host to another genki image by digest. That can take hosted assistants offline, or serve them on a hostname the attacker controls, where the BFF still refuses a session on a hostname that is not `active` for its Client.

It cannot: run code of its own on the host, read genki's Key Vault, reach Postgres, change the API, worker, portal, workspace or console, or touch their certificates. The one secret within reach is `GENAI_PROXY_KEY`, and only by mounting it into a genki image, which does not print it. Rotating the proxy key and the binder's identity is the response, and the alert says when.

## Why

A maintainer's pull request is enough while a handful of services have hostnames, and it gives what self-service would lose:

- **Review by a person before a name goes live.** The reviewer checks that the asker controls the domain.
- **One source of truth for Azure state.** The host app's domains are in the template, so a deploy never drops them.
- **No write right to Azure at run time.** No identity outside the deploy can change the host app.

It costs a pull request and up to three deploys per hostname, and a maintainer's time. Self-service later gives a service owner a hostname in minutes without asking a maintainer and with no deploy, with the checks kept as rules the API enforces and as the audit log. Because Azure has no narrower right than writing the whole app, its boundary is drawn around the app: its own environment, its own identity with almost nothing, and a policy on what any write may set. Its reserved list, first-verified rule and DNS proof cover the abuse we know of: claiming genki's own names, another tenant's names, or a name the claimant does not control.

Rejected:

- **The binder's identity on the worker or the API.** Those carry the shared identity with all of Key Vault and Postgres, so a flaw in either would hand over both the data and the host.
- **The host in genki's own environment, with the shared identity.** A write to it could attach the shared identity or a Key Vault reference and read every platform secret, and certificate rights there would cover the API's.
- **A custom role with a binding action only.** Azure has none: the compute permissions list no action for custom domains apart from `listCustomHostNameAnalysis`.
- **The API calls Azure in the request.** Certificate issuance takes minutes and fails often while DNS propagates; the request would time out and a retry would race with itself.
- **`asuid` alone as proof.** The verification id is the app's, not the claim's, so any tenant could point its claim at a name someone else has pointed at genki.
- **Uniqueness from the first claim.** It would let any tenant block a name it does not control, and its 409 would tell it who holds which names.
- **Front Door.** It removes the Bicep pass-through and per-app limits, but costs a base fee per profile and every request, and ADR 0061 decided against it for now. It stays the way out if hostnames outgrow one app.

## Consequences

- Kunnskapsassistenten's `qa.kunnskap.digdir.cloud` is added through the parameter file. At the swap it is removed from the old app first, since Azure binds a hostname to one app, then bound here and its CNAME moved; the gap is a few minutes. The DNS zone stays where it is until the old resource group is retired. Later hostnames per environment, `test.kunnskap.digdir.cloud` for `test` and the apex `kunnskap.digdir.cloud` for `prod` with `qa` redirecting to it (ADR 0064), are entries of the same kind; the redirect needs the self-service flow or a host rule of its own.
- A CAA record on the owner's domain must allow `digicert.com`, and the owner must not put a proxy CNAME in between.
- Azure documents no limit on custom domains per app or managed certificates per environment, and no rate for DigiCert issuance.
- Built: `hostedHostnames` and its stages, subdomains under `apps.` with their records in genki's zone (`infra/modules/dns.bicep`), the managed certificates and bindings on the host app, the `assistantHost.dnsRecords` output and `GENAI_HOSTED_HOSTNAMES` (`infra/main.bicep`, `infra/modules/assistant-host.bicep`, test `scripts/hosted-hostnames-infra.test.ts`); the host's own environment, identity with AcrPull only, and Key Vault (`infra/modules/assistant-host-infra.bicep`, test `scripts/assistant-host-infra.test.ts`); the API's reading of `GENAI_HOSTED_HOSTNAMES` and the reserved zones, with one label under `apps.` let through (`apps/api/src/hosts.ts`, test "a service may take one label under apps. in genki’s zone once opened to it, and no other name there"). None of it is deployed while `assistantHostEnabled` is off.
- Not built: `GENAI_PROXY_KEY` in the host's Key Vault (ADR 0061), and all of "Later: self-service claims". When the claims come, an operator assigns the custom role, the policy and the alert once, with rights to create role and policy assignments, which the infrastructure workflow lacks; the policy's aliases are confirmed with `az provider show --namespace Microsoft.App --expand "resourceTypes/aliases"` first, and a part without an alias is covered by the alert only. Tests to come with them: "a hostname under genki's own zones is refused", "a claim on a name another tenant holds looks like any unverified claim", "pending claims on one name do not block each other and the first verified wins", "a hostname is not served before its challenge is verified", "an apex hostname is verified by A and TXT records and bound with HTTP validation", "a redirect hostname answers 308 to the same path and starts no login", "a lapsed hostname is not served", "the binder removes a domain no claim holds", "the internal hostname routes refuse every principal but the binder", "the infrastructure template passes the host app's domains through", "the policy refuses an image outside genki's registry on the host app".

## Sources

- Custom domains and managed certificates: https://learn.microsoft.com/en-us/azure/container-apps/custom-domains-managed-certificates
- Revisions and application-scope changes: https://learn.microsoft.com/en-us/azure/container-apps/revisions
- Container app and managed certificate resources: https://learn.microsoft.com/en-us/azure/templates/microsoft.app/containerapps, https://learn.microsoft.com/en-us/azure/templates/microsoft.app/managedenvironments/managedcertificates
- `Microsoft.App` permissions: https://learn.microsoft.com/en-us/azure/role-based-access-control/permissions/compute
- Azure Policy effects and aliases: https://learn.microsoft.com/en-us/azure/governance/policy/concepts/effect-deny, https://learn.microsoft.com/en-us/azure/governance/policy/concepts/definition-structure-alias
- Container Apps jobs: https://learn.microsoft.com/en-us/azure/container-apps/jobs
