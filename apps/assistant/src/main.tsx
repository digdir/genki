import '@digdir/designsystemet-css';
import '@digdir/designsystemet-theme/digdir.css';
import '@genai/ui-blocks/styles.css';
import '@genai/ui-assembly/styles.css';
import './app.css';
import { LocaleProvider, storedPreference } from '@genai/i18n/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { hostnameOf } from './host';
import { browserLogin, type HostLogin } from './login';

const local = import.meta.env.DEV;
const url = new URL(window.location.href);
const send = window.fetch.bind(window);
const signIn = (login: HostLogin) =>
  browserLogin({
    ...login,
    fetch: send,
    storage: window.sessionStorage,
    location: () => new URL(window.location.href),
    navigate: (to) => window.location.assign(to),
    ...(local
      ? { endpoint: (to: string) => to.replace(/^http:\/\/localhost:\d+\//, '/api/') }
      : {}),
    uiLocales: () => document.documentElement.lang || 'nb',
  });
const language = storedPreference(window.localStorage);
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <LocaleProvider
        initialPreference={language.load()}
        detected={navigator.languages}
        onPreferenceChange={language.save}
      >
        <App
          hostname={hostnameOf(url, local ? import.meta.env.VITE_GENKI_HOST : undefined)}
          path={`${url.pathname}${url.search}`}
          signIn={signIn}
          fetcher={send}
        />
      </LocaleProvider>
    </StrictMode>,
  );
