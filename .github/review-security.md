# Security review

Runs when a pull request changes auth, identity, tenancy, the model gate, personal data handling, migrations, `infra/`, `.github/` or the `Dockerfile`. What genki promises to protect is in [docs/security/README.md](../docs/security/README.md).

Report only what a lower-trust caller could actually do: name the caller, what they send, the check that should stop them, and what they get. No finding without that chain.

Check in particular:

- Every route that reads or writes tenant data takes the tenant from the verified token, never from the path or body alone.
- API keys and tokens are compared in constant time, never logged, and scoped to one tenant and one purpose.
- Dev mode and mock settings refuse to start outside dev mode, and a test proves it.
- A tenant secret is sent only to the hosts it is bound to, and tool calls never reach a private or reserved address.
- Workflows use `pull_request`, never `pull_request_target`, pin third-party actions to a full commit SHA, and grant the least permissions the job needs.
- Infra changes keep secrets in Key Vault and identities federated; no new stored Azure secret.
- Text from models, documents or users is never executed or used to build a query, path or command.

Do not report denial of service, rate limits or generic hardening without a concrete path.
