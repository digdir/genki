# 0054 An assembly draws an assistant from a layout

Status: proposed, 2026-11-11 (partly built: the layout, its catalogue, rules and templates, and `@genai/ui-assembly`; no app uses the assembly yet; a block in both its zones, 2026-11-13)

Left: where a layout is stored, such as a frontend part of the service definition, and the builder's preview in the portal drawing a layout with the assembly. Each needs its own change.

## Context

ADR 0053 keeps the UI blocks free of fetching: data in, events out. It left two things for their own decision: a layout format, which says which blocks a service has and where they sit, and a package that fetches, which turns what genki sends into the blocks' props.

## Decision

- **A layout is data.** `AssistantLayout` in `packages/ui-blocks/src/builder/layout.ts`, version 1, places blocks in the shell's three zones, `primary`, `main` and `secondary`, each with only the settings that differ from the block's default.
- **One catalogue says what a layout may hold.** `blockCatalogue` in `builder/catalogue.ts` lists each block, its options, the zones it may sit in and what it needs from a partner. `isAssistantLayout` and `layoutProblems` in `layout.ts` check a layout against it.
- **A block stands in one zone, or in both its zones where the catalogue says `both`.** The layout then lists it once in each, with the same settings, and the assembly draws it in each its own way. Only Fremgangsmåte is marked `both`: the card over each answer in `main`, the detailed tool in `secondary`, and beside the tool the card is compact. `layoutProblems` reports `placed-twice` for any other block placed more than once, and for any block placed twice in one zone. The builder offers the places with `placesOf`: each zone, then `both`.
- **A template is a named layout,** in `builder/templates.ts`, such as `knowledge-assistant`. A template may carry a look (`templateLook`): `knowledge-assistant-next` draws the same blocks in a new look. A new look sits behind a template, or behind props and `--genai-*` variables whose defaults keep today's look, so an existing layout never changes by itself.
- **`@genai/ui-assembly` is the one UI package that calls genki.** It sits beside `@genai/ui-blocks` among the consumers and depends on `@genai/client`. It holds the state the blocks share (`useAssistant`), places each block of a layout in its zone (`<Assistant>`), and turns genki's answers and stream into the blocks' props. The blocks stay free of fetching.
- **One interface to genki.** Every call goes through `AssistantApi`. `createGenkiApi` implements it with reads (models, threads, collections, fields, facets), a new thread and a question; tests use a fake.
- **No key in the page.** `createGenkiApi` takes a `baseUrl` and sends no credentials of its own. A host reaches genki through its own proxy or session, which adds the key or the person's token.
- **Writes other than a question are the host's.** Feedback goes to the host's `onFeedback`, with the answer's `runId` (genki's task id) when genki gave one; without `onFeedback`, no feedback is offered.

## Why

- A service owner's preview and an app such as Kunnskapsassistenten should draw the same assistant from the same layout, without breaking 0053's rule for the blocks.
- A layout as data can be edited by the builder, checked by a host and stored later. The catalogue keeps one table: the builder proposed in #210 had its own rules.
- Turned down: fetching inside the blocks, which breaks 0053; and each host writing its own wiring, which would drift as the builder's sketches and the workspace's chat did.
- A block in both zones is placement, so it is said where placement is said, in the zones, and a layout that places a block once is unchanged. Turned down: an option on the block, `place: card | tool | both`, which would say the same thing as the zone it stands in and could contradict it.

## Consequences

- The atlas has a module `ui-assembly` (`docs/architecture/modules/ui-assembly.yaml`), and `docs/components/ui-assembly.html` describes it.
- No app uses the assembly yet. Kunnskapsassistenten's next client is its first host; the workspace and the builder's preview can follow.
- The layout's version 1, `AssistantApi` and the assembly's props are public once the package is published: changing them then breaks a host.
- The assembly's stylesheet follows the blocks' rules, and its lint refuses literal colours.
- In the template `knowledge-assistant-next`, Fremgangsmåte stands in both zones. Its look drew the tool for Fremgangsmåte in `main` before this was a choice, so a layout from that template stored earlier with Fremgangsmåte in `main` alone now draws the card alone.
