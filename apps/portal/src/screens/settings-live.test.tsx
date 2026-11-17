// @vitest-environment jsdom
import {
  cleanup,
  configure,
  fireEvent,
  getConfig,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { strategyRoutes } from '../mock/strategies';
import { kari } from '../test-utils';

interface Call {
  path: string;
  method: string;
  reason: string | null;
  body: unknown;
}

const catalog = [
  {
    key: 'retrieval.retrieveTopK',
    description: 'Chunks fetched by id after merging.',
    category: 'retrieval',
    axis: 'service',
    sensitivity: 'normal',
    default: 100,
    settableAt: ['platform', 'tenant', 'service', 'call'],
    schema: { type: 'integer', exclusiveMinimum: 0, maximum: 9007199254740991 },
  },
  {
    key: 'retrieval.merge.mode',
    description: 'How results are merged.',
    category: 'retrieval',
    axis: 'service',
    sensitivity: 'normal',
    default: 'weighted-sum',
    settableAt: ['platform', 'tenant', 'service', 'call'],
    schema: { type: 'string', enum: ['weighted-sum', 'rrf'] },
  },
  {
    key: 'answers.writtenStandard',
    description: 'Written standard for answers.',
    category: 'answers',
    axis: 'service',
    sensitivity: 'normal',
    default: 'user',
    settableAt: ['platform', 'tenant', 'service', 'call'],
    schema: { type: 'string', enum: ['user', 'bokmal', 'nynorsk'] },
  },
  {
    key: 'usage.monthlyTokens',
    description: 'Tokens a tenant may use per calendar month.',
    category: 'usage',
    axis: 'service',
    sensitivity: 'normal',
    default: 50_000_000,
    settableAt: ['platform', 'tenant'],
    operatorOnly: true,
    schema: { type: 'integer', minimum: 1 },
  },
];

const effective = (tenantValue?: number, serviceValue?: number) => ({
  'retrieval.retrieveTopK': {
    key: 'retrieval.retrieveTopK',
    value: serviceValue ?? tenantValue ?? 80,
    source: serviceValue ? 'service' : tenantValue ? 'tenant' : 'platform',
    defaultVersion: 2,
    overridden: [
      { layer: 'default', value: 100 },
      ...(tenantValue || serviceValue ? [{ layer: 'platform', value: 80 }] : []),
      ...(serviceValue && tenantValue ? [{ layer: 'tenant', value: tenantValue }] : []),
    ],
    rejected: [],
  },
  'retrieval.merge.mode': {
    key: 'retrieval.merge.mode',
    value: 'weighted-sum',
    source: 'default',
    defaultVersion: 1,
    overridden: [],
    rejected: [],
  },
});

const definition = {
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: '991825827', id: 'ka', name: 'Kunnskapsassistenten' },
  spec: { purpose: 'Svar', settings: {} },
};

interface Options {
  onWrite?: (path: string, method: string) => Response | undefined;
  effectiveFails?: boolean;
  secret?: boolean;
  audit?: unknown[];
}

const otherSave = (key: string, reason: string) => ({
  task: 't9',
  tenant: '991825827',
  action: 'platform.setting.set',
  actor: 'employee:ola',
  actorName: 'Ola Nordmann',
  at: '2026-10-07T09:30:00Z',
  outcome: 'applied',
  target: `setting:${key}`,
  reason,
});

