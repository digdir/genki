# AI Gateway contract

What genki needs from an AI gateway: the models it serves and their prices, usage per hour or day, and keys with budgets. Any gateway product can sit behind it. A gateway is accepted when it passes genki's contract tests against a fake that implements this page ([ADR 0038](../adr/0038-ai-gateway.md)). The aivar lab API and its in-memory gateway (`GATEWAY=fake`) are the first implementation.

genki is the client here. Nothing on this page is a route genki serves.

## Routes

All routes are under one base URL that genki configures, such as `https://gateway-api.example.no/v1`. It is not the base URL genki sends model calls to: the gateway's OpenAI-compatible `/v1/models` lists models for callers, and this one lists models with prices for genki. They may share a host only if the paths do not collide.

| Route                                                 | Scope         | What it does                                                          |
| ----------------------------------------------------- | ------------- | --------------------------------------------------------------------- |
| `GET /v1/models`                                      | `models:read` | The served models, with prices, residency and capabilities            |
| `GET /v1/usage?from&to&bucket&groupBy&subject&cursor` | `usage:read`  | Usage per hour or day, at the cost each call had                      |
| `POST /v1/keys`                                       | `keys:write`  | Makes a key for a subject. The secret is in this answer only          |
| `GET /v1/keys?subject&cursor`                         | `keys:read`   | The keys within the client's scope, or one subject's, with budget use |
| `GET /v1/keys/{id}`                                   | `keys:read`   | One key                                                               |
| `PATCH /v1/keys/{id}`                                 | `keys:write`  | Changes the name, labels, models, limits or subject                   |
| `DELETE /v1/keys/{id}`                                | `keys:write`  | Revokes the key                                                       |

Step 1 (usage) needs `models:read` and `usage:read`. Step 3 (keys) adds `keys:read` and `keys:write`. genki asks for no more than the step it runs.

## Authentication

genki sends a credential with every request, and the gateway checks it before anything else. Without a valid credential the answer is `401`.

The gateway follows genki's own identity model ([ADR 0008](../adr/0008-principal-model-and-api-key-bridge.md), [ADR 0035](../adr/0035-operator-login.md)): machines and people sign in through different issuers, and an organisation is always an organisation number.

| Who                                 | Issuer                                                            | Token                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| genki as a client, now              | The gateway                                                       | `Authorization: Bearer <client key>`, a key the gateway team issues to genki                                       |
| genki as a client, next             | Entra ID                                                          | A token for genki's managed identity, with the gateway API as audience. No secret to store or rotate               |
| Other machine clients, later        | Maskinporten                                                      | A token for the client's Maskinporten client, with a gateway scope. Organisation is the consumer, as in genki      |
| People in the gateway's own screens | Ansattporten, with Entra ID through Ansattporten for Digdir staff | The person's organisations come from Altinn rights in the token, as in genki's portal. Digdir staff by Entra group |

- The gateway trusts more than one issuer at once, and the client chooses. genki starts with the client key, moves to Entra ID, and can move to Maskinporten without a change on the gateway side. The client key is revoked once genki has moved.
- An Entra token is accepted only from Digdir's Entra tenant (`tid`) and only for a managed identity or application the gateway has registered as a client (`oid` or `appid`). Managed identities are for calls between Digdir's own platforms, as in genki, so this is for genki and other Digdir platforms, not for agencies.
- A token's scope comes from the client it was issued to, configured on the gateway like a client key's scope. Nothing in the token's claims widens it, and no `genki-*` header widens it.
- genki never forwards a person's Ansattporten token to the gateway. The token's audience is genki, and genki has already decided what the person may do. The gateway sees genki as the client, and `genki-tenant` (step 4) as the organisation the call is for.
- If the gateway gets its own screens for people, it registers its own Ansattporten client. People then see the same organisations in the gateway as in genki, because both read them from the same Altinn rights.

- A client key is a credential for the API, not a key for model calls. It never works on the model listener, and a model key never works here.
- genki stores a client key as a `secret://` reference and resolves it per request, as it does for model endpoints ([ADR 0021](../adr/0021-model-access-through-protocol-adapters.md)). Each genki environment has its own credential: its own client key, or its own managed identity.
- The gateway gives each client a **scope**: the route scopes in the table above, and the organisation numbers it may act for. genki's organisations are its tenants, and the gateway team keeps that list with genki's operators.

