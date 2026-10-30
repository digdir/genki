// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { strategyRoutes } from '../mock/strategies';
import { go, kari } from '../test-utils';

const zero = { inputTokens: 0, outputTokens: 0, requests: 0, costMicroNok: 0 };

const emptyPlatform: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = url.replace(/^(\/api)+/, '').split('?')[0] ?? '';
  const body = (() => {
    const served = strategyRoutes(path);
    if (served) return served;
    if (path.endsWith('/overview'))
      return {
        services: [],
        recentTasks: [],
        usageThisMonth: zero,
        qualityWarnings: [],
        review: { pendingToolChanges: 0, failedTasksLastDay: 0 },
      };
    if (path.endsWith('/usage'))
      return {
        from: '',
        to: '',
        priced: true,
        totals: zero,
        daily: [],
        byService: [],
        byModel: [],
      };
    if (/^\/tenants\/[^/]+\/services$/.test(path)) return { data: [] };
    if (path.endsWith('/definitions')) return { data: [] };
    if (path.endsWith('/audit')) return { data: [] };
    if (path.endsWith('/access')) return { services: [], keys: [] };
    if (path.endsWith('/tasks')) return { data: [], total: 0 };
    if (path.endsWith('/clients'))
      return {
        clients: [],
        endpoints: { chat: ['POST /api/conversations'], mcp: ['/api/mcp'] },
        oidc: {},
      };
    if (path.endsWith('/api-keys')) return { keys: [] };
    if (path.endsWith('/integrations'))
      return { connections: [], traces: { enabled: false, content: false } };
    if (path === '/datasets') return { datasets: [] };
    if (/^\/tenants\/[^/]+\/datasets$/.test(path)) return { data: [] };
    if (path.endsWith('/catalog') || path.endsWith('/pipelines')) return { data: [] };
    if (path === '/settings') return { data: [] };
    if (path === '/models')
      return { data: [{ id: 'foundry-openai/gpt-4.1', residency: 'eu', capabilities: [] }] };
    if (path === '/shared-services') return { data: [] };
    if (path.endsWith('/playground/options'))
      return {
        services: [],
        models: [
          { id: 'foundry-openai/gpt-4.1', name: 'GPT-4.1', dataLocation: 'eu', status: 'allowed' },
        ],
        datasets: [],
        skills: [],
        blocks: [],
        testSets: [],
        quota: { usedPercent: 0 },
      };
    if (path.endsWith('/assistant/turns'))
      return {
        turnId: 'trn_live',
        status: 'completed',
        message: 'Jeg har lest beskrivelsen. Hva skal tjenesten svare på?',
        proposals: [],
        usage: { tokens: 120, budgetLeftToday: 199880, dailyBudget: 200000 },
      };
    return {};
  })();
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
};

const kaDefinition = {
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: '991825827', id: 'kunnskapsassistenten', name: 'Kunnskapsassistenten' },
  spec: {
    purpose: 'Svar med kilder fra offentlige rapporter i Kudos',
    audience: ['employees'],
    riskClass: 'limited',
    variants: [{ id: 'default', aliases: [{ name: 'ka' }] }],
    output: { kind: 'answer', withSources: true },
    strategy: {
      id: 'agent-loop',
      version: 1,
      config: { budget: { searches: 4, reads: 6, readChars: 12000 } },
    },
    knowledge: { datasets: [{ dataset: 'digdir/kudos' }], reranker: 'colbert' },
    model: { primary: 'foundry-openai/gpt-4o-2m-tps', residency: 'global' },
    exposure: { chat: true, mcp: true, openai: true, rest: true },
  },
};

const kaPlatform: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  if (/\/tenants\/[^/]+\/services$/.test(url.split('?')[0] ?? ''))
    return json({
      data: [
        {
          id: 'kunnskapsassistenten',
          name: 'Kunnskapsassistenten',
          purpose: 'Svar med kilder fra offentlige rapporter i Kudos',
          outputKind: 'answer',
          channels: ['chatOwn', 'api', 'mcp'],
          latestVersion: 1,
          status: 'active',
          statusReason: null,
          updatedAt: '2026-10-07T07:35:43.346Z',
          updatedBy: 'platform:seed',
          runsThisWeek: 3,
        },
      ],
    });
  if (url.endsWith('/definitions'))
    return json({ data: [{ kind: 'Service', id: 'kunnskapsassistenten', latestVersion: 1 }] });
  if (url.endsWith('/definitions/services/kunnskapsassistenten')) {
    const latest = {
      kind: 'Service',
      id: 'kunnskapsassistenten',
      version: 1,
      publishedBy: 'platform:seed',
      publishedAt: '2026-10-07T07:35:43.346Z',
      reason: 'local configuration',
      definition: kaDefinition,
    };
    return json({ latest, versions: [latest] });
  }
  return emptyPlatform(input, init);
};

