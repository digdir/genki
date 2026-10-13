// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

const platform = () => {
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
        data: state.tenant
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

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('live settings', () => {
  it('shows platform settings with Norwegian names, effective value and source', async () => {
    const { fetch } = platform();
    await renderLive('#/settings', fetch);
    const region = await grid();

    const row = within(region)
      .getByRole('button', { name: 'Treff som hentes (top-k)' })
      .closest('tr') as HTMLElement;
    expect(within(row).getAllByText('80').length).toBeGreaterThan(0);
    expect(within(region).getByRole('button', { name: 'Måte å flette søkene på' })).toBeTruthy();
  });

  it('saves a tenant value with a reason and lists the changelog from the platform', async () => {
    const { calls, fetch } = platform();
    await renderLive('#/settings', fetch);
    fireEvent.click(within(await grid()).getByRole('button', { name: 'Treff som hentes (top-k)' }));
    const side = screen.getByRole('dialog');

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
    fireEvent.click(within(await grid()).getByRole('button', { name: 'Treff som hentes (top-k)' }));
    const side = screen.getByRole('dialog');

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
  it('saves the tenant written standard with a reason', async () => {
    const { calls, fetch } = platform();
    await renderLive('#/settings', fetch);
    const tenantLevel = await screen.findByRole('group', { name: 'Målform i svar, Virksomhet' });
    expect(within(tenantLevel).getByRole('radio', { name: 'Samme som spørsmålet' })).toHaveProperty(
      'checked',
      true,
    );

    fireEvent.click(within(tenantLevel).getByRole('radio', { name: 'Nynorsk' }));
    expect(screen.getByText(/Samme som spørsmålet → Nynorsk/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    expect(await screen.findByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Vi svarer alltid på nynorsk' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));

    expect(
      await screen.findByText(/Målform i svar er endret for .*Endringen er logget\./),
    ).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT' && c.path.endsWith('answers.writtenStandard'));
    expect(put?.body).toEqual({ value: 'nynorsk' });
    expect(put?.reason).toBe('Vi svarer alltid på nynorsk');
  });

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
