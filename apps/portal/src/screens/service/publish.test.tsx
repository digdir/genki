// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { strategyRoutes } from '../../mock/strategies';
import { kari } from '../../test-utils';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const definition = {
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: '991825827', id: 'klarsprak', name: 'Klarspråk' },
  spec: {
    purpose: 'Skriver om tekst til klarspråk',
    audience: ['employees'],
    riskClass: 'limited',
    riskConfirmation: { by: 'employee:x', at: '2026-10-07', reasons: ['Ok'] },
    output: { kind: 'answer', withSources: false },
    strategy: {
      id: 'single-call',
      version: 1,
      config: { instructions: 'prompts/klarsprak.nb.md' },
    },
    model: { primary: 'foundry-openai/gpt-4o-2m-tps', residency: 'global' },
    exposure: { rest: true },
  },
};

const published = {
  kind: 'Service',
  tenant: '991825827',
  id: 'klarsprak',
  version: 1,
  publishedBy: 'platform:seed',
  publishedAt: '2026-10-07T07:35:43.346Z',
  reason: 'local configuration',
  definition,
  files: { 'prompts/klarsprak.nb.md': 'Skriv klart.' },
};

type Problem = { path: string; message: string };

const platform = (
  outcome: { validate?: Problem[]; publish?: Problem[] },
  draft: boolean = true,
) => {
  const posts: {
    url: string;
    body: { files: Record<string, string>; definition?: { spec: Record<string, unknown> } };
  }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
        },
      });
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith('/definitions/complete')) {
        const sent = posts.at(-1)?.body.definition as { spec: Record<string, unknown> };
        return json({
          definition: { ...sent, spec: { ...sent.spec, guardrails: { 'human-approval': true } } },
          applied: [
            { path: 'spec.guardrails.human-approval', rule: 'human-approval-for-high-risk' },
          ],
        });
      }
      if (url.endsWith('/definitions/validate'))
        return outcome.validate
          ? json({ title: 'Ugyldig', status: 422, errors: outcome.validate }, 422)
          : json({ valid: true });
      if (url.endsWith('/definitions'))
        return outcome.publish
          ? json({ title: 'Avvist', status: 422, errors: outcome.publish }, 422)
          : json({ ...published, version: 2, publishedBy: 'employee:kari' });
    }
    const served = strategyRoutes(new URL(url, 'http://x').pathname.replace(/^\/api/, ''));
    if (served) return json(served);
    if (url.split('?')[0]?.endsWith('/services/klarsprak/draft'))
      return draft
        ? json({
            revision: 1,
            definition,
            files: published.files,
            at: '2026-10-08T08:00:00Z',
            reason: 'utkast',
            baseVersion: 1,
            latestVersion: 1,
          })
        : json({ title: 'Fant ikke', status: 404 }, 404);
    if (url.endsWith('/definitions/services/klarsprak'))
      return json({ latest: published, versions: [published] });
    if (url.endsWith('/definitions')) return json([{ kind: 'Service', id: 'klarsprak' }]);
    if (url.endsWith('/tasks')) return json({ data: [], total: 0 });
    if (url.includes('/usage')) return json({ totals: {}, daily: [], byService: [], byModel: [] });
    if (url.includes('/models')) return json({ data: [] });
    return json({});
  };
  return { fetch, posts };
};

const openPublishPage = async (fetch: typeof globalThis.fetch) => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = '#/services/klarsprak';
  render(<App auth={auth} fetch={fetch} live />);
  await screen.findByRole('heading', { level: 1, name: 'Klarspråk' });
  expect(screen.queryByRole('button', { name: 'Publiser som testutgave' })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Publiser ...' }));
  await screen.findByRole('heading', { level: 1, name: 'Publiser Klarspråk, utgave 2' });
  return document.body;
};

const publishFromHeader = async (fetch: typeof globalThis.fetch) => {
  const page = await openPublishPage(fetch);
  expect(within(page).queryByRole('button', { name: 'Publiser som testutgave' })).toBeNull();
  await waitFor(() => expect(screen.queryByText('Sjekker utkastet mot plattformen …')).toBeNull());
  fireEvent.change(within(page).getByLabelText(/^Hva endret du, og hvorfor\?/), {
    target: { value: 'Strammer inn instruksjonene' },
  });
  fireEvent.click(within(page).getByRole('button', { name: 'Publiser' }));
  return page;
};