What a client may read or change:

- **Models:** every model the gateway serves.
- **Usage:** only calls whose chain (below) holds an organisation in its scope. Without `subject`, the answer holds only those calls. A `subject` outside the scope answers `403`.
- **Keys:** it lists and reads keys whose subject is in an organisation in its scope. It changes and revokes only keys it issued itself; other keys in its scope are read-only to it. A key outside the scope answers `404`, as if it did not exist.
- **Subjects it may give a key:** `org`, `team`, `service` or `user` within an organisation in its scope. Moving a key to a subject outside the scope answers `403`.

The gateway sets a key's `issuer` from the credential, never from the body.

## Conventions

- **Times** are RFC 3339 in UTC.
- **Money** is `{ "currency": "USD", "micros": 857000 }`: a currency code (ISO 4217) and a whole number of millionths of it. genki never receives a converted figure, and converts to kroner itself.
- **Rates and amounts** in prices and limits are decimal strings, such as `"2.4"`, so no precision is lost.
- **Lists** answer `{ "data": [...], "next": "<cursor>" | null }`. Pass `next` as `cursor` to get the next page. A cursor is opaque, and it marks the last row returned, not an offset, so a page boundary does not move when an open usage bucket gets new rows between two requests.
- **Errors** answer `application/problem+json`: `{ "type", "title", "status", "detail"?, "errors"?: [{ "path", "message" }] }`. `type` may be `about:blank`. genki acts on `status` and `errors[].path`.
- **Unknown fields** in a request body answer `400`. Unknown fields in an answer are ignored by genki, so a gateway may add fields.

| Status | When                                                                        | What genki does                                     |
| ------ | --------------------------------------------------------------------------- | --------------------------------------------------- |
| `400`  | The query or body is not valid; `errors` names each field                   | Reports a fault in genki                            |
| `401`  | No credential, or one the gateway does not accept                           | Stops and alerts operators                          |
| `403`  | The credential lacks the route's scope, or the subject is outside its scope | Stops and alerts operators                          |
| `404`  | No such key, or a key outside the scope                                     | Treats the key as gone                              |
| `429`  | Too many requests; `retry-after` says when to come back                     | Waits for `retry-after`, then tries on the next run |
| `502`  | The gateway product behind the API did not answer                           | Tries again on the next run                         |

## Subjects

A subject is whom keys and usage belong to, written `<kind>:<id>`. In JSON it is `{ "kind", "id", "org" }`, and every kind but `org` carries the organisation number it belongs to in `org`.

| Kind      | `id`                                   | Who                                                             |
| --------- | -------------------------------------- | --------------------------------------------------------------- |
| `org`     | An organisation number of 9 digits     | An organisation                                                 |
| `team`    | 1 to 100 characters, no colon          | A team in `org`                                                 |
| `service` | 1 to 100 characters, no colon          | A service in `org`. For a key genki makes, the genki service id |
| `user`    | 1 to 100 characters, no colon          | A person in `org`, by a pseudonymous id                         |
| `apiKey`  | The key's id                           | One key                                                         |
| `genki`   | The genki tenant's organisation number | genki's own calls for that tenant, through genki's key (step 4) |

`claim:<name>` is reserved for grouping by a JWT claim once the gateway accepts JWT. Until then the gateway answers `400` to it.

**The chain.** Each call is recorded with the subjects it belongs to when it is made: its key (`apiKey`), the key's subject, and the organisation. A later change to the key does not rewrite past usage. A `subject` filter matches any subject in the chain.

