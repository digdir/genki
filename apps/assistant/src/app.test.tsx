// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LocaleProvider } from '@genai/i18n/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { hostnameOf, inLanguage, isPageLink } from './host';

document.getAnimations ??= () => [];

const view = {
  hostname: 'ka.example.no',
  tenant: '991825827',
  service: 'klarsprak',
  environment: 'prod',
  name: { nb: 'Klarspråkassistenten', en: 'The plain language assistant' },
  login: { issuer: null, clientId: 'klarsprak-host' },
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

const draw = (path: string, fetcher: typeof fetch, local = false, locale: 'nb' | 'en' = 'nb') =>
  render(
    <LocaleProvider preference={locale}>
      <App hostname="ka.example.no" path={path} local={local} fetcher={fetcher} />
    </LocaleProvider>,
  );

afterEach(cleanup);

describe('the assistant host', () => {
  it('draws the service’s name and menu, and a sign-in notice where sign-in is not built', async () => {
    draw('/', genki({ '/api/v1/hosts/ka.example.no': () => json(view) }));

    const name = await screen.findByRole('link', { name: 'Klarspråkassistenten' });
    expect(name.getAttribute('href')).toBe('/');
    const menu = screen.getByRole('navigation', { name: 'Meny' });
    expect(menu.querySelector('a[href="/om"]')?.textContent).toBe('Om');
    const help = screen.getByRole('link', { name: 'Hjelp' });
    expect(help.getAttribute('target')).toBe('_blank');
    expect(help.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText('Innlogging med Ansattporten kommer snart.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Logg inn lokalt' })).toBeNull();
  });

  it('follows the person’s language in the service’s texts', async () => {
    draw('/', genki({ '/api/v1/hosts/ka.example.no': () => json(view) }), false, 'en');

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

  it('logs in through the dev login when it runs locally', async () => {
    const asked: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      asked.push(`${init?.method ?? 'GET'} ${String(input)}`);
      if (String(input) === '/api/v1/hosts/ka.example.no') return json(view);
      if (String(input) === '/api/mock/dev-login') return json({ name: 'Kari', token: 't' });
      return json({ data: [] });
    };
    draw('/', fetcher, true);

    fireEvent.click(await screen.findByRole('button', { name: 'Logg inn lokalt' }));

    expect(await screen.findByText('Tjenesten har ikke noe oppsett for assistenten.')).toBeTruthy();
    expect(asked).toContain('POST /api/mock/dev-login');
    expect(screen.getByRole('button', { name: 'Logg ut' })).toBeTruthy();
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
