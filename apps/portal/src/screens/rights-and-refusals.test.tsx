// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { createApiClient } from '../api';
import { mockAnsattporten } from '../auth';
import { logTimelines } from '../data/log';
import { exampleModels, exampleOrganisations, mockFetch, serviceTemplate } from '../mock';
import type { DatasetView } from '../api/datasets';
import type { AccessRequest } from '../api/onboarding';
import type { OnboardingMockOptions } from '../mock/onboarding';
import type { Organisation } from '../types';

document.getAnimations ??= () => [];
beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const problem = (status: number, body: Record<string, unknown>, headers: HeadersInit = {}) =>
  new Response(JSON.stringify({ status, ...body }), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const answering =
  (pattern: RegExp, reply: () => Response, base: typeof fetch = mockFetch()): typeof fetch =>
  async (input, init) =>
    pattern.test(urlOf(input)) ? reply() : base(input, init);

const forbidden = (title: string) => () => problem(403, { type: 'about:blank', title });

const renderAs = async (
  path: string,
  fetch: typeof globalThis.fetch,
  organisations: Organisation[] = exampleOrganisations,
) => {
  const auth = mockAnsattporten({ name: 'Erik Larsen', organisations });
  await auth.login();
  window.location.hash = path;
  return render(<App auth={auth} fetch={fetch} live />);
};

const useOnly: Organisation[] = [
  { orgNumber: '999888777', name: 'Testetaten', actions: ['use-services'] },
];

describe('refusals from the API', () => {
  it('shows the API title for a refused usage tile and change list, without retry', async () => {
    const fetch = answering(
      /\/(usage|audit)\b/,
      forbidden('Du trenger rettigheten «Se forbruk og kostnad»'),
    );
    await renderAs('#/overview', fetch);

    const tile = (await screen.findByRole('heading', { name: /^Forbruk i/ })).closest(
      'section',
    ) as HTMLElement;
    expect(
      await within(tile).findByText('Du trenger rettigheten «Se forbruk og kostnad»'),
    ).toBeTruthy();
    expect(within(tile).queryByText(/USAGE-503|akkurat nå/)).toBeNull();
    const changes = screen
      .getByRole('heading', { name: 'Siste endringer' })
      .closest('section') as HTMLElement;
    expect(
      await within(changes).findByText('Du trenger rettigheten «Se forbruk og kostnad»'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Prøv igjen' })).toBeNull();
  });

  it('shows the refusal on Forbruk instead of an outage with skeletons', async () => {
    const fetch = answering(
      /\/usage\b/,
      forbidden('Du trenger rettigheten «Se forbruk og kostnad»'),
    );
    const { container } = await renderAs('#/usage', fetch);

    expect(await screen.findByText('Du trenger rettigheten «Se forbruk og kostnad»')).toBeTruthy();
    expect(screen.queryByText(/midlertidig utilgjengelige/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Prøv igjen' })).toBeNull();
    expect(container.querySelector('.ds-skeleton')).toBeNull();
  });

  it('says when the monthly quota is used up and when calls are rate limited', async () => {
    await renderAs(
      '#/usage',
      answering(/\/usage\b/, () =>
        problem(429, { type: 'urn:genai:problem:quota-exhausted', title: 'Quota' }),
      ),
    );
    expect(await screen.findByText('Månedskvoten for tokens er brukt opp')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Se forbruket' }).getAttribute('href')).toBe(
      '#/statistics',
    );
    cleanup();

    await renderAs(
      '#/usage',
      answering(/\/usage\b/, () =>
        problem(
          429,
          { type: 'urn:genai:problem:rate-limited', title: 'Slow down' },
          {
            'retry-after': '12',
          },
        ),
      ),
    );
    expect(await screen.findByText('For mange kall. Prøv igjen om 12 sekunder.')).toBeTruthy();
  });

  it('shows the refusal in the builder assistant instead of an outage', async () => {
    const fetch = answering(
      /\/assistant\/turns$/,
      forbidden('Du trenger rettigheten «Administrere tjenester»'),
    );
    await renderAs('#/services/new', fetch);
    const panel = await screen.findByRole('complementary', { name: 'Byggeassistent' });
    const composer = within(panel).getByRole('textbox', { name: 'Skriv til assistenten' });
    fireEvent.change(composer, { target: { value: 'Svar på spørsmål' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(
      await within(panel).findByText('Du trenger rettigheten «Administrere tjenester»'),
    ).toBeTruthy();
    expect(within(panel).queryByText(/svarer ikke akkurat nå/)).toBeNull();
  });
});

describe('rights in the UI', () => {
  it('hides create and publish actions from someone who can only use services', async () => {
    const empty = answering(
      /\/overview$/,
      () =>
        Response.json({
          services: [],
          recentTasks: [],
          usageThisMonth: { inputTokens: 0, outputTokens: 0, requests: 0, costMicroNok: 0 },
          qualityWarnings: [],
          review: { pendingToolChanges: 0, failedTasksLastDay: 0 },
        }),
      mockFetch(undefined, undefined, undefined, undefined, {
        features: { datasets: { datasets: [] } },
      }),
    );
    await renderAs('#/overview', empty, useOnly);

    const start = await screen.findByRole('region', { name: 'Kom i gang' });
    expect(within(start).queryByRole('link', { name: 'Legg til datasett' })).toBeNull();
    expect(within(start).queryByRole('link', { name: 'Lag en tjeneste' })).toBeNull();
    expect(within(start).getByText('Du trenger rettigheten «Administrere datasett».')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Lag en tjeneste' })).toBeNull();
    cleanup();

    await renderAs('#/services', mockFetch(), useOnly);
    await screen.findByRole('heading', { level: 1, name: 'Tjenester' });
    expect(screen.queryByRole('button', { name: 'Ny tjeneste' })).toBeNull();
    cleanup();

    await renderAs('#/datasets', mockFetch(), useOnly);
    await screen.findByRole('heading', { name: 'Egne datasett og endepunkter' });
    await screen.findByText(/oppføringer/);
    expect(screen.queryByRole('button', { name: 'Ny' })).toBeNull();
    cleanup();

    await renderAs('#/services/rapportassistenten', mockFetch(), useOnly);
    await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' });
    expect(screen.queryByRole('button', { name: 'Publiser' })).toBeNull();
    expect(screen.getByText('Du trenger rettigheten «Administrere tjenester».')).toBeTruthy();
  });
});

describe('an organisation Digdir has not registered', () => {
  const unregistered = (base: typeof fetch = mockFetch()) =>
    answering(
      /\/tenants\/999888777\//,
      () =>
        problem(403, {
          type: 'urn:genai:problem:tenant-not-registered',
          title: 'Virksomheten er ikke registrert',
        }),
      base,
    );
  const onboarding = (options: OnboardingMockOptions) =>
    mockFetch(undefined, undefined, undefined, undefined, {
      features: { onboarding: options },
    });
  const withRequests = (requests: AccessRequest[]) => onboarding({ requests });
  const fill = (form: HTMLElement) => {
    fireEvent.change(within(form).getByLabelText('E-post til kontaktpersonen'), {
      target: { value: 'erik.larsen@testetaten.example.no' },
    });
    fireEvent.change(within(form).getByLabelText('Hva vil dere bruke plattformen til?'), {
      target: { value: 'Svare saksbehandlere med kilder fra egne rapporter.' },
    });
    fireEvent.click(
      within(form).getByLabelText(
        'Jeg har lest gjeldende utkast til vilkår og databehandleravtale',
      ),
    );
  };

  it('sends an access request with the organisation from the session and shows it as pending', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const base = unregistered();
    await renderAs('#/overview', async (input, init) => {
      calls.push({
        url: urlOf(input),
        method: init?.method ?? 'GET',
        body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
      });
      return base(input, init);
    });

    const form = await screen.findByRole('form', { name: 'Be om tilgang' });
    expect((within(form).getByLabelText('Organisasjonsnummer') as HTMLInputElement).value).toBe(
      '999888777',
    );
    expect((within(form).getByLabelText('Navn på virksomheten') as HTMLInputElement).value).toBe(
      'Testetaten',
    );
    expect((within(form).getByLabelText('Kontaktperson') as HTMLInputElement).value).toBe(
      'Erik Larsen',
    );
    expect(within(form).getByText('Ikke bestemt')).toBeTruthy();

    fireEvent.click(within(form).getByRole('button', { name: 'Send forespørsel' }));
    const summary = within(form).getByRole('heading', {
      name: 'For å sende forespørselen må du rette opp dette:',
    }).parentElement as HTMLElement;
    expect(
      within(summary)
        .getAllByRole('link')
        .map((l) => [l.textContent, l.getAttribute('href')]),
    ).toEqual([
      ['Skriv e-postadressen til kontaktpersonen.', '#f-epost'],
      ['Skriv hva dere vil bruke plattformen til, med minst 20 tegn.', '#f-bruk'],
      ['Kryss av for at du har lest utkastene til vilkår og databehandleravtale.', '#f-vilkar'],
    ]);
    fireEvent.change(within(form).getByLabelText('E-post til kontaktpersonen'), {
      target: { value: 'erik.larsen@' },
    });
    expect(
      within(form).getAllByText(
        'E-postadressen ser ikke riktig ut. Den skal se slik ut: navn@virksomhet.example.no.',
      ).length,
    ).toBeGreaterThan(0);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    fill(form);
    fireEvent.click(within(form).getByRole('button', { name: 'Send forespørsel' }));

    expect(await screen.findByRole('heading', { name: 'Venter på Digdir' })).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      org: '999888777',
      orgName: 'Testetaten',
      contactName: 'Erik Larsen',
      contactEmail: 'erik.larsen@testetaten.example.no',
      purpose: 'Svare saksbehandlere med kilder fra egne rapporter.',
      acceptedTerms: true,
    });
    expect(calls.find((c) => c.method === 'POST')?.url).toMatch(/\/onboarding\/requests$/);
    expect(screen.queryByRole('form', { name: 'Be om tilgang' })).toBeNull();
  });

  it('keeps what was filled in and offers to try again when the request does not reach Digdir', async () => {
    const base = unregistered();
    let fail = true;
    await renderAs('#/overview', async (input, init) =>
      fail && init?.method === 'POST' && /\/onboarding\/requests$/.test(urlOf(input))
        ? problem(503, { title: 'Utilgjengelig' })
        : base(input, init),
    );

    const form = await screen.findByRole('form', { name: 'Be om tilgang' });
    fill(form);
    fireEvent.click(within(form).getByRole('button', { name: 'Send forespørsel' }));

    expect(
      await screen.findByRole('heading', { name: 'Forespørselen ble ikke sendt' }),
    ).toBeTruthy();
    expect(
      (within(form).getByLabelText('E-post til kontaktpersonen') as HTMLInputElement).value,
    ).toBe('erik.larsen@testetaten.example.no');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    expect(await screen.findByRole('heading', { name: 'Venter på Digdir' })).toBeTruthy();
  });

  it('tells the requester to log in again once Digdir approves', async () => {
    await renderAs(
      '#/overview',
      unregistered(
        withRequests([
          {
            id: 'req-1',
            org: '999888777',
            status: 'approved',
            requestedAt: '2026-10-06T08:00:00Z',
            decision: { by: 'operator:drift', at: '2026-10-08T09:00:00Z', reason: 'Signert' },
          },
        ]),
      ),
    );

    expect(await screen.findByRole('heading', { name: 'Godkjent: logg inn på nytt' })).toBeTruthy();
    expect(screen.getByText(/Digdir godkjente forespørselen 8\. oktober 2026\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Logg inn på nytt' }));
    expect(await screen.findByRole('button', { name: 'Logg inn' })).toBeTruthy();
  });

  it('shows the reason when Digdir refuses and lets the requester try again', async () => {
    await renderAs(
      '#/overview',
      unregistered(
        withRequests([
          {
            id: 'req-1',
            org: '999888777',
            status: 'rejected',
            requestedAt: '2026-10-06T08:00:00Z',
            decision: {
              by: 'operator:drift',
              at: '2026-10-07T09:00:00Z',
              reason: 'Virksomheten er ikke en offentlig virksomhet',
            },
          },
        ]),
      ),
    );

    expect(await screen.findByRole('heading', { name: 'Avslått' })).toBeTruthy();
    expect(screen.getByText('Virksomheten er ikke en offentlig virksomhet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send en ny forespørsel' }));
    expect(screen.getByRole('form', { name: 'Be om tilgang' })).toBeTruthy();
  });

  it('says a request is already sent when someone else in the organisation asked', async () => {
    await renderAs(
      '#/overview',
      unregistered(onboarding({ pendingByOther: { '999888777': '2026-09-30T10:00:00Z' } })),
    );

    expect(await screen.findByRole('heading', { name: 'Forespørselen er sendt' })).toBeTruthy();
    expect(screen.getByText(/30\. september 2026/)).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Be om tilgang' })).toBeNull();
  });

  it('explains who may ask when the person lacks the right', async () => {
    await renderAs('#/overview', unregistered(onboarding({ mayRequest: false })));

    expect(await screen.findByRole('heading', { name: 'Du kan ikke be om tilgang' })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Se hvem som har tilgang i Altinn (åpnes i ny fane)' }),
    ).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Be om tilgang' })).toBeNull();
  });

  it('replaces the screens with a page without the side menu that explains Digdir must register it', async () => {
    await renderAs('#/overview', unregistered());

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Virksomheten er ikke registrert ennå',
      }),
    ).toBeTruthy();
    expect(screen.getByText(/Digdir må registrere virksomheten/)).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Hovedmeny' })).toBeNull();
    expect(screen.getByText('Org.nr. 999 888 777 · ikke registrert')).toBeTruthy();
    const main = screen.getByRole('main');
    expect(within(main).getByRole('link', { name: 'Kontakt Digdir' }).getAttribute('href')).toBe(
      '#/contact',
    );
    expect(within(main).getByRole('link', { name: 'API-referansen' }).getAttribute('href')).toBe(
      '#/api-reference',
    );
    await screen.findByRole('form', { name: 'Be om tilgang' });
    expect(screen.getByRole('heading', { name: 'Du handler for flere virksomheter' })).toBeTruthy();
    fireEvent.click(within(main).getByRole('button', { name: 'Bytt virksomhet' }));
    expect(screen.getByRole('dialog', { name: 'Velg virksomhet' })).toBeTruthy();
  });

  it('lets an unregistered organisation read the API reference', async () => {
    await renderAs('#/api-reference', unregistered());

    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Virksomheten er ikke registrert ennå' }),
      ).toBeNull(),
    );
  });

  it('offers no switch when the person has only this organisation', async () => {
    await renderAs('#/overview', unregistered(), [exampleOrganisations[0] as Organisation]);

    await screen.findByRole('form', { name: 'Be om tilgang' });
    expect(screen.queryByRole('button', { name: 'Bytt virksomhet' })).toBeNull();
  });
});

describe('empty lists and deep links', () => {
  it('shows the empty state for Tjenester when there are no services', async () => {
    await renderAs('#/services', mockFetch([]));

    expect(await screen.findByRole('heading', { name: 'Ingen tjenester ennå' })).toBeTruthy();
    expect(screen.queryByText('Ingen tjenester passer søket')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Nullstill søk og filter' })).toBeNull();
  });

  it('shows an empty state for Ferdigheter when there are none', async () => {
    const fetch = answering(/\/skills(\?|$)/, () => Response.json({ data: [] }));
    await renderAs('#/skills', fetch);

    expect(await screen.findByRole('heading', { name: 'Ingen ferdigheter ennå' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('opens a dataset from a link with its full id', async () => {
    const views: DatasetView[] = [
      {
        id: 'veiledere',
        fullId: '999888777/veiledere',
        name: 'Veiledere og rapporter',
        scope: '999888777',
        editable: true,
        source: 'upload',
        documents: 6,
        chunks: 48,
        lastExecution: null,
        nextRunAt: null,
      },
    ];
    await renderAs(
      '#/datasets/999888777%2Fveiledere',
      mockFetch(undefined, logTimelines, exampleModels, undefined, {
        features: { datasets: { datasets: views } },
      }),
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Veiledere og rapporter' }),
    ).toBeTruthy();
    window.location.hash = '#/datasets';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor(() => expect(screen.getAllByText('Veiledere og rapporter')).toHaveLength(1));
  });
});

describe('the step flow picker', () => {
  it('chooses a published step flow and links to the editor', async () => {
    const template = serviceTemplate('999888777');
    const fetch = answering(/\/definitions\/template/, () =>
      Response.json({
        definition: {
          ...template,
          spec: {
            ...template.spec,
            strategy: { id: 'step-flow', version: 1, config: {} },
          },
        },
      }),
    );
    await renderAs('#/services/new/advanced/how', fetch);

    const picker = (await screen.findByRole('combobox', { name: 'Stegflyt' })) as HTMLSelectElement;
    expect(screen.queryByRole('textbox', { name: /Stegflyt/ })).toBeNull();
    await screen.findByRole('option', { name: 'postruting, versjon 2' });
    fireEvent.change(picker, { target: { value: 'postruting@2' } });
    expect(
      screen.getByRole('link', { name: 'Åpne i stegflyt-editoren' }).getAttribute('href'),
    ).toBe('#/step-flows/postruting');
  });
});

describe('change reasons', () => {
  it('sends reasons with «» and – encoded so the browser accepts them', async () => {
    const headers: string[] = [];
    const api = createApiClient({
      baseUrl: '/api',
      token: () => 'kari',
      fetch: async (_input, init) => {
        const value = new Headers(init?.headers).get('change-reason') ?? '';
        if (/[^\x20-\x7e]/.test(value)) throw new TypeError('non ISO-8859-1 code point');
        headers.push(value);
        return Response.json({ task: 't' });
      },
    });

    await api.setTenantSetting('999888777', 'retrieval.topK', 5, 'Endret «topK» – fordi ’ja’');

    expect(headers).toHaveLength(1);
    expect(decodeURIComponent(headers[0] ?? '')).toBe('Endret «topK» – fordi ’ja’');
  });
});

it('keeps the template valid for the mock models', () => {
  expect((serviceTemplate('1', exampleModels).spec.model as { primary: string }).primary).toBe(
    exampleModels[0]?.id,
  );
});
