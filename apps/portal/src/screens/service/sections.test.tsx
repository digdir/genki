// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { createApiClient } from '../../api';
import { RightsProvider } from '../../Shell';
import { LiveChanges } from '../changes/LiveChanges';
import { LiveNewService } from '../services/LiveNewService';
import { LiveTransfer } from '../settings/LiveTransfer';
import { DefinitionEditor } from './DefinitionEditor';
import { TestRun } from './TestRun';
import { Versions } from './Versions';

const asManager = (ui: ReactNode) => (
  <RightsProvider value={['manage-services']}>{ui}</RightsProvider>
);

document.getAnimations ??= () => [];
afterEach(cleanup);

const tenant = '991825827';
const definition = (instructions: string, version: number) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id: 'klarsprak', name: 'Klarspråk', version },
  spec: {
    purpose: 'Skriv om til klart språk',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions } },
    model: { primary: 'foundry-openai/gpt-4o', residency: 'global' },
  },
});
const versionRow = (version: number, reason: string) => ({
  version,
  publishedBy: 'employee:ansattporten:kari',
  publishedAt: '2026-10-0' + String(version) + 'T10:00:00Z',
  reason,
});

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

const platform = (routes: Record<string, (call: Call) => unknown>) => {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^\/api/, '');
    const method = init?.method ?? 'GET';
    const call: Call = {
      method,
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    const key = `${method} ${path.split('?')[0] ?? ''}`;
    const handler = routes[key];
    if (!handler)
      return new Response(JSON.stringify({ title: 'Not found', status: 404 }), { status: 404 });
    const reply = handler(call) as { status?: unknown };
    const status =
      typeof reply.status === 'number'
        ? reply.status
        : method === 'POST' && key === 'POST /definitions'
          ? 201
          : 200;
    return new Response(JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, api: createApiClient({ baseUrl: '/api', fetch, token: () => 'kari' }) };
};

const service = `/tenants/${tenant}/definitions/services/klarsprak`;
const history = () => ({
  kind: 'Service',
  tenant,
  id: 'klarsprak',
  latest: {
    ...versionRow(2, 'Kortere'),
    kind: 'Service',
    tenant,
    id: 'klarsprak',
    definition: definition('Svar kort.', 2),
    files: {},
  },
  versions: [versionRow(1, 'Første'), versionRow(2, 'Kortere')],
});
const published = (version: number) => ({
  ...versionRow(version, 'x'),
  kind: 'Service',
  tenant,
  id: 'klarsprak',
  definition: definition('x', version),
});