**genki's own calls** go through a key whose consumer is `genki`, with the tenant in the `genki-tenant` header. Their chain is `apiKey:<genki's key>`, `genki:<tenant>` and `org:<tenant>`. It never holds the organisation or service on genki's own key, so the organisation that runs genki does not get every tenant's calls on its bill.

## Models

`GET /v1/models`

```json
{
  "data": [
    {
      "id": "gpt-6.1-sol",
      "provider": "azure",
      "region": "swedencentral",
      "residency": "eu",
      "capabilities": ["stream", "tools", "json-schema"],
      "apis": ["chat-completions", "responses"],
      "price": {
        "currency": "USD",
        "perTokens": 1000000,
        "validFrom": "2026-10-01",
        "rates": { "input": "2.4", "output": "12", "cacheRead": "0.12", "cacheWrite": "3" },
        "tiers": [
          {
            "contextOver": 272000,
            "rates": { "input": "4.8", "output": "18", "cacheRead": "0.24", "cacheWrite": "6" }
          }
        ]
      }
    }
  ],
  "next": null
}
```

- `id` is what a caller sends as the model. `provider` is required.
- `residency` is one of genki's levels: `norway`, `eu` or `global` ([ADR 0045](../adr/0045-data-stays-in-the-eu-eea.md)). Left out, genki treats the model as `global`.
- `capabilities` uses genki's names: `stream`, `tools`, `json-schema`, `reasoning`. `apis` lists the request formats the gateway accepts for it: `chat-completions`, `responses`, `messages`. Both are arrays, never `null`.
- `price` is the price that applies now, or `null` for a model the gateway cannot price. Rates are per `perTokens` tokens, except `perPage`, which is per page. Other rates are `reasoning`, `inputAudio` and `outputAudio`. A tier replaces the rates when a call's context is over `contextOver` tokens.

## Usage

`GET /v1/usage?from=2026-10-12T00:00:00Z&to=2026-10-13T00:00:00Z&bucket=hour&groupBy=model,subject&subject=org:991825827`

| Parameter | Required                                      | What it takes                                                                               |
| --------- | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `from`    | Yes                                           | The start, on a bucket boundary in UTC                                                      |
| `to`      | Yes                                           | The end, not included, on a bucket boundary. At most 31 days of `hour` or 400 days of `day` |
| `bucket`  | Yes                                           | `hour` or `day`                                                                             |
| `groupBy` | No                                            | Any of `model` and `provider`, and either `subject` (the call's owner) or one subject kind  |
| `subject` | No                                            | `<kind>:<id>`, matched against the chain                                                    |
| `org`     | With `team`, `service` or `user` in `subject` | The organisation number the subject belongs to, since two organisations may use the same id |
| `cursor`  | No                                            | `next` from the page before                                                                 |

```json
{
  "from": "2026-10-12T00:00:00Z",
  "to": "2026-10-13T00:00:00Z",
  "bucket": "hour",
  "data": [
    {
      "start": "2026-10-12T09:00:00Z",
      "closed": true,
      "model": "gpt-6.1-sol",
      "subject": { "kind": "service", "id": "kunnskapsassistenten", "org": "991825827" },
      "inputTokens": 120000,
      "outputTokens": 30000,
      "cachedInputTokens": 40000,
      "cacheWriteTokens": 0,
      "requests": 412,
      "unpricedRequests": 0,
      "cost": { "currency": "USD", "micros": 857000 }
    }
  ],
  "next": null
}
```

- **The owner.** With `groupBy=subject`, `subject` is the key's own subject when the call was made, or `genki:<tenant>` for genki's own calls. A key with no subject gives a row without `subject`.
- **Tokens.** `inputTokens` includes `cachedInputTokens` and `cacheWriteTokens`.
- **Cost** is what the gateway charged each call, at the rates and tier that applied to that call. Only the gateway knows a call's context size, so its cost is the one genki shows. `unpricedRequests` counts calls it could not price; their cost is not in `cost`. All rows in one answer have the same currency.
- **Buckets.** A call belongs to the bucket it started in. A bucket is `closed` once its end plus the longest a call may run has passed. A closed bucket never changes: not its rows' figures, and no row is added to it or removed. A group with no calls has no row.
- **Order.** Rows come by `start`, then by group, in the same order on every request.

## Keys

Every change carries `change-reason: <why>`, at least 10 characters, URL-encoded when it has characters outside ASCII. The gateway logs it with the change and keeps it on the key. Without it the answer is `400` with `errors: [{ "path": "change-reason", ... }]`, before anything changes. genki also sends `genki-task: <id>`, the id of its own audited admin task ([ADR 0010](../adr/0010-admin-operations-and-audit.md)), so the gateway's log points to genki's audit entry.

**Make a key:** `POST /v1/keys`

```json
{
  "subject": { "kind": "service", "id": "kunnskapsassistenten", "org": "991825827" },
  "name": "Kunnskapsassistenten, prod",
  "labels": { "genki.service": "kunnskapsassistenten", "genki.environment": "prod" },
  "models": ["gpt-6.1-*"],
  "limits": [
    {
      "name": "monthly",
      "amount": "500",
      "currency": "NOK",
      "period": "month",
      "warnAt": "0.8",
      "onExceeded": "block"
    }
  ]
}
```

Answers `201` with the key and its secret, once:

```json
{
  "id": "k_000042",
  "subject": { "kind": "service", "id": "kunnskapsassistenten", "org": "991825827" },
  "name": "Kunnskapsassistenten, prod",
  "issuer": "genki",
  "labels": { "genki.service": "kunnskapsassistenten", "genki.environment": "prod" },
  "models": ["gpt-6.1-*"],
  "limits": [
    {
      "name": "monthly",
      "amount": "500",
      "currency": "NOK",
      "period": "month",
      "warnAt": "0.8",
      "onExceeded": "block",
      "enforced": { "amount": "45.87", "currency": "USD", "period": "30d", "usdNok": "10.90" },
      "used": "0",
      "remaining": "500",
      "window": { "start": "2026-10-28T00:00:00Z", "end": "2026-11-27T00:00:00Z" },
      "warning": false,
      "exceeded": false
    }
  ],
  "createdAt": "2026-11-03T10:15:00Z",
  "secret": "sk-…"
}
```

- `subject` is required. `name` (at most 100 characters), `labels` (at most 20, names of letters, digits, `.`, `-` and `_`), `models` (names or patterns with one `*`; left out means every model) and `limits` are optional.
- `consumer` is not set through this route. A key whose consumer is `genki` is made by the gateway's operators for genki, since it lets the caller name the tenant a call counts under.
- A limit is an `amount` with a `currency`, or a whole number of `tokens`; a `period` of `hour`, `day`, `month` or `30d`; an optional `warnAt` fraction between 0 and 1; and `onExceeded` of `block` (the default) or `record`. Each name is unique in the key and does not end in `-warn`.
- When the gateway counts a limit differently from what was asked, it says how under `enforced`, with any exchange rate used. A limit it cannot enforce at all answers `400`. `used` and `remaining` are in what was asked.
- The secret is never shown again. A new key starts its budgets from zero, so there is no rotate route: make a new key, then revoke the old one.

**List keys:** `GET /v1/keys?subject=org:991825827` answers `{ "data": [<key>, ...], "next": null }`, each key as above without `secret`. `subject` matches the key's chain, and takes `org` as on usage. `GET /v1/keys/{id}` answers one key.

**Change a key:** `PATCH /v1/keys/{id}` with any of `name`, `labels`, `models`, `limits` and `subject`. A field left out stays as it is; `labels`, `models` and `limits` are replaced whole, and `"limits": []` removes every limit. A changed subject applies to calls from then on. Answers `200` with the key.

```json
{ "name": "Kunnskapsassistenten, production", "limits": [] }
```

**Revoke a key:** `DELETE /v1/keys/{id}` answers `204`. The key stops working from about the next request; calls already running finish. Revoking it again answers `404`.

## Per-call headers (step 4)

Only when a genki model endpoint points at the gateway, with genki's key, genki sends two headers on every model call. In genki the model gate of ADR 0047 (proposed) adds them from the call's context, so no adapter or strategy can leave them out or set them.

| Header         | Value                                            |
| -------------- | ------------------------------------------------ |
| `genki-tenant` | The tenant's organisation number, 9 digits       |
| `genki-task`   | The genki task the call belongs to, an opaque id |

- The gateway records the call under `genki:<tenant>` (see Subjects) and keeps `genki-task` on it.
- On a key whose consumer is `genki`, a call without `genki-tenant`, with one that is not 9 digits, or with an organisation outside genki's scope, is refused with `400` before any model is called.
- On any other key the gateway ignores both headers.
- The gateway removes every `genki-*` header before it forwards a call to a model provider.
- The values are keys, not content: no title, prompt or person is in them.

## What the aivar lab does not do yet

genki needs these before it runs against a gateway outside the lab:

- **Sign-in and scope.** The lab API has no authentication, so anyone who reaches it can read every organisation's usage and make keys. It needs client keys first and Entra ID tokens next (see Authentication), each mapped to a client with route scopes and an organisation list, enforced on every route. Its `Within` filters on usage and keys are the place for it.
- **Issuer from the credential.** It sets every key's issuer to `aivar`, and lets any caller change or revoke any key.
- **`consumer` reserved.** It accepts any `consumer` in the body, so anyone could make a `genki` key and put usage on any tenant.
- **genki's calls on the tenant's organisation.** It records genki's calls under the organisation of genki's key as well as `genki:<tenant>`, so a filter on that organisation counts every tenant's genki calls.
- **`genki-tenant` checked and `genki-*` removed.** A genki call without the header is recorded with no owner, and the headers are not stripped before the provider.
- **A subject filter within one organisation.** `subject=service:<id>` matches that id in every organisation; it needs `org`.
- **A cursor that holds.** Its cursor is an offset, so rows shift between pages while an open bucket grows.
- **Residency on every model.** The lab's model has none, and `residency` is free text.
- **A test gateway per genki environment**, or at least a credential per environment, so genki-test never reads production usage or makes production keys.
- **Keys handed out by hand get a subject**, or genki cannot tie their usage to an organisation.
- **Contract checks for the rules above** in `gateway/contract`: scope refusals, genki attribution, the reserved consumer and a closed bucket that stays the same.

## Step 1 in genki: design

For whoever builds #21 in genki; a gateway implementer can stop above. Step 1 reads usage and changes nothing in how genki calls models.

### `port-usage` and `UsageSource`

`packages/port-usage` holds the types, the port, a fake and the contract suite, and no vendor code.

```ts
export interface Money {
  currency: string;
  micros: number;
}
export interface UsageSubject {
  kind: string;
  id: string;
  org?: string;
}
export interface UsageRow {
  source: string;
  start: string;
  closed: boolean;
  model?: string;
  subject?: UsageSubject;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  requests: number;
  unpricedRequests: number;
  cost: Money;
}
export interface UsageQuery {
  from: Date;
  to: Date;
  bucket: 'hour' | 'day';
  cursor?: string;
}
export interface UsageSource {
  readonly id: string;
  usage(query: UsageQuery): Promise<{ rows: UsageRow[]; next: string | null }>;
}
```

- `packages/providers-ai-gateway` implements `UsageSource` over this contract with `groupBy=model,subject`. It calls through the egress-guarded fetch, resolves its credential from `secret://`, and sets its own header and body timeouts (ADR 0041).
- `memoryUsageSource` in `port-usage` is a fake that keeps the rules on this page: the chain, genki attribution and closed buckets. The suite `usage@1` runs against the fake, against the provider over HTTP with the fake behind it, and against the aivar API with `GATEWAY=fake`.
- genki's own source is an adapter in `apps/api` over the `kernel.usage` events, giving rows per day and model with `cost: { currency: "NOK", micros: costMicroNok }`. Both sources therefore meet in one row type, and one function in `port-usage`, `combine`, sums them and applies the counting rule below.

