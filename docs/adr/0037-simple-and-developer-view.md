# 0037 Owner pages and developer tools in the portal

Status: proposed, 2026-10-20 (rewritten to a developer tools area, 2026-10-30)

## Context

The portal's first users are administrators in an agency who set up services, datasets and access without a technical background. The same menus also carried what a developer needs: keys, systems, triggers, hooks, tracing, step flows and the API reference. A non-technical owner met all of it at once. Developers still need every part of it, and ADR 0032 keeps the API the whole truth: the portal is one client.

The first version of this record proposed a switch that added the technical parts to every screen. That needs a simple and a developer variant of each screen, and it was never built.

## Decision

- **The main menu holds the owner's work, in three groups.** Bygg (Tjenester, Fellestjenester, Datasett, Byggeklosser, Prøveområde, Utviklerverktøy), Analyse (Statistikk, Logg) and Administrasjon (Tilgang, Innstillinger).
- **Technical parts live in one place, Utviklerverktøy.** For the organisation it is `/developer`, with Driftsstatus, Nøkler, Brukerflater, Systemer, Utløsere, Stegflyter, Kroker, Sporing og evaluering, Felles sikkerhetsfiltre and API-referanse og dokumentasjon. Each service gets its own Utviklerverktøy tab with what is technical about that service: calling it from code, strategy parameters and step flows, model fallback and roles, variants, hooks, the definition and tracing.
- **The owner keeps what the owner decides.** On a service: the model in plain words (its name, where data is processed, cost in kroner), risk level and confirmation, privacy and safety filters, topics to refuse, whether the service may be improved automatically, testing, the log and versions with rollback. For the organisation: statistics, access and settings.
- **Where a setting lives is decided once.** One map from a part of the definition to its page is used by the publish dialog's fix buttons, the builder assistant's cards, error messages and old addresses, so they never point to a page that no longer holds the setting.
- **Utviklerverktøy is visible to everyone signed in, until a personal preference hides it.** The preference is `view: simple | developer` in `PUT /tenants/{tenant}/me/preferences`. It grants nothing: rights still come from Altinn (ADR 0027), and hiding something never stands in for checking a right in the API.
- **Old addresses keep working.** `/integrations` and its tabs, `/usage` and `/help` forward to where the page lives now, keeping the open row and the query.
- **The console has no owner view.** Its users are operators.

## Why

- **One place is cheaper and clearer than two variants of every screen.** A developer knows where to look, an owner is not shown what they do not need, and no screen has to be built twice.
- **Owner decisions stay with the owner.** The risk class is set by a person (ADR 0020), and where data is processed is chosen per service (ADR 0021). The model decides both cost and residency. These cannot sit behind a technical switch.
- **A preference instead of a right** keeps Altinn as the only source of access, and avoids people asking for a right to see a YAML file.
- Turned down:
  - **A switch that adds technical parts to every screen:** every screen in two variants, and the same page looks different to two people talking about it.
  - **Treating a new service as simple and a published one as technical:** a developer creating a service needs the technical parts, and an owner editing a published one does not.
  - **Showing technical parts only with `manage-services`:** mixes a right with a preference, and non-technical owners often have that right.

## Consequences

- Not built:
  - The `view` preference and its switch in the user menu. Until then Utviklerverktøy is in the menu for everyone.
  - The Utviklerverktøy tab on each service and the map from setting to page. The service builder is unchanged until they land, together with the new builder for new services.
- New technical parts go into Utviklerverktøy. Putting something in an owner page is a deliberate choice.
- A page with no content yet is not shown in a menu.