describe('service definition sections', () => {
  it('edits the YAML, validates it and publishes it as a new version with a reason', async () => {
    const { api, calls } = platform({
      [`GET ${service}`]: history,
      'POST /definitions/validate': () => ({ valid: true }),
      'POST /definitions': () => published(3),
    });
    render(<DefinitionEditor api={api} tenant={tenant} serviceId="klarsprak" />);

    const editor = await screen.findByLabelText('Tjenestedefinisjon (YAML)');
    expect((editor as HTMLTextAreaElement).value).toContain('instructions: Svar kort.');
    expect((editor as HTMLTextAreaElement).value).not.toMatch(/version: 2/);
    fireEvent.change(editor, {
      target: {
        value: (editor as HTMLTextAreaElement).value.replace('Svar kort.', 'Svar svært kort.'),
      },
    });
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Enda kortere svar' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Publiser ny versjon' }));

    expect(await screen.findByText('Versjon 3 er publisert og i bruk.')).toBeTruthy();
    const publish = calls.find((c) => c.method === 'POST' && c.path === '/definitions');
    expect(decodeURIComponent(publish?.headers.get('change-reason') ?? '')).toBe(
      'Enda kortere svar',
    );
    expect((publish?.body as { definition: string }).definition).toContain('Svar svært kort.');
  });

  it('shows schema errors from validation and does not publish', async () => {
    const { api, calls } = platform({
      [`GET ${service}`]: history,
      'POST /definitions/validate': () => ({
        status: 422,
        errors: [{ path: 'spec.riskClass', message: 'Invalid option' }],
      }),
    });
    render(<DefinitionEditor api={api} tenant={tenant} serviceId="klarsprak" />);
    const editor = await screen.findByLabelText('Tjenestedefinisjon (YAML)');
    fireEvent.change(editor, { target: { value: 'kind: Service' } });
    fireEvent.change(screen.getByLabelText('Begrunnelse'), { target: { value: 'Prøver noe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publiser ny versjon' }));

    expect(await screen.findByText('spec.riskClass')).toBeTruthy();
    expect(calls.some((c) => c.path === '/definitions')).toBe(false);
  });

  it('lists the version history and republishes an earlier version as a new one', async () => {
    const { api, calls } = platform({
      [`GET ${service}`]: history,
      [`GET ${service}/versions/1`]: () => ({
        ...published(1),
        definition: definition('Svar langt.', 1),
      }),
      'POST /definitions': () => published(3),
    });
    render(<Versions api={api} tenant={tenant} serviceId="klarsprak" />);

    expect(await screen.findByText('Begrunnelse: Kortere')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Ta i bruk igjen/ }));
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Tilbake til lange svar' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Publiser versjon 1 på nytt' }));

    expect(await screen.findByText('Versjon 1 er publisert på nytt som versjon 3.')).toBeTruthy();
    const publish = calls.find((c) => c.method === 'POST' && c.path === '/definitions');
    const sent = (publish?.body as { definition: { metadata: Record<string, unknown> } })
      .definition;
    expect(sent.metadata.version).toBeUndefined();
    expect(JSON.stringify(sent)).toContain('Svar langt.');
  });

  it('test runs the definition in use once and links the run in the log', async () => {
    const { api, calls } = platform({
      [`GET ${service}`]: history,
      [`POST /tenants/${tenant}/definitions/test-run`]: () => ({
        ok: true,
        task: 't-9',
        answer: 'Kort svar.',
      }),
    });
    render(<TestRun api={api} tenant={tenant} serviceId="klarsprak" />);

    fireEvent.change(screen.getByLabelText('Spørsmål eller tekst'), { target: { value: 'Hei' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør prøve' }));

    expect(await screen.findByText('Kort svar.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Se kjøringen i Logg' }).getAttribute('href')).toBe(
      '#/log/t-9',
    );
    const run = calls.find((c) => c.path.endsWith('/test-run'));
    expect(run?.body).toMatchObject({
      query: 'Hei',
      definition: { metadata: { id: 'klarsprak' } },
    });
  });
});