### The poll job

- One queue, `usage-gateway-poll`, on the platform server, with its contract in code (ADR 0041): singleton per source, one attempt per job with retries and a dead-letter queue. pg-boss `schedule()` sends it at 20 minutes past every hour, after the gateway's settle time. Job data is `{ "source": "<id>" }` and nothing else. It calls no model, so lockdown does not stop it.
- A run reads the source's `closedThrough` mark and asks for `hour` buckets from there to the end of the current hour, in 31-day pieces, every page. The first run starts at a configured date.
- It writes in one transaction per bucket. A closed bucket's rows are inserted. An open bucket's stored rows for that source are deleted and the new ones inserted. `closedThrough` moves to the end of the last unbroken run of closed buckets in the same transaction.
- **Idempotency.** Rows live in `usage_buckets`, keyed on source, start, model and the subject's kind, id and organisation. Closed rows are inserted with `on conflict do nothing`, and open rows are replaced as a whole. Running a job twice, or two jobs over the same hours, leaves the same rows. Buckets before `closedThrough` are never asked for again, so a closed bucket is read once. A closed row that comes back different is logged as a contract breach, and the stored row stays. A run that fails leaves `closedThrough` where it was, so the next run fills the gap.
- Hours are stored; days are summed in genki, in UTC like the usage routes today.

