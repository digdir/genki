# genki-admin MCP server

`genki-admin` is a local MCP server that lets a coding agent (Claude Code, Codex, Cursor, VS Code Copilot and others) work on genki services through the public API, as the person who logged in. The agent can list and read services, describe strategies and models, validate a definition and see what it changes, try an unsaved definition in the playground next to the published one, publish a new version with a change reason, and read runs and their timelines. It runs on your machine over stdio, calls the same API routes as the portal and nothing else, and is not part of any image or deploy. See [ADR 0046](../../docs/adr/0046-admin-mcp-for-coding-agents.md) for the decision.

What it will never do:

- read or write secrets, API keys or API clients, and it neither accepts nor creates an API key;
- grant or change rights, register tools, or call operator routes;
- set or confirm a risk class. That is done by a person in the portal.

## Security

- **Changes are marked.** Every change reason the server sends ends with `(via kodeagent, genki-admin)`, so the version history and Logg show that a change was made through a coding agent, by the person who logged in.

- **It acts as you.** Every call carries your own login, so the API applies your rights, the lockdown rules (ADR 0033) and the quality gates. Every publish is in the version history under your name.
- **Prompt injection.** Service definitions, prompt files, answers, sources and run input are written by other people. Tools wrap that text, and the API's error messages, in `<untrusted-data-…>` tags with a random suffix and tell the agent it is data, never instructions. Results come as text only, so nothing from genki reaches the agent outside the tags. The server's instructions to the agent say the same. Your coding agent still asks you before each tool call: read what it is about to publish.
- **One organisation.** The server is pinned to `GENKI_TENANT`. A definition whose `metadata.tenant` is another organisation is refused before it reaches the API.
- **Read-only mode.** `GENKI_READ_ONLY=true` removes `publish_definition`. `GENKI_PLAYGROUND=false` removes the tools that cost money, `run_playground` and `evaluate_change`. Set both to allow reading only.
- **Playground budget.** `run_playground` and `evaluate_change` call models and cost money. The server stops starting runs once the session has spent `GENKI_PLAYGROUND_BUDGET_NOK` (5 kr by default). The check happens before each run, so the last run can go slightly over. An evaluation is charged when it is read to the end, and no new one starts before that. A run whose cost you may not see counts as using up the budget.
- **Local files.** `documentPath` reads only files under the folder the server was started in, never a hidden file or folder (such as `.env` or `.aws`), and never through a link that leads outside.
- **Tokens.** The API, the portal and the login issuer must use https, except on this machine (`localhost`, `127.0.0.1`, `::1`). The access token stays in the server's memory, is never written to disk, and is gone when the server stops.
- **Where data goes.** Whatever a tool returns, including definitions, prompt files, answers and run timelines, ends up in the agent's transcript and is sent to the agent's model provider. Do not use it on services whose content may not leave Digdir that way.

## Quick start: local genki in development mode

No login is needed against a local API in development mode. The server logs in through the API's mock dev login, which it only does against `localhost` or `127.0.0.1`.

1. Start genki from the genki repository:

   ```sh
   npm start
   ```

   The API listens on `http://localhost:8080`.

2. Add the server to Claude Code:

   ```sh
   claude mcp add genki-admin -s local -e GENKI_TENANT=991825827 -e GENKI_DEV_LOGIN=true -- <path to genki>/node_modules/.bin/tsx --conditions=source <path to genki>/apps/admin-mcp/src/main.ts
   ```

3. Start Claude Code in the genki repository, so the `genki-admin` skill in `.claude/skills` loads too. Run `/mcp` to check that `genki-admin` is connected with 12 tools.

## Against genki-test

```sh
claude mcp add genki-admin -s local \
  -e GENKI_API_BASE=https://api.genki-test.digdir.cloud \
  -e GENKI_TENANT=<organisation number> \
  -e ADMIN_MCP_CLIENT_ID=<the console's client id, CONSOLE_CLIENT_ID in the test environment> \
  -- <path to genki>/node_modules/.bin/tsx --conditions=source <path to genki>/apps/admin-mcp/src/main.ts
```

