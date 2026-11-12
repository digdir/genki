## What and why

<!-- One or two sentences: what changes, and why. Link the issue if there is one. -->

## Risk

<!-- Low, or sensitive because it touches: auth, tenancy, the model gate, personal data, migrations, infra or workflows. -->

## Undo

<!-- Revert is enough, or it needs a data step or an infra step: say which. -->

## How it was tested

<!-- Commands you ran and what you checked by hand. Name the tests that state any new rule. -->

- [ ] `npm run check` passes

## Checklist

- [ ] Every new rule has a test whose name states it
- [ ] User-facing text is in the i18n catalogues, in bokmål and English, with no em-dashes
- [ ] Vendor SDKs stay in `packages/providers-*`
- [ ] ADRs, docs and `docs/architecture/modules` are updated if a contract, boundary or module changed
- [ ] No secrets, personal data or local paths