const platform = ({ onWrite, effectiveFails = false, secret = false, audit }: Options = {}) => {
  const calls: Call[] = [];
  const state: { tenant?: number | undefined; service?: number | undefined } = {};
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^(\/api)+/, '');
    const method = init?.method ?? 'GET';
    calls.push({
      path,
      method,
      reason: decodeURIComponent(new Headers(init?.headers).get('change-reason') ?? ''),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (method !== 'GET') {
      const answer = onWrite?.(path, method);
      if (answer) return answer;
    }
    if (effectiveFails && /\/settings\/effective$/.test(path))
      return new Response(JSON.stringify({ title: 'Internal error', status: 500 }), {
        status: 500,
      });
    if (secret && path === '/settings')
      return json({
        data: [
          ...catalog,
          {
            key: 'tools.lovdata.key',
            description: 'Key for Lovdata.',
            category: 'tools',
            axis: 'service',
            sensitivity: 'secret',
            default: null,
            settableAt: ['platform', 'tenant'],
          },
        ],
      });
    if (/\/settings\/answers\.writtenStandard$/.test(path) && method === 'PUT')
      return json({ task: 't2', value: {} });
    const served = strategyRoutes(path);
    if (served) return json(served);
    if (path === '/settings') return json({ data: catalog });
    if (/\/settings\/effective\?service=ka$/.test(path))
      return json(effective(state.tenant, state.service));
    if (/\/settings\/effective$/.test(path)) return json(effective(state.tenant));
    if (path.includes('?dryRun=true')) return json({ dryRun: true, tenant: {}, services: [] });
    if (/\/settings\/retrieval\.retrieveTopK$/.test(path) && method === 'PUT') {
      state.tenant = (calls.at(-1)?.body as { value: number }).value;
      return json({ task: 't1', value: {} });
    }
    if (path.endsWith('/settings/defaults/retrieval.retrieveTopK/changelog'))
      return json({
        data: [
          {
            key: 'retrieval.retrieveTopK',
            version: 2,
            value: 80,
            changedAt: '2026-10-01T08:00:00Z',
            changedBy: 'drift',
            reason: 'Færre treff gir raskere svar',
          },
        ],
      });
    if (path.endsWith('/audit'))
      return json({
        data: audit
          ? audit
          : state.tenant
            ? [
                {
                  task: 't1',
                  tenant: '991825827',
                  action: 'platform.setting.set',
                  actor: 'kari',
                  at: '2026-10-07T09:00:00Z',
                  outcome: 'applied',
                  target: 'setting:retrieval.retrieveTopK',
                  reason: 'Vi trenger flere treff',
                },
              ]
            : [],
      });
    if (/\/definitions\/services\/ka$/.test(path))
      return json({
        kind: 'Service',
        tenant: '991825827',
        id: 'ka',
        latest: {
          kind: 'Service',
          tenant: '991825827',
          id: 'ka',
          version: 3,
          definition,
          files: { 'prompts/ka.md': 'Svar kort.' },
        },
        versions: [],
      });
    if (path === '/definitions' && method === 'POST') {
      state.service = (
        calls.at(-1)?.body as { definition: { spec: { settings: Record<string, number> } } }
      ).definition.spec.settings['retrieval.retrieveTopK'];
      return json({ kind: 'Service', tenant: '991825827', id: 'ka', version: 4, definition });
    }
    if (path.endsWith('/definitions')) return json({ data: [] });
    if (path.startsWith('/models')) return json({ data: [] });
    if (path.startsWith('/datasets')) return json({ datasets: [] });
    return json({});
  };
  return { calls, fetch };
};

const renderLive = async (path: string, fetch: typeof globalThis.fetch) => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = path;
  return render(<App auth={auth} fetch={fetch} live />);
};

const grid = () => screen.findByRole('region', { name: 'Innstillinger per lag' });