### Subject to organisation

| Owner                     | Organisation  |
| ------------------------- | ------------- |
| `org:<n>`                 | `n`           |
| `team`, `service`, `user` | `subject.org` |
| `genki:<n>`               | `n`           |
| `apiKey`, or no subject   | None          |

- The organisation must be a tenant in `tenants`. The row then gets that tenant, and row-level security keeps it in that tenant (ADR 0022).
- A row with no organisation, or one that is not a tenant, goes to `usage_unassigned`, which only operators read. Rows there mean a key without a subject or a scope that does not match genki's tenants.
- The subject is kept as it came. Tying `service:<id>` to a genki service waits for keys made in genki (step 3).

### Money: the open decision

ADR 0038 leaves open whether `costMicroNok` gets a sibling with currency and rate, or usage rows carry `{ currency, micros }`.

**Recommendation: rows carry `{ currency, micros }`, and rates live in one table by currency and day.** `currency_rates` holds `currency`, `day` and `nokPerUnit`, filled from Norges Bank's daily rates. A NOK figure uses the rate for the row's day, or the latest day before it, and the routes show the rate and its day next to the original amount.

- It is the contract's shape, so nothing is converted on the way in, and a sum per currency stays exact.
- A rate belongs to a day, not to a row. Copying it onto every row repeats one number thousands of times, and a wrong rate could never be corrected.
- genki's own `Usage.costMicroNok` stays as it is: genki's prices are in kroner, and events are not rewritten. #22 adds `cost: Money` to `Usage` when it brings prices in other currencies.
- A row with no rate at all shows its original amount and counts as unpriced in kroner, never as 0.

