import '@digdir/designsystemet-css';
import '@digdir/designsystemet-theme/digdir.css';
import '@genai/schema-forms/styles.css';
import './app.css';
import { resolveLocale } from '@genai/i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { localDevLogin, mockAnsattporten } from './auth';
import { exampleOrganisations, mockFetch } from './mock';
import { setting } from './runtime-config';
import { ansattporten } from './oidc';

const useMock = setting('API') === 'mock';
const send = window.fetch.bind(window);
const locale = () => resolveLocale(document.documentElement.lang);
const configuredIssuer = setting('ANSATTPORTEN_ISSUER');
const issuer = configuredIssuer ?? 'http://localhost:8080/mock/ansattporten';
const auth = useMock
  ? mockAnsattporten({ name: 'Kari Nordmann', organisations: exampleOrganisations }, 300)
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
      ...(configuredIssuer ? {} : { fallback: localDevLogin(send) }),
      uiLocales: locale,
    });
const root = document.getElementById('root');

if (root) {
  createRoot(root).render(
    <StrictMode>
      <App
        auth={auth}
        fetch={useMock ? mockFetch() : send}
        live={!useMock}
        languages={navigator.languages}
      />
    </StrictMode>,
  );
}
