# 0053 Building blocks for assistants

Status: proposed, 2026-11-02 (partly built: the package and Approach, used in the workspace; the package's rules and their lint, 2026-11-10)

Not built yet: the other components from the list (chat, threads, sources, filter, footnotes, projects, notes, document view), the builder's preview drawing the real components, a playground, and a way for a service definition to say which components it has and where. All but projects and notes are proposed in open pull requests #403 to #413.

Left: how an answer's footnotes and the excerpts they cite are numbered and linked, which depends on how the platform cites (ADR 0052); a layout format, which says which components a service has and where they sit; and a package that fetches, which would turn the stream into props for a host and be the first UI package to depend on `@genai/client`. Each needs its own decision.

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
- **Every value through a variable.** Each Designsystemet token is read where it is used as `var(--genai-<block>-<element>-<property>, <token>)`, with that one fallback. A size no token has, such as a width, is a literal fallback the same way, and never bare. A block sets no `--genai-` variable and no literal colour.
- **Checked by the lint.** `packages/ui-blocks/src/styles.test.ts` reads every block's sheet and fails on a literal colour, a size or weight outside a fallback, a bare `var(--ds-…)`, a second layer, a sheet `ui-blocks.css` does not import, or a variable no component page names.
- **Each block's words in its own catalogue,** bokmål as the source and English held to it with `satisfies`, so a host that imports one block loads only its words. `uiBlocksNb` and `uiBlocksEn` combine them for a host's own text.
- **One page per block** in `docs/components/`, listing every prop and every variable with its default. A test reads the props interface against the page, and the lint reads the variables. A PR that changes a block updates its page in the same PR.

## Why

The builder proposed in #210 draws the components as sketches with example content, and the workspace draws its own chat. The two would drift, and the preview would show a service owner something their users never see. A shared package makes the preview true by construction.

The component library was first planned in kunnskapsassistenten (digdir/kunnskapsassistenten#167). Building it here puts it next to the API it depends on, the workspace that runs services and the builder that composes them, so a change to the stream, a component and the builder can land in one PR. Kunnskapsassistenten can use the package once it is published.

The styling rules are Designsystemet's own: its components sit in cascade layers and read their values through variables. A host brands a block the way it brands everything else, with a theme for all of them and a variable for one detail. Variables are read where they are used, not set on the block's root, because a value set on the root is resolved there and an inner `data-color` would no longer change it.

## Consequences

- The workspace depends on `@genai/ui-blocks`, and the portal will once the builder's preview draws the components. Of this repository's packages it depends on `@genai/i18n` only, so it stays usable outside this repository; its icons come from `@navikt/aksel-icons`.
- A new block passes the lint and its page's test before it lands, since both run in `npm test`.
- The variables and props are public once the package is published: renaming one then breaks a host. Until then they may still change.
- What a component needs from the platform shows up as gaps. Approach is the first: the stream sends tool calls and agent iterations, but not what the assistant understood, how many documents it read or what it did not find. Those need the step frames in `docs/frontend-contract.md` to carry more, which is a separate change.
- The layout templates proposed for the builder in #210 and the kits in kunnskapsassistenten describe the same thing, a layout and a set of components. They should become one description in the service definition, the layout format left above.
