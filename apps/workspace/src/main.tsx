import '@digdir/designsystemet-css';
import '@digdir/designsystemet-theme/digdir.css';
import '@genai/ui-blocks/styles.css';
import './app.css';
import { resolveLocale } from '@genai/i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createWorkspaceApi } from './api';
import { App } from './App';
import { mockLogin } from './auth';
import { bffLogin } from './bff-login';
import {
  caseworker,
  exampleConversation,
  exampleDraft,
  mockApprovalsApi,
  mockWorkspaceApi,
} from './mock';
import { createProjectsApi } from './projects-api';
import { setting } from './runtime-config';
import { mockProjectsApi } from './projects-mock';

const useMock = setting('API') === 'mock';
const send = window.fetch.bind(window);
const locale = () => resolveLocale(document.documentElement.lang);
const auth = useMock
  ? mockLogin(caseworker, 300)
  : bffLogin({
      fetch: send,
      navigate: (url) => window.location.assign(url),
      location: () => new URL(window.location.href),
      locale,
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
