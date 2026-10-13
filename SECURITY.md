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

We confirm that we received the report, keep you informed while we fix it, and ask you to give us reasonable time before you disclose it.

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
- the parked Azure setup in `infra/`, which is not deployed
- the services the platform calls (Azure AI Foundry, Typesense, Altinn, Ansattporten, Maskinporten, Langfuse) and other Digdir systems such as digdir-headless-rag: report those to their owners
- model answers that are wrong or unwanted but cross no security boundary, and denial of service by volume
- findings from automated scanners without a demonstrated impact

Never commit a secret. If you find one in this repository or its history, report it as a vulnerability.
