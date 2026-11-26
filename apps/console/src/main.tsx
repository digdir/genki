import '@digdir/designsystemet-css';
import '@digdir/designsystemet-theme/digdir.css';
import '@genai/schema-forms/styles.css';
import './app.css';
import { resolveLocale } from '@genai/i18n';
import { LocaleProvider, storedPreference } from '@genai/i18n/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { bffLogin } from './bff-login';
import { setting } from './runtime-config';

const useMock = setting('API') === 'mock';
const language = storedPreference(window.localStorage, 'genai.console.language');
const send: typeof fetch = (input, init) => {
  const chosen = language.load();
  if (!chosen) return window.fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set('accept-language', chosen);
  return window.fetch(input, { ...init, headers });
};
const auth = useMock
  ? mockEntra({ name: 'Lise Dahl', roles: [operatorRole] }, 300)
  : bffLogin({
      fetch: send,
      navigate: (url) => window.location.assign(url),
      here: () => `${window.location.pathname}${window.location.search}${window.location.hash}`,
      locale: () => resolveLocale(document.documentElement.lang),
    });
const root = document.getElementById('root');
const apiFetch = async (): Promise<typeof fetch> =>
  useMock ? (await import('./mock')).mockFetch() : send;

if (root) {
  void apiFetch().then((fetch) =>
    createRoot(root).render(
      <StrictMode>
        <LocaleProvider
          initialPreference={language.load()}
          detected={navigator.languages}
          onPreferenceChange={language.save}
          title={{
            nb: 'Driftskonsoll – Fellesløsning for generativ KI',
            en: 'Operations console – Generative AI platform',
          }}
        >
          <App auth={auth} fetch={fetch} />
        </LocaleProvider>
      </StrictMode>,
    ),
  );
}
