import '@digdir/designsystemet-css';
import '@digdir/designsystemet-theme/digdir.css';
import '@genai/schema-forms/styles.css';
import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { mockAnsattporten } from './auth';
import { bffLogin } from './bff-login';
import { setting } from './runtime-config';
import { applyTheme, storedTheme } from './theme';

applyTheme(storedTheme());

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
const auth = mock
  ? mockAnsattporten({ name: 'Kari Nordmann', organisations: mock.exampleOrganisations }, 300)
  : bffLogin({
      fetch: send,
      navigate: (url) => window.location.assign(url),
      location: () => new URL(window.location.href),
      uiLocale: () => document.documentElement.lang,
    });
const root = document.getElementById('root');

if (root) {
  createRoot(root).render(
    <StrictMode>
      <App
        auth={auth}
        fetch={mock ? mock.mockFetch() : send}
        live
        languages={navigator.languages}
      />
    </StrictMode>,
  );
}
