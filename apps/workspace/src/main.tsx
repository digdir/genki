import '@digdir/designsystemet-css';
import '@digdir/designsystemet-theme/digdir.css';
import './app.css';
import { resolveLocale } from '@genai/i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createWorkspaceApi } from './api';
import { App } from './App';
import { localDevLogin, mockLogin } from './auth';
import {
  caseworker,
  exampleConversation,
  exampleDraft,
  mockApprovalsApi,
  mockWorkspaceApi,
} from './mock';
import { ansattporten } from './oidc';
import { createProjectsApi } from './projects-api';
import { setting } from './runtime-config';
import { mockProjectsApi } from './projects-mock';

const useMock = setting('API') === 'mock';
const send = window.fetch.bind(window);
const locale = () => resolveLocale(document.documentElement.lang);
const configuredIssuer = setting('ANSATTPORTEN_ISSUER');
const issuer = configuredIssuer ?? 'http://localhost:8080/mock/ansattporten';
const auth = useMock
  ? mockLogin(caseworker, 300)
  : ansattporten({
      issuer,
      clientId: setting('OIDC_CLIENT_ID') ?? 'local-workspace',
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
const api = useMock
  ? mockWorkspaceApi(400)
  : createWorkspaceApi({
      baseUrl: '/api',
      fetch: send,
      token: () => auth.current()?.token,
      locale,
    });
const projects = useMock
  ? mockProjectsApi({ delayMs: 300 })
  : createProjectsApi({
      baseUrl: '/api',
      fetch: send,
      token: () => auth.current()?.token,
      actorName: () => auth.current()?.name,
      locale,
    });
const root = document.getElementById('root');

if (root) {
  createRoot(root).render(
    <StrictMode>
      <App
        auth={auth}
        api={api}
        projects={projects}
        languages={navigator.languages}
        {...(useMock
          ? {
              approvals: mockApprovalsApi(),
              draft: exampleDraft,
              initialMessages: exampleConversation,
            }
          : {})}
      />
    </StrictMode>,
  );
}
