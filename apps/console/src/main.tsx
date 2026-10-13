import '@digdir/designsystemet-css';
import '@digdir/designsystemet-theme/digdir.css';
import '@genai/schema-forms/styles.css';
import './app.css';
import { resolveLocale } from '@genai/i18n';
import { LocaleProvider, storedPreference } from '@genai/i18n/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ansattportenLogin, mockEntra, operatorRole } from './auth';
import { mockFetch } from './mock';

const useMock = import.meta.env.VITE_API === 'mock';
const language = storedPreference(window.localStorage, 'genai.console.language');
const send: typeof fetch = (input, init) => {
  const chosen = language.load();
  if (!chosen) return window.fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set('accept-language', chosen);
  return window.fetch(input, { ...init, headers });
};
const origin = window.location.origin;
const auth = useMock
  ? mockEntra({ name: 'Lise Dahl', roles: [operatorRole] }, 300)
  : ansattportenLogin({
      issuer: import.meta.env.VITE_OIDC_ISSUER ?? 'http://localhost:8080/mock/ansattporten',
      clientId: import.meta.env.VITE_OIDC_CLIENT_ID ?? 'local-console',
      redirectUri: `${origin}/callback`,
      postLogoutRedirectUri: `${origin}/`,
      tokenEndpoint: import.meta.env.VITE_OIDC_TOKEN_ENDPOINT ?? '/api/mock/ansattporten/token',
      apiBaseUrl: '/api',
      audience: import.meta.env.VITE_API_AUDIENCE ?? 'digdir:genai',
      resource: import.meta.env.VITE_ALTINN_RESOURCE ?? 'urn:altinn:resource:digdir-genai-platform',
      fetch: send,
      storage: window.sessionStorage,
      navigate: (url) => window.location.assign(url),
      locale: () => resolveLocale(document.documentElement.lang),
    });
const root = document.getElementById('root');

if (root) {
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
        <App auth={auth} fetch={useMock ? mockFetch() : send} live={!useMock} />
      </LocaleProvider>
    </StrictMode>,
  );
}
