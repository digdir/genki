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
import { ansattporten } from './oidc';

const useMock = import.meta.env.VITE_API === 'mock';
const send = window.fetch.bind(window);
const locale = () => resolveLocale(document.documentElement.lang);
const issuer =
  (import.meta.env.VITE_ANSATTPORTEN_ISSUER as string | undefined) ??
  'http://localhost:8080/mock/ansattporten';
const auth = useMock
  ? mockAnsattporten({ name: 'Kari Nordmann', organisations: exampleOrganisations }, 300)
  : ansattporten({
      issuer,
      clientId: 'local-portal',
      redirectUri: `${window.location.origin}/callback`,
      audience: 'digdir:genai',
      altinnResource: 'urn:altinn:resource:digdir-genai-platform',
      fetch: send,
      storage: window.sessionStorage,
      location: () => new URL(window.location.href),
      navigate: (url) => window.location.assign(url),
      replace: (url) => window.history.replaceState(null, '', url),
      endpoint: (url) => url.replace(/^http:\/\/localhost:\d+\//, '/api/'),
      fallback: localDevLogin(send),
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