### No double counting

The rule, in `combine`: a gateway row under `genki:<tenant>` counts only for a model whose genki endpoint runs through the gateway, and then genki's own cost for that model in that tenant and hour is left out while its tokens and task link stay. In step 1 no endpoint runs through the gateway, so `genki:*` rows are stored and never counted.

The test, `a call is counted once whether genki or the gateway measured it`, puts three calls for one tenant in the fake gateway and genki's events: a call on the tenant's own gateway key, a call genki measured itself, and a call through genki's gateway key with `genki-tenant` set, which genki also measured. It runs the poll, then asserts that the tenant's totals equal the three calls' tokens and cost once each. A second case marks the endpoint as running through the gateway and asserts the same tokens, with the third call's cost from the gateway. `usage@1` adds that a filter on the organisation of genki's key does not hold genki's calls, and a worker test that a second poll, and a poll after an open bucket closes, leaves the stored rows equal to the fake's.

### Routes and screens

- No request reads the gateway. `usageOver` adds one query to the `Promise.all` it already runs: the tenant's `usage_buckets` in the window, one indexed read on tenant and start. `GET /operator/usage` reads every listed tenant in one query, inside its 30-second cache.
- `totals`, `daily[].usage` and `usageThisMonth` on the overview become the sum of both sources. Each gains `bySource: [{ "source": "genki", "usage": ... }, { "source": "gateway", "usage": ... }]`, and `byModel` rows gain `source`. Gateway rows also come as `bySubject`, with `cost`, `rate` and `rateDay`. `byService`, `byProject`, `testing` and `ingestion` stay genki's own, since the gateway cannot see services, projects or test runs.
- `view-usage` gates all of it, as today. The change goes into the API changes in `README.md`, since `totals` now means the sum.
- The portal's usage screen shows the source on each row and the total with the share from each.