describe('a test run that fails', () => {
  const failing = (body: Record<string, unknown>) =>
    platform({
      [`GET ${service}`]: history,
      [`POST /tenants/${tenant}/definitions/test-run`]: () => ({ status: 502, ...body }),
    });
  const runIt = async (api: ReturnType<typeof failing>['api']) => {
    render(<TestRun api={api} tenant={tenant} serviceId="klarsprak" />);
    fireEvent.change(screen.getByLabelText('Spørsmål eller tekst'), { target: { value: 'Hei' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør prøve' }));
  };

  it('names the step, shows the technical message and links the run in the log', async () => {
    const { api } = failing({
      title: 'Steget «dokumenter» feilet. Tjenesten feilet underveis.',
      code: 'strategy_error',
      step: 'dokumenter',
      runId: 'r-8c21',
      errors: [{ path: '', message: 'search returned 0 hits' }],
    });
    await runIt(api);

    expect(await screen.findByRole('heading', { name: 'Kjøringen feilet' })).toBeTruthy();
    expect(screen.getByText('Steget «dokumenter» feilet.').tagName).toBe('STRONG');
    expect(document.querySelector('.run-failure-detail')?.textContent).toContain(
      'message: search returned 0 hits',
    );
    expect(screen.getByRole('link', { name: 'Se kjøringen i Logg' }).getAttribute('href')).toBe(
      '#/log/r-8c21',
    );
  });

  it('says the model did not answer when the model failed', async () => {
    const { api } = failing({ title: 'Vi fikk ikke svar fra modellen.', code: 'model_error' });
    await runIt(api);

    expect(
      await screen.findByRole('heading', { name: 'Vi fikk ikke svar fra modellen' }),
    ).toBeTruthy();
    expect(screen.getByText(/Det er ikke noe galt med oppsettet/)).toBeTruthy();
  });
});

describe('creating a service in live mode', () => {
  it('preselects the model the platform picks for new services, not the first in the list', async () => {
    window.location.hash = '#/services/new';
    const { api } = platform({
      'GET /models': () => ({
        data: [
          { id: 'foundry-claude/claude-fable-5', residency: 'eu', capabilities: [] },
          { id: 'foundry-openai/gpt-4o-mini', residency: 'eu', capabilities: [] },
        ],
      }),
      [`GET /tenants/${tenant}/definitions/template`]: () => ({
        definition: {
          spec: { model: { primary: 'foundry-openai/gpt-4o-mini', residency: 'eu' } },
        },
      }),
    });
    render(<LiveNewService api={api} tenant={tenant} />);

    await waitFor(() =>
      expect((screen.getByLabelText('Modell') as HTMLSelectElement).value).toBe(
        'foundry-openai/gpt-4o-mini',
      ),
    );
  });

  it('publishes a real definition from the form and opens the new service', async () => {
    window.location.hash = '#/services/new';
    const { api, calls } = platform({
      'GET /models': () => ({
        data: [{ id: 'foundry-openai/gpt-4o', residency: 'global', capabilities: [] }],
      }),
      'POST /definitions/validate': () => ({ valid: true }),
      'POST /definitions': () => ({ ...published(1), id: 'svarbrev' }),
    });
    render(<LiveNewService api={api} tenant={tenant} />);

    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Svarbrev' } });
    fireEvent.change(screen.getByLabelText('Formål'), { target: { value: 'Utkast til svarbrev' } });
    fireEvent.change(screen.getByLabelText('Instruksjoner til modellen'), {
      target: { value: 'Skriv høflig.' },
    });
    await screen.findByRole('option', { name: /gpt-4o/ });
    fireEvent.click(screen.getByRole('button', { name: 'Opprett og publiser' }));

    await waitFor(() => expect(window.location.hash).toBe('#/services/svarbrev'));
    const publish = calls.find((c) => c.method === 'POST' && c.path === '/definitions');
    expect(publish?.body).toMatchObject({
      definition: {
        metadata: { tenant, id: 'svarbrev', name: 'Svarbrev' },
        spec: {
          purpose: 'Utkast til svarbrev',
          strategy: { id: 'single-call', config: { instructions: 'Skriv høflig.' } },
          model: { primary: 'foundry-openai/gpt-4o', residency: 'global' },
        },
      },
    });
    expect(decodeURIComponent(publish?.headers.get('change-reason') ?? '')).toBe('Ny tjeneste');
  });

  it('refuses to publish without a name, purpose and instructions', async () => {
    const { api, calls } = platform({
      'GET /models': () => ({
        data: [{ id: 'foundry-openai/gpt-4o', residency: 'global', capabilities: [] }],
      }),
    });
    render(<LiveNewService api={api} tenant={tenant} />);
    await screen.findByRole('option', { name: /gpt-4o/ });
    fireEvent.click(screen.getByRole('button', { name: 'Opprett og publiser' }));

    expect(await screen.findByText('Gi tjenesten et navn.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('tenant export and import in live mode', () => {
  const bundle = {
    format: 'genai-tenant-export/v1',
    tenant,
    exportedAt: '2026-10-07T10:00:00Z',
    definitions: [{ definition: definition('Svar kort.', 2), files: {} }],
    settings: { values: { 'retrieval.topK': 8 }, pins: {} },
  };

  it('exports the bundle from the platform', async () => {
    const { api } = platform({ [`GET /tenants/${tenant}/export`]: () => bundle });
    render(
      asManager(
        <LiveTransfer api={api} tenant={tenant} tenantName="Digdir" onFlash={() => undefined} />,
      ),
    );

    expect(await screen.findByText('1 definisjoner, 1 innstillinger')).toBeTruthy();
    expect(screen.getByLabelText('Innholdet i eksportfilen').textContent).toContain(
      'genai-tenant-export/v1',
    );
  });

  it('dry runs an import, then applies it with a reason', async () => {
    const { api, calls } = platform({
      [`GET /tenants/${tenant}/export`]: () => bundle,
      [`POST /tenants/${tenant}/import`]: (call) => ({
        dryRun: call.path.includes('dryRun=true'),
        plan: [{ target: `Service:${tenant}/klarsprak`, action: 'update', conflict: false }],
      }),
    });
    render(
      asManager(
        <LiveTransfer api={api} tenant={tenant} tenantName="Digdir" onFlash={() => undefined} />,
      ),
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Importer fra fil' }));
    const file = new File([JSON.stringify(bundle)], 'eksport.json', { type: 'application/json' });
    fireEvent.change(screen.getByLabelText('Eksportfil (JSON)'), { target: { files: [file] } });
    await screen.findByText('eksport.json');
    await screen.findByText('Tjenester og stegflyter');
    fireEvent.click(screen.getByRole('button', { name: 'Kjør prøvekjøring' }));

    expect(await screen.findByText('Prøvekjøring: ingenting er endret ennå')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Flytter fra test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk endringene' }));

    expect(await screen.findByText('Importen er ferdig')).toBeTruthy();
    const applied = calls.filter((c) => c.path.includes('/import'));
    expect(applied.map((c) => c.path.includes('dryRun=true'))).toEqual([true, false]);
    expect(decodeURIComponent(applied[1]?.headers.get('change-reason') ?? '')).toBe(
      'Flytter fra test',
    );
  });
});

describe('the change log in live mode', () => {
  it("lists the tenant's audit entries, newest first", async () => {
    const { api } = platform({
      [`GET /tenants/${tenant}/audit`]: () => ({
        data: [
          {
            task: 'a1',
            tenant,
            action: 'platform.service.publish',
            actor: 'employee:ansattporten:kari',
            at: '2026-10-01T10:00:00Z',
            outcome: 'applied',
            target: 'platform.service.publish',
            reason: 'x',
          },
          {
            task: 'a2',
            tenant,
            action: 'platform.apikeys.create',
            actor: 'employee:ansattporten:ola',
            at: '2026-10-02T10:00:00Z',
            outcome: 'applied',
            target: 'api-key:1/k',
            reason: 'y',
          },
        ],
      }),
    });
    render(asManager(<LiveChanges api={api} tenant={tenant} />));

    const items = await screen.findAllByRole('listitem');
    expect(items[0]?.textContent).toContain('laget API-nøkkelen 1/k');
    expect(items[1]?.textContent).toContain('publiserte');
  });

  it("shows the person's name for a change, and Digdir for an operator", async () => {
    const { api } = platform({
      [`GET /tenants/${tenant}/audit`]: () => ({
        data: [
          {
            task: 'b1',
            tenant,
            action: 'platform.testset.save',
            actor: 'employee:ansattporten:kari',
            actorName: 'Kari Nordmann',
            at: '2026-10-01T10:00:00Z',
            outcome: 'applied',
            target: 'test-set:991825827/kjerne@2',
            reason: 'x',
          },
          {
            task: 'b2',
            tenant,
            action: 'platform.service.publish',
            actor: 'operator:entra:lise',
            actorName: 'Lise Dahl',
            onBehalfOf: tenant,
            at: '2026-10-02T10:00:00Z',
            outcome: 'applied',
            target: 'Service:klarsprak@3',
            reason: 'y',
          },
        ],
      }),
    });
    render(asManager(<LiveChanges api={api} tenant={tenant} />));

    const items = await screen.findAllByRole('listitem');
    expect(items[0]?.textContent).toMatch(/^Digdir publiserte klarsprak, versjon 3/);
    expect(items[1]?.textContent).toMatch(/^Kari Nordmann lagret testsettet kjerne, versjon 2/);
    expect(screen.queryByText(/Ansatt i virksomheten/)).toBeNull();
  });
});
