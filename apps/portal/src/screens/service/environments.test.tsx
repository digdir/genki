// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import { exampleUsage, mockFetch } from '../../mock';
import { useRoute } from '../../hooks';
import { RightsProvider } from '../../Shell';
import { renderAt } from '../../test-utils';
import type { ClientView } from '../../types';
import { RunsTab } from '../log/RunsTab';
import { draftOf, specOf } from './ClientForm';
import { LogSection } from './LogSection';
import { ServiceKeys } from './ServiceKeys';
import { EnvironmentsSection } from './EnvironmentsSection';
import { Versions } from './Versions';

document.getAnimations ??= () => [];
afterEach(cleanup);

const tenant = '991825827';
const asManager = (ui: ReactNode) => (
  <RightsProvider value={['manage-services']}>{ui}</RightsProvider>
);

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

const platform = (
  routes: Record<string, (call: Call) => unknown>,
  { slow = false }: { slow?: boolean } = {},
) => {
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
    if (slow) await new Promise((resolve) => setTimeout(resolve, 20));
    const handler = routes[`${method} ${path.split('?')[0] ?? ''}`];
    if (!handler)
      return new Response(JSON.stringify({ title: 'Not found', status: 404 }), { status: 404 });
    return new Response(JSON.stringify(handler(call)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, api: createApiClient({ baseUrl: '/api', fetch, token: () => 'kari' }) };
};

const versionRow = (version: number) => ({
  version,
  publishedBy: 'employee:ansattporten:kari',
  publishedAt: `2026-10-0${version}T10:00:00Z`,
  reason: `Versjon ${version}`,
});
const history = () => ({
  kind: 'Service',
  tenant,
  id: 'klarsprak',
  latest: {
    ...versionRow(3),
    kind: 'Service',
    tenant,
    id: 'klarsprak',
    definition: { apiVersion: 'genai/v1', kind: 'Service', metadata: { tenant, id: 'klarsprak' } },
    files: {},
  },
  versions: [versionRow(1), versionRow(2), versionRow(3)],
});
const definitionPath = `/tenants/${tenant}/definitions/services/klarsprak`;
const environmentsPath = `/tenants/${tenant}/services/klarsprak/environments`;
const env = (
  name: string,
  version: number,
  followsPublishes = false,
  previousVersion?: number,
) => ({
  name,
  version,
  followsPublishes,
  previousVersion: previousVersion ?? null,
});
const staged = () => ({
  latestVersion: 3,
  environments: [env('prod', 2, false, 1), env('test', 3, true)],
});
const reasonOf = (call: Call | undefined) =>
  decodeURIComponent(call?.headers.get('change-reason') ?? '');

describe('service environments in the portal', () => {
  it('adds a test environment with a reason and says prod stays on the version it ran', async () => {
    let added = false;
    const { api, calls } = platform({
      [`GET ${definitionPath}`]: history,
      [`GET ${environmentsPath}`]: () =>
        added ? staged() : { latestVersion: 3, environments: [env('prod', 3, true)] },
      [`POST ${environmentsPath}`]: () => {
        added = true;
        return staged();
      },
    });
    render(asManager(<EnvironmentsSection api={api} tenant={tenant} serviceId="klarsprak" />));

    expect(await screen.findByText(/Tjenesten har bare prod/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Legg til miljø' }));
    expect((screen.getByLabelText('Navn') as HTMLInputElement).value).toBe('test');
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Testerne skal prøve nye versjoner' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Legg til' }));

    expect(
      await screen.findByText(
        'test er lagt til. Nye versjoner går dit, og prod står på versjon 3.',
      ),
    ).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST' && c.path === environmentsPath);
    expect(post?.body).toEqual({ name: 'test' });
    expect(reasonOf(post)).toBe('Testerne skal prøve nye versjoner');
    expect(await screen.findByRole('button', { name: 'Flere valg for test' })).toBeTruthy();
  });

  it('refuses an environment name that is not lowercase letters, digits and dashes before sending it', async () => {
    const { api, calls } = platform({
      [`GET ${definitionPath}`]: history,
      [`GET ${environmentsPath}`]: () => ({
        latestVersion: 3,
        environments: [env('prod', 3, true)],
      }),
    });
    render(asManager(<EnvironmentsSection api={api} tenant={tenant} serviceId="klarsprak" />));

    fireEvent.click(await screen.findByRole('button', { name: 'Legg til miljø' }));
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Test miljø' } });
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Testerne skal prøve nye versjoner' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Legg til' }));

    expect(await screen.findByText(/Navnet må begynne med en liten bokstav/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('puts the version test runs in prod without publishing', async () => {
    const { api, calls } = platform({
      [`GET ${definitionPath}`]: history,
      [`GET ${environmentsPath}`]: staged,
      [`POST ${environmentsPath}/prod/promote`]: () => ({
        latestVersion: 3,
        environments: [env('prod', 3, false, 2), env('test', 3, true)],
      }),
    });
    render(asManager(<EnvironmentsSection api={api} tenant={tenant} serviceId="klarsprak" />));

    fireEvent.click(
      await screen.findByRole('button', { name: 'Ta versjonen test kjører i bruk i prod' }),
    );
    expect(
      screen.getByText(/prod går fra versjon 2 til versjon 3, som test kjører nå/),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Testerne er fornøyde' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk i prod' }));

    expect(await screen.findByText('prod kjører nå versjon 3.')).toBeTruthy();
    const promote = calls.find((c) => c.path.endsWith('/prod/promote'));
    expect(promote?.body).toEqual({ from: 'test' });
    expect(reasonOf(promote)).toBe('Testerne er fornøyde');
    expect(calls.some((c) => c.method === 'POST' && c.path === '/definitions')).toBe(false);
  });

  it('rolls an environment back to the version it ran before its last change by default', async () => {
    const { api, calls } = platform({
      [`GET ${definitionPath}`]: history,
      [`GET ${environmentsPath}`]: staged,
      [`POST ${environmentsPath}/prod/rollback`]: () => ({
        latestVersion: 3,
        environments: [env('prod', 1, false, 2), env('test', 3, true)],
      }),
    });
    render(asManager(<EnvironmentsSection api={api} tenant={tenant} serviceId="klarsprak" />));

    fireEvent.click(await screen.findByRole('button', { name: 'Rull tilbake prod' }));
    const choice = screen.getByLabelText('Versjonen prod skal kjøre') as HTMLSelectElement;
    expect(choice.value).toBe('1');
    expect(
      within(choice)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Versjon 3', 'Versjon 1, som kjørte før siste endring']);
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Versjon 2 svarer feil' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rull tilbake prod' }));

    expect(await screen.findByText('prod kjører nå versjon 1.')).toBeTruthy();
    const rollback = calls.find((c) => c.path.endsWith('/prod/rollback'));
    expect(rollback?.body).toEqual({ version: 1 });
  });

  it('keeps the success message on screen while the versions reload after a change', async () => {
    let promoted = false;
    const after = () => ({
      latestVersion: 3,
      environments: [env('prod', 3, false, 2), env('test', 3, true)],
    });
    const { api } = platform(
      {
        [`GET ${definitionPath}`]: history,
        [`GET ${environmentsPath}`]: () => (promoted ? after() : staged()),
        [`POST ${environmentsPath}/prod/promote`]: () => {
          promoted = true;
          return after();
        },
      },
      { slow: true },
    );
    render(asManager(<EnvironmentsSection api={api} tenant={tenant} serviceId="klarsprak" />));

    fireEvent.click(
      await screen.findByRole('button', { name: 'Ta versjonen test kjører i bruk i prod' }),
    );
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Testerne er fornøyde' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk i prod' }));

    expect(await screen.findByText('prod kjører nå versjon 3.')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Miljøer' });
    await waitFor(() => expect(within(list).getAllByText('Kjører versjon 3')).toHaveLength(2));
    expect(screen.getByText('prod kjører nå versjon 3.')).toBeTruthy();
  });

  it('removes an environment with a reason after the owner confirms', async () => {
    let removed = false;
    const { api, calls } = platform({
      [`GET ${definitionPath}`]: history,
      [`GET ${environmentsPath}`]: () => ({
        latestVersion: 3,
        environments: removed
          ? [env('prod', 3, true)]
          : [env('prod', 3, false, 2), env('test', 3, true)],
      }),
      [`DELETE ${environmentsPath}/test`]: () => {
        removed = true;
        return { latestVersion: 3, environments: [env('prod', 3, true)] };
      },
    });
    render(asManager(<EnvironmentsSection api={api} tenant={tenant} serviceId="klarsprak" />));

    fireEvent.click(await screen.findByRole('button', { name: 'Flere valg for test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fjern test' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Testmiljøet trengs ikke lenger' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Fjern test' }));

    expect(await screen.findByText('test er fjernet.')).toBeTruthy();
    const remove = calls.find((c) => c.method === 'DELETE');
    expect(remove?.path).toBe(`${environmentsPath}/test`);
    expect(reasonOf(remove)).toBe('Testmiljøet trengs ikke lenger');
    expect(await screen.findByText(/Tjenesten har bare prod/)).toBeTruthy();
  });

  it('keeps Rull tilbake and Fjern for a non-prod environment in a menu that works by keyboard', async () => {
    const { api } = platform({
      [`GET ${definitionPath}`]: history,
      [`GET ${environmentsPath}`]: staged,
    });
    render(asManager(<EnvironmentsSection api={api} tenant={tenant} serviceId="klarsprak" />));

    const more = await screen.findByRole('button', { name: 'Flere valg for test' });
    expect(screen.queryByRole('button', { name: 'Fjern test' })).toBeNull();
    expect(more.getAttribute('aria-expanded')).toBe('false');
    more.focus();
    fireEvent.click(more);

    expect(more.getAttribute('aria-expanded')).toBe('true');
    const rollback = screen.getByRole('button', { name: 'Rull tilbake test' });
    const remove = screen.getByRole('button', { name: 'Fjern test' });
    expect(document.activeElement).toBe(rollback);
    fireEvent.keyDown(rollback, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(remove);
    fireEvent.keyDown(remove, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rollback);
    fireEvent.keyDown(rollback, { key: 'Escape' });

    expect(screen.queryByRole('button', { name: 'Fjern test' })).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(screen.getByRole('button', { name: 'Rull tilbake prod' })).toBeTruthy();
  });

  it('marks each version with the environments that run it', async () => {
    const { api } = platform({
      [`GET ${definitionPath}`]: history,
      [`GET ${environmentsPath}`]: staged,
    });
    render(asManager(<Versions api={api} tenant={tenant} serviceId="klarsprak" />));

    const versions = await screen.findByRole('list', { name: 'Versjoner' });
    await waitFor(() => expect(within(versions).getByText('I bruk i prod')).toBeTruthy());
    const items = within(versions).getAllByRole('listitem');
    expect(within(items[0] as HTMLElement).getByText('I bruk i test')).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText('I bruk i prod')).toBeTruthy();
    expect(within(versions).queryByText('I bruk')).toBeNull();
  });

  it('sends who uses a new environment with it when the owner says', async () => {
    const { api, calls } = platform({
      [`GET ${definitionPath}`]: history,
      [`GET ${environmentsPath}`]: () => ({
        latestVersion: 3,
        environments: [env('prod', 3, true)],
      }),
      [`POST ${environmentsPath}`]: staged,
    });
    render(asManager(<EnvironmentsSection api={api} tenant={tenant} serviceId="klarsprak" />));

    fireEvent.click(await screen.findByRole('button', { name: 'Legg til miljø' }));
    fireEvent.change(screen.getByLabelText('Hvem bruker det (valgfritt)'), {
      target: { value: ' testerne i HR ' },
    });
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Testerne skal prøve nye versjoner' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Legg til' }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        name: 'test',
        description: 'testerne i HR',
      }),
    );
  });

  it('says on the card who uses an environment, with its runs today', async () => {
    const { api } = platform({
      [`GET ${definitionPath}`]: history,
      [`GET ${environmentsPath}`]: () => ({
        latestVersion: 3,
        environments: [
          env('prod', 2, false, 1),
          { ...env('test', 3, true), description: 'testerne i HR' },
        ],
      }),
      [`GET /tenants/${tenant}/tasks`]: () => ({ data: [], total: 14, offset: 0, limit: 1 }),
    });
    render(asManager(<EnvironmentsSection api={api} tenant={tenant} serviceId="klarsprak" />));

    const list = await screen.findByRole('list', { name: 'Miljøer' });
    await waitFor(() =>
      expect(list.textContent).toContain('14 kjøringer i dag, fra testerne i HR.'),
    );
  });

  it('lists the history of the environments newest first', async () => {
    const { api } = platform({
      [`GET ${definitionPath}`]: history,
      [`GET ${environmentsPath}`]: staged,
      [`GET /tenants/${tenant}/services/klarsprak/environment-history`]: () => ({
        data: [
          {
            environment: 'prod',
            action: 'promoted',
            version: 2,
            previousVersion: 1,
            from: 'test',
            at: '2026-11-12T09:14:00Z',
            by: 'employee:ansattporten:kari',
            byName: 'Kari Nordmann',
            reason: 'Testet i HR',
          },
          {
            environment: 'test',
            action: 'added',
            version: null,
            previousVersion: null,
            at: '2026-10-01T08:00:00Z',
            by: 'employee:ansattporten:ola',
            byName: 'Ola Hansen',
            reason: '',
          },
        ],
        total: 2,
      }),
    });
    render(asManager(<EnvironmentsSection api={api} tenant={tenant} serviceId="klarsprak" />));

    const list = await screen.findByRole('list', { name: 'Historikk' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      '12. nov 10:14 · prod gikk fra versjon 1 til 2, tatt i bruk av Kari Nordmann: «Testet i HR»',
      '3. okt 12:00 · test fikk versjon 3 ved publisering',
      '2. okt 12:00 · test fikk versjon 2 ved publisering',
      '1. okt 10:00 · test ble lagt til av Ola Hansen',
    ]);
  });

  it('keeps Ta i bruk i prod disabled with the reason when prod runs that version', async () => {
    const { api, calls } = platform({
      [`GET ${definitionPath}`]: history,
      [`GET ${environmentsPath}`]: () => ({
        latestVersion: 3,
        environments: [env('prod', 3, false, 2), env('test', 3, true)],
      }),
    });
    render(asManager(<EnvironmentsSection api={api} tenant={tenant} serviceId="klarsprak" />));

    const promote = await screen.findByRole('button', {
      name: 'Ta versjonen test kjører i bruk i prod',
    });
    expect(promote.getAttribute('aria-disabled')).toBe('true');
    expect(promote.getAttribute('aria-describedby')).toBeTruthy();
    expect(
      document.getElementById(promote.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('prod kjører allerede versjon 3.');
    fireEvent.click(promote);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('puts the menu for a non-prod environment right after Ta i bruk i prod, before the reason', async () => {
    const { api } = platform({
      [`GET ${definitionPath}`]: history,
      [`GET ${environmentsPath}`]: () => ({
        latestVersion: 3,
        environments: [env('prod', 3, false, 2), env('test', 3, true)],
      }),
    });
    render(asManager(<EnvironmentsSection api={api} tenant={tenant} serviceId="klarsprak" />));

    const promote = await screen.findByRole('button', {
      name: 'Ta versjonen test kjører i bruk i prod',
    });
    const more = screen.getByRole('button', { name: 'Flere valg for test' });
    const reason = screen.getByText('prod kjører allerede versjon 3.');
    expect(promote.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(more.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the environments without actions to a member who may not manage services', async () => {
    const { api } = platform({
      [`GET ${definitionPath}`]: history,
      [`GET ${environmentsPath}`]: staged,
    });
    render(<EnvironmentsSection api={api} tenant={tenant} serviceId="klarsprak" />);

    const list = await screen.findByRole('list', { name: 'Miljøer' });
    expect(within(list).getByText('Kjører versjon 2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Legg til miljø' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Rull tilbake/ })).toBeNull();
  });

  it('filters the service run log by environment', async () => {
    const run = (id: string, environment: string) => ({
      id,
      status: 'completed',
      service: 'klarsprak',
      capability: 'klarsprak',
      environment,
      excerpt: `Kjøring ${id}`,
      createdAt: '2026-10-07T10:00:00Z',
      endedAt: null,
    });
    const { api, calls } = platform({
      [`GET ${environmentsPath}`]: staged,
      [`GET /tenants/${tenant}/tasks`]: (call) =>
        call.path.includes('environment=test')
          ? { data: [run('t2', 'test')], total: 1 }
          : { data: [run('t1', 'prod'), run('t2', 'test')], total: 2 },
    });
    render(<LogSection api={api} tenant={tenant} id="klarsprak" runId={undefined} live />);

    expect(await screen.findByText('Kjøring t1')).toBeTruthy();
    fireEvent.change(await screen.findByLabelText('Miljø'), { target: { value: 'test' } });

    await waitFor(() => expect(screen.queryByText('Kjøring t1')).toBeNull());
    expect(screen.getByText('Kjøring t2')).toBeTruthy();
    expect((screen.getByLabelText('Miljø') as HTMLSelectElement).value).toBe('test');
    const asked = calls
      .filter((c) => c.path.includes('/tasks?'))
      .map((c) => new URL(c.path, 'http://portal').searchParams);
    expect(
      asked.some((q) => q.get('service') === 'klarsprak' && q.get('environment') === 'test'),
    ).toBe(true);
  });

  it('filters the run log by environment only once a service is chosen', async () => {
    const { api, calls } = platform({
      [`GET /tenants/${tenant}/services`]: () => ({
        data: [{ id: 'klarsprak', name: 'Klarspråk' }],
      }),
      [`GET /tenants/${tenant}/tasks`]: () => ({ data: [], total: 4 }),
      [`GET ${environmentsPath}`]: staged,
    });
    window.location.hash = '#/log';
    const Routed = () => {
      const [route] = useRoute();
      return <RunsTab api={api} tenant={tenant} live query={route.query} />;
    };
    render(<Routed />);

    expect(await screen.findByRole('option', { name: 'Klarspråk' })).toBeTruthy();
    expect(screen.queryByLabelText('Miljø')).toBeNull();
    fireEvent.change(screen.getByLabelText('Tjeneste'), { target: { value: 'klarsprak' } });
    fireEvent.change(await screen.findByLabelText('Miljø'), { target: { value: 'test' } });

    await waitFor(() =>
      expect(
        calls.some((c) => /\/tasks\?service=klarsprak&environment=test&from=/.test(c.path)),
      ).toBe(true),
    );
  });

  it('binds a new service key to the environments the owner chooses', async () => {
    const { api, calls } = platform({
      [`GET /tenants/${tenant}/services/klarsprak/api-keys`]: () => ({ keys: [] }),
      [`POST /tenants/${tenant}/services/klarsprak/api-keys`]: () => ({
        key: 'gp_x',
        apiKey: { id: 'k1', name: 'Testserver', environments: ['test'] },
      }),
    });
    render(
      <ServiceKeys
        api={api}
        tenant={tenant}
        service="klarsprak"
        clients={[]}
        environments={['prod', 'test']}
        onFlash={() => undefined}
        createRequest={1}
      />,
    );

    fireEvent.change(await screen.findByLabelText('Navn'), { target: { value: 'Testserver' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'test' }));
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Testserveren skal bare nå test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lag nøkkel' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST');
    expect((post?.body as { environments?: string[] }).environments).toEqual(['test']);
  });

  it('keeps the environments of a client when it is edited and saved', () => {
    const client: ClientView = {
      definition: {
        apiVersion: 'genai/v1',
        kind: 'Client',
        metadata: { tenant, id: 'testflate', name: 'Testflate' },
        spec: {
          service: 'klarsprak',
          environments: ['test'],
          kind: 'server',
          channels: ['openai'],
          allowedOrigins: [],
        },
      },
      version: 1,
      updatedAt: '2026-10-07T10:00:00Z',
      updatedBy: 'employee:ansattporten:kari',
      deliveries: [],
    };
    expect(specOf(draftOf(client, 'klarsprak'), 'klarsprak').environments).toEqual(['test']);
  });
  it('filters usage by environment and says the quota still covers the whole organisation', async () => {
    const calls: string[] = [];
    const tally = exampleUsage.totals;
    const base = mockFetch(undefined, undefined, undefined, undefined, {
      usage: {
        ...exampleUsage,
        byEnvironment: [
          { environment: 'prod', usage: tally },
          { environment: 'test', usage: tally },
        ],
      },
    });
    await renderAt('#/statistics', async (input, init) => {
      calls.push(String(input));
      return base(input, init);
    });

    fireEvent.change(await screen.findByLabelText('Miljø'), { target: { value: 'test' } });

    expect(
      await screen.findByText(/Viser bare bruken fra kjøringene i miljøet test\./),
    ).toBeTruthy();
    expect(calls.some((c) => /\/usage\?days=190&environment=test$/.test(c))).toBe(true);
    expect((screen.getByLabelText('Miljø') as HTMLSelectElement).value).toBe('test');
  });
});