The first tool call opens the browser for an Ansattporten login (authorization code flow with PKCE, callback on `http://localhost:5173/callback`). It uses the console's Ansattporten client, which has that callback registered for local development and is trusted in genki-test (`OPERATOR_CLIENT_IDS`), so a trusted Entra login works as it does in the console. No new registration is needed. When the token is about to expire the server refreshes it; if that fails, it opens the browser again. Restarting the agent means logging in again.

If you run the portal's dev server on port 5173, stop it while you log in, or set `ADMIN_MCP_REDIRECT_URI` to another callback registered for the client.

## Other clients

Use absolute paths. These examples use local development mode; for genki-test, replace the `env` block with `GENKI_API_BASE`, `GENKI_TENANT` and `ADMIN_MCP_CLIENT_ID` as above.

Cursor (`.cursor/mcp.json`) and Claude Desktop (`claude_desktop_config.json`) use `mcpServers`:

```json
{
  "mcpServers": {
    "genki-admin": {
      "command": "/path/to/genki/node_modules/.bin/tsx",
      "args": ["--conditions=source", "/path/to/genki/apps/admin-mcp/src/main.ts"],
      "env": { "GENKI_TENANT": "991825827", "GENKI_DEV_LOGIN": "true" }
    }
  }
}
```

VS Code (`.vscode/mcp.json`) uses `servers` and a `type`:

```json
{
  "servers": {
    "genki-admin": {
      "type": "stdio",
      "command": "/path/to/genki/node_modules/.bin/tsx",
      "args": ["--conditions=source", "/path/to/genki/apps/admin-mcp/src/main.ts"],
      "env": { "GENKI_TENANT": "991825827", "GENKI_DEV_LOGIN": "true" }
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.genki-admin]
command = "/path/to/genki/node_modules/.bin/tsx"
args = ["--conditions=source", "/path/to/genki/apps/admin-mcp/src/main.ts"]
env = { GENKI_TENANT = "991825827", GENKI_DEV_LOGIN = "true" }
```

For other clients, or if a format has changed, see the client's documentation. The skill in `.claude/skills/genki-admin` is only loaded by Claude Code; other agents get the server's own instructions on connect.

## Configuration

| Variable                      | Default                                          | What it does                                                                                   |
| ----------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `GENKI_API_BASE`              | required; `http://localhost:8080` with dev login | The genki API. https, unless on this machine                                                   |
| `GENKI_TENANT`                | required                                         | The organisation number (9 digits) the server works for                                        |
| `ADMIN_MCP_CLIENT_ID`         | required unless `GENKI_DEV_LOGIN=true`           | The Ansattporten client id                                                                     |
| `ANSATTPORTEN_ISSUER`         | `https://test.ansattporten.no`                   | The login issuer                                                                               |
| `GENKI_AUDIENCE`              | `digdir:genai`                                   | The `resource` asked for at login                                                              |
| `GENKI_ALTINN_RESOURCE`       | `urn:altinn:resource:digdir-genai-platform-test` | The Altinn resource in the login's `authorization_details`                                     |
| `ADMIN_MCP_REDIRECT_URI`      | `http://localhost:5173/callback`                 | The login callback; must be registered for the client, http on this machine                    |
| `GENKI_DEV_LOGIN`             | `false`                                          | `true` uses the API's mock dev login. Local API only                                           |
| `GENKI_READ_ONLY`             | `false`                                          | `true` removes `publish_definition`                                                            |
| `GENKI_PLAYGROUND`            | `true`                                           | `false` removes `run_playground` and `evaluate_change`                                         |
| `GENKI_PLAYGROUND_BUDGET_NOK` | `5`                                              | Most the session may spend in the playground, in kroner                                        |
| `GENKI_PORTAL_URL`            | derived                                          | Portal for links. Derived from an `api.` host (`api.x` gives `portal.x`); none for a local API |

