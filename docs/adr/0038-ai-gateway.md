# 0038 The AI Gateway as a usage source, key issuer and model route

Status: proposed, 2026-10-20 (amended 2026-11-03: contract written, sign-in, money, step 4 headers)

## Context

Digdir runs an AI Gateway that other teams and tools call directly, outside genki. The aivar lab (digdir/aivar-lab) prototypes it: agentgateway 1.6 behind a gateway-neutral API at `/v1` with models and prices (`GET /v1/models`), usage per hour or day (`GET /v1/usage`), and keys with budgets (`/v1/keys`). Its usage and model routes follow the contract genki proposed in #21, and it already knows genki: a key whose consumer is `genki` reports each call under `genki:<tenant>`, taken from the `genki-tenant` header, with `genki-task` beside it.

genki today calls model providers (Azure AI Foundry) directly, measures each call itself (`Usage` with `costMicroNok`), and keeps its own price list. An organisation that uses both genki and the gateway sees two totals, and a service owner who wants a gateway key asks the gateway team by hand (#23).

The lab API has no sign-in yet. Anyone who reaches it can read every organisation's usage and make keys.

## Decision

genki integrates with the gateway in four steps, each usable on its own, behind one product-neutral contract that genki owns and any gateway can implement.

- **The contract is genki's, written down.** `docs/api/gateway.md` describes the routes genki uses (`/v1/models`, `/v1/usage`, `/v1/keys`), subjects (`<kind>:<id>`, kinds `org`, `team`, `service`, `user`, `apiKey`, `genki`), closed buckets, money as `{ currency, micros }` and errors as problem+json. A gateway is accepted when it passes genki's contract tests against a fake; the aivar API's own contract checks and its in-memory gateway (`GATEWAY=fake`) are the first implementation.
- **Step 1, usage (#21).** A `port-usage` package with a `UsageSource` interface; genki's own records are one source and the gateway another. A worker job reads closed buckets once and open buckets hourly, maps subjects to organisations by organisation number, and the usage routes and screens show the sum with the source on each row.
- **Step 2, models and prices.** The gateway's model list (prices, residency, capabilities) becomes a model discovery source next to Foundry's, so a model genki routes through the gateway carries the price the gateway charges and the residency it runs in. Residency rules on services keep working on that data.
- **Step 3, keys (#23).** The portal gets "Gateway-nøkler" under Tilgang. A key is made for `org:<tenant>` or `service:<id>` within the tenant, with optional budgets. Making, changing and revoking a key are audited admin tasks with a reason (ADR 0010), and need `manage-services` (ADR 0027). The key value is shown once, as the gateway returns it once.
- **Step 4, genki's own calls through the gateway (optional, later).** A model endpoint may point at the gateway with a key whose consumer is `genki`. genki then sends `genki-tenant` and `genki-task` on every call, added by the model gate of ADR 0047 from the call's context, so no adapter or strategy can leave them out or set them. The gateway reserves `consumer: genki` for keys genki's client issued, refuses a genki call whose `genki-tenant` is missing or outside genki's scope, and removes every `genki-*` header before the provider.
- **No double counting.** Gateway rows under `genki:*` are stored but not counted while genki calls that model directly. Once a model runs through the gateway, its rows under `genki:<tenant>` replace genki's own measured cost for those calls, because only the gateway knows the price tier and context it charged; genki's own records keep the task link and tokens. A test proves each call is counted once.
- **Money stays in its currency.** Usage rows carry `{ currency, micros }` as the gateway reports them, and nothing is converted on the way in. Rates live in one table, `currency_rates`, by currency and day from Norges Bank. A kroner figure uses the rate for the row's day or the latest before it and is shown with the rate and its day. A row with no rate counts as unpriced in kroner, never as 0. genki's own `Usage.costMicroNok` stays as it is.
- **Sign-in comes first, on genki's identity model (ADR 0008).** genki calls the gateway only with a credential the gateway checks: a client key now, then a token for genki's managed identity from Entra ID. The gateway trusts several issuers at once, Entra ID for Digdir platforms and Maskinporten for other machine clients, so genki can move between them without a change on the gateway side. A client's scope (route scopes and organisation numbers) is configured on the gateway, never read from token claims or headers, and genki only reads usage and manages keys for its tenants. genki never forwards a person's Ansattporten token. Nothing in steps 1 to 4 runs against a gateway without sign-in, outside the lab.

## Why

One contract keeps genki free to work with the gateway the agency team chooses, and keeps the aivar API free to swap agentgateway for another product, as its adapter design already allows. Reading usage first gives service owners one total without changing how genki calls models. Keys in the portal remove a manual step and tie usage to an organisation from the start. Routing genki's own calls through the gateway is the largest change, since it puts the gateway in the path of every answer, so it comes last and stays optional per endpoint.

Rejected:

- **genki reading agentgateway's Postgres directly:** ties genki to one gateway product and its tables.
- **The gateway owning genki's usage screens:** service owners work in genki, and genki's usage carries the task, service and project that the gateway cannot see.
- **Routing everything through the gateway at once:** the gateway would become a dependency of every answer before it has sign-in, monitoring and an agreed operating model.

## Consequences

- New package `port-usage`, a gateway provider, a usage poll job in the worker, and a "Gateway-nøkler" section in the portal. Each step gets tests against a fake that implements the contract.
- Step 4 needs the model gate of ADR 0047, which is proposed and not built.
- `usage_buckets` and `currency_rates` are new tables. `Usage` gains `cost: Money` only when #22 brings prices in other currencies.
- The model and embedding routers put the list price on each call's `costMicroNok` when the call is metered (#189), unless the provider already reported a cost, and leave a call on an unpriced model unpriced. A gateway that reports its charge per call therefore wins over the price list without a change to the routers.
- To agree with the gateway team before step 1 is built: the client scope and when genki moves from the client key to Entra ID, how keys already handed out get a subject, whether `/v1/models` on the API and the OpenAI-compatible `/v1` on the gateway listener stay on separate hosts, a test gateway or credential per genki environment, and which of the contract's rules the gateway keeps in its API and which need a change to agentgateway itself. The subject kind `claim:<name>` is reserved for when the gateway accepts tokens on the model listener.
- If the gateway gets screens of its own for people, it signs them in with Ansattporten as genki does, so both read a person's organisations from the same Altinn rights.
- The lab API is a prototype. genki builds against the contract and the fake, and runs against a real gateway only once it has sign-in.
