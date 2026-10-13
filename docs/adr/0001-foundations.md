# 0001 Foundations

Status: accepted, 2026-10-12 (partly built). Proposed 2026-10-06

Not built yet: production. A test environment in Azure is deployed from `main` with the workflows in `.github/workflows`.

## Decision

- **Language:** TypeScript on Node 24, strict mode, npm workspaces.
- **Repo:** lives in the `digdir` organisation as open source.
- **Hosting:** Azure Container Apps in Norway East, infrastructure in Bicep, deploys from GitHub Actions with OIDC.
- **Search:** the existing Typesense instance, behind a search port so it can be replaced.
- **Identity:** Ansattporten for employees, Maskinporten for agency systems, Altinn Autorisasjon for access decisions, Entra ID for Digdir operators. An agency is a tenant, keyed on organisation number.
- **Order of work:** parity with digdir-headless-rag first, measured by its contract tests and golden sets, before any new features. Parity for the scope in ADR 0017 came first; new features followed from 2026-10-07.

## Why

- TypeScript has first-class SDKs for MCP, OpenAI and Typesense, and is the language the Kunnskapsassistenten frontend and most of the public sector already use.
- TypeScript widens the pool of people who can maintain the platform.
- The platform is hosted by Digdir and consumed by agencies, like Altinn, so it uses the national identity and authorisation solutions instead of its own.
