// @vitest-environment jsdom
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { ansattportenLogin, codeChallenge, mockEntra, operatorRole } from './auth';
import { mockFetch } from './mock';

document.getAnimations ??= () => [];

const issuer = 'http://localhost:8080/mock/ansattporten';
const resource = 'urn:altinn:resource:digdir-genai-platform';

const encode = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const idToken = (name: string) => `${encode({ alg: 'none' })}.${encode({ name })}.sig`;

const notFound = () => new Response('404 Not Found', { status: 404 });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Extra = (path: string, init?: RequestInit) => Response | undefined;

const liveApi = (operator = true, extra?: Extra) => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    calls.push({ path, ...(init ? { init } : {}) });
    const extraReply = extra?.(path, init);
    if (extraReply) return extraReply;
    if (path === '/api/mock/ansattporten/token')
      return json({ access_token: 'access', id_token: idToken('Ola Drift'), token_type: 'Bearer' });
    if (path === '/api/operator/tenants' && init?.method === 'POST')
      return json({ orgNumber: '974760673', name: 'Brønnøysundregistrene' });
    if (path === '/api/operator/tenants/991825827/definitions')
      return json({
        data: [
          {
            kind: 'Service',
            id: 'klarsprak',
            name: 'Klarspråk',
            latestVersion: 2,
            publishedAt: '2026-10-02T10:00:00Z',
            publishedBy: 'employee:ansattporten:kari',
          },
        ],
      });
    const version = (n: number, instructions: string) => ({
      version: n,
      publishedBy: 'employee:ansattporten:kari',
      publishedAt: `2026-10-0${n}T10:00:00Z`,
      reason: n === 1 ? 'Første versjon' : 'Kortere svar',
      definition: {
        apiVersion: 'genai/v1',
        kind: 'Service',
        metadata: { tenant: '991825827', id: 'klarsprak', version: n },
        spec: { strategy: { id: 'single-call', config: { instructions } } },
      },
      files: {},
    });
    if (path === '/api/operator/tenants/991825827/definitions/services/klarsprak')
      return json({
        kind: 'Service',
        tenant: '991825827',
        id: 'klarsprak',
        latest: version(2, 'Svar kort.'),
        versions: [version(1, 'Svar langt.'), version(2, 'Svar kort.')].map(
          ({ definition: _d, files: _f, ...v }) => v,
        ),
      });
    if (path === '/api/operator/tenants/991825827/definitions/services/klarsprak/versions/1')
      return json(version(1, 'Svar langt.'));
    if (path === '/api/operator/tenants/991825827/definitions/services/klarsprak/versions/2')
      return json(version(2, 'Svar kort.'));
    if (path === '/api/operator/tenants')
      return operator
        ? json({
            data: [
              {
                orgNumber: '991825827',
                name: 'Digitaliseringsdirektoratet',
                status: 'active',
                services: 2,
                quotaUsedPercent: 0,
              },
            ],
          })
        : json({ title: 'Forbidden' }, 403);
    if (path === '/api/operator/tracing') return json({ enabled: false, source: 'environment' });
    if (path === '/api/operator/running-tasks') return json({ data: [] });
    if (path === '/api/health') return json({ status: 'ok', version: 'dev' });
    return notFound();
  };
  return { calls, fetch };
};

const memoryStorage = (): Storage => {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
};

const client = (fetch: typeof globalThis.fetch, storage = memoryStorage()) => {
  const visited: string[] = [];
  const auth = ansattportenLogin({
    issuer,
    clientId: 'local-console',
    redirectUri: 'http://localhost:5174/callback',
    postLogoutRedirectUri: 'http://localhost:5174/',
    tokenEndpoint: '/api/mock/ansattporten/token',
    apiBaseUrl: '/api',
    audience: 'digdir:genai',
    resource,
    fetch,
    storage,
    navigate: (url) => visited.push(url),
  });
  return { auth, visited, storage };
};

const startLogin = async (c: ReturnType<typeof client>) => {
  const before = c.visited.length;
  void c.auth.login();
  await waitFor(() => expect(c.visited.length).toBeGreaterThan(before));
  return new URL(c.visited.at(-1) ?? '');
};

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.location.hash = '';
});
afterEach(cleanup);

