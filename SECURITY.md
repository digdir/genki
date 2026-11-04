# Security

Thank you for helping keep genki and its users safe.

## Reporting a vulnerability

Do not report a vulnerability in a public issue, pull request or discussion. Report it privately, in one of two ways:

- **GitHub private vulnerability reporting:** on this repository's **Security** tab, choose **Report a vulnerability**.
- **Digdir's security contact:** use the channels in Digdir's [security.txt](https://www.digdir.no/.well-known/security.txt). Digdir's [responsible disclosure policy](https://www.digdir.no/digdir/responsible-disclosure-policy/6386) applies.

Include as much of this as you can:

- what kind of issue it is and what an attacker could do with it
- the affected files, route or setting, and the commit you tested
- the configuration needed to reproduce it (for example dev mode on or off, Postgres or memory, which identity provider)
- steps to reproduce, and a proof of concept if you have one

## What happens next

genki is run by a small team, so these are targets, not guarantees:

1. **Acknowledge.** We confirm that we received the report within three working days.
2. **Assess.** Within ten working days we tell you whether we can reproduce it, how severe we think it is, and what we plan to do. We may ask you questions on the way.
3. **Fix.** We fix it privately, tracked in a GitHub security advisory, with a test that would have caught it. Serious issues come first. While the platform is not in production, we aim to fix within 30 days of the assessment, sooner for anything that crosses a tenant boundary or exposes a secret. We keep you informed while we work, and tell you if it will take longer.
4. **Deploy.** The fix is merged to `main` and deployed to the test environment. Secrets that may have leaked are rotated.
5. **Disclose.** We publish the advisory on this repository once the fix is deployed, normally within 90 days of your report. We agree the date with you, and ask you to wait for it before you disclose.

The maintainers handle reports ([who maintains genki](CONTRIBUTING.md#who-maintains-genki)).

## Credit

We credit everyone who reports a vulnerability we fix, by name or handle, in the published advisory, unless you ask to stay anonymous. Tell us in the report how you want to be credited.

## Supported versions

The platform is under development and not in production. Only the latest commit on `main` is supported; there are no releases or backports yet.

## Scope

In scope:

- the code in this repository: the API, worker, portal, console and workspace apps, and the packages they use
- authentication and authorisation: Ansattporten, Maskinporten and API key handling, Altinn rights, operator access and tenant isolation (row-level security in Postgres)
- leaks between tenants or users: conversations, documents, datasets, API keys, secrets and logs
- prompt injection or tool misuse that crosses a tenant boundary, reaches a secret, or calls a tool or network address the service was not granted
- the container image built from the `Dockerfile` and the CI workflow

Out of scope:

- dev mode (`GENAI_DEV_MODE=true`): the mock Ansattporten, mock Altinn, dev login and in-memory storage are for local development and are insecure by design. A way to turn dev mode on, or reach the mock login, without setting that flag is in scope.
- the test persons, generated keys and example data in `apps/api/config/local` and in tests
- the Azure setup in `infra/`, deployed to the test environment only
- the services the platform calls (Azure AI Foundry, Typesense, Altinn, Ansattporten, Maskinporten, Langfuse) and other Digdir systems such as digdir-headless-rag: report those to their owners
- model answers that are wrong or unwanted but cross no security boundary, and denial of service by volume
- findings from automated scanners without a demonstrated impact

Never commit a secret. If you find one in this repository or its history, report it as a vulnerability.

## Security documentation

What genki protects and what operators must configure is in [docs/security](docs/security/README.md). The threat model and the argument for why it holds are in the [assurance case](docs/security/assurance-case.md).
