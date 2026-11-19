# 0063 A service's theme comes from Designsystemet

Status: proposed, 2026-11-19

Left: logos and images; fonts other than Inter; more than one theme per service; colours set by hand per token (the config's `overrides`); and themes for the portal, workspace and console. Each needs its own change.

## Context

genki's apps and `@genai/ui-blocks` use Designsystemet with its default theme. A hosted assistant (ADR 0061) needs to look like its service, as Kunnskapsassistenten does today with its own theme built by the Designsystemet CLI from `designsystemet.config.json` (accent `#0062BA`, neutral `#1E2B3C`, three brand colours, radius 4, Inter). ADR 0065 stores the layout in `spec.interface` and leaves the theme to this record.

How Designsystemet themes work (v1.24.0, 2026-11-09):

- A theme is configuration. Since v1.24 the CLI is one command, `npx @digdir/designsystemet -c designsystemet.config.json`, that reads a config file and builds what its `output` names; `tokens create` and `tokens build` still work but are deprecated. With `output: ["css"]` it builds the stylesheet straight from the config and writes no token files.
- A theme in the config has `colors` (names to hex values, `neutral` required), `borderRadius` (a number) and `typography.fontFamily`, and optionally `overrides` per semantic token. The config has a strict JSON schema shipped with the CLI (`dist/config.schema.json`); colour names must match `^[a-z0-9-]+$`, and the severity colours are filled in from defaults.
- The stylesheet is `--ds-*` custom properties in `@layer ds.theme.*`, loaded after `@digdir/designsystemet-css`. `data-color` picks one of the theme's colours for an element and its children, `data-color-scheme` is `light`, `dark` or `auto`, and `data-size` is `sm`, `md` or `lg`.
- The CLI does not check contrast when it builds. The theme builder (theme.designsystemet.no) shows WCAG levels and wants 3:1 for base colours against surfaces.
- The token JSON format is an implementation detail that Digdir says can change at any time.
- The package exports the build as a library too. Its `package.json` has no `main` and one code entry, `@digdir/designsystemet/internal`, which exports `validateConfig`, `parseConfig`, `formatThemeCSS` and `getContrastFromHex`. For `output: ["css"]` the CLI only calls `formatThemeCSS({ name, ...theme })` per theme and writes the result; `formatThemeCSS` returns `{ destination, output }` objects with the CSS as a string and touches no file or process. The subpath is named `internal` and is not documented as a stable API.

## Decision

- **A service's theme is a small Designsystemet config in its definition.** `spec.interface.theme`, beside ADR 0065's `layout`, holds one theme in the same shape a theme takes in `designsystemet.config.json`: `colors`, `borderRadius` and `typography.fontFamily`. An owner can paste the theme from the theme builder or from their own config file as it is. Without it, a hosted assistant uses Designsystemet's default theme, which is Digdir's.
- **genki checks it against the pinned schema, then narrows it.** The theme must pass the JSON schema of the CLI version genki pins, and genki's own rules on top:
  - `colors`: `accent` and `neutral` required, `brand1`, `brand2` and `brand3` optional, nothing else; each `#rrggbb`. Fixed names keep a layout's `data-color` values the same in every service.
  - `borderRadius`: a whole number from 0 to 24.
  - `typography.fontFamily`: `Inter`, the only value for now.
  - No `overrides`, no `output` and no theme name: genki sets those.
  - Beside the config, `colorScheme`: `light`, `dark` or `auto`, default `auto`, which the host sets on the page.
- **genki builds the stylesheet in process, with the library the CLI uses.** The API imports `formatThemeCSS` from `@digdir/designsystemet/internal`, at the exact version pinned in genki's `package.json`, and calls it with the service's theme under a name of its own (`service`), as the CLI does for `output: ["css"]`. No child process, temporary directory or file is involved, so ADR 0043's rule `no-code-execution-in-the-platform` holds with no exception. The CSS is stored in `interface_themes`, keyed by the SHA-256 of the theme and the package version, and served by a public, cacheable API route `GET /v1/themes/{hash}.css` (content-addressed and immutable, `Content-Type: text/css`, no tenant data beyond the CSS, a year's cache). The host's nginx proxies `/theme/` to it, so the page loads `/theme/{hash}.css` from its own origin and the host needs no database login.
- **Only the config is stored, never token JSON.** A version's stylesheet is built again from its config on first read after a package upgrade.
- **It is built at publish and validation.** `POST /definitions/validate` and a publish that changes the theme build it and check contrast.
- **genki checks contrast, since the CLI does not.** Each colour's base against the neutral surface must reach 3:1, and its text colour against its base 4.5:1, in light and dark, with the ratios from Designsystemet's specification. Below that the publish is refused with `theme-contrast` and the pair, and the portal shows the pairs as the theme builder does.
- **The host sets the attributes.** It loads Designsystemet's base CSS and then the service's stylesheet or the default, and sets `data-color-scheme` from the theme and the person's choice, `data-color="accent"` on the body and `data-size="md"`.

