# Developer tools: where things live

Design brief from the Claude Design canvas "Utviklerverktøy – informasjonshierarki" (2026-10-30). It settles which developer tools belong to the whole organisation and which belong to one service. Mock screens are in `mocks/` as reference markup; they are drawn with Designsystemet colours and type, not with real components.

Related: ADR 0037 (simple and developer view).

## The rule

- **Made once and shared across services → the menu page** "Utviklerverktøy", the last item under **Bygg** in the sidebar.
- **Applies to one service → the tab "Utviklerverktøy"** on the service, next to Oppsett and Grensesnitt.

A non-technical owner sees only Oppsett and Grensesnitt on a service. Everything technical for that service sits behind the one extra tab, never as separate tabs (API, Sporing, …), which read as noise.

## Sidebar

- Remove Utviklerverktøy from the avatar menu (`userMenuLinks` in `apps/portal/src/Shell.tsx`, `['#/developer', 'shell.menuDeveloper']`).
- Add it as the last link in the **Bygg** group of `navigationGroups`, route `#/developer`.

## Organisation level: the menu page (mock `A3-virksomhet.dc.html`)

Intro: "Det som gjelder hele virksomheten. Det som gjelder én tjeneste, finner du i fanen Utviklerverktøy på tjenesten."

Submenu, in this order:

1. Driftsstatus
2. Nøkler: every key in the organisation. The "Gjelder" column links to the service a key reaches.
3. Brukerflater
4. Systemer
5. Stegflyter: the library of step flows
6. Hooks: the library of hooks
7. Felles sikkerhetsfiltre: filters every service inherits
8. API-referanse og dokumentasjon

Removed from the old page and moved to the service tab: Kjøringer/sporing, Utløsere, and anything else scoped to a single service.

## Service level: the tab (mocks `A1-*.dc.html`)

Tabs on the service: **Oppsett · Grensesnitt · Utviklerverktøy**. The tab has one flat submenu with an icon per item and no group headings:

| Item | What it shows | Mock |
|---|---|---|
| Kall fra kode | Endpoint `POST /tenants/{tenant}/services/{id}/run`, curl example. Before publishing: an info box saying the service answers calls once published. | `A1-tjeneste-fane` |
| Nøkler | Keys that reach this service, and "Lag nøkkel for tjenesten" | `A1-tjeneste-fane` |
| Utløsere | Triggers for this service | none |
| Modell og arbeidsmåte | Model, strategy, number of excerpts, temperature, max length, budget; Lagre and Tilbakestill | `A1-a-modell` |
| Stegflyt | Which step flow from the library this service uses | none |
| Hooks | Which hooks from the library are connected | none |
| Sikkerhetsfiltre | "Fra virksomheten" (inherited, read-only here) and "Bare for denne tjenesten", plus "Legg til filter" | `A1-d-filtre` |
| Kjøringer og sporing | Runs table (time, status, duration, tokens, trace id) and the step timeline of a selected run | `A1-b-sporing` |
| Definisjon | YAML/JSON toggle, Kopier, Last ned, Rediger definisjonen | `A1-c-definisjon` |
| Versjoner | Published versions of the service | none |

Icon paths (24×24 viewBox, stroke 1.6) are in the mocks.

The A1 mock of a new, unpublished service shows 7 items; the A1-a to A1-d mocks of a published service show all 10. Settle which items hide before publishing.

## How the two levels connect

| Organisation (menu page) | Relation | Service (tab) |
|---|---|---|
| Nøkler | gives access to | Nøkler |
| Stegflyter | is chosen as | Stegflyt |
| Hooks | is connected as | Hooks |
| Felles sikkerhetsfiltre | inherited, can be extended | Sikkerhetsfiltre |
| API-referanse | example from | Kall fra kode |

Service only: Utløsere, Modell og arbeidsmåte, Kjøringer og sporing, Definisjon, Versjoner.
Organisation only: Driftsstatus, Systemer, Brukerflater.

## Open questions

- Can a hook or a step flow be specific to one service? If yes, the service tab needs "Lag ny" for them too, not only a choice from the library.
- Should the tab show only to people with the developer view on (ADR 0037), or to everyone?

## Code pointers

- Sidebar: `apps/portal/src/Shell.tsx`, labels in `apps/portal/src/i18n/nb/core-shell.ts`
- Menu page: `apps/portal/src/screens/DeveloperTools.tsx`
- Service sections: `apps/portal/src/screens/service/sections.ts`