describe('operator login with Ansattporten', () => {
  it('starts the code flow with PKCE, the platform audience and the Altinn resource', async () => {
    const c = client(liveApi().fetch);
    const url = await startLogin(c);

    expect(url.origin + url.pathname).toBe(`${issuer}/authorize`);
    const q = url.searchParams;
    expect(q.get('client_id')).toBe('local-console');
    expect(q.get('redirect_uri')).toBe('http://localhost:5174/callback');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('resource')).toBe('digdir:genai');
    expect(JSON.parse(q.get('authorization_details') ?? '')).toEqual([
      { type: 'ansattporten:altinn:resource', resource },
    ]);
    const pending = JSON.parse(c.storage.getItem('console.login') ?? '{}') as {
      verifier: string;
      state: string;
    };
    expect(q.get('state')).toBe(pending.state);
    expect(q.get('code_challenge')).toBe(await codeChallenge(pending.verifier));
  });

  it('exchanges the code with the verifier and opens the console for an operator', async () => {
    const api = liveApi();
    const c = client(api.fetch);
    const state = (await startLogin(c)).searchParams.get('state') ?? '';
    window.history.replaceState(null, '', `/callback?code=abc&state=${state}&iss=${issuer}`);

    render(<App auth={c.auth} fetch={api.fetch} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Virksomheter' })).toBeTruthy();
    expect(screen.getByText('Ola Drift')).toBeTruthy();
    expect(window.location.pathname).toBe('/');
    const token = api.calls.find((call) => call.path === '/api/mock/ansattporten/token');
    const body = new URLSearchParams(String(token?.init?.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBeTruthy();
    expect(body.get('client_id')).toBe('local-console');
  });

  it('refuses a person the API does not treat as an operator', async () => {
    const api = liveApi(false);
    const c = client(api.fetch);
    const state = (await startLogin(c)).searchParams.get('state') ?? '';
    window.history.replaceState(null, '', `/callback?code=abc&state=${state}`);

    render(<App auth={c.auth} fetch={api.fetch} />);

    expect(
      await screen.findByRole('heading', { name: 'Du har ikke tilgang til driftskonsollet' }),
    ).toBeTruthy();
    expect(screen.getByText(/Du er logget inn som Ola Drift/)).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('rejects a callback whose state does not match', async () => {
    const api = liveApi();
    const c = client(api.fetch);
    await startLogin(c);
    window.history.replaceState(null, '', '/callback?code=abc&state=wrong');

    render(<App auth={c.auth} fetch={api.fetch} />);

    expect((await screen.findByRole('alert')).textContent).toMatch(/kunne ikke fullføres/);
    expect(api.calls.some((call) => call.path === '/api/mock/ansattporten/token')).toBe(false);
  });

  it('takes the authorize and end-session endpoints from the identity provider metadata', async () => {
    const api = liveApi();
    const withMetadata: typeof fetch = async (input, init) =>
      String(input) === `${issuer}/.well-known/openid-configuration`
        ? Response.json({
            issuer,
            authorization_endpoint: 'https://login.example/authorize',
            end_session_endpoint: 'https://login.example/logout',
          })
        : api.fetch(input, init);
    const c = client(withMetadata);
    const url = await startLogin(c);
    expect(url.origin + url.pathname).toBe('https://login.example/authorize');

    await c.auth.logout();
    expect(c.visited.at(-1)).toMatch('https://login.example/logout?client_id=local-console');
  });

  it('treats a 404 from the operator routes as no operator role', async () => {
    const api = liveApi();
    const notOperator: typeof fetch = async (input, init) =>
      String(input).endsWith('/operator/tenants')
        ? new Response('Not found', { status: 404 })
        : api.fetch(input, init);
    const c = client(notOperator);
    const state = (await startLogin(c)).searchParams.get('state') ?? '';
    await c.auth.completeLogin?.(new URL(`http://localhost:5174/callback?code=a&state=${state}`));
    expect(c.auth.current()?.roles).toEqual([]);
  });

  it('clears the session on logout and sends the browser to the end-session endpoint', async () => {
    const api = liveApi();
    const c = client(api.fetch);
    const state = (await startLogin(c)).searchParams.get('state') ?? '';
    await c.auth.completeLogin?.(new URL(`http://localhost:5174/callback?code=a&state=${state}`));
    expect(c.auth.current()?.roles).toEqual([operatorRole]);

    render(<App auth={c.auth} fetch={api.fetch} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Logg ut' }));

    expect(await screen.findByRole('button', { name: 'Logg inn med Digdir-konto' })).toBeTruthy();
    expect(c.auth.current()).toBeUndefined();
    expect(c.storage.getItem('console.session')).toBeNull();
    expect(c.visited.at(-1)).toMatch(`${issuer}/logout?client_id=local-console`);
  });

  it('keeps the fake login in mock mode', async () => {
    render(
      <App auth={mockEntra({ name: 'Lise Dahl', roles: [operatorRole] })} fetch={mockFetch()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Logg inn med Digdir-konto' }));
    expect(await screen.findByText('Lise Dahl')).toBeTruthy();
  });
});

const openLive = async (path: string, extra?: Extra) => {
  const auth = mockEntra({ name: 'Ola Drift', roles: [operatorRole] });
  await auth.login();
  window.location.hash = path;
  const api = liveApi(true, extra);
  render(<App auth={auth} fetch={api.fetch} live />);
  return api;
};

describe('live mode without invented data', () => {
  it('shows the real tracing status, says connecting tools is not available yet, and no example tools', async () => {
    await openLive('#/tracing');

    expect(await screen.findByRole('heading', { name: 'Plattformens sporing' })).toBeTruthy();
    expect(screen.getByText('Ikke tilgjengelig ennå')).toBeTruthy();
    expect(screen.queryByText('Arize Phoenix')).toBeNull();
    expect(screen.queryByText('Rapportassistenten')).toBeNull();
  });

  it('shows the real tokens and cost of the month when the API reports them', async () => {
    await openLive('#/tenants', (path) =>
      path === '/api/operator/usage'
        ? json({
            data: [
              {
                orgNumber: '991825827',
                usage: { inputTokens: 1_500_000, outputTokens: 300_000, costMicroNok: 3_410_000 },
              },
            ],
          })
        : undefined,
    );

    const row = (await screen.findByText('Digitaliseringsdirektoratet')).closest(
      'tr',
    ) as HTMLElement;
    expect(within(row).getByText(/3,41 kr/)).toBeTruthy();
    expect(within(row).getByText(/1,8 mill\./)).toBeTruthy();
    expect(within(row).queryByText('Ikke tilgjengelig')).toBeNull();
  });

  it('says Ikke tilgjengelig for usage the API does not report, and names the month', async () => {
    await openLive('#/tenants');

    const row = (await screen.findByText('Digitaliseringsdirektoratet')).closest(
      'tr',
    ) as HTMLElement;
    expect(within(row).getAllByText('Ikke tilgjengelig')).toHaveLength(2);
    expect(within(row).queryByText(/0 % av kvoten|0 kr/)).toBeNull();
    const month = new Intl.DateTimeFormat('nb-NO', {
      month: 'long',
      timeZone: 'Europe/Oslo',
    }).format(new Date());
    const tokens = screen.getByText(`Tokens i ${month}`, { selector: ':not(th)' });
    expect(tokens.parentElement?.textContent).toContain('Ikke tilgjengelig');
    expect(screen.queryByText(/0,0 mill\./)).toBeNull();
  });

  it('registers a tenant through the platform without onboarding requests', async () => {
    const api = await openLive('#/onboarding');

    fireEvent.change(await screen.findByRole('textbox', { name: 'Organisasjonsnummer' }), {
      target: { value: '974760673' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Navn på virksomheten' }), {
      target: { value: 'Brønnøysundregistrene' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /Begrunnelse/ }), {
      target: { value: 'Avtale signert' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Registrer' }));

    expect(await screen.findByText(/Brønnøysundregistrene er registrert/)).toBeTruthy();
    const post = api.calls.find(
      (c) => c.path === '/api/operator/tenants' && c.init?.method === 'POST',
    );
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      orgNumber: '974760673',
      name: 'Brønnøysundregistrene',
    });
    expect(new Headers(post?.init?.headers).get('change-reason')).toBe('Avtale%20signert');
    expect(api.calls.some((c) => /^\/api\/operator\/onboarding($|\?|\/\d)/.test(c.path))).toBe(
      false,
    );
    expect(screen.queryByRole('button', { name: 'Send forespørselen' })).toBeNull();
  });

  it("shows a tenant's services and the YAML of each version", async () => {
    await openLive('#/tenants/services?tenant=991825827&kind=service&id=klarsprak');

    expect(await screen.findByText('Klarspråk')).toBeTruthy();
    expect(await screen.findByText('Kortere svar')).toBeTruthy();
    expect((await screen.findByLabelText('Versjon 2 som YAML')).textContent).toContain(
      'instructions: Svar kort.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Vis YAML, versjon 1' }));
    expect((await screen.findByLabelText('Versjon 1 som YAML')).textContent).toContain(
      'Svar langt.',
    );
  });

  it('falls back to API health on Drift when the API has no operations overview', async () => {
    const api = await openLive('#/operations');

    expect(await screen.findByText(/API-et svarer/)).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/api/operator/operations')).toBe(true);
  });

  it('shows the operations overview from the API, with a dash where it reports no number', async () => {
    await openLive('#/operations', (path) =>
      path === '/api/operator/operations'
        ? json({
            incidents: [],
            components: [
              { name: 'API', status: 'normal' },
              { name: 'Innlesing', status: 'degraded', errorRate: '50 %' },
            ],
            queueStats: [{ label: 'Innlesinger som kjører', value: '1' }],
            queue: [
              {
                type: 'Innlesing',
                what: 'Nettsider · nettsider · Digitaliseringsdirektoratet',
                status: 'running',
                age: '3 min',
                at: '2026-10-08T10:00:00Z',
              },
            ],
            triggers: [
              {
                tenant: 'Digitaliseringsdirektoratet',
                what: 'Planlagt innlesing: Nettsider · nettsider',
                error: 'sitemap svarte 503',
                failedAt: '2026-10-08T03:00:00Z',
              },
            ],
          })
        : undefined,
    );

    const rates = await screen.findByRole('region', { name: 'Feilrate siste time' });
    expect(within(rates).getByText('50 %')).toBeTruthy();
    expect(within(rates).getByText('Høyt')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Innlesing svarer tregt' })).toBeTruthy();
    expect(screen.getByText('Nettsider · nettsider · Digitaliseringsdirektoratet')).toBeTruthy();
    expect(screen.getByText('sitemap svarte 503')).toBeTruthy();
    expect(screen.getByText(/Siste vellykkede: aldri/)).toBeTruthy();
    expect(screen.queryByText(/API-et svarer/)).toBeNull();
  });

  it('shows approved access requests on Oppstart and leaves pending ones to Til behandling', async () => {
    const approved = {
      id: 'req-1',
      org: '974760673',
      orgName: 'Brønnøysundregistrene',
      contactName: 'Ida Moe',
      requestedBy: 'Ida Moe',
      requestedAt: '2026-10-07T08:00:00Z',
      status: 'approved',
      terms: { accepted: true, version: 'utkast', at: '2026-10-07T08:00:00Z' },
      decision: { by: 'operator:entra:ola', at: '2026-10-08T09:00:00Z', reason: 'ok' },
    };
    const waiting = {
      id: 'req-2',
      org: '991825827',
      orgName: 'Digdir',
      contactName: 'Ola Nordmann',
      requestedAt: '2026-10-07T08:00:00Z',
      status: 'pending',
    };
    await openLive('#/onboarding', (path) =>
      path === '/api/operator/onboarding/requests'
        ? json({ data: [approved, waiting] })
        : undefined,
    );

    const card = await screen.findByRole('article', { name: 'Brønnøysundregistrene' });
    expect(within(card).getByText(/kontaktperson Ida Moe/)).toBeTruthy();
    expect(within(card).getAllByRole('listitem')[0]?.textContent).toMatch(/ola, Digdir/);
    expect(screen.queryByRole('article', { name: 'Digdir' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Registrer virksomhet' })).toBeTruthy();
  });

  it('names the operator of a support session instead of showing the id', async () => {
    await openLive('#/support-access', (path) =>
      path === '/api/operator/support-sessions'
        ? json({
            data: [
              {
                id: 's1',
                operator: 'operator:entra:9f2c',
                operatorName: 'Ola Drift',
                tenant: '991825827',
                reason: 'Feilsøking av sak DIG-1',
                openedAt: '2026-10-08T09:00:00Z',
                expiresAt: '2026-10-08T09:30:00Z',
                status: 'expired',
              },
            ],
          })
        : undefined,
    );

    expect(await screen.findByText('Ola Drift', { selector: 'strong' })).toBeTruthy();
    expect(screen.queryByText('9f2c')).toBeNull();
  });

  it('turns a missing endpoint into a not-available notice rather than an error', async () => {
    await openLive('#/quality-matrix');

    expect(await screen.findByText('Ikke tilgjengelig ennå')).toBeTruthy();
    expect(screen.queryByText('Kunne ikke hente dataene')).toBeNull();
  });
});

describe('sidebar', () => {
  it('marks Kvalitetsmatrise og dommere as the current page on every tab of the matrix', async () => {
    await openLive('#/quality-matrix?tab=judges');
    const menu = screen.getByRole('navigation', { name: 'Konsollmeny' });

    expect(
      within(menu)
        .getByRole('link', { name: 'Kvalitetsmatrise og dommere' })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(within(menu).queryByRole('link', { name: 'Dommere' })).toBeNull();
  });

  it('stretches the sidebar and its border to the full page height', () => {
    const rule = (selector: string) =>
      new RegExp(`(^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`).exec(
        readFileSync(`${import.meta.dirname}/app.css`, 'utf8'),
      )?.[2] ?? '';

    expect(rule('.sidebar')).toMatch(/align-self: stretch/);
    expect(rule('.sidebar')).toMatch(/border-right/);
    expect(rule('.sidebar')).not.toMatch(/max-height|position: sticky/);
    expect(rule('.sidebar-inner')).toMatch(/position: sticky/);
  });
});
