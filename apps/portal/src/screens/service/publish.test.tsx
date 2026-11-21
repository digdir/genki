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
  outcome: {
    validate?: Problem[];
    publish?: Problem[];
    staged?: boolean | 'pinned';
    promoteFails?: boolean;
    draftSpec?: Record<string, unknown>;
    gates?: unknown[] | 'fails';
    runs?: unknown[];
    testSets?: unknown[];
  },
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
          : json({
              ...published,
              version: 2,
              publishedBy: 'employee:kari',
              ...(outcome.staged
                ? {
                    environments: [
                      { name: 'prod', version: 1, followsPublishes: false },
                      outcome.staged === 'pinned'
                        ? { name: 'test', version: 1, followsPublishes: false }
                        : { name: 'test', version: 2, followsPublishes: true },
                    ],
                  }
                : { environments: [{ name: 'prod', version: 2, followsPublishes: true }] }),
            });
      if (url.endsWith('/environments/prod/promote'))
        return outcome.promoteFails
          ? json({ title: 'Nede', status: 503 }, 503)
          : json({ environments: [] });
      if (url.endsWith('/environments/prod/rollback')) return json({ environments: [] });
    }
    const served = strategyRoutes(new URL(url, 'http://x').pathname.replace(/^\/api/, ''));
    if (served) return json(served);
    if (url.split('?')[0]?.endsWith('/services/klarsprak/draft'))
      return draft
        ? json({
            revision: 1,
            definition: { ...definition, spec: { ...definition.spec, ...outcome.draftSpec } },
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
    if (outcome.runs && url.endsWith('/eval-runs')) return json({ data: outcome.runs });
    if (outcome.testSets && url.endsWith('/test-sets')) return json({ data: outcome.testSets });
    if (url.endsWith('/gates'))
      return outcome.gates === 'fails'
        ? json({ title: 'Nede', status: 503 }, 503)
        : json({ data: outcome.gates ?? [] });
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
  fireEvent.click(await screen.findByRole('button', { name: 'Publiser' }));
  await screen.findByRole('heading', { level: 1, name: 'Publiser Klarspråk' });
  return document.body;
};

const publishFromHeader = async (fetch: typeof globalThis.fetch) => {
  const page = await openPublishPage(fetch);
  expect(within(page).queryByRole('button', { name: 'Publiser som testutgave' })).toBeNull();
  await waitFor(() =>
    expect(screen.queryByText('Sjekker testutgaven mot plattformen …')).toBeNull(),
  );
  fireEvent.change(within(page).getByLabelText(/^Hva er endret, og hvorfor\?/), {
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
      (await screen.findByRole('button', { name: 'Publiser' })).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('says users get everything in the test edition and goes back to Oppsett on Avbryt without publishing', async () => {
    const { fetch, posts } = platform({});
    await openPublishPage(fetch);
    expect(window.location.hash).toBe('#/services/klarsprak/setup/publish');
    expect(screen.getByText('Brukerne får alt som er i testutgaven nå.')).toBeTruthy();
    expect(screen.getByText('Du kan angre publiseringen i Historikk.')).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Avbryt' }));
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
    expect(within(page).getByText('Sjekker testutgaven mot plattformen …')).toBeTruthy();
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
      await within(page).findByRole('heading', {
        name: 'Plattformen godtar ikke testutgaven ennå',
      }),
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

  it('gives users the new edition when a test edition would otherwise keep it from them', async () => {
    const { fetch, posts } = platform({ staged: true });
    await publishFromHeader(fetch);

    await waitFor(() =>
      expect(posts.some((p) => p.url.endsWith('/environments/prod/promote'))).toBe(true),
    );
    expect(posts.find((p) => p.url.endsWith('/environments/prod/promote'))?.body).toEqual({
      from: 'test',
    });
  });

  it('moves users to the new edition when no test edition holds it', async () => {
    const { fetch, posts } = platform({ staged: 'pinned' });
    await publishFromHeader(fetch);

    await waitFor(() =>
      expect(posts.some((p) => p.url.endsWith('/environments/prod/rollback'))).toBe(true),
    );
    expect(posts.find((p) => p.url.endsWith('/environments/prod/rollback'))?.body).toEqual({
      version: 2,
    });
  });

  it('says users did not get the new edition when moving it to them fails', async () => {
    const { fetch } = platform({ staged: true, promoteFails: true });
    await publishFromHeader(fetch);

    expect(
      await screen.findByText(
        'Publisert, men brukerne har ikke fått den. Prøv igjen under Teknisk.',
      ),
    ).toBeTruthy();
  });

  it('leaves the edition in use alone when the publish already moved it', async () => {
    const { fetch, posts } = platform({});
    await publishFromHeader(fetch);

    expect(await screen.findByText('Utgave 2 er publisert.')).toBeTruthy();
    expect(posts.some((p) => p.url.includes('/environments/'))).toBe(false);
  });

  it('asks what users get from a new variant and publishes it in place of Standard when chosen', async () => {
    const fast = {
      id: 'fast',
      title: { nb: 'Raskere svar', en: 'Faster' },
      aliases: [],
      overrides: {},
    };
    const { fetch, posts } = platform({
      draftSpec: { variants: ['default', { ...fast, chat: false }] },
    });
    const page = await openPublishPage(fetch);
    const choice = await within(page).findByRole('group', { name: 'Ny variant: Raskere svar' });
    expect(
      (within(choice).getByRole('radio', { name: 'Skjult for brukerne' }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(within(page).getByRole('row', { name: /Varianter/ }).textContent).toContain(
      'Standard, Raskere svar (skjult)',
    );
    fireEvent.click(within(choice).getByRole('radio', { name: 'Erstatter Standard' }));
    expect(within(page).getByRole('row', { name: /Varianter/ }).textContent).toContain(
      'Raskere svar, Standard',
    );
    await waitFor(() =>
      expect(screen.queryByText('Sjekker testutgaven mot plattformen …')).toBeNull(),
    );
    fireEvent.change(within(page).getByLabelText(/^Hva er endret, og hvorfor\?/), {
      target: { value: 'Raskere svar for alle' },
    });
    fireEvent.click(within(page).getByRole('button', { name: 'Publiser' }));

    expect(await screen.findByText('Utgave 2 er publisert.')).toBeTruthy();
    const variants = posts.filter((p) => p.url.endsWith('/definitions')).at(-1)?.body.definition
      ?.spec.variants as unknown[];
    expect(variants).toEqual([{ ...fast }, 'default']);
  });

  it('shows what each changed area is in use now and after publishing', async () => {
    const { fetch } = platform({ draftSpec: { purpose: 'Skriver kortere tekst' } });
    const page = await openPublishPage(fetch);
    const row = await within(page).findByRole('row', { name: /Formål/ });
    expect(within(row).getByText('Skriver om tekst til klarspråk')).toBeTruthy();
    expect(within(row).getByText('Skriver kortere tekst')).toBeTruthy();
  });

  it('never lists a new risk confirmation as a change', async () => {
    const { fetch } = platform({
      draftSpec: {
        riskConfirmation: { by: 'employee:kari', at: '2026-11-20', reasons: ['Sjekket på nytt'] },
      },
    });
    const page = await openPublishPage(fetch);
    expect(await within(page).findByText('Testutgaven er lik den i bruk.')).toBeTruthy();
    expect(within(page).queryByRole('row', { name: /Risiko/ })).toBeNull();
  });

  it('names the quality requirement the test edition is under, with Kjør testsettet after the text', async () => {
    const { fetch } = platform({
      gates: [
        {
          id: 'avslag-uten-kilde',
          version: 1,
          mandatory: true,
          spec: { kind: 'threshold', metric: 'refusal', threshold: 0.9 },
        },
      ],
      runs: [
        {
          id: 'd1',
          status: 'completed',
          testSet: 'kjerne',
          version: 'draft',
          draftRevision: 1,
          startedAt: '2026-10-08T09:00:00Z',
          endedAt: '2026-10-08T09:10:00Z',
          score: 0.9,
          passed: 9,
          total: 10,
          metrics: { refusal: { mean: 0.89, n: 9 } },
        },
      ],
    });
    const page = await openPublishPage(fetch);
    const below = await within(page).findByText(
      'Under kravet på ett punkt: avslag uten kilde er 89 %, kravet er 90 %.',
    );
    const run = within(below.closest('[role="status"]') as HTMLElement).getByRole('link', {
      name: 'Kjør testsettet',
    });
    expect(below.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says the quality requirements could not be checked instead of saying they are met', async () => {
    const { fetch } = platform({
      gates: 'fails',
      testSets: [{ id: 'kjerne', name: 'Kjerne', cases: 10 }],
      runs: [
        {
          id: 'd1',
          status: 'completed',
          testSet: 'kjerne',
          version: 'draft',
          draftRevision: 1,
          startedAt: '2026-10-08T09:00:00Z',
          endedAt: '2026-10-08T09:10:00Z',
          score: 1,
          passed: 10,
          total: 10,
        },
      ],
    });
    const page = await openPublishPage(fetch);
    expect(await within(page).findByText('Kunne ikke sjekke kravene til kvalitet.')).toBeTruthy();
    expect(within(page).queryByText('Alle krav er nådd.')).toBeNull();
  });

  it('lets only one new variant replace Standard', async () => {
    const variant = (id: string, nb: string) => ({
      id,
      title: { nb, en: nb },
      aliases: [],
      overrides: {},
      chat: false,
    });
    const { fetch } = platform({
      draftSpec: {
        variants: ['default', variant('fast', 'Raskere svar'), variant('long', 'Lengre svar')],
      },
    });
    const page = await openPublishPage(fetch);
    const fast = await within(page).findByRole('group', { name: 'Ny variant: Raskere svar' });
    const long = within(page).getByRole('group', { name: 'Ny variant: Lengre svar' });
    fireEvent.click(within(fast).getByRole('radio', { name: 'Erstatter Standard' }));
    fireEvent.click(within(long).getByRole('radio', { name: 'Erstatter Standard' }));
    expect(
      (within(fast).getByRole('radio', { name: 'Brukerne kan velge den' }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (within(long).getByRole('radio', { name: 'Erstatter Standard' }) as HTMLInputElement).checked,
    ).toBe(true);
  });
});
