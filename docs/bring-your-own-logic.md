# Lag din egen / Bring your own logic

Status: stable for the tool step (`tool@1`) and the remote agent (`remote-agent/v1` over HTTP and A2A); both are tested end to end with fake endpoints (`apps/api/src/external-logic.test.ts`, `packages/strategy-remote/src/remote.test.ts`). Still preview: external step blocks are not built (see the last section), and neither route has been run against a real outside agent. This page says what you can change with configuration, what you can bring from outside with an endpoint, and what still needs a change to the platform. The reasons are in `docs/adr/0028-custom-logic-from-outside.md`.

## What is configuration

You do not need code or an endpoint for these. They are definitions you publish, and each change is a new version.

| Need                               | Where                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| The work a service does            | `Service` definition: purpose, input, output, exposure, guardrails                                           |
| Instructions, examples, prompts    | `strategy.config` of `single-call`, `rag-single-shot` or `agent-loop`, and prompt files                      |
| Fixed steps in a fixed order       | A `StepFlow` definition built from the built-in step blocks, with branches, loops and approvals              |
| Which model, with fallback         | `spec.model`, from the model catalogue                                                                       |
| Where data may be processed        | `spec.model.residency`                                                                                       |
| Search over your documents         | Datasets, rerankers and `spec.knowledge`                                                                     |
| Tools the service may call         | A tool source (MCP, OpenAPI or A2A) registered under `/tenants/{tenant}/tool-connections`, then `spec.tools` |
| Reusable instructions and examples | Skills                                                                                                       |
| Hooks at defined points in a run   | `/operator/hooks` or `/tenants/{tenant}/hooks`                                                               |

## What is your endpoint

These two routes let your own logic run outside the platform, with the platform's identity, access, channels, guardrails, audit, cost caps, timeouts, cancel and logging around it.

### Tool step: logic that fits one step

1. Run an MCP server, an OpenAPI service or an A2A agent. Register it as a tool source and sync it. Tools are named `<source>.<tool>`, for example `saker.sok`.
2. List the tool in the service: `tools: [saker.sok@1]`. This is the grant. A flow cannot call a tool the service has not listed.
3. Add a step with the block `tool@1`:

```yaml
- id: sok
  block: tool@1
  params:
    source: saker
    tool: sok
    arguments: { q: '{{input.query}}', limit: 5 }
    timeoutMs: 20000
  onError: use-default
  default: { text: 'Saksarkivet svarte ikke.', json: null, parts: [], sources: [] }
```

Later steps read `{{sok.text}}`, `{{sok.json.<field>}}`, `{{sok.parts}}` and `{{sok.sources}}`. If the step is the last one, its parts become the answer. `onError` works as for other steps; a tool that reports an error counts as a failure. The call shows in **Hva skjedde** with the argument names, not the values.

Try it in the portal: Stegflyter, add a step, choose **Kall et verktøy**. A complete example is `packages/definitions/examples/saksoppslag-flyt.yaml` with the service `saksoppslag.yaml`.

### Own engine (`remote-agent`): a whole turn answered by your agent

Use the strategy `remote-agent` when your agent does its own retrieval and reasoning.

```yaml
strategy:
  id: remote-agent
  version: 1
  config:
    endpoint:
      url: https://tilskuddsagent.example.no/api/turn
      protocol: http # or a2a
      residency: eu # norway | eu | global, where the agent processes data
      auth: { kind: bearer, secret: 'secret://tenant/991825827/tilskuddsagent-token' }
      timeoutMs: 60000
    send: { history: true, maxMessages: 10, identity: none, metadata: [] }
```

- Store the token as a tenant secret first (`PUT /tenants/{tenant}/secrets/{name}`) and refer to it. An inline key is refused, and so is a secret of another tenant.
- `residency` is what the endpoint declares. Publish fails when it is wider than `spec.model.residency`. A remote service does not need to name a model: `model: { residency: eu }` is enough. If you name one anyway, the remote agent does not call it and its residency does not constrain the agent. A variant that switches to a platform strategy still needs a model.
- `send` decides what leaves the platform. Earlier messages are sent by default. The caller's identifier is sent only with `identity: subject`. Form fields are sent only when named in `metadata`.
- Plain HTTPS only: no private addresses, no redirects to other hosts.

Try it in the portal: open a service, go to the setup, choose **Egen motor** under the way the service works, and fill in the address and residency. A complete example is `packages/definitions/examples/ekstern-agent.yaml`.

#### The HTTP contract, `remote-agent/v1`

The platform sends `POST {url}` with `content-type: application/json`, the header `x-genai-contract: remote-agent/v1`, and your credential:

```json
{
  "contract": "remote-agent/v1",
  "conversation": { "id": "thread-or-task-id", "task": "task-id" },
  "query": "Når er fristen?",
  "messages": [{ "role": "user", "text": "Når er fristen?" }],
  "context": {
    "tenant": "991825827",
    "caller": { "tenant": "991825827" },
    "service": { "id": "991825827/ekstern-agent/default", "version": "3" }
  },
  "metadata": {}
}
```

`messages` ends with the current question and has the earlier turns before it. `context.principal` (`kind`, `subject`, `tenant`) is present only when the service shares identity. Answer with HTTP 200 and JSON:

```json
{
  "answer": "Fristen er 1. mars.",
  "sources": [{ "id": "s1", "title": "Fristene", "url": "https://example.no/frister" }],
  "steps": [
    { "title": "Slo opp fristen", "summary": "fant 1 treff", "status": "done", "durationMs": 50 }
  ],
  "usage": { "inputTokens": 30, "outputTokens": 8, "costMicroNok": 500 }
}
```

Only `answer` is needed, or `data` (an object) for a service whose output is fields. `sources` become the sources of the answer in every channel. `steps` (at most 50, `status` is `done`, `failed` or `skipped`) are shown in **Hva skjedde**. `usage` is charged to the task, so cost caps apply. Anything else is ignored. A reply that breaks the contract, an HTTP error or a timeout fails the task.

With `protocol: a2a` the platform sends a `SendMessage` to the agent card at the URL, with the question as text and the conversation, context and metadata as a data part, and polls the task until it finishes. It reads text artifacts as the answer and sources from a part with the media type `application/vnd.genai.sources+json`.

## What needs a platform change

- A new strategy id, or a change to how an existing one works.
- A step block that needs platform internals: retrieval ports, the kernel, state or the model router. A step that only needs to call something outside is a tool step.
- A new plug-in kind, a new protocol, or a changed contract.
- Registering a step block as an endpoint. This is planned as external step blocks; until then use the tool block.

These follow the core lane in `docs/adr/0023-extension-model.md`: a change in this repository, with tests and an ADR.
