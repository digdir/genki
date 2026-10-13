# 0007 Paradigm-neutral service definition

Status: accepted, 2026-10-12 (built). Proposed 2026-10-06. Revised the same day to take in a later design round.

## Decision

A service definition has the same top level whatever the service does:

```yaml
apiVersion: genai/v1
kind: Service
metadata: { tenant: '991825827', id: kunnskapsassistenten, name: Kunnskapsassistenten }
spec:
  purpose: ...
  audience: [employees]
  riskClass: limited
  riskConfirmation: { by: ..., at: ..., reasons: [...] }
  variants:
    - id: default
      aliases: [ka]
  input: { accepts: [text/plain], ocr: false }
  output: { kind: answer, withSources: true } # answer | fields | document
  strategy:
    id: agent-loop # always concrete; the UI's "let the assistant choose" never reaches the definition
    version: 1
    config: { ... } # validated by the strategy's own schema
  knowledge: { datasets: [{ dataset: digdir/kudos, filters: { ... } }], runtimeDocuments: false }
  tools: [rag@1, digdir.klarsprak@2.3] # always pinned to a version
  model: { primary: ..., fallback: ..., residency: norway } # norway | eu | global
  guardrails:
    pii-before-model: { categories: [national-id] }
    require-sources: true
    language: { mode: same }
  exposure: { chat: true, mcp: true, openai: true, rest: true }
  triggers: [{ kind: queue-message, queue: post-inn }] # schedule | queue-message | document-arrives
  evaluation: { testSets: [...], gates: [...] }
  improve: { allow: [instructions, retrieval] }
```

- Keys and values are English, including enums and the API. The portal shows Norwegian labels.
- `metadata.version` is set by the store on publish and ignored if given.
- Each variant has a public name, `<service>__<variant>` unless set, and may keep older names as aliases. Public names are unique across the platform. A variant may set its own `model`, its own `strategy: { id, version, config }` (checked with that strategy's schema and model needs, and a step flow like a service-level one, see ADR 0031), and `chat: false` for a variant that gives no answer.
- `exposure` says how clients can call the service; `triggers` say when it starts by itself. They are kept apart.
- Tools and step-flow building blocks are referenced with a version. A newer version is offered to the tenant, never switched in silently.
- Guardrails are named plugins, each with settings validated by its own schema.
- Agent-specific settings, such as instructions and budgets, live inside `strategy.config`.
- Step flows are their own versioned kind (`kind: StepFlow`), reusable across services. A service uses one with `strategy: { id: step-flow, config: { flow: <id>@<version> } }`. A step has exactly one action: `block`, `repeat` (with a required `max`), `forEach`, `switchOn` with `cases`, or `subflow`, and `onError` is `stop`, `skip` or `use-default`.
- The schema is closed. Unknown keys fail validation at publish. High-risk services and services for the public are refused until they are offered.
- One example per job type, plus a step flow, validates in CI.

## Why

The first example was shaped around agents, so a klarspråk rewrite or a classification job had nowhere to go. A later design round added public names per variant, versioned tool references, reusable step flows and concrete guardrails; this revision takes those in and keeps the code's conventions for ids, MIME types and residency.

## Consequences

- A new paradigm is a new strategy id with its own config schema. The top level stays the same.
