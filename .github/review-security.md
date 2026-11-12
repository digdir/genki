# Security review

Runs when a pull request changes auth, identity, tenancy, the model gate, personal data handling, migrations, `infra/`, `.github/` or the `Dockerfile`. What genki promises to protect is in [docs/security/README.md](../docs/security/README.md).

Report only what a lower-trust caller could actually do: name the caller, what they send, the check that should stop them, and what they get. No finding without that chain.

Check in particular:

- Every route that reads or writes tenant data takes the tenant from the verified token, never from the path or body alone.
- API keys and tokens are compared in constant time, never logged, and scoped to one tenant and one purpose.
- Dev mode and mock settings refuse to start outside dev mode, and a test proves it.
- A tenant secret is sent only to the hosts it is bound to, and tool calls never reach a private or reserved address.
- Workflows use `pull_request`, never `pull_request_target`, pin third-party actions to a full commit SHA, and grant the least permissions the job needs.
- Workflow expressions do what the author meant. `0`, `''`, `false` and `null` are falsy, so `a && b || c` is not a ternary when `b` can be falsy: `${{ x && 0 || 1 }}` is always `1`. For every `if:`, fallback, default and pass-with-no-tests style flag, ask what happens when it yields nothing and whether CI then passes green doing nothing. When a change alters what CI runs, read whatever checks have finished (`gh pr checks`, `gh run view --log`). Treat pending checks as unknown, not as missing or failed, and report a CI wiring problem only when you can show it from the workflow file or a finished run.
- Infra changes keep secrets in Key Vault and identities federated; no new stored Azure secret.
- Text from models, documents or users is never executed or used to build a query, path or command.

Do not report denial of service, rate limits or generic hardening without a concrete path.

## Invariants

Check every path the change touches against these, not only the main route. A path that breaks one is Important under the REVIEW.md bullet it belongs to. Where a test holds the invariant, it is named; a change that weakens that test is a finding.

- **Only operators change what a service is shared with.** Every path that can change who may use a service checks for an operator.
- **Only operators change the limits Digdir sets for an organisation.** Every path that writes a tenant setting (set, remove, pin, import) goes through `SettingsRegistry` with the writer, and a setting marked `operatorOnly` refuses anyone but an operator. Tests: `apps/api/src/operator-only-settings.test.ts`, "refuses a tenant manager who sets, previews, removes or pins %s" and "refuses a tenant manager who imports %s".
- **A key or client gets only the rights it was granted, never every right by default.** A missing or empty grant means nothing, on every way a principal is made. Tests: `apps/api/src/api-consistency.test.ts`, "refuses every route of its own organisation to a Maskinporten client, which holds no right there", and `packages/identity/src/platform-rights.test.ts`, "gives an API key only the rights its scopes grant, in its own organisation".
- **Every route that reads tenant data checks the tenant on that route, not only on a sibling route.** Tests: `apps/api/src/api-consistency.test.ts`, "answers 404, never 403, on every tenant route to someone who cannot reach the tenant", and `apps/api/src/routes/portal-routes.test.ts`, "reads a playground run by id like a service run, but not one from another tenant".
