# 0028 Custom logic comes from outside

Status: accepted, 2026-10-12 (partly built). Proposed 2026-10-09

Not built yet: external step blocks.

## Decision

Built-in strategies and step blocks are code in this repository. They are reviewed, tested and released like the rest of the core. A service is not limited to them: custom logic comes in from outside, without a platform change, through three routes. The platform's guarantees apply around all of them.

**What is code.** `agent-loop`, `rag-single-shot`, `single-call`, `step-flow` and the built-in step blocks are core code. The plug-in registry still refuses to take a strategy or a step block as an external plug-in, and its message now points to the routes below.

**Routes for custom logic.**

1. **The `tool` step block.** A step flow calls one tool from any registered tool source (MCP, OpenAPI, A2A) with arguments mapped from the flow input and earlier steps, and the result (text, JSON, parts, sources) is an ordinary output for later steps. The service lists the tool under `spec.tools`, which is the grant; a tool the service has not been granted is refused. This is for logic that fits a step: look something up, call a classifier, run a calculation.
2. **The `remote-agent` strategy.** A service hands the whole turn to an agent the team runs, over a plain HTTP contract (`remote-agent/v1`) or A2A. This is for an engine that does its own retrieval and reasoning.
3. **External step blocks (later).** A step block that is an endpoint, with a declared input and output schema, registered as a plug-in and callable from any flow. Not built yet; the tool block covers most of the need in the meantime.

**What the platform keeps.**

- Identity, access and channels. The remote agent sits behind the same exposures as any service: workspace chat, MCP, `/v1`, REST and A2A. Who may call is decided before the turn starts.
- Guardrails and hooks. Both wrap the remote strategy like the others, so a question with a national identity number is refused before it leaves.
- Audit and "Hva skjedde". Calls to a tool or a remote agent are events in the kernel stream. Steps the remote agent reports are mapped into the same stream. Argument values are not logged, only their names.
- Cost caps, timeouts and cancel. Usage the remote agent reports is charged to the task budget, so caps apply. Every call has a time limit, and cancelling the task stops the call.
- Residency. A remote endpoint declares where it processes data, and publish refuses an endpoint wider than the service requires, as it does for models, datasets and rerankers. The declaration is trusted, not verified.
- Secrets and egress. Endpoint credentials are tenant secret references (`secret://tenant/<orgnr>/<name>`), never inline, and a secret of another tenant is refused. All calls go through the egress guard: HTTPS only, no private or platform addresses, no redirects to other hosts.

**What stays a core change.** New strategy ids, new step blocks that need access to platform internals (retrieval ports, the kernel, the state store), new plug-in kinds and changed contracts. These follow the core lane in 0023.

## Why

The principle in 0023 is that nothing a service can do is hard-coded, and that a new plug-in of an existing kind needs no platform work. Strategies and step blocks broke that principle: a team with its own retrieval engine, its own agent framework or one special step had to wait for a platform release. Both routes use contracts and protocols the platform already speaks, so the cost of openness is one strategy and one block, not a new plug-in runtime.

Running foreign code inside the platform process was the alternative. It would need a sandbox, resource limits and a separate review of every plug-in. Calling an endpoint puts the code under the team's own operation and keeps the platform's guarantees on the boundary, where they can be tested.

## Consequences

- A remote agent is a processor of the data it is sent. The team that registers one is responsible for it, in the same way as for a tool source. What is sent is configured per service: earlier messages, the caller's identifier and named form fields, each off or empty by default except history.
- The residency declaration, not a check, is what keeps data in the right place. A platform-wide allow-list of remote hosts is a possible follow-up for operators who want one.
- `step-flow` now declares the `tools` port, so a flow can call a tool, and so a flow can use the agent block's tools.
- The remote strategy ignores the service model. The definition still names one, because the schema needs it, and the model's residency does not constrain a remote service.
- Remote agents are not part of contract tests at registration. A service with one is evaluated like any other, through its test sets and gates.
- A flow that uses the `tool` block gets a publish-time check of the block parameters, but not that the tool is granted; the check happens when the flow runs. A service that lists the tool and the flow that calls it are published separately.