const renderLive = async (path: string, fetch: typeof globalThis.fetch = emptyPlatform) => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = path;
  return render(<App auth={auth} fetch={fetch} live />);
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('live mode shows only platform data', () => {
  it('keeps example ingestions and changes off Oversikt, and reads changes from the audit log', async () => {
    await renderLive('#/overview');

    await screen.findByRole('heading', { level: 1, name: 'Oversikt' });
    expect(screen.queryByText('Nettsidene til Testetaten')).toBeNull();
    expect(screen.queryByText('Ola Nordmann')).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'Innlesinger som trenger oppfølging' }),
    ).toBeTruthy();
    expect(screen.queryByText('Ikke tilgjengelig ennå')).toBeNull();
    expect(screen.getByText('Ingen datasett ennå')).toBeTruthy();
    expect(await screen.findByText('Ingen endringer ennå')).toBeTruthy();
  });

  it('lists no example services on a fresh platform', async () => {
    await renderLive('#/services');

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText('Rapportassistenten')).toBeNull();
    expect(screen.queryByText('Søknadsuttrekk')).toBeNull();
  });

  it('shows no example people or groups under Tilgang', async () => {
    await renderLive('#/access');

    await screen.findByRole('tab', { name: 'Tjenester' });
    for (const name of ['Mona Hauge', 'Per Hansen', 'Ahmed Ali'])
      expect(screen.queryByText(name)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Rettigheter fra Altinn' })).toBeTruthy();
    expect(screen.getByText(/Plattformen henter ikke rettighetene fra Altinn ennå/)).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Datasett' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Grupper' }));
    expect(await screen.findByText('Grupper kan ikke lagres i plattformen ennå.')).toBeTruthy();
  });

  it('Tilgang shows no person count in live mode, since Altinn owns who has the right', async () => {
    const withService: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.split('?')[0]?.endsWith('/access')
        ? new Response(
            JSON.stringify({
              services: [
                {
                  id: 'svar',
                  name: 'Svartjenesten',
                  publicName: 'svar',
                  requirement: { resource: 'svar', action: 'use-services' },
                },
              ],
              keys: [],
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        : emptyPlatform(input, init);
    };
    await renderLive('#/access', withService);

    expect(await screen.findByText('Alle med «Bruke tjenester» i Altinn')).toBeTruthy();
    expect(screen.queryByText(/0 personer/)).toBeNull();
  });

  it('Tilgang lists active services first with their own names, and archived ones last and marked', async () => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const summary = (id: string, name: string, lifecycle: string) => ({
      id,
      name,
      purpose: '',
      outputKind: 'answer',
      channels: [],
      latestVersion: 1,
      status: 'active',
      statusReason: null,
      lifecycle,
      updatedAt: null,
      updatedBy: null,
      runsThisWeek: 0,
    });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.split('?')[0] ?? '';
      if (path.endsWith('/access'))
        return json({
          services: [
            {
              id: 'gammel',
              name: 'Gammel agent (faithful)',
              publicName: 'gammel',
              requirement: {},
            },
            { id: 'svar', name: 'Svartjenesten (faithful)', publicName: 'svar', requirement: {} },
          ],
          keys: [],
        });
      if (path.endsWith('/services'))
        return json({
          data: [
            summary('gammel', 'Gammel agent', 'archived'),
            summary('svar', 'Svartjenesten', 'active'),
          ],
        });
      return emptyPlatform(input, init);
    };
    await renderLive('#/access', fetch);

    const panel = await screen.findByRole('tabpanel');
    await within(panel).findByText('Svartjenesten');
    const titles = [...panel.querySelectorAll('.expand-title')].map((e) => e.textContent);
    expect(titles).toEqual(['Svartjenesten', 'Gammel agentArkivert']);
    expect(screen.queryByText(/faithful/)).toBeNull();
  });

  it('says a service limit cannot be set yet in live mode', async () => {
    const used = { inputTokens: 100, outputTokens: 50, requests: 2, costMicroNok: 1000 };
    const withUsage: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.split('?')[0]?.endsWith('/usage')
        ? new Response(
            JSON.stringify({
              from: '',
              to: '',
              priced: true,
              totals: used,
              daily: [],
              byService: [{ service: 'svar', title: 'Svartjenesten', usage: used }],
              byModel: [],
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        : emptyPlatform(input, init);
    };
    await renderLive('#/usage', withUsage);

    const row = (await screen.findByRole('rowheader', { name: /Svartjenesten/ })).closest(
      'tr',
    ) as HTMLElement;
    expect(within(row).getByText('Kan ikke settes ennå')).toBeTruthy();
    expect(within(row).queryByText('Ingen egen grense')).toBeNull();
  });

  it('does not show the example no-access page in live mode', async () => {
    await renderLive('#/access?view=no-access');

    await screen.findByRole('tab', { name: 'Tjenester' });
    expect(screen.queryByText(/Erik Strand/)).toBeNull();
  });

  it('shows no example systems or frontends', async () => {
    await renderLive('#/integrations');

    await screen.findByRole('heading', { level: 1, name: 'Integrasjoner' });
    expect(screen.queryByText('Saksbehandlingssystemet')).toBeNull();
    go('#/integrations?tab=frontends');
    expect(await screen.findByText('Ingen brukerflater er registrert')).toBeTruthy();
  });

  it('reads the change log from the audit log instead of showing example entries', async () => {
    await renderLive('#/log?tab=changes');

    expect(await screen.findByText('Ingen endringer ennå')).toBeTruthy();
    expect(screen.queryByText('Ola Nordmann')).toBeNull();
  });

  it('shows the empty state for step flows and datasets', async () => {
    await renderLive('#/step-flows');
    expect(await screen.findByText('Ingen stegflyter ennå')).toBeTruthy();
    cleanup();

    await renderLive('#/datasets');
    expect(await screen.findByText('Ingen datasett ennå')).toBeTruthy();
  });

  it('exports from the platform and offers no example targets in settings', async () => {
    await renderLive('#/settings?tab=transfer');

    expect(await screen.findByText('0 definisjoner, 0 innstillinger')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Tjeneste' })).toBeNull();
  });

  it('live mode opens the builder with the assistant', async () => {
    await renderLive('#/services/new');

    const panel = await screen.findByRole('complementary', { name: 'Byggeassistent' });
    expect(within(panel).getByRole('textbox', { name: /assistenten/i })).toBeTruthy();
    expect(screen.queryByText(/Da setter jeg opp/)).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Formål og målgruppe' })).toBeTruthy();
  });

  it('keeps the plain form for creating a service', async () => {
    await renderLive('#/services/new?skjema=1');

    expect(await screen.findByRole('textbox', { name: 'Navn' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Opprett og publiser' })).toBeTruthy();
  });

  it('lists Kunnskapsassistenten from the platform definitions', async () => {
    await renderLive('#/services', kaPlatform);

    expect(await screen.findByText('Kunnskapsassistenten')).toBeTruthy();
    expect(screen.getByText('Svar med kilder fra offentlige rapporter i Kudos')).toBeTruthy();
    expect(screen.queryByText('Rapportassistenten')).toBeNull();
  });

  it('shows the real model, knowledge and how Kunnskapsassistenten is exposed', async () => {
    await renderLive('#/services/kunnskapsassistenten/channels', kaPlatform);

    expect(await screen.findByText('/api/mcp')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Start og kanaler/ })).toBeTruthy();
    go('#/services/kunnskapsassistenten');
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Hva tjenesten gjør' }),
    ).toBeTruthy();
    expect(screen.getAllByText(/gpt-4o-2m-tps/).length).toBeGreaterThan(0);
    expect(screen.getByText(/digdir\/kudos/)).toBeTruthy();
    expect(screen.queryByText(/Qwen|Borealis/)).toBeNull();
  });

  it('offers no example templates in Ny tjeneste', async () => {
    await renderLive('#/services/new');

    await screen.findByRole('complementary', { name: 'Byggeassistent' });
    expect(screen.queryByRole('button', { name: /Som Kunnskapsassistenten/ })).toBeNull();
  });
});

const serviceWith = (strategy: Record<string, unknown>): typeof fetch => {
  const definition = { ...kaDefinition, spec: { ...kaDefinition.spec, strategy } };
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/definitions/services/kunnskapsassistenten')) {
      const latest = {
        kind: 'Service',
        id: 'kunnskapsassistenten',
        version: 1,
        publishedBy: 'platform:seed',
        publishedAt: '2026-10-07T07:35:43.346Z',
        reason: 'local configuration',
        definition,
      };
      return new Response(JSON.stringify({ latest, versions: [latest] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return kaPlatform(input, init);
  };
};

describe('live service page', () => {
  it('shows Kunnskapsassistenten as an agent with its budget, not as a step flow', async () => {
    await renderLive('#/services/kunnskapsassistenten/how-it-works', kaPlatform);

    expect(
      await screen.findByRole('heading', { level: 3, name: 'Agent (søker selv)' }),
    ).toBeTruthy();
    expect(screen.getByText('agent-loop@1')).toBeTruthy();
    fireEvent.click(await screen.findByLabelText('Vis avanserte innstillinger'));
    expect((screen.getByLabelText(/Flest søk/) as HTMLInputElement).value).toBe('4');
    expect((screen.getByLabelText(/Flest dokumenter som leses/) as HTMLInputElement).value).toBe(
      '6',
    );
    expect((screen.getByLabelText(/Flest tegn som leses/) as HTMLInputElement).value).toBe('12000');
    expect(screen.queryByText(/Fast stegflyt/, { selector: 'h3' })).toBeNull();
    expect(screen.queryByText(/Ukjent stegtype/)).toBeNull();
  });

  it.each([
    [
      { id: 'single-call', version: 1, config: { instructions: 'Svar kort.', temperature: 0.2 } },
      'Ett steg',
      'Temperatur',
      '0,2',
    ],
    [
      { id: 'rag-single-shot', version: 1, config: { generate: false, topK: 12 } },
      'Ett søk og ett svar',
      'Treff når den bare søker',
      '12',
    ],
    [
      { id: 'agent-loop', version: 1, config: { maxIterations: 5 } },
      'Agent (søker selv)',
      'Flest runder',
      '5',
    ],
    [
      { id: 'step-flow', version: 1, config: { flow: 'fact-checker@1' } },
      'Fast stegflyt',
      'Stegflyt',
      'fact-checker@1',
    ],
    [
      {
        id: 'remote-agent',
        version: 1,
        config: { endpoint: { url: 'https://motor.example.no/turn', residency: 'eu' } },
      },
      'Egen motor',
      'Adresse',
      'https://motor.example.no/turn',
    ],
  ])('maps strategy %#: %s', async (strategy, name, field, value) => {
    await renderLive('#/services/kunnskapsassistenten/setup/how', serviceWith(strategy));

    expect(await screen.findByRole('heading', { level: 3, name })).toBeTruthy();
    expect(screen.getByText(`${strategy.id}@1`)).toBeTruthy();
    expect(
      ((await screen.findByLabelText(new RegExp(`^${field}`))) as HTMLInputElement).value,
    ).toBe(value);
    expect(
      screen.getByRole('button', {
        name: new RegExp(`^Arbeidsmåte\\s*${name.replace(/[()]/g, '\\$&')}`),
      }),
    ).toBeTruthy();
  });

  it('says in the service builder that the chosen model ignores temperature', async () => {
    const strategy = { id: 'single-call', version: 1, config: { temperature: 0.2 } };
    const base = serviceWith(strategy);
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new URL(url, 'http://x').pathname.endsWith('/models')
        ? new Response(
            JSON.stringify({
              data: [
                {
                  id: 'foundry-openai/gpt-4o-2m-tps',
                  residency: 'global',
                  capabilities: [],
                  parameters: { temperature: { mode: 'unsupported' } },
                },
              ],
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        : base(input, init);
    };
    await renderLive('#/services/kunnskapsassistenten/setup/how', fetch);

    expect(await screen.findByText(/støtter ikke temperatur/)).toBeTruthy();
  });

  it.each(['', '/channels', '/versions', '/log'])(
    'has no assistant or dead panel at %s',
    async (path) => {
      await renderLive(`#/services/kunnskapsassistenten${path}`, kaPlatform);

      await screen.findByRole('navigation', { name: 'Tjenesten' });
      expect(screen.queryByRole('complementary', { name: 'Byggeassistent' })).toBeNull();
      expect(screen.queryByText(/KI-assistenten som setter opp tjenesten/)).toBeNull();
      expect(screen.queryByText(/Prøvekjøring fra portalen er ikke koblet til/)).toBeNull();
      expect(screen.queryByRole('link', { name: 'Slik fungerer tjenesten' })).toBeNull();
    },
  );
});
