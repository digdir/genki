// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LocaleProvider } from '@genai/i18n/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { hostnameOf, inLanguage, isPageLink } from './host';
import { browserLogin, type HostLogin } from './login';

document.getAnimations ??= () => [];

const view = {
  hostname: 'ka.example.no',
  tenant: '991825827',
  service: 'klarsprak',
  environment: 'prod',
  name: { nb: 'Klarspråkassistenten', en: 'The plain language assistant' },
  login: {
    issuer: 'https://login.example.no',
    clientId: 'klarsprak-host',
    audience: 'aud-ka',
    altinnResource: 'urn:altinn:resource:ka',
  },
  menu: [
    { label: 'Om', page: 'om' },
    { label: { nb: 'Hjelp', en: 'Help' }, href: 'https://example.no/hjelp' },
  ],
  pages: [{ id: 'om', title: 'Om tjenesten' }],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const genki =
  (routes: Record<string, () => Response>): typeof fetch =>
  async (input) =>
    (routes[String(input)] ?? (() => json({ code: 'host_not_found' }, 404)))();

const memory = () => {
  const kept = new Map<string, string>();
  return {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  };
};

const jwt = (claims: Record<string, unknown>) =>
  `x.${btoa(JSON.stringify(claims)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}.x`;

const browser = (at = 'https://ka.example.no/') => {
  const went: string[] = [];
  const storage = memory();
  const location = { url: new URL(at) };
  const signIn = (login: HostLogin) =>
    browserLogin({
      ...login,
      fetch: (input, init) => globalThis.fetch(input, init),
      storage,
      location: () => location.url,
      navigate: (to) => went.push(to),
    });
  return { went, storage, location, signIn };
};

const draw = (
  path: string,
  fetcher: typeof fetch,
  locale: 'nb' | 'en' = 'nb',
  signIn = browser().signIn,
) =>
  render(
    <LocaleProvider preference={locale}>
      <App hostname="ka.example.no" path={path} signIn={signIn} fetcher={fetcher} />
    </LocaleProvider>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the assistant host', () => {
  it('draws the service’s name and menu, and a sign-in button', async () => {
    draw('/', genki({ '/api/v1/hosts/ka.example.no': () => json(view) }));

    const name = await screen.findByRole('link', { name: 'Klarspråkassistenten' });
    expect(name.getAttribute('href')).toBe('/');
    const menu = screen.getByRole('navigation', { name: 'Meny' });
    expect(menu.querySelector('a[href="/om"]')?.textContent).toBe('Om');
    const help = screen.getByRole('link', { name: 'Hjelp' });
    expect(help.getAttribute('target')).toBe('_blank');
    expect(help.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('button', { name: 'Logg inn' })).toBeTruthy();
  });

  it('offers no sign-in where genki names no issuer', async () => {
    const without = { ...view, login: { ...view.login, issuer: null } };
    draw('/', genki({ '/api/v1/hosts/ka.example.no': () => json(without) }));

    expect(await screen.findByText('Innlogging er ikke satt opp her.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Logg inn' })).toBeNull();
  });

  it('follows the person’s language in the service’s texts', async () => {
    draw('/', genki({ '/api/v1/hosts/ka.example.no': () => json(view) }), 'en');

    expect(await screen.findByRole('link', { name: 'The plain language assistant' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Help' })).toBeTruthy();
  });

  it('says there is no assistant on a hostname genki does not know', async () => {
    draw('/', genki({}));

    expect(
      await screen.findByRole('heading', { name: 'Her er det ingen assistent.' }),
    ).toBeTruthy();
  });

  it('draws a page from the menu as Markdown, with raw HTML as text', async () => {
    draw(
      '/om',
      genki({
        '/api/v1/hosts/ka.example.no': () => json(view),
        '/api/v1/hosts/ka.example.no/pages/om': () =>
          json({ id: 'om', title: 'Om tjenesten', body: '# Hvem\n\nVi er <b>Digdir</b>.' }),
      }),
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Om tjenesten' })).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 2, name: 'Hvem' })).toBeTruthy();
    expect(document.querySelector('article b')).toBeNull();
  });

  it('links a page only to https and mailto addresses, as the menu does', async () => {
    const body = [
      '[Sikker](https://example.no/a) [Usikker](http://example.no/b) [Post](mailto:post@example.no)',
      '[Innlogget](https://kari:hemmelig@example.no/) <http://example.no/c> <https://example.no/d>',
    ].join('\n\n');
    draw(
      '/om',
      genki({
        '/api/v1/hosts/ka.example.no': () => json(view),
        '/api/v1/hosts/ka.example.no/pages/om': () =>
          json({ id: 'om', title: 'Om tjenesten', body }),
      }),
    );

    await screen.findByRole('heading', { level: 1, name: 'Om tjenesten' });
    const hrefs = [...document.querySelectorAll('article a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      'https://example.no/a',
      'mailto:post@example.no',
      'https://example.no/d',
    ]);
    expect(document.querySelector('article')?.textContent).toContain('Usikker');
  });

  it('checks a mailto address in linear time', () => {
    const long = `mailto:${'a@'.repeat(50_000)}`;
    const started = performance.now();
    expect(isPageLink(long)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('starts no login on a hostname genki does not answer for, such as one opened to another tenant', async () => {
    const asked: string[] = [];
    const notHere: typeof fetch = async (input) => {
      asked.push(String(input));
      return json({ type: 'urn:genai:problem:host-not-found', status: 404 }, 404);
    };
    vi.stubGlobal('fetch', notHere);
    draw('/', notHere);

    expect(
      await screen.findByRole('heading', { name: 'Her er det ingen assistent.' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Logg inn' })).toBeNull();
    expect(asked).toEqual(['/api/v1/hosts/ka.example.no']);
  });

  it('sends the person to the issuer with the host’s client, PKCE and its own callback', async () => {
    const at = browser('https://ka.example.no/?q=1');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) =>
      String(input) === 'https://login.example.no/.well-known/openid-configuration'
        ? json({
            issuer: 'https://login.example.no',
            authorization_endpoint: 'https://login.example.no/authorize',
            token_endpoint: 'https://login.example.no/token',
          })
        : json({}, 404),
    );
    draw('/', genki({ '/api/v1/hosts/ka.example.no': () => json(view) }), 'nb', at.signIn);

    fireEvent.click(await screen.findByRole('button', { name: 'Logg inn' }));

    await vi.waitFor(() => expect(at.went).toHaveLength(1));
    const authorize = new URL(at.went[0] ?? '');
    expect(authorize.origin + authorize.pathname).toBe('https://login.example.no/authorize');
    const q = authorize.searchParams;
    expect(q.get('client_id')).toBe('klarsprak-host');
    expect(q.get('redirect_uri')).toBe('https://ka.example.no/auth/callback');
    expect(q.get('resource')).toBe('aud-ka');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(JSON.parse(q.get('authorization_details') ?? '[]')).toEqual([
      { type: 'ansattporten:altinn:resource', resource: 'urn:altinn:resource:ka' },
    ]);
    expect(q.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    const pending = JSON.parse(at.storage.getItem('assistant.klarsprak-host.login') ?? '{}');
    expect(q.get('state')).toBe(pending.state);
    expect(q.get('nonce')).toBe(pending.nonce);
    expect(pending.returnTo).toBe('/?q=1');
  });

  it('draws the service’s layout once the callback has exchanged the code', async () => {
    const at = browser('https://ka.example.no/auth/callback?code=c1&state=s1');
    at.storage.setItem(
      'assistant.klarsprak-host.login',
      JSON.stringify({ state: 's1', verifier: 'v1', nonce: 'n1', returnTo: '/' }),
    );
    const posted: string[] = [];
    const asked: string[] = [];
    const layout = {
      version: 1,
      zones: { primary: [], main: [{ block: 'chat' }], secondary: [] },
      profile: { assistantName: 'Klarspråkassistenten', suggestions: ['Skriv om dette'] },
    };
    const token = jwt({ sub: 'kari', exp: 4_102_444_800 });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push(`${url} ${new Headers(init?.headers).get('authorization') ?? ''}`);
      if (url === '/api/v1/hosts/ka.example.no') return json(view);
      if (url.endsWith('/.well-known/openid-configuration'))
        return json({
          issuer: 'https://login.example.no',
          authorization_endpoint: 'https://login.example.no/authorize',
          token_endpoint: 'https://login.example.no/token',
        });
      if (url === 'https://login.example.no/token') {
        posted.push(String(init?.body));
        return json({ access_token: token, id_token: jwt({ nonce: 'n1', name: 'Kari Nordmann' }) });
      }
      if (url === '/api/v1/models') return json({ data: [{ id: 'klarsprak__default' }] });
      if (url === '/api/v1/models/klarsprak__default/interface') return json({ layout });
      return json({ data: [] });
    });
    draw('/auth/callback?code=c1&state=s1', globalThis.fetch, 'nb', at.signIn);

    expect(await screen.findByText('Skriv om dette')).toBeTruthy();
    const body = new URLSearchParams(posted[0]);
    expect(body.get('code')).toBe('c1');
    expect(body.get('code_verifier')).toBe('v1');
    expect(body.get('redirect_uri')).toBe('https://ka.example.no/auth/callback');
    expect(asked).toContain(`/api/v1/models Bearer ${token}`);
    expect(screen.getByRole('button', { name: 'Logg ut' })).toBeTruthy();
    expect(at.storage.getItem('assistant.klarsprak-host.login')).toBeNull();
  });

  it('refuses a callback whose state is not the one it sent', async () => {
    const at = browser('https://ka.example.no/auth/callback?code=c1&state=forged');
    at.storage.setItem(
      'assistant.klarsprak-host.login',
      JSON.stringify({ state: 's1', verifier: 'v1', nonce: 'n1', returnTo: '/' }),
    );
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return json({}, 404);
    });
    draw(
      '/auth/callback?code=c1&state=forged',
      genki({ '/api/v1/hosts/ka.example.no': () => json(view) }),
      'nb',
      at.signIn,
    );

    expect(await screen.findByText('Innloggingen mislyktes. Prøv igjen.')).toBeTruthy();
    expect(asked).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Logg ut' })).toBeNull();
  });

  it('draws the layout’s texts in the reader’s language, since the blocks take one wording', () => {
    const layout = {
      version: 1,
      zones: { primary: [], main: [{ block: 'chat', settings: { copy: true } }], secondary: [] },
      profile: {
        assistantName: { nb: 'Klarspråkassistenten', en: 'The plain language assistant' },
        suggestions: [{ nb: 'Skriv om', en: 'Rewrite' }, 'Hei'],
      },
    };
    expect(inLanguage(layout, 'en')).toEqual({
      ...layout,
      profile: { assistantName: 'The plain language assistant', suggestions: ['Rewrite', 'Hei'] },
    });
  });

  it('takes the hostname from the address unless a local run names one', () => {
    const url = new URL('https://ka.example.no/om');
    expect(hostnameOf(url, 'annen.example.no')).toBe('annen.example.no');
    expect(hostnameOf(url, undefined)).toBe('ka.example.no');
  });
});