## Why

genki is config-first, and since v1.24 Designsystemet is too: a theme is a small config that one command turns into CSS. Storing that config in the definition gives the theme the draft, versions, environments and rollback the rest of the interface has (ADR 0065), uses a format owners already have from the theme builder, and leaves the colour maths, scales and dark mode to Designsystemet's own pipeline. The blocks keep working because they only read `--ds-*` properties.

Rejected:

- **One Digdir look for all.** Simplest, but a service's users should recognise their service; Kunnskapsassistenten already has its own colours.
- **Stored token JSON.** The format is not a contract, so a CLI upgrade could break stored themes, and every token takes any value. If owners come with tokens, the CLI's `generate-config-from-tokens` turns them back into a config that this record's rules then check.
- **Uploaded CSS.** It can hide or fake any part of the page, read attribute values out through `url()`, load tracking fonts and images, break forced colours, and cannot be reviewed. The CSP would also have to allow it.
- **The full config as owners write it.** Free colour names would make a layout's `data-color` mean different things per service. The CLI writes the font family straight into CSS, so free text is an injection risk; an allowlist is not. `overrides` set any token to any colour and skip the scales the contrast check relies on.
- **Running the CLI in a child process in the API.** ADR 0043 forbids `child_process` in the API, the worker and their packages, and the CLI adds nothing the library call does not do.
- **Building the theme in a worker job.** The same rule covers `apps/worker`, so a job would still have to call the library, and a publish would wait on a queue for a build of five colours.
- **Building in the browser.** The host would ship the CLI and its colour maths to every visitor, and the contrast check would not gate a publish.

## Consequences

- Kunnskapsassistenten's theme fits as its config has it: accent `#0062BA`, neutral `#1E2B3C`, brand1 `#F45F63`, brand2 `#E5AA20`, brand3 `#1E98F5`, radius 4, Inter. Its brand colours must pass the contrast check, or be adjusted, before it is published.
- The API carries `@digdir/designsystemet` as a production dependency, pinned to an exact version since its `internal` entry may change in any release. Upgrading it is a reviewed change, and a test builds every stored theme with the new version.
- A build runs on the API's event loop only at validation and publish, never on a read, and its input is bounded by the five colours above.
- Inter is served from the host's own origin; the host loads no font from a CDN.
- ADR 0065's `Left:` drops the theme on acceptance.
- Not built: all of it. Tests to come with it: "a service without a theme gets the default", "a theme pasted from the theme builder is accepted as it is", "a theme the pinned schema refuses is refused", "a colour name outside the five is refused", "a font family outside the allowlist is refused", "overrides are refused", "a colour below 3:1 against the surface is refused with the pair", "the stylesheet holds only custom properties, color-scheme and Designsystemet's layers", "the stylesheet matches what the pinned CLI builds from the same config", "no token JSON is stored".

## Sources

- Designsystemet CLI, v1.24.0: https://github.com/digdir/designsystemet/blob/v1.24.0/packages/cli/README.md
- Package exports and the library entry, v1.24.0: https://cdn.jsdelivr.net/npm/@digdir/designsystemet@1.24.0/package.json, https://cdn.jsdelivr.net/npm/@digdir/designsystemet@1.24.0/dist/src/internal.d.ts, and the CLI's `createCss` in https://cdn.jsdelivr.net/npm/@digdir/designsystemet@1.24.0/dist/bin/designsystemet.js
- Deprecated commands: https://github.com/digdir/designsystemet/blob/v1.24.0/packages/cli/bin/deprecated.ts
- Configuration schema: https://github.com/digdir/designsystemet/tree/v1.24.0/packages/cli/src/schemas
- CLI configuration: https://designsystemet.no/en/fundamentals/code/cli-config
- Setup and attributes: https://designsystemet.no/en/fundamentals/code/setup
- Your own theme: https://designsystemet.no/en/fundamentals/start-here/own-theme
- Theme builder and its contrast checks: https://theme.designsystemet.no, https://github.com/digdir/designsystemet/blob/main/apps/themebuilder/app/model/contrast.ts
- Default theme: https://github.com/digdir/designsystemet/blob/v1.24.0/designsystemet.config.json