describe('publishing the draft in live mode', () => {
  it('offers Publiser only when there is a draft', async () => {
    const { fetch } = platform({}, false);
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/klarsprak';
    render(<App auth={auth} fetch={fetch} live />);
    await screen.findByRole('heading', { level: 1, name: 'Klarspråk' });
    expect(
      (await screen.findByRole('button', { name: 'Publiser ...' })).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('names the next edition on the publish page and goes back to Oppsett without publishing', async () => {
    const { fetch, posts } = platform({});
    await openPublishPage(fetch);
    expect(window.location.hash).toBe('#/services/klarsprak/setup/publish');
    expect(screen.getByText(/Utgave 1 er i bruk til du publiserer/)).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Fortsett å redigere' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Klarspråk' })).toBeTruthy();
    expect(window.location.hash).toBe('#/services/klarsprak/setup');
    expect(posts.some((p) => p.url.endsWith('/definitions'))).toBe(false);
  });

  it('keeps Publiser locked until the platform has checked the draft', async () => {
    const { fetch: base, posts } = platform({});
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/definitions/validate')) await held;
      return base(input, init);
    };
    const page = await openPublishPage(fetch);
    const button = within(page).getByRole('button', { name: 'Publiser' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(within(page).getByText('Sjekker utkastet mot plattformen …')).toBeTruthy();
    fireEvent.click(button);
    expect(posts.some((p) => p.url.endsWith('/definitions'))).toBe(false);

    release();
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBeNull());
  });

  it('validates, publishes with the files and shows the new edition', async () => {
    const { fetch, posts } = platform({});
    await publishFromHeader(fetch);

    expect(await screen.findByText('Utgave 2 er publisert.')).toBeTruthy();
    const complete = '/tenants/999888777/definitions/complete';
    expect(posts.map((p) => p.url.replace(/^.*\/api/, ''))).toEqual([
      complete,
      '/definitions/validate',
      complete,
      '/definitions/validate',
      '/definitions',
    ]);
    expect(posts[1]?.body.files).toEqual({ 'prompts/klarsprak.nb.md': 'Skriv klart.' });
    expect(posts[4]?.body.files).toEqual({ 'prompts/klarsprak.nb.md': 'Skriv klart.' });
  });

  it('validates and publishes the definition the API completed, not only what the editor built', async () => {
    const { fetch, posts } = platform({});
    await publishFromHeader(fetch);

    expect(await screen.findByText('Utgave 2 er publisert.')).toBeTruthy();
    const sent = (path: string) =>
      posts.filter((p) => p.url.endsWith(path)).at(-1)?.body.definition?.spec.guardrails;
    expect(sent('/definitions/validate')).toEqual({ 'human-approval': true });
    expect(sent('/definitions')).toEqual({ 'human-approval': true });
  });

  it('shows validation errors inline and does not publish', async () => {
    const { fetch, posts } = platform({
      validate: [{ path: 'spec.strategy.config.instructions', message: 'må fylles ut' }],
    });
    const page = await publishFromHeader(fetch);

    expect(
      await within(page).findByRole('heading', { name: 'Plattformen godtar ikke utkastet ennå' }),
    ).toBeTruthy();
    expect(within(page).getByText('Instruksjoner:').parentElement?.textContent).toBe(
      'Instruksjoner: må fylles ut',
    );
    expect(
      within(page).getByRole('button', { name: 'Publiser' }).getAttribute('aria-disabled'),
    ).toBe('true');
    expect(posts.some((p) => p.url.endsWith('/definitions'))).toBe(false);
  });

  it('explains when the quality gates refuse the publish', async () => {
    const { fetch } = platform({
      publish: [{ path: 'spec.evaluation', message: 'refused by evaluation gates (sourceHit)' }],
    });
    const page = await publishFromHeader(fetch);

    expect(
      await within(page).findByText(/Kravene til kvalitet stoppet publiseringen/),
    ).toBeTruthy();
    expect(within(page).getByText(/refused by evaluation gates/)).toBeTruthy();
    expect(screen.queryByText('Utgave 2 er publisert.')).toBeNull();
  });
});
