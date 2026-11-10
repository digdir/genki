# 0053 Building blocks for assistants

Status: proposed, 2026-11-02 (partly built: the package and Approach, used in the workspace)

Not built yet: the other components from the list (chat, threads, sources, filter, footnotes, projects, notes, document view), the builder's preview drawing the real components, a playground, and a way for a service definition to say which components it has and where.

## Decision

The components an assistant is made from (chat, threads, approach, sources, filter and the rest) are React components in one shared package, `@genai/ui-blocks`, in this repository.

- **One component, every place.** The workspace draws a published service with them, and the builder's preview in the portal draws the draft with the same components. A component is not drawn a second way anywhere else.
- **Data in, events out.** A component does not fetch and does not know about the API. It gets plain props (the steps, the counts, whether the assistant is working) and reports what the person did through callbacks. Each app turns what the API sends into those props.
- **Text from the platform is shown as sent.** Where the platform sends text, such as a step label, the component shows it. Where it sends a kind, such as a tool name, the app translates it, and a kind it does not know is left out rather than shown raw.
- **Designsystemet first.** Components are built from `@digdir/designsystemet-react` and its tokens, with React and Designsystemet as peer dependencies. Own markup only where Designsystemet has nothing, and then with semantics and keyboard support from the start.
- **Two languages.** The package has its own catalogue in bokmål and English, as `@genai/schema-forms` does.
- **Documented beside the code.** Each component has a page in `docs/components/`. A PR that changes a component updates its page in the same PR.
- **Not shown without data.** A component, or a part of one, is shown only when there is something to show. An empty card or a link to nothing is a bug.

## Why

The builder's preview drew the components as sketches with example content, and the workspace drew its own chat. The two would drift, and the preview would show a service owner something their users never see. A shared package makes the preview true by construction.

The component library was first planned in kunnskapsassistenten (digdir/kunnskapsassistenten#167). Building it here puts it next to the API it depends on, the workspace that runs services and the builder that composes them, so a change to the stream, a component and the builder can land in one PR. Kunnskapsassistenten can use the package once it is published.

## Consequences

- The workspace and the portal depend on `@genai/ui-blocks`. The package depends on `@genai/i18n` only, so it stays usable outside this repository.
- What a component needs from the platform shows up as gaps. Approach is the first: the stream sends tool calls and agent iterations, but not what the assistant understood, how many documents it read or what it did not find. Those need the step frames in `docs/frontend-contract.md` to carry more, which is a separate change.
- The builder's templates and the kits in kunnskapsassistenten describe the same thing, a layout and a set of components. They should become one description in the service definition, which needs its own decision.
