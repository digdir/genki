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

const local = import.meta.env.DEV;
const url = new URL(window.location.href);
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
          path={url.pathname}
          local={local}
        />
      </LocaleProvider>
    </StrictMode>,
  );
