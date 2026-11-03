# 0047 One governed path for model operations

Status: proposed, 2026-11-03

## Context

Model providers add a new kind of API every month or two: decisions, image, speech, realtime, batch, provider-side files and agents. Genki reaches models through three separate stacks (`port-model`, `port-embedding`, `port-rerank`), each with its own router, and the governance in them already differs: only the model router checks lockdown admission (ADR 0033), rerank meters nothing, the embedding router has no egress guard and no tenant sharing, and search embeddings outside a run are metered into a no-op. PII masking and hooks wrap only the port named `model` (`packages/guardrails/src/strategy.ts`, `packages/hooks/src/strategy.ts`), so a new port would skip them without anyone noticing. Issue #248 (the Azure OpenAI Decisions API) is the first new kind that needs a decision.

## Decision

### One gate

Every model call passes through one gate in the kernel, `packages/kernel/src/gate.ts`, whatever its kind. The gate does, in this order and nothing else: admission, enabled, tenant sharing, every residency ceiling (router, request, service), the payload guard on the request, the call through the egress-guarded fetch, usage into the meter, provenance, the audit event `kernel.gate.call` (port, operation, model, endpoint, status, byte counts, never the body), then the guard on the result. The three routers call the gate; their own copies of these checks are removed. Embeddings and rerank declare their admission explicitly (`open`, as ADR 0033 intends), instead of having none by accident.

### The payload guard moves into the gate

The PII vault and the before- and after-model hooks are handed to the gate as a `guard` on every `use`, not wrapped around one port by name. A call whose payload has image, audio or file content is refused unless the guard allows unmaskable input (below).

### Closed payload shapes

Every operation declares a closed payload shape (`packages/kernel/src/payload.ts`): where text, images, audio, files, ids and usage sit in the request, the response and the stream events. There is no `any` field. One walker uses the shape to mask, restore, find media and validate:

- an unknown field in a request is refused before anything leaves Genki;
- an unknown field in a response is dropped and counted in the audit event;
- an unknown stream event ends the stream;
- a URL or a provider-side object id in a request is refused.

### Operations on the catalogue

A catalogue model carries `operations` (default `['chat']`) next to `capabilities`. An operator classifies the operations a deployment serves, as ADR 0044 prefers evidence to guessing from names. An adapter implements the operations it supports; a call to one it does not implement fails as `unsupported` (ADR 0023). The first new operation is `decide` (#248), exposed as the kernel port `decision` over the same routes, so grants, `use:decision` policy and the audit event come from the kernel.

### Descriptors and three tiers

A new kind can arrive without hand-written types through an operation descriptor: a versioned file with the endpoint path, the payload shape, the usage mapping and the stream events, keyed on the API version and any beta headers. Descriptors are reviewed like code and proven against recorded fixtures in the contract suite `operation@1`; they are never edited in the console. One executor turns a descriptor into a gated call and rewrites the model field to the catalogue deployment, so a caller cannot pick another deployment.

| Tier                      | Who may call                                                                   | Guard                                                                 |
| ------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Raw: descriptor in review | Operators, as a kernel task, synthetic data, test only                         | All PII categories masked always, media refused, admitted logins only |
| Described                 | Services, through a `call-operation` step block, once the kind is `production` | The service's own guardrails                                          |
| Typed                     | Services and strategies through Genki's own types                              | The service's own guardrails                                          |

A raw use that a service depends on becomes described or typed before the service may publish it.

### What a call must meet before it carries real data

1. It runs inside a published service version, or it is an operator call marked synthetic. Anything else is refused.
2. The endpoint's residency is within the service's at publish and at call, and the endpoint has a processor record: its data processing agreement, sub-processors with locations, and provider-side retention. An endpoint without one cannot serve a service with real data.
3. Every text field is masked and guarded. Image, audio and file input is refused unless the service's confirmed risk assessment records `acceptsUnmaskedInput` with reasons.
4. Every call is audited as who, what, where and how much; the payload is kept only in the encrypted store under the service's retention.
5. Each operation kind has a maturity, `test` or `production`. The environment declares its tier, and the gate refuses an operation whose maturity does not admit it, at publish and at call. Moving a kind to `production` takes two people, as risk confirmation does in ADR 0020.

### Decisions about people

A service whose decisions concern a natural person declares `decidesAboutPeople`. That requires the risk class `high`, a human step before a result is final, and the model input kept for review. A refusal or a low-confidence answer goes to a person, never to "no". Without the declaration, a decision may only concern content.

### Kept out

Realtime and live sessions, ephemeral provider keys in the browser, batch, provider-side files, vector stores and conversations, stored or background responses, hosted agents and tools, voice cloning and URLs the provider fetches do not go through descriptors. Each needs its own ADR, because each holds a session or keeps data at the provider, which conflicts with ADR 0044 and ADR 0045.

## Why

The three routers already disagree on governance, and each new kind built the same way would add a fourth copy that fails open where it is missed. Gateways that moved fast on decisions (LiteLLM, GoModel, LLM Gateway) were fast because auth, cost and logging sat in one place; what they added per kind was the shape. A closed shape, unlike a list of paths to mask, proves that the rest of a request carries no user content, so the raw lane can mask and meter instead of passing bodies through unread.

Turned down:

- A port per family with its own router and catalogue: it duplicates the deployment and the governance, and drifts.
- Opaque pass-through: it cannot mask, guard or reliably meter.
- An external gateway as the way in for new kinds: residency hides behind one URL, it adds a processor, and new kinds still wait for the gateway.
- JSONPath or the providers' OpenAPI specs as the descriptor language: paths locate text but do not prove the rest is harmless, and specs lag new features.
- Media scanning as a substitute for a recorded decision: it is not reliable enough to stand in for one.

## Consequences

- The gate ships as a wrapper around the existing routers first, behind two contract suites, `gate@1` and `operation@1`; the routers' own checks are removed only when the suites pass. CI enumerates every registered operation and descriptor, so a new one cannot ship unproven. The key test: "no operation sends a valid national id upstream when the service masks national ids", checked against the recorded request bodies.
- Moving the guard into the gate changes masking for every service run and must not mask twice.
- Rerank becomes metered, and embeddings get the egress guard and tenant sharing.
- The masker covers patterns for Norwegian ids, phone, email, account numbers and ICD-10 codes, not names or free-text health data. Masking reduces exposure; it does not make data anonymous.
- A new host, or a partner model sold under its own terms, may be a new sub-processor that agencies must be told about before their data reaches it. In production that notice, not the code, sets how fast a new kind can go live.
- Not built yet: everything in this record. Issue #248 is the first operation on the gate.