const defaultTimeout = getConfig().asyncUtilTimeout;
beforeAll(() => configure({ asyncUtilTimeout: 5000 }));
afterAll(() => configure({ asyncUtilTimeout: defaultTimeout }));
beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('live settings', () => {
  it('shows platform settings with Norwegian names, effective value and source', async () => {
    const { fetch } = platform();
    await renderLive('#/settings/all', fetch);
    const region = await grid();

    const row = within(region)
      .getByRole('button', { name: 'Treff som hentes (top-k)' })
      .closest('tr') as HTMLElement;
    expect(within(row).getAllByText('80').length).toBeGreaterThan(0);
    expect(within(region).getByRole('button', { name: 'Måte å flette søkene på' })).toBeTruthy();
  });

  it('shows a limit Digdir sets read-only to the organisation, with a note that Digdir sets it', async () => {
    const { calls, fetch } = platform();
    await renderLive('#/settings/all', fetch);
    fireEvent.click(await within(await grid()).findByRole('button', { name: 'Tokens per måned' }));
    const side = await screen.findByRole('dialog');

    const edit = within(side).getByRole('region', { name: 'Digdir setter denne grensen' });
    expect(within(edit).getByText(/Ta kontakt med Digdir/)).toBeTruthy();
    expect(within(side).queryByLabelText(/Verdi/)).toBeNull();
    expect(within(side).queryByRole('button', { name: 'Forhåndsvis endring' })).toBeNull();
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('saves a tenant value with a reason and lists the changelog from the platform', async () => {
    const { calls, fetch } = platform();
    await renderLive('#/settings/all', fetch);
    fireEvent.click(
      await within(await grid()).findByRole('button', { name: 'Treff som hentes (top-k)' }),
    );
    const side = await screen.findByRole('dialog');

    const log = await within(side).findByRole('region', { name: 'Endringer her' });
    expect(within(log).getByText(/Plattformstandard v2: 80/)).toBeTruthy();
    expect(within(log).getByText('«Færre treff gir raskere svar»')).toBeTruthy();

    fireEvent.change(within(side).getByLabelText('Verdi'), { target: { value: '120' } });
    fireEvent.click(within(side).getByRole('button', { name: 'Forhåndsvis endring' }));
    const preview = await within(side).findByRole('region', { name: 'Forhåndsvisning' });
    fireEvent.change(within(preview).getByLabelText('Begrunnelse'), {
      target: { value: 'Vi trenger flere treff' },
    });
    fireEvent.click(within(preview).getByRole('button', { name: 'Lagre' }));

    expect(await within(side).findByText('«Vi trenger flere treff»')).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT' && !c.path.includes('dryRun'));
    expect(put?.path).toMatch(/\/tenants\/\d+\/settings\/retrieval\.retrieveTopK$/);
    expect(put?.body).toEqual({ value: 120 });
    expect(put?.reason).toBe('Vi trenger flere treff');
  });

  it('publishes a service value as a new version with the reason', async () => {
    const { calls, fetch } = platform();
    await renderLive('#/services/ka/settings', fetch);
    fireEvent.click(
      await within(await grid()).findByRole('button', { name: 'Treff som hentes (top-k)' }),
    );
    const side = await screen.findByRole('dialog');

    fireEvent.change(within(side).getByLabelText('Verdi'), { target: { value: '40' } });
    fireEvent.click(within(side).getByRole('button', { name: 'Forhåndsvis endring' }));
    const preview = await within(side).findByRole('region', { name: 'Forhåndsvisning' });
    fireEvent.change(within(preview).getByLabelText('Begrunnelse'), {
      target: { value: 'Tjenesten trenger færre treff' },
    });
    fireEvent.click(within(preview).getByRole('button', { name: 'Lagre' }));

    await screen.findByText(/er lagret/);
    const publish = calls.find((c) => c.method === 'POST' && c.path === '/definitions');
    expect(publish?.reason).toBe('Tjenesten trenger færre treff');
    expect(publish?.body).toEqual({
      definition: {
        ...definition,
        spec: { ...definition.spec, settings: { 'retrieval.retrieveTopK': 40 } },
      },
      files: { 'prompts/ka.md': 'Svar kort.' },
    });
  });
});

describe('Målform i svar', () => {
  it('lets a service inherit or choose its own, and publishes the choice', async () => {
    const { calls, fetch } = platform();
    await renderLive('#/services/ka/settings', fetch);
    const serviceLevel = await screen.findByRole('group', {
      name: 'Målform i svar, Tjeneste: Kunnskapsassistenten',
    });
    expect(within(serviceLevel).getByRole('radio', { name: 'Arv fra Virksomhet' })).toHaveProperty(
      'checked',
      true,
    );
    expect(screen.getByText('Nå: Samme som spørsmålet, fra Virksomhet.')).toBeTruthy();

    fireEvent.click(within(serviceLevel).getByRole('radio', { name: 'Bokmål' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));

    await screen.findByText(/Målform i svar er endret for Kunnskapsassistenten/);
    const publish = calls.find((c) => c.method === 'POST' && c.path === '/definitions');
    expect(publish?.reason).toBe('Målform i svar: Bokmål');
    expect(publish?.body).toMatchObject({
      definition: { spec: { settings: { 'answers.writtenStandard': 'bokmal' } } },
    });
  });
});

describe('Innstillinger: Vanlige', () => {
  const problem = (status: number, title: string) =>
    new Response(JSON.stringify({ title, status }), { status });

  it('opens on Vanlige and saves a changed written standard with the reason', async () => {
    const { calls, fetch } = platform();
    await renderLive('#/settings', fetch);
    expect(await screen.findByRole('tab', { name: 'Vanlige', selected: true })).toBeTruthy();
    const select = await screen.findByLabelText('Målform i svar');
    expect((select as HTMLSelectElement).value).toBe('user');

    fireEvent.change(select, { target: { value: 'nynorsk' } });
    const bar = screen.getByRole('region', { name: 'Du har endringer som ikke er lagret' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Lagre endringene' }));
    expect(await within(bar).findByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    fireEvent.change(within(bar).getByLabelText(/Hvorfor endrer du dette/), {
      target: { value: 'Vi svarer alltid på nynorsk' },
    });
    fireEvent.click(within(bar).getByRole('button', { name: 'Lagre endringene' }));

    expect(await screen.findByText(/^Lagret kl\./)).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT' && c.path.endsWith('answers.writtenStandard'));
    expect(put?.body).toEqual({ value: 'nynorsk' });
    expect(put?.reason).toBe('Vi svarer alltid på nynorsk');
    expect(
      screen.queryByRole('region', { name: 'Du har endringer som ikke er lagret' }),
    ).toBeNull();
  });

  it('shows a refused save as a refusal and keeps the choice', async () => {
    const { fetch } = platform({
      onWrite: (path) =>
        path.endsWith('answers.writtenStandard') ? problem(403, 'Forbidden') : undefined,
    });
    await renderLive('#/settings', fetch);
    fireEvent.change(await screen.findByLabelText('Målform i svar'), {
      target: { value: 'bokmal' },
    });
    fireEvent.change(screen.getByLabelText(/Hvorfor endrer du dette/), {
      target: { value: 'Vi svarer alltid på bokmål' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre endringene' }));

    expect(
      await screen.findByText(/ble ikke lagret: du mangler «Administrere tjenester»/),
    ).toBeTruthy();
    expect(screen.queryByText(/Lagret kl\./)).toBeNull();
    expect((screen.getByLabelText('Målform i svar') as HTMLSelectElement).value).toBe('bokmal');
  });

  it('shows what someone else saved first and keeps the choice and reason, without reloading', async () => {
    let conflicts = 1;
    const { calls, fetch } = platform({
      onWrite: (path) =>
        path.endsWith('answers.writtenStandard') && conflicts-- > 0
          ? problem(409, 'Changed elsewhere')
          : undefined,
    });
    await renderLive('#/settings', fetch);
    fireEvent.change(await screen.findByLabelText('Målform i svar'), {
      target: { value: 'bokmal' },
    });
    fireEvent.change(screen.getByLabelText(/Hvorfor endrer du dette/), {
      target: { value: 'Vi svarer alltid på bokmål' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre endringene' }));

    expect(await screen.findByText(/Noen andre lagret en endring/)).toBeTruthy();
    expect((screen.getByLabelText('Målform i svar') as HTMLSelectElement).value).toBe('bokmal');
    expect((screen.getByLabelText(/Hvorfor endrer du dette/) as HTMLInputElement).value).toBe(
      'Vi svarer alltid på bokmål',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Lagre mine endringer likevel' }));
    expect(await screen.findByText(/^Lagret kl\./)).toBeTruthy();
    expect(
      calls.filter((c) => c.method === 'PUT' && c.path.endsWith('answers.writtenStandard')),
    ).toHaveLength(2);
  });

  it('names who saved first, when and why, when a save meets a conflict', async () => {
    let conflicts = 1;
    const { fetch } = platform({
      onWrite: (path) =>
        path.endsWith('answers.writtenStandard') && conflicts-- > 0
          ? problem(409, 'Changed elsewhere')
          : undefined,
      audit: [otherSave('answers.writtenStandard', 'Vi svarer på nynorsk')],
    });
    await renderLive('#/settings', fetch);
    fireEvent.change(await screen.findByLabelText('Målform i svar'), {
      target: { value: 'bokmal' },
    });
    fireEvent.change(screen.getByLabelText(/Hvorfor endrer du dette/), {
      target: { value: 'Vi svarer alltid på bokmål' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre endringene' }));
    expect(
      await screen.findByText(
        /Lagret av Ola Nordmann 7\. okt\. 2026, 11:30: «Vi svarer på nynorsk»/,
      ),
    ).toBeTruthy();
  });

  it('shows an error instead of the defaults when the saved settings cannot be loaded', async () => {
    const { fetch } = platform({ effectiveFails: true });
    await renderLive('#/settings', fetch);
    expect(await screen.findByText(/Vi viser ikke standardverdiene i stedet/)).toBeTruthy();
    expect(screen.queryByLabelText('Målform i svar')).toBeNull();
    expect(screen.getByRole('button', { name: 'Prøv igjen' })).toBeTruthy();
  });

  it('asks before switching tab with unsaved changes', async () => {
    const { fetch } = platform();
    await renderLive('#/settings', fetch);
    fireEvent.change(await screen.findByLabelText('Målform i svar'), {
      target: { value: 'bokmal' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Alle innstillinger' }));
    expect(screen.getByText(/Vil du forlate siden uten å lagre/)).toBeTruthy();
    expect(window.location.hash).toBe('#/settings');
    fireEvent.click(screen.getByRole('button', { name: 'Forlat uten å lagre' }));
    expect(await grid()).toBeTruthy();
    expect(window.location.hash).toBe('#/settings/all');
  });

  it('shows the quota Digdir sets as text, not as a field', async () => {
    const { fetch } = platform();
    await renderLive('#/settings', fetch);
    expect(await screen.findByText(/50\s000\s000 tokens per måned/)).toBeTruthy();
    expect(screen.queryByLabelText('Tokens per måned')).toBeNull();
  });

  it('sends the old export address on to Alle innstillinger', async () => {
    const { fetch } = platform();
    await renderLive('#/settings?tab=transfer', fetch);
    expect(await grid()).toBeTruthy();
    expect(window.location.hash).toBe('#/settings/all');
    expect(screen.getByRole('heading', { name: 'Eksporter og importer' })).toBeTruthy();
  });
});

describe('Innstillinger: ærlig lagring i tabellen', () => {
  it('does not offer to save a secret value the portal cannot send', async () => {
    const { calls, fetch } = platform({ secret: true });
    await renderLive('#/settings/all', fetch);
    fireEvent.click(await within(await grid()).findByRole('button', { name: 'tools.lovdata.key' }));
    const side = await screen.findByRole('dialog');
    expect(within(side).getByText(/Hemmelige verdier kan ikke settes her ennå/)).toBeTruthy();
    expect(within(side).queryByLabelText('Ny hemmelig verdi')).toBeNull();
    expect(within(side).queryByRole('button', { name: 'Forhåndsvis endring' })).toBeNull();
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('shows a refused tenant save as a refusal, not a failure', async () => {
    const { fetch } = platform({
      onWrite: (path, method) =>
        method === 'PUT' && path.endsWith('retrieval.retrieveTopK')
          ? new Response(JSON.stringify({ title: 'Forbidden', status: 403 }), { status: 403 })
          : undefined,
    });
    await renderLive('#/settings/all', fetch);
    fireEvent.click(
      await within(await grid()).findByRole('button', { name: 'Treff som hentes (top-k)' }),
    );
    const side = await screen.findByRole('dialog');
    fireEvent.change(within(side).getByLabelText('Verdi'), { target: { value: '120' } });
    fireEvent.click(within(side).getByRole('button', { name: 'Forhåndsvis endring' }));
    const preview = await within(side).findByRole('region', { name: 'Forhåndsvisning' });
    fireEvent.change(within(preview).getByLabelText('Begrunnelse'), {
      target: { value: 'Vi trenger flere treff' },
    });
    fireEvent.click(within(preview).getByRole('button', { name: 'Lagre' }));
    expect(
      await within(side).findByText(
        'Endringen ble ikke lagret: du mangler «Administrere tjenester».',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/er lagret/)).toBeNull();
  });

  it('shows the value someone else saved first and lets the person save again', async () => {
    let conflicts = 1;
    const { calls, fetch } = platform({
      onWrite: (path, method) =>
        method === 'PUT' &&
        !path.includes('dryRun') &&
        path.endsWith('retrieval.retrieveTopK') &&
        conflicts-- > 0
          ? new Response(JSON.stringify({ title: 'Changed elsewhere', status: 409 }), {
              status: 409,
            })
          : undefined,
    });
    await renderLive('#/settings/all', fetch);
    fireEvent.click(
      await within(await grid()).findByRole('button', { name: 'Treff som hentes (top-k)' }),
    );
    const side = await screen.findByRole('dialog');
    fireEvent.change(within(side).getByLabelText('Verdi'), { target: { value: '120' } });
    fireEvent.click(within(side).getByRole('button', { name: 'Forhåndsvis endring' }));
    const preview = await within(side).findByRole('region', { name: 'Forhåndsvisning' });
    fireEvent.change(within(preview).getByLabelText('Begrunnelse'), {
      target: { value: 'Vi trenger flere treff' },
    });
    fireEvent.click(within(preview).getByRole('button', { name: 'Lagre' }));
    expect(await within(side).findByText(/Noen andre lagret denne innstillingen/)).toBeTruthy();
    expect((within(preview).getByLabelText('Begrunnelse') as HTMLTextAreaElement).value).toBe(
      'Vi trenger flere treff',
    );
    fireEvent.click(within(preview).getByRole('button', { name: 'Lagre min verdi likevel' }));
    expect(await within(side).findByText('«Vi trenger flere treff»')).toBeTruthy();
    expect(
      calls.filter(
        (c) => c.method === 'PUT' && !c.path.includes('dryRun') && c.path.endsWith('retrieveTopK'),
      ),
    ).toHaveLength(2);
  });

  it('names who saved the setting first, when and why, after a conflict in the panel', async () => {
    let conflicts = 1;
    const { fetch } = platform({
      onWrite: (path, method) =>
        method === 'PUT' &&
        !path.includes('dryRun') &&
        path.endsWith('retrieval.retrieveTopK') &&
        conflicts-- > 0
          ? new Response(JSON.stringify({ title: 'Changed elsewhere', status: 409 }), {
              status: 409,
            })
          : undefined,
      audit: [otherSave('retrieval.retrieveTopK', 'Færre treff for KA')],
    });
    await renderLive('#/settings/all', fetch);
    fireEvent.click(
      await within(await grid()).findByRole('button', { name: 'Treff som hentes (top-k)' }),
    );
    const side = await screen.findByRole('dialog');
    fireEvent.change(within(side).getByLabelText('Verdi'), { target: { value: '120' } });
    fireEvent.click(within(side).getByRole('button', { name: 'Forhåndsvis endring' }));
    const preview = await within(side).findByRole('region', { name: 'Forhåndsvisning' });
    fireEvent.change(within(preview).getByLabelText('Begrunnelse'), {
      target: { value: 'Vi trenger flere treff' },
    });
    fireEvent.click(within(preview).getByRole('button', { name: 'Lagre' }));
    const alert = await within(side).findByRole('alert');
    expect(alert.textContent).toMatch(
      /Lagret av Ola Nordmann 7\. okt\. 2026, 11:30: «Færre treff for KA»/,
    );
  });
});
