# 0050 Building blocks are made where they are found

Status: proposed, 2026-11-05 (not built; step flows placed in Utviklerverktøy as ADR 0037 has them, 2026-11-05)

Builds on ADR 0031, ADR 0037, ADR 0047 and ADR 0048. Where things sit in Utviklerverktøy is ADR 0037's; this record says what the step-flow library, the editor and the model choice do there.

## Context

A step flow is a reusable part that several services may pin (ADR 0031), but the portal treats it as part of one service.

- Its editor opens from Oppsett → Arbeidsmåte inside a service, from a placeholder in Utviklerverktøy, or from the hidden route `#/step-flows`. Opening it highlights Tjenester in the menu.
- The editor shows "I tjenesten" tabs and a service breadcrumb when no service is involved, and loses the service when opened from one.
- Byggeklosser lists step flows but does not open them. It also lists step types such as `call-operation@1` as step flows.
- The flow picker is a native select, so typing a name jumps to another flow. A new flow cannot be named outside YAML.
- "Bruk i en tjeneste" only shows a message.

For models, service owners see a name, a guessed provider and "ikke priset". They do not see the connection, the region, the price the API already returns, whether a processor record exists, or what the model can do.

In the console, adding a new API spans Modeller and Modelloperasjoner, four kinds of state (descriptor status, kind maturity, model operations, processor record), and five or six reasons typed in separate places. A page-wide reason field gates every checkbox, connections cannot be edited, and Revisjon names every ADR 0047 action "Annen handling".

## Decision

### Portal: Byggeklosser

- **Byggeklosser is where reusable parts are found.** Each kind lists its blocks and opens the place a block is made: skills, tools, guardrails and judges open their editors, Stegflyter opens the library in Utviklerverktøy, and Datasett and Fellestjenester open their own pages.
- **The step-flow library is Utviklerverktøy → Stegflyter** (ADR 0037), at `/developer/step-flows`, and `/developer/step-flows/{id}` is the editor, with a name field, the services that pin each version, and "Bruk i en tjeneste" that picks a service and pins the flow. Platform flows are listed beside the organisation's own.
- **Step types are their own kind**, Stegtyper, listing the step blocks such as `call-operation@1` with what each needs. They are not step flows.
- **A service picks a flow, it does not contain one.** The service's Utviklerverktøy tab → Stegflyt picks a flow and version with a searchable list and opens the editor with the service as context (`?tjeneste={id}`), so the editor offers "Tilbake til {tjeneste}" and "Fest denne versjonen". Without that context the editor shows no service.
- **Models are a block kind with the facts an owner needs**: provider and connection, where data is processed, the price per unit (ADR 0048), whether the connection has a processor record, and the operations the model offers with the API bound for each. The model picker in Oppsett shows the same facts.
- **A model per operation is chosen in one place**, the service's Utviklerverktøy tab → Modell og arbeidsmåte, listing each kind its flow uses. A step's own `params.model` is shown there when it overrides. The owner's Oppsett keeps the model in plain words (ADR 0037).

### Console: one models area

- **Modeller has three levels in one place**: Tilkoblinger (connections, with families, discovery and the processor record), the models on each connection (with their bindings, residency, limits and prices), and API-er (the registry of ADR 0048: built-in, bundled and uploaded, with status, test cases, contract and the kind's maturity). Modelloperasjoner is folded into it.
- **Adding a new API is one guided path**: upload, try on a model, save as a test case, approve, bind to models, move the kind to production. Each step links to the next and shows what is still missing, including a missing processor record.
- **Every change asks for its reason in its own dialog**, next to the action. The page-wide reason field is removed.
- **Connections can be edited**, and a connection in use cannot be removed.
- **Revisjon names every action** of ADR 0047, 0048 and 0049 in plain words.

### Words

- Norwegian text says Tilkobling for a connection, Modell for a model, API for an API and Oppskrift for a descriptor, which is how an uploaded API is described. A built-in API is shown as innebygd.
- English text says connection, model, API and recipe.

## Why

Things that are reused should be found where reuse happens. A flow edited inside one service invites changes that break the other services pinning it, and a library that cannot open its own items is a dead end. The library sits where ADR 0037 puts the organisation's technical parts, so the portal has one layout, and Byggeklosser links to it so owners still find it.

The console change follows ADR 0048: once a connection serves many APIs and a model binds one per kind, the screens should show that structure instead of a protocol label.

Turned down:

- Keeping the editor under Tjenester with a library tab: it is how the v5 design draws it, and it is what makes the flow look like it belongs to one service.
- Moving the library to Byggeklosser: it would split the technical parts ADR 0037 gathers in Utviklerverktøy. Byggeklosser links to it instead.
- Removing Datasett and Fellestjenester from the menu: owners use them daily and find them there.

## Consequences

- The routes `#/step-flows` and `#/step-flows/{id}` forward to `/developer/step-flows` and `/developer/step-flows/{id}`.
- `GET /tenants/{tenant}/building-blocks` lists step types as their own kind, and the model block carries the connection, price and processor-record facts.
- The screens are redrawn in Claude Design from this record before they are built; the design is a proposal that can be reworked later.
- Not built yet: all of the above.
