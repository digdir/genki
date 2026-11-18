# 0053 Building blocks for assistants

Status: proposed, 2026-11-02 (partly built: the package and Approach, used in the workspace; the package's rules and their lint, 2026-11-10; the components from #403 to #413, 2026-11-11)

Not built yet: projects, notes, the builder's preview drawing the real components, and a playground.

Decided in their own records: how an answer's footnotes cite excerpts (ADR 0052); and the layout format and the package that fetches, `@genai/ui-assembly` (ADR 0054).

## Decision

The components an assistant is made from (chat, threads, approach, sources, filter and the rest) are React components in one shared package, `@genai/ui-blocks`, in this repository. They are what a person sees and uses, not the reusable definition parts that ADR 0050 calls building blocks.

- **One component, every place.** The workspace draws a published service with them, and the builder's preview in the portal draws the draft with the same components. A component is not drawn a second way anywhere else.
- **Data in, events out.** A component does not fetch and does not know about the API. It gets plain props (the steps, the counts, whether the assistant is working) and reports what the person did through callbacks. Each app turns what the API sends into those props.
- **Text from the platform is shown as sent.** Where the platform sends text, such as a step label, the component shows it. Where it sends a kind, such as a tool name, the app translates it, and a kind it does not know is left out rather than shown raw.
- **Designsystemet first.** Components are built from `@digdir/designsystemet-react` and its tokens, with React and Designsystemet as peer dependencies. Own markup only where Designsystemet has nothing, and then with semantics and keyboard support from the start.
- **Not shown without data.** A component, or a part of one, is shown only when there is something to show. An empty card or a link to nothing is a bug.

### How a block is made

- **One folder per block,** `packages/ui-blocks/src/<block>/`, with the component, its stylesheet `<block>.css`, its catalogue `i18n.ts` and its tests. Its own classes are `uib-<block>` and `uib-<block>-*`; the few that blocks share, such as `uib-visually-hidden`, are in `ui-blocks.css`.
- **Ids in English.** Block ids, folders, classes, variables and catalogue namespaces are English (`approach`, `document-view`). What a person reads comes from the catalogue («Fremgangsmåte»).
- **Styles in one layer.** A block's sheet starts with `@layer ds.theme, ds.base, ds.components, genai.components;` and holds one `@layer genai.components` block, so a host's own CSS wins. `ui-blocks.css` imports every block's sheet and holds only what blocks share.
- **Every value through a variable.** Each Designsystemet token in a block's sheet is read where it is used as `var(--genai-<block>-<element>-<property>, <token>)`, with that one fallback, or through a private `--_` holder that is read only as such a fallback, for a default a container query changes. A length no token has, such as a width in `rem`, is a literal fallback the same way. Neither a length nor a font weight is ever bare. A block sets no `--genai-` variable and no literal colour.
- **Checked by the lint.** `packages/ui-blocks/src/styles.test.ts` reads every block's sheet and fails on a hex, functional or common named colour, a length with a unit or a font weight outside a fallback, a bare `var(--ds-…)`, a second layer, a variable not named after the block's folder or not named on a component page, and a sheet `ui-blocks.css` does not import.
- **Each block's words in its own catalogue,** bokmål as the source and English held to it with `satisfies`. The package declares only its stylesheets as side effects, so a host that imports one block bundles only that block's words. `uiBlocksNb` and `uiBlocksEn` combine them for a host's own text.
- **One page per block** in `docs/components/`, listing every prop and every variable with its default. A PR that changes a block updates its page in the same PR.

## Why

The builder proposed in #210 draws the components as sketches with example content, and the workspace draws its own chat. The two would drift, and the preview would show a service owner something their users never see. A shared package makes the preview true by construction.

The component library was first planned in kunnskapsassistenten (digdir/kunnskapsassistenten#167). Building it here puts it next to the API it depends on, the workspace that runs services and the builder that composes them, so a change to the stream, a component and the builder can land in one PR. Kunnskapsassistenten can use the package once it is published.

The styling rules are Designsystemet's own: its components sit in cascade layers and read their values through variables. A host brands a block the way it brands everything else, with a theme for all of them and a variable for one detail. Variables are read where they are used, not set on the block's root, because a value set on the root is resolved there and an inner `data-color` would no longer change it.

## Consequences

- The workspace depends on `@genai/ui-blocks`, and the portal will once the builder's preview draws the components. Of this repository's packages it depends on `@genai/i18n` only, so it stays usable outside this repository; its icons come from `@navikt/aksel-icons`.
- The lint reads a new block's sheet as soon as it is in a folder, and runs in `npm test`. A new block brings its own test that reads its props against its page, as `approach/docs.test.ts` does.
- The variables and props are public once the package is published: renaming one then breaks a host. Until then they may still change.
- What a component needs from the platform shows up as gaps. Approach is the first: the stream sends tool calls and agent iterations, but not what the assistant understood, how many documents it read or what it did not find. Those need the step frames in `docs/frontend-contract.md` to carry more, which is a separate change.
- The layout templates proposed for the builder in #210 and the kits in kunnskapsassistenten describe the same thing, a layout and a set of components. They should become one description in the service definition: the layout format of ADR 0054.
