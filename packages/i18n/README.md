# @genai/i18n

Typed translations and locale formatting for the platform. Locales are `nb` (default, the
source catalogue) and `en`. Adding `nn` means adding it to `locales` in `src/locale.ts`;
`tsc` then lists every catalogue that needs a nynorsk translation.

## Catalogues

Each app owns its catalogues under `src/i18n/`, one namespace per screen or area, so
parallel work does not touch the same file:

```
src/i18n/nb/chat.ts     export const chat = defineNamespace({ send: 'Send', ... });
src/i18n/en/chat.ts     export const chat = { send: 'Send', ... } satisfies Translation<typeof nbChat>;
src/i18n/index.ts       export const nb = defineCatalogue({ chat, table });
                        export const en = { chat: enChat, table: enTable } satisfies Translation<typeof nb>;
                        export const { useT, translator } = defineTranslations({ nb, en });
                        export type Key = MessageKey<typeof nb>;
```

A missing English key fails `tsc`. Add one test per app:

```ts
expect(catalogueProblems(nb, en)).toEqual([]);
```

It checks that every English value is non-empty, uses the same `{placeholders}` and
`<tags>` as bokmål, has no extra keys and no em-dashes.

## Message syntax

- `'Hei, {name}'`: numbers and dates passed as values are formatted for the locale.
- Plurals are objects chosen with `Intl.PluralRules` on `count`:
  `{ one: '{count} kilde', other: '{count} kilder' }`. `zero` is optional.
- Rich text: `'Les <link>vilkårene</link>'`, rendered with `t.rich`. `<br/>` self-closes.

## Converting a screen

```tsx
import { useFormat } from '@genai/i18n/react';
import { useT } from '../i18n';

const Sources = ({ sources, at }: Props) => {
  const t = useT();
  const f = useFormat();
  return (
    <section aria-label={t('chat.sourcesLabel')}>
      <Heading>{t('chat.sources', { count: sources.length })}</Heading>
      <p>{t('chat.updated', { when: f.dateTime(at) })}</p>
      <p>{t.rich('chat.terms', { link: (c) => <a href="/vilkar">{c}</a> })}</p>
    </section>
  );
};
```

Rules of thumb:

- Every user-facing string goes through `t`: text, `aria-label`, `title`, `placeholder`, alt
  text, error and empty states, toasts.
- Module-level label tables store keys typed `PlainKey<typeof nb>` (keys without params), so
  the component can call `t(view.label)`. Helpers outside components take `t` (and `f`) as arguments; type them
  with `ReturnType<typeof translator>` and `Format`.
- Never format with `'nb-NO'`. Use `useFormat()`: `date`, `time`, `dateTime`, `month`,
  `weekday`, `number`, `decimal`, `percent`, `currency` (kr / NOK), `relative`, `list`,
  `bytes`. Times are Oslo time; bokmål writes `kl. 10.05`, English `10:05`.
- `t` is bound to the locale of the render. In async handlers, read it from a ref
  (`const tRef = useRef(t); tRef.current = t;`) after an `await`.
- Tenant content (service names, field labels) is shown as authored. Do not translate it.
- Keep product names: Kudos, Altinn, Ansattporten, Maskinporten, Designsystemet. No
  em-dashes in any copy.

## Language state

Wrap the app in `LocaleProvider`:

```tsx
<LocaleProvider
  preference={preferences.language}
  detected={navigator.languages}
  onPreferenceChange={save}
>
```

The locale is the person's preference, else the detected list (browser or `ui_locales`),
else the surrounding provider, else `nb`. The provider sets `document.documentElement.lang`.
`LanguageChoice` is the "Språk / Language" radio group for a user menu; it reads and sets
the provider's preference. `storedPreference(localStorage)` keeps a preference in the
browser where there is no server-side store.

## Tests

Without a provider everything renders in bokmål, so tests that query Norwegian text keep
working. To test English: `render(inEnglish(<Screen />))` or `<InLocale locale="en">`.
Tests never pass `navigator.languages` (jsdom reports `en-US`).

## Server side

`negotiate(acceptLanguage)` picks a locale from `Accept-Language` or `ui_locales`.
`createTranslator(catalogues, locale)` gives the same `t` without React.
`createRetranslator(nb, { en }, 'en')` maps finished bokmål text, including filled
templates, to the target language; the API uses it to translate problem details at the
boundary.
