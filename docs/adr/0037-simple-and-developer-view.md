# 0037 Simple and developer view in the portal

Status: proposed, 2026-10-20

## Context

The portal's first users are administrators in an agency who set up services, datasets and access without a technical background. Today the same screens also carry what a developer needs: the API call behind an action, the definition as YAML, strategy parameters, model ids, tokens, task ids, hooks, building blocks, step flows and the API reference. A non-technical owner meets all of it at once, and it makes simple work look hard. Developers still need every part of it, and ADR 0032 keeps the API the whole truth: the portal is one client.

## Decision

- **The portal has two views: simple (default) and developer.** Simple is what a non-technical owner needs to set up, test, publish and follow a service. Developer adds everything technical on top, on the same screens. Nothing exists only in the developer view that cannot be reached through the API.
- **The developer view is a personal preference, not a right.** It is stored in the person's own preferences for the organisation (`PUT /tenants/{tenant}/me/preferences`, `view: simple | developer`), so it follows the person across devices. It grants nothing: rights still come from Altinn (ADR 0027), and hiding something in the simple view never stands in for checking a right in the API.
- **One switch, always in the same place.** "Utviklervisning" in the user menu, plus a small marker in the header while it is on. Turning it on or off keeps the person on the page they are on.
- **The simple view speaks the owner's language.**
  - Cost in kroner, not tokens; tokens are shown in the developer view.
  - Models by their display name, not their id.
  - "Slik svarer tjenesten" instead of strategy names and parameters.
  - Errors say what to do next; a task id appears only in the developer view.
- **What the simple view leaves out, by default:**
  - API calls behind actions ("Vis API-kall"), the API reference and code snippets.
  - The definition as YAML or JSON and raw schema editors.
  - Strategy parameters, budgets and step-flow editing (step flows can be chosen, not edited).
  - Hooks, building-block registration, client registration (Brukerflater) and keys beyond creating one for a named use.
  - Task timelines beyond the summary, trace ids and raw events.
- **What both views have:** the builder assistant and the forms it fills, datasets and their status, testing a service, quality results in plain words, access, usage, publishing, and the service log as a readable list.
- **Deep links still work.** A link into a developer-only part (for example `?view=yaml`) opens it and offers to switch to the developer view, instead of a dead end.
- **The console has no simple view.** Its users are operators.

## Why

The platform should be usable by the people who own the services, not only by developers, and "config-first" means the forms and the assistant must be enough on their own for the common work. Two views on the same screens keep one portal and one set of routes, instead of a second "easy" portal that drifts. A preference instead of a right keeps Altinn as the only source of access, and avoids people asking for a right just to see a YAML file.

Rejected:

- **A separate simple portal:** two apps to keep in step.
- **Per-feature toggles:** too many choices for the people the simple view is for.
- **Showing technical parts to people with `manage-services` only:** mixes a right with a preference, and non-technical owners often have that right.
- **Hiding the switch behind an organisation setting:** developers in any agency must be able to turn it on themselves.

## Consequences

- Every portal screen gets a simple and a developer variant of the same page. Tests check, per screen, what the simple view shows and leaves out, and that the developer view still shows everything it does today.
- New technical parts default to the developer view; putting something in the simple view is a deliberate choice, reviewed against the design handoff.
- The simple view needs plain-language texts for things that today only have a technical label (strategies, budgets, errors), in bokmål and English.
- Kroner in the simple view uses the price list the usage screens already use; where no price exists, the simple view says "ukjent kostnad" instead of falling back to tokens.
- The workspace is unaffected. External frontends see no difference, since nothing changes in the API.
