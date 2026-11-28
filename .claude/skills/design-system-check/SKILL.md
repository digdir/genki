---
name: design-system-check
description: Check that frontend code uses Designsystemet's components and tokens instead of hand-rolled elements, widgets and hard-coded values, and suggest the component to use with a link to its docs. Use when asked to check, audit or quality-assure components, before a pull request that touches .tsx or .css in apps/*/src or packages/ui-*, or when asked "bruker vi designsystemet riktig?".
---

# Design system check

genki builds every screen on Designsystemet (`@digdir/designsystemet-react` and `-css`, Digdir's theme, Aksel icons). This check finds the places where the code builds by hand something Designsystemet already has, and says what to use instead, with the link to its docs. It quality-assures; it does not rewrite on its own.

## Rules it checks against

These are the rules. A rules file the user keeps wins over this list when they disagree.

- How genki uses Designsystemet: Designsystemet first, with the component's own `variant`, `data-color` and `data-size` before own CSS; say so when you deviate, and why; tokens, never fixed values (`--ds-size-*`, `--ds-font-*`, `--ds-color-*`); lines are `Divider` or the border tokens; low density (`data-size="sm"`, `xs` on small controls); icons from `@navikt/aksel-icons`. If the user keeps their own design rules file, read that too.
- The tests that already hold part of this in `packages/ui-blocks/src`: `styles.test.ts`, `inline-colours.test.ts`, `corners-css.test.ts`. What they enforce is not a finding here unless the code is outside what they cover (the apps, for instance).
- The installed version: `node_modules/@digdir/designsystemet-react/package.json`. Only suggest a component that version exports. `EXPERIMENTAL_` components may be suggested, marked as experimental.

## 1. Find candidates

Run the scanner. It is deliberately noisy: it lists candidates, never verdicts.

```sh
node .claude/skills/design-system-check/scan.mjs            # the change: lines touched since origin/main, plus uncommitted
node .claude/skills/design-system-check/scan.mjs <paths…>   # files or folders the user named
node .claude/skills/design-system-check/scan.mjs --all      # every apps/*/src and packages/*/src
node .claude/skills/design-system-check/scan.mjs --all --summary   # one line per file, most candidates first
```

Default to the change. Use paths or `--all` only when the user asks for a folder or the whole repository. On `--all`, start with `--summary` and ask which area to go through, or take the area with most candidates first; do not read thousands of lines into the conversation.

A line marked `ds-ok: <reason>` (on the line or the line above) is a deviation someone has already explained, and the scanner skips it.

## 2. Judge each candidate

Open the code around each candidate and decide. Keep a finding only when Designsystemet has a component or token that does the job and the code does not use it. Drop it when:

- the raw element is already inside a Designsystemet component on purpose: `<a>` under `<Link asChild>` or `<Button asChild>`, `<input>` under `<Field>` styled by `ds-input`, `<ul>` that is a `List` rendered with `asChild`;
- the element has no visual role: a `<label>` that is visually hidden, a `<p>` inside text rendered from markdown, a `<table>` in rendered model output that gets Designsystemet's look from a parent class;
- the value is not a design value: `0`, `1px` hairlines inside a component that uses border tokens for colour, layout widths and grid tracks (widths divisible by 8, not tokens), `100%`;
- a class name only sounds like a component (`card` as a data word, `menu` in a route name).

When you are unsure, look at how the same thing is done elsewhere: `git grep` the component name in `packages/ui-blocks/src` and `apps/portal/src`. A pattern the codebase already solves with a component is strong evidence.

Also look for what the scanner cannot see: a `div` with click handlers acting as a button, a hand-built tab bar or segmented control made of buttons with `aria-pressed`, an error list at the top of a form that is not an `ErrorSummary`, a loading state that is text instead of `Spinner` or `Skeleton`, chips in a vertical list that should be radio buttons (Designsystemet's own guidance), and a component styled with local CSS where a `variant`, `data-color` or `data-size` would do it.

## 3. Report

Group by file. Each finding has:

- `file:line` as a link;
- what the code does now, in a few words;
- what to use instead: the component (with the variant or prop, when it matters) or the token, and the docs link from the scanner, `https://designsystemet.no/no/components/docs/<component>/overview`, or the tokens page for a value;
- how sure you are: **Bør byttes** (Designsystemet clearly covers it), **Vurder** (it probably fits, but the custom version may do something the component does not), or **Avvik uten begrunnelse** (a deliberate-looking deviation with no `ds-ok` or comment saying why).

End with a count per kind and the two or three changes that would give most consistency for least work. Write the report in the language the user writes in.

If a deviation is really a theme choice (corner radius, a colour, a size used everywhere), say that, and suggest changing it in the theme or as a shared `--genai-*` variable, not one component at a time.

## 4. Offer to fix

Do not edit while checking. After the report, ask once which findings to fix. When the user says yes:

- make the change in genki (frontend belongs in `packages/ui-blocks`, `packages/ui-assembly`, `packages/i18n` or the app), never in a vendored copy;
- keep behaviour: accessible names, test ids the tests use, keyboard behaviour; a Testing Library test that found the element by role must still pass;
- remove the CSS the component made unnecessary;
- for a deviation that stays, add `ds-ok: <why>` so the next check skips it and the reason is written down;
- run only the tests for the files you touched (`npx vitest run <paths>`), and `npx eslint <files>`.

When Designsystemet has nothing that fits and the same hand-built thing appears in more than one place, suggest making it one block in `packages/ui-blocks`, built from Designsystemet parts and tokens, and offer to build it.
