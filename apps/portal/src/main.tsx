import '@digdir/designsystemet-css';
import '@digdir/designsystemet-theme/digdir.css';
import '@genai/schema-forms/styles.css';
import './app.css';
import { resolveLocale } from '@genai/i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { localDevLogin, mockAnsattporten } from './auth';
import { setting } from './runtime-config';
import { ansattporten, organisationsFromApi } from './oidc';

const reloadedFor = 'genki:reloaded-for';
window.addEventListener('vite:preloadError', (event) => {
  try {
    if (window.sessionStorage.getItem(reloadedFor) === import.meta.url) return;
    window.sessionStorage.setItem(reloadedFor, import.meta.url);
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

const mock = setting('API') === 'mock' ? await import('./mock') : undefined;
const send = window.fetch.bind(window);
const locale = () => resolveLocale(document.documentElement.lang);
const configuredIssuer = setting('ANSATTPORTEN_ISSUER');
const issuer = configuredIssuer ?? 'http://localhost:8080/mock/ansattporten';
const auth = mock
  ? mockAnsattporten({ name: 'Kari Nordmann', organisations: mock.exampleOrganisations }, 300)
  : ansattporten({
      issuer,
      clientId: setting('OIDC_CLIENT_ID') ?? 'local-portal',
      redirectUri: `${window.location.origin}/callback`,
      audience: setting('API_AUDIENCE') ?? 'digdir:genai',
      altinnResource: setting('ALTINN_RESOURCE') ?? 'urn:altinn:resource:digdir-genai-platform',
      fetch: send,
      storage: window.sessionStorage,
      location: () => new URL(window.location.href),
      navigate: (url) => window.location.assign(url),
      replace: (url) => window.history.replaceState(null, '', url),
      endpoint: (url) => url.replace(/^http:\/\/localhost:\d+\//, '/api/'),
      organisations: organisationsFromApi(send, '/api'),
      ...(configuredIssuer ? {} : { fallback: localDevLogin(send) }),
      uiLocales: locale,
    });
const root = document.getElementById('root');

if (root) {
  createRoot(root).render(
    <StrictMode>
      <App
        auth={auth}
        fetch={mock ? mock.mockFetch() : send}
        live={!mock}
        languages={navigator.languages}
      />
    </StrictMode>,
  );
}
