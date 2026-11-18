# Models and building blocks

Brief for the screens of ADR 0050, built on ADR 0048 and ADR 0049. It is a proposal and can be reworked. Draw with the portal and console shell, Designsystemet components and the existing tone. All UI text in bokmål, with no em-dashes.

## The problem

- The step-flow editor is reached only inside one service (Oppsett → Arbeidsmåte), and looks like part of a service even when none is involved. Step flows are reusable and belong in the library under Utviklerverktøy → Stegflyter (ADR 0037), which Byggeklosser links to.
- Byggeklosser lists step flows but does not open them, and step types such as «Kall en operasjon» are mixed in with step flows.
- Service owners do not see the connection, region, price or processor record of a model.
- In the console an endpoint is locked to one API («OpenAI-kompatibel (Chat Completions)»). A connection now offers many APIs, and each model binds one API per kind of call.
- Adding a new API spans two screens, four kinds of state and five or six reasons.

## Words

| Norwegian UI | English    | Meaning                                           |
| ------------ | ---------- | ------------------------------------------------- |
| Tilkobling   | connection | Where and how Genki reaches a provider            |
| Modell       | model      | One deployment on a connection                    |
| API          | API        | One wire API, built-in or uploaded                |
| Oppskrift    | recipe     | An uploaded API description (descriptor)          |
| innebygd     | built-in   | An API Genki has its own code for                 |
| type kall    | kind       | What a call does: chat, avgjørelse, transkripsjon |

## Screens

### Portal (service owner)

1. **Byggeklosser, overview.** Kinds: Stegflyter, Stegtyper, Modeller, Ferdigheter, Verktøy, Vern, Dommere, Datasett, Fellestjenester. Each kind opens the place its blocks are made; Stegflyter opens the library in Utviklerverktøy.
2. **Utviklerverktøy → Stegflyter** (`/developer/step-flows`). The organisation's own and Digdir's flows, the current version, «Brukes av» (services and the version each has pinned), and «Ny stegflyt», which asks for a name first.
3. **Step-flow editor without a service.** Name, purpose, diagram and YAML, run a test, versions, and «Bruk i en tjeneste» (dialog: pick a service, pin a version). No «I tjenesten» tabs.
4. **The same editor opened from a service.** Clear context: «Tilbake til {tjeneste}» and «Fest denne versjonen i tjenesten».
5. **Service → Utviklerverktøy → Stegflyt.** A searchable picker for flow and version, a summary of the steps, and «Rediger stegflyten».
6. **Service → Utviklerverktøy → Modell og arbeidsmåte.** A model picker with the facts per model: provider and connection, where data is processed, price per unit, processor record (registrert / mangler). Below it, «Modell per type kall» for each kind the flow uses.
7. **Byggeklosser → Modell, detail.** The same facts, plus the kinds the model offers and the API bound for each.

### Console (platform team)

8. **Modeller, three levels.** Tilkoblinger → the models on each → API-er. Replaces today's Modeller and Modelloperasjoner. Draw two variants.
9. **Connection, detail and edit.** Name, address, key (secret), API families with their base (openai, anthropic), discovery rules, processor record. Editable. Pattern: the endpoint editor under Søkemotorer.
10. **Model, detail.** Kind → API (for example chat → `openai/responses@1`, avgjørelse → `openai/decide@1`), where data is processed, limits, prices per unit (tokens, audio seconds, images, calls). Each change asks for its reason in its own dialog next to the action. No page-wide reason field.
11. **API-er.** The registry: innebygd / følger med / lastet opp, kind, status (til vurdering, godkjent), test cases, contract test, the kind's maturity (test / produksjon), and the models bound to it.
12. **«Legg til et nytt API», one guided path.** Upload the recipe → try it on a model → save as a test case → approve → bind to models → move the kind to production. Shows what is missing, such as a processor record on the connection. Draw two variants.
13. **Revisjon.** Every action with a readable name (lastet opp oppskrift, godkjente oppskrift, flyttet type til produksjon, registrerte databehandleropplysninger, knyttet API til modell).

States to show: an empty list, an upload that fails (every reason listed), a connection without a processor record, a kind in test, and a step flow used by three services on different versions.

## Example data

Based on genki-test, 2026-11-05. No real people.

- Connection `foundry`: API families openai and anthropic, processor record registered.
- Models: gpt-5.4-mini (EU, 0,0076 kr in and 0,0459 kr out per 1 000 tokens; chat and plain-language), gpt-6-luna (EU; chat and decide), gpt-transcribe (global; transcription, not priced), claude-sonnet-5-5 (global; chat through `anthropic/messages@1`).
- APIs: `openai/chat-completions@1`, `openai/responses@1`, `anthropic/messages@1` (innebygd); `openai/decide@1`, `openai/embeddings@1` (følger med); `openai/plain-language@1` (lastet opp, godkjent, i produksjon).
- Step flows: «Klarspråk» (v1, used by `klarsprak-akseptansetest`), «KI-oversikt» (v3, Digdir).

## Delivery

One mock per screen in `mocks/` next to this brief, drawn as a Design artifact in Claude and exported here.