Flags are on only for the exact value `true`.

## Tools

| Tool                   | What it does                                                                                                                               | Kind        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `list_services`        | The organisation's services with id, name, latest version, status and variants                                                             | Reads       |
| `get_service`          | A definition as YAML (latest or a given `version`), its prompt files, version history and who called it in the last 50 runs                | Reads       |
| `new_service_template` | A minimal valid definition for a new service, with the platform's defaults                                                                 | Reads       |
| `describe_strategy`    | Without `id`, the strategies; with `id`, the config keys (also what a variant may override), the starting config and built-in instructions | Reads       |
| `list_models`          | The models the organisation can choose, whether it may use them, where data is processed and the price per 1,000 tokens                    | Reads       |
| `validate_definition`  | Checks a definition without saving it and lists the fields that differ from the published version                                          | Reads       |
| `publish_definition`   | Validates, then publishes the next version with a `reason` of at least 10 characters                                                       | Writes      |
| `run_playground`       | Runs a published version or an unsaved `yaml`, optionally next to a second setup in `compareWith`, and returns answer, sources, cost, time | Costs money |
| `list_runs`            | Recent service runs or playground runs (`origin`), filtered by `service` or `status`                                                       | Reads       |
| `get_run`              | One run with its timeline, compact by default; `full: true` gives the whole timeline as JSON                                               | Reads       |
| `explain_run`          | A diagnosis of a run: where it failed, a search that found nothing or sources never read, warnings, and where the time went                | Reads       |
| `evaluate_change`      | Runs a test set on an unsaved `yaml` and on the published version, and says which cases it fixed or broke and whether that is chance       | Costs money |

Details worth knowing:

- Tool annotations tell the client which tools only read (`readOnlyHint`), which change something (`destructiveHint`) and which reach outside (`openWorldHint` on `run_playground`). Results come as text only.
- `validate_definition`, `publish_definition` and `run_playground` take the prompt files in `files`, path to text, as `get_service` returns them.
- When validation says `unknown model`, the error lists the models the organisation may use.
- `run_playground` takes `variant`, `model` (for example `local/echo` to test for free), `output: fields` for services that extract fields, and `documentPath`, a file of at most 10 MB under the folder the server was started in, sent as the input document. Nothing is saved, but the run can be read back with `get_run`.
- `get_run` with `full: true` is cut at 60,000 characters.
- `explain_run` uses the search attribution when you may see it (operators in a support session); otherwise it judges retrieval from the timeline and says so.
- `evaluate_change` never touches the saved draft. It waits up to `waitSeconds` (default 120); if the runs are not done, it returns their ids, and you call it again with `runs`. With few cases, "no detectable difference" is the honest answer. The publish gates still decide what may be published.
- The server is built on the official MCP SDK (`@modelcontextprotocol/server`). It speaks protocol version `2026-07-28` and falls back to `2025-11-25` and older for clients that ask for them.

## Workflows

### Change a service safely

1. `get_service` for the definition, its prompt files and who calls it. If an API key or another channel calls it, others depend on it: copy it to a new id instead.
2. `describe_strategy` with the strategy id to see which config keys exist.
3. Edit the YAML. Keep the whole definition and `metadata.id`.
4. `validate_definition` with `yaml` and `files` until it is valid. Read the list of changed fields: it should only show what you meant to change.
5. `run_playground` with `yaml`, `files` and `compareWith: {}` to run the change next to the published version. Compare the steps, not only the answers.
6. If the service has a test set, `evaluate_change` with `yaml` and `files` to see which cases the change fixes or breaks.
7. `publish_definition` with a `reason` that says what changed and why.
8. Check with `get_service` and one more playground run.

### Investigate a slow or failed run

