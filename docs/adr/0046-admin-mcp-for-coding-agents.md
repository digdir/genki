# 0046 Coding agents work on genki through a local admin MCP server

Status: proposed, 2026-11-02

## Context

Coding agents such as Claude Code and Copilot have no direct way to work on genki. To list services, read a run's timeline, compare setups in the playground, check a definition or publish a version, an agent has to drive the portal through a browser, which is slow, fragile and hard to repeat. Everything it needs is already in the API (ADR 0032), so what is missing is a thin layer an agent can call.

## Decision

- **A local MCP server.** `apps/admin-mcp` is an MCP server over stdio that the agent starts on the developer's machine. It calls the public API and nothing else, through the same routes as the portal. It adds no route to the API and is not part of an image or a deploy.
- **The person's own login.** On first use the server opens the browser for an Ansattporten login with the authorization code flow, PKCE and a loopback redirect to `http://127.0.0.1:<port>/callback` (RFC 8252), through an Ansattporten client that genki-test already trusts (`ADMIN_MCP_CLIENT_ID`): the console's, whose registered redirect `http://localhost:5173/callback` is the default, so no new registration is needed. The server listens on both loopback addresses for a `localhost` callback. The API sees the same principal as when that person uses the portal: the same rights, the same lockdown rules (ADR 0033) and the person's name in the change log. The token stays in the server's memory, is never written to disk, is sent only over https except to the same machine, and when it expires the person logs in again. The development login works only against a local API. The console client is listed in `OPERATOR_CLIENT_IDS`, so a trusted Entra login works there as it does in the console. Changes are still told apart: the server ends every change reason it sends with `(via kodeagent, genki-admin)`, so the version history and Logg show that a change came through a coding agent, next to the person who made it. The agent cannot leave the marker out, since the server adds it. It is declared by the client, not verified by the API; a `via` field on the audit entry and the version, set from a client of its own, would make it structured and verified.
- **No API keys.** The definition and platform routes keep refusing API keys (ADR 0033), and the server neither accepts nor creates one.
- **The first tools:**
  - list services with their versions and variants, and who has called a service lately, so an agent sees who depends on it;
  - read a definition as YAML, and validate a definition (`POST /definitions/validate`) with the paths that differ from the published version;
  - start a new service from the template (`GET /tenants/{tenant}/definitions/template`);
  - describe the strategies and the config schema of one (`GET /tenants/{tenant}/definitions/strategies`), which is also what a variant may override;
  - list the models the organisation may use, with residency and price (`GET /tenants/{tenant}/playground/options`, `GET /models`);
  - publish a definition with a change reason (`POST /definitions`);
  - run the playground on a published version or on an unsaved definition sent with the request, alone or compared with a second setup, and return the answer, sources, steps, tokens, cost and time. Nothing is saved, so an agent can try a change before anyone publishes it;
  - list runs, playground runs included, and read a run's timeline (`/tenants/{tenant}/tasks`);
  - explain a run: where it failed, a search that found nothing or sources found but never read, warnings and where the time went, from the timeline and, for people who may see it, the search attribution (`GET /tenants/{tenant}/diagnostics/tasks/{task}/attribution`);
  - evaluate a change: run a test set on an unsaved definition and on the published version (`POST /tenants/{tenant}/services/{id}/eval-runs` with `version: draft` and `definition`, which never touches the saved draft), compare case by case and test the difference with an exact McNemar test. The publish gates still decide what may be published.
- **Changes go through the normal path (ADR 0020).** The publish tool validates first, refuses a change reason under 10 characters, and the API applies the usual rights and quality gates. The person approves each change in the coding agent before it is sent; the tool is marked destructive, so clients ask.
- **The agent cannot set or confirm a risk class.** The API accepts a definition whose `riskConfirmation` matches its `riskClass` and stamps it with the publisher, so the server guards it: it refuses to publish when `riskClass` or `riskConfirmation` differs from the published version, or when a new service is above `minimal`, and gives the link to the service in the portal, where a person confirms it. Republishing an unchanged confirmation stamps it again with the person who approved the publish.
- **One organisation per server.** `GENKI_TENANT` pins it: every path is built from it, and a definition whose `metadata.tenant` differs is refused before anything is sent, also for a person with rights in several organisations.
- **Text from genki is untrusted data.** Definitions, version notes, answers, sources, user questions and documents are written by other people and can carry prompt injection. The server wraps them in tags with a random id and a note that they are data, as Supabase's MCP server does, and the skill tells the agent never to follow instructions inside them.
- **Modes and limits.** `GENKI_READ_ONLY=true` leaves the publish tool out; `GENKI_PLAYGROUND=false` leaves the tools that cost money out, the playground and evaluation; `GENKI_PLAYGROUND_BUDGET_NOK` (default 5) caps what they may cost in one session; an evaluation is charged when it is read to the end, and a cost the person may not see counts as the whole budget. Tools carry MCP annotations (read-only, destructive, open world) and return text only, so everything from genki, including API error messages, is inside the untrusted-data tags. `documentPath` reads only files under the folder the server was started in, never hidden files or links leading outside.
- **What the server leaves out:** secrets, API keys and clients, rights, tool registration and operator routes. These widen access, which ADR 0020 keeps away from changes made with AI.
- **Playground runs can be read back.** They are already stored as tasks with timelines, but the task list and `GET /tenants/{tenant}/tasks/{task}` show only service runs. The task list takes `origin=playground` to list the tenant's playground runs, `GET /tenants/{tenant}/tasks/{task}` returns one as it returns a service run, both with the same rights as service runs, and Logg can show them.
- **A skill teaches the workflow and the rules:** validate before publishing, always give a reason, never change a service others depend on (copy it instead), how to read a timeline, and the YAML mistakes that come up most.

## Why

- The API is already the contract, and the portal is one client of it (ADR 0032). A local server that only calls the API adds nothing to defend on the server side.
- Signing in as the person keeps ADR 0020's rule that changes are published with the person's own principal and rights, and leaves the key rules of ADR 0033 as they are.
- Turned down:
  - **An MCP endpoint hosted on the API.** Nothing to install, but it adds an admin surface to the server that needs its own review.
  - **A short-lived admin key that a trusted Entra login mints.** Faster to build, but it opens the definition routes to keys. ADR 0034 notes that keys outlive the token and the person's group membership.
  - **Propose, then apply, as in the prototype.** Two steps for every change. The coding agent already asks the person before each call, and the publish path, its gates and the risk confirmation stay the same.

## Consequences

- A person running the portal's dev server on port 5173 at the same time as logging in must stop it, or point `ADMIN_MCP_REDIRECT_URI` at another callback registered for the client.
- Built with this record: the server and its tools in `apps/admin-mcp`, tested against the API in `contract.test.ts`, playground runs in the task routes, and the skill in `.claude/skills/genki-admin`. The browser login is tested against a fake provider only, until the client is registered. The prototype's change sets and chat page are not carried over.
- What the tools return reaches the coding agent's transcript and its model provider, including user questions and document text from runs. `get_run` is compact by default to limit this; `full: true` gives the whole timeline.
- The server is built on the official MCP SDK (`@modelcontextprotocol/server`, pinned) and speaks protocol version 2026-07-28, falling back to 2025-11-25 and older.
- Not built yet: confirmation through MCP elicitation, and MCP resources and prompts. The run timeline does not show the effective instructions a model got, so a prompt change cannot be verified from it.
- A playground run stays out of the default task list, the overview and the usage by service, so Logg and the numbers people already read do not change.
