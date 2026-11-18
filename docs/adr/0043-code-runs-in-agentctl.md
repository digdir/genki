# 0043 Code runs in agentctl, not in the platform

Status: proposed, 2026-10-29

## Context

The platform's agents call only tools the platform knows: search, document reads and the tenants' registered MCP, OpenAPI and A2A tools, all over HTTP through the egress guard (ADR 0015). Nothing in the API, the worker or the kernel runs code that a model, a user or a tenant wrote. ADR 0028 turned down running foreign code inside the platform, since it would need a sandbox, resource limits and a review of every plug-in.

Some tasks do need code: an analysis written for the question, a conversion no step block covers, a script run against a file. Digdir also runs [agentctl](https://github.com/digdir/digdir-agents), which runs long-running agents in isolated sandboxes. Each agent gets its own computer, its network goes through the host, where policy fails closed, and real secrets never enter the sandbox. This record sets how the two meet, so neither builds what the other already does.

## Decision

**The platform does not run code.** No interpreter, shell, `child_process`, `vm` or `worker_threads` in the API, the worker or any package they load. A strategy, step block or tool that would need one is not added to the platform. The dependency rule `no-code-execution-in-the-platform` in `.dependency-cruiser.cjs` enforces it, outside test files.

**A service that needs code calls an agent in agentctl,** through the routes of ADR 0028 and nothing new:

- as a tool: the agent is reachable as an MCP server, an OpenAPI tool or an A2A agent, registered by the tenant as a tool connection (ADR 0015) and granted to the service in `spec.tools`;
- as the whole turn: the agent answers as a `remote-agent` strategy (`remote-agent/v1` or A2A).

Everything ADR 0015 and ADR 0028 keep at the boundary applies unchanged: the grant, the egress guard, credentials as tenant secret references bound to the agent's host, results marked as untrusted, timeouts and cancel, usage charged to the task budget, the residency declaration and the events in "Hva skjedde". The agent receives only what the call sends: the tool's arguments, or the context the remote-agent configuration names. It never receives the caller's token or a platform credential.

**An agent in agentctl uses the platform like any other client.** It calls a published service through the open API, MCP or `/v1`, with an API key of the tenant. A key can only ask questions (scope `query`). An agent that wants to change a tenant's services proposes the change, and a person with the right approves it (ADR 0020, ADR 0026). agentctl gets no platform credential beyond the tenant's key.

## Why

- **Each side keeps what it is good at.** The platform encodes good practice for knowledge work: datasets with rights, retrieval, evaluation and gates, aimed at people who are not developers. agentctl gives an agent a whole computer. Code that must run belongs where a computer is already isolated, and knowledge an agent needs is best served by a service that is evaluated and governed.
- **No second sandbox.** Isolating code at the level agentctl does (a virtual machine per agent, mediated network, no secrets inside) is a product of its own. Building a weaker one in the platform would give operators an attack surface they do not need to own.
- **The boundary already exists.** ADR 0028's routes and ADR 0015's guard were made for logic that runs outside the platform. An agent in agentctl is one more endpoint behind them, so the decision costs no new contract.
- Turned down:
  - **A sandbox inside the platform** (an interpreter in the worker, a container per call). ADR 0028 turned it down, and agentctl now exists.
  - **Running every agent session of the platform inside agentctl,** to isolate its tool calls. The platform's tool calls are HTTP requests to registered hosts through the egress guard, with no local execution, so a virtual machine per session would add start-up time and cost without isolating anything the guard does not. This is worth revisiting if the platform ever runs local tools.
  - **Moving datasets, rights or evaluation into agentctl.** They would lose the tenant isolation, audit and publishing gates the platform gives them.

## Consequences

- Not built: no agent in agentctl is reachable as an MCP server, A2A agent or `remote-agent/v1` endpoint today. That needs work on the agentctl side, and agentd running on a host the tenant can register, not on a person's own machine.
- The team that registers an agent is responsible for it as a processor of what it is sent, as for any tool or remote agent (ADR 0028). An agent in agentctl keeps its computer between sessions, so what it is sent can stay there. Its residency declaration and how long it keeps data are part of the registration review.
- The dependency rule makes a new import of `child_process`, `vm` or `worker_threads` in platform code fail `npm run check`. Scripts under `scripts/` and test files are outside it.
- How this platform itself is built, for example with coding agents running in agentctl, is a way of working and not part of this record. CONTRIBUTING.md applies however the code was written.