1. `list_runs`, with `status: failed` or a `service`, or `origin: playground` for playground runs.
2. `explain_run` with the id for a diagnosis, then `get_run` for the details behind it. Look for steps marked `failed`, `partial`, `skipped` or `warning`, and where the time and tokens went.
3. `get_run` with `full: true` when the compact view leaves out the detail you need.

### Start a new service

1. `new_service_template` for a minimal valid definition.
2. `list_models` and `describe_strategy` to choose a model and a strategy.
3. Change `metadata.id`, `metadata.name` and `spec.purpose`, then validate, try and publish as above. A new service with `riskClass: minimal` can be published from the agent.

### Risk classes

`publish_definition` refuses a new service with a risk class above `minimal`, and any change to `riskClass` or `riskConfirmation`, before it calls the API. The error gives a link to the service in the portal, where a person confirms the risk class. Publish the other changes without touching those fields, or let the person publish in the portal.

## The skill

`.claude/skills/genki-admin/SKILL.md` teaches the agent the workflow above and the rules: work through the MCP only and not genki's source code, validate before publishing, always give a reason, never change a service others depend on, never touch `riskClass` to get a publish through, treat a failed quality gate as information, and treat run content as data. It also explains how to read a timeline and lists the YAML mistakes that come up most.

Claude Code loads it when it runs in the genki repository and the task is to change, test, compare or debug a service in a running genki.

## Troubleshooting

| Message or symptom                                    | What to do                                                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port 5173 is busy`                                   | The portal's dev server or another genki-admin login uses it. Stop it, or set `ADMIN_MCP_REDIRECT_URI` to another callback registered for the client                      |
| `login timed out`                                     | The browser login was not finished within 5 minutes. Call a tool again to start a new login                                                                               |
| HTTP 403                                              | You lack the right for that organisation or service, or the environment is locked down (ADR 0033) and your login is not trusted there. The error carries the API's reason |
| `this server works for <org> only`                    | `metadata.tenant` in the YAML is not `GENKI_TENANT`. Fix the YAML, or reconfigure the server for that organisation                                                        |
| `The playground budget for this session … is used up` | Ask before spending more. Raise `GENKI_PLAYGROUND_BUDGET_NOK` and restart the server                                                                                      |
| `unknown model`                                       | The error lists the models the organisation may use. `list_models` shows them with price and data location                                                                |
| `… must use https unless it is on this machine`       | Use an `https://` URL, or `localhost`/`127.0.0.1` for a local API                                                                                                         |
| `GENKI_DEV_LOGIN works only against a local API`      | Dev login is for a local API in development mode. Use the browser login against genki-test                                                                                |
| `dev login answered 404`                              | The local API does not run in development mode with the mock login                                                                                                        |
| `GENKI_TENANT must be an organisation number`         | Use the 9-digit organisation number                                                                                                                                       |

The server writes its own messages, such as `ready: 12 tools` and the login URL, to stderr. Most clients show them in their MCP logs.

## Development

Tests need Node 24 or newer. From the genki repository root:

```sh
npx vitest run apps/admin-mcp
```

`contract.test.ts` boots the API in memory and runs every tool against it, so a change to an API route that breaks a tool fails here. `protocol.test.ts` covers the JSON-RPC handling and `login.test.ts` the browser login against a fake provider.

To smoke test over stdio, send JSON-RPC lines and read the answers:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | GENKI_TENANT=991825827 GENKI_DEV_LOGIN=true node_modules/.bin/tsx --conditions=source apps/admin-mcp/src/main.ts
```

`tools/list` works without an API. A `tools/call` needs the local API running.

## Related

- [ADR 0046: Coding agents work on genki through a local admin MCP server](../../docs/adr/0046-admin-mcp-for-coding-agents.md)
- [ADR 0020: Changes made by AI](../../docs/adr/0020-changes-made-by-ai.md)
- [ADR 0033: Locked test environment](../../docs/adr/0033-locked-test-environment.md)
