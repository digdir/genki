import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { testContext } from '@genai/port-embedding/testing';
import { knowledgeProfiles } from '@genai/port-knowledge';
import { createPool } from '@genai/providers-postgres';
import type { AssistantProposal } from '@genai/strategy-builder';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { storeProposal, type CatalogProposal } from './proposals.js';

const digdir = '991825827';
const other = '999888777';

const principals: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services'] }],
  },
};

let container: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createPool>;
let source: ReturnType<typeof createPool>;
const throwawayPassword = () => randomBytes(9).toString('base64url');
const readerPassword = throwawayPassword();
let login: { port: number; user: string; password: string };

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  pool = createPool({ connectionString: container.getConnectionUri() });
  await pool.query('CREATE DATABASE fagsystem');
  const uri = new URL(container.getConnectionUri());
  uri.pathname = '/fagsystem';
  source = createPool({ connectionString: uri.toString() });
  await source.query(`
    CREATE TABLE saker (
      id int PRIMARY KEY, saksnummer text, tittel text, sammendrag text, status text,
      avsluttet date, personnummer text
    );
    INSERT INTO saker VALUES
      (1, '2026/101', 'Klage på vedtak om tilskudd', 'Klagen ble tatt til følge etter ny vurdering.', 'avsluttet', '2026-03-01', '01019012345'),
      (2, '2026/102', 'Søknad om driftstilskudd', 'Søknaden om driftstilskudd er under behandling.', 'åpen', null, '02029012345'),
      (3, '2026/103', 'Innsyn i postjournal', 'Innsyn ble gitt i postjournalen for mars.', 'avsluttet', '2026-04-11', '03039012345');
    CREATE TABLE logg (n int);
    CREATE FUNCTION skriv() RETURNS int LANGUAGE sql AS $$ INSERT INTO logg VALUES (1) RETURNING n $$;
    CREATE VIEW skrivende AS SELECT saker.*, skriv() AS n FROM saker;
    CREATE FUNCTION brekk(int) RETURNS text LANGUAGE plpgsql STABLE AS $$ BEGIN RAISE EXCEPTION 'raden kan ikke leses'; END $$;
    CREATE VIEW brutt AS SELECT id, tittel, brekk(id) AS sammendrag, status FROM saker;
    CREATE FUNCTION sakte(text) RETURNS text LANGUAGE plpgsql STABLE AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN $1; END $$;
    CREATE VIEW treg AS SELECT id, saksnummer, tittel, sakte(sammendrag) AS sammendrag, status, avsluttet FROM saker;
    CREATE ROLE leser LOGIN PASSWORD '${readerPassword}';
    GRANT SELECT ON saker, skrivende, brutt, treg TO leser;
    GRANT INSERT ON logg TO leser;
  `);
  login = { port: container.getPort(), user: 'leser', password: readerPassword };
}, 120_000);

afterAll(async () => {
  await source?.end();
  await pool?.end();
  await container?.stop();
});

const reason = 'Koblingen er gjennomgått';

const boot = async () => {
  const warnings: string[] = [];
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: {
        endpoints: {
          'platform-pg': {
            engine: 'pgvector',
            options: { connection: 'platform' },
            sharing: { tenants: '*' },
          },
        },
        datasets: [],
      },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({}),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const principal = principals[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
    egress: { testOverride: { allowLoopback: true } },
    onWarning: (message) => warnings.push(message),
    knowledgePool: pool,
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const call = (path: string, as: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${as}`,
        'content-type': 'application/json',
        'change-reason': 'Testendring',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const propose = async (title: string, table = 'saker') =>
    (await storeProposal(
      admin,
      principals.kari as Principal,
      digdir,
      { id: 'saksinnsyn', name: 'Saksinnsyn' },
      {
        id: 'forslag',
        level: 2,
        kind: 'connector',
        title,
        detail: 'Leser avsluttede saker fra fagsystemet',
        validation: { ok: true },
        requiresApproval: true,
        appliedToDraft: false,
        mapping: [{ table, becomes: 'document', fields: ['tittel', 'sammendrag'] }],
        source: {
          engine: 'postgres',
          host: '127.0.0.1',
          database: 'fagsystem',
          table,
          fields: {
            id: 'id',
            title: 'tittel',
            text: ['sammendrag'],
            date: 'avsluttet',
            metadata: ['saksnummer'],
          },
          filter: [{ column: 'status', op: 'eq', value: 'avsluttet' }],
        },
        permissions: [{ type: 'data', value: table, note: 'Bare lesing' }],
        tests: [],
      } satisfies AssistantProposal,
    )) as CatalogProposal;
  return { platform, admin, call, propose, warnings };
};

const json = async <T = Record<string, unknown>>(response: Response) =>
  (await response.json()) as T;

interface ConnectorView {
  id: string;
  status: string;
  dataset: string;
  connection: Record<string, unknown>;
  lastSync: { status: string; rows?: number; error?: string } | null;
}

const settled = async (call: Awaited<ReturnType<typeof boot>>['call'], id: string) => {
  for (let i = 0; i < 300; i++) {
    const view = await json<ConnectorView>(
      await call(`/tenants/${digdir}/connectors/${encodeURIComponent(id)}`, 'kari'),
    );
    if (view.status !== 'syncing' && view.status !== 'not_synced') return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the sync did not finish');
};

describe('a connector mapping approved from the builder assistant', () => {
  it('reads only closed cases into a searchable dataset, syncs again on demand and never shows the password', async () => {
    const logged: string[] = [];
    const capture = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(capture),
    );
    const { platform, admin, call, propose, warnings } = await boot();
    const proposal = await propose('Avsluttede saker');

    const approved = await call(`/tenants/${digdir}/proposals/${proposal.id}/approve`, 'kari', {
      body: { reason, connection: { ...login, tls: false } },
    });
    const approvedText = await approved.text();
    expect(approved.status).toBe(200);
    expect(approvedText).not.toContain(login.password);

    const listed = await json<{ data: ConnectorView[] }>(
      await call(`/tenants/${digdir}/connectors`, 'kari'),
    );
    expect(listed.data).toHaveLength(1);
    const id = listed.data[0]?.id ?? '';
    const first = await settled(call, id);
    expect(first).toMatchObject({
      status: 'connected',
      connection: {
        engine: 'postgres',
        host: '127.0.0.1',
        database: 'fagsystem',
        user: login.user,
        credentials: 'stored',
      },
      source: { table: 'saker', filter: [{ column: 'status', op: 'eq', value: 'avsluttet' }] },
      lastSync: { status: 'succeeded', rows: 2 },
    });
    expect(first.connection).not.toHaveProperty('password');

    const { ctx } = testContext();
    const search = (query: string) =>
      platform.knowledge
        .open(
          { kind: 'dataset', id: `${digdir}/${first.dataset}`, tenant: digdir },
          {
            ...ctx,
            tenant: digdir,
          },
        )
        .search({ query, profile: knowledgeProfiles.content });
    const closed = await search('klage');
    expect(closed.hits[0]?.text).toContain('Klagen ble tatt til følge');
    const open = await search('driftstilskudd');
    expect(open.hits.map((h) => h.text).join(' ')).not.toContain('under behandling');
    expect(JSON.stringify(closed)).not.toContain('01019012345');

    await source.query(
      "INSERT INTO saker VALUES (4, '2026/104', 'Tilsyn med kommunen', 'Tilsynet med kommunen er avsluttet uten avvik.', 'avsluttet', '2026-05-02', '04049012345')",
    );
    const again = await call(
      `/tenants/${digdir}/connectors/${encodeURIComponent(id)}/sync`,
      'kari',
      {
        body: {},
      },
    );
    expect(again.status).toBe(202);
    expect(await settled(call, id)).toMatchObject({ lastSync: { status: 'succeeded', rows: 3 } });
    expect((await search('tilsynet')).hits[0]?.text).toContain('uten avvik');

    const path = `/tenants/${digdir}/connectors/${encodeURIComponent(id)}`;
    const rotated = await call(`${path}/credentials`, 'kari', {
      method: 'PUT',
      body: { password: throwawayPassword() },
    });
    expect(rotated.status).toBe(200);
    expect(await rotated.text()).not.toContain(throwawayPassword());
    expect((await call(`${path}/sync`, 'kari', { body: {} })).status).toBe(202);
    expect(await settled(call, id)).toMatchObject({
      status: 'failed',
      lastSync: { error: expect.stringContaining('password authentication failed') },
    });
    expect(
      (
        await call(`${path}/credentials`, 'kari', {
          method: 'PUT',
          body: { password: login.password },
        })
      ).status,
    ).toBe(200);

    const pipelines = await call(`/tenants/${digdir}/datasets/${first.dataset}/pipelines`, 'kari');
    const pipelineText = await pipelines.text();
    expect(pipelineText).toContain(`secret://tenant/${digdir}/connector-`);
    expect(pipelineText).not.toContain(login.password);
    const proposals = await (await call(`/tenants/${digdir}/proposals`, 'kari')).text();
    const audit = JSON.stringify(await admin.audit(digdir));
    for (const text of [proposals, audit, JSON.stringify(listed), ...warnings, ...logged])
      expect(text).not.toContain(login.password);
    for (const spy of spies) spy.mockRestore();
  });

  it('refuses unknown columns, raw SQL, a view that writes and a wrong password at approval', async () => {
    const { call, propose, admin } = await boot();
    const approve = async (proposal: CatalogProposal, body: Record<string, unknown>) =>
      call(`/tenants/${digdir}/proposals/${proposal.id}/approve`, 'kari', {
        body: { reason, connection: { ...login, tls: false }, ...body },
      });
    const proposal = await propose('Saker med feil');
    const sourceWith = (patch: Record<string, unknown>) => ({
      source: {
        table: 'saker',
        fields: { id: 'id', title: 'tittel', text: ['sammendrag'] },
        ...patch,
      },
    });

    const unknown = await approve(proposal, {
      source: { table: 'saker', fields: { id: 'id', title: 'tittel', text: ['hemmelig_notat'] } },
    });
    expect(unknown.status).toBe(422);
    const unknownBody = await json<{ errors: Record<string, unknown>[] }>(unknown);
    expect(JSON.stringify(unknownBody)).toContain('unknown columns in public.saker');
    expect(unknownBody.errors[0]).toMatchObject({
      path: 'connection',
      code: 'columns',
      missing: ['hemmelig_notat'],
      known: expect.arrayContaining(['tittel', 'sammendrag', 'status']),
    });

    for (const table of [
      { table: 'borte', fields: { id: 'id', title: 'tittel', text: ['sammendrag'] } },
      { table: 'logg', fields: { id: 'n', title: 'n', text: ['n'] } },
    ]) {
      const unreadable = await approve(proposal, { source: table });
      expect(
        (await json<{ errors: Record<string, unknown>[] }>(unreadable)).errors[0],
      ).toMatchObject({ code: 'table' });
    }

    const injected = await approve(
      proposal,
      sourceWith({ filter: [{ column: 'status; DROP TABLE saker', op: 'eq', value: 'x' }] }),
    );
    expect(injected.status).toBe(422);
    const rawSql = await approve(proposal, sourceWith({ where: "status = 'avsluttet'" }));
    expect(rawSql.status).toBe(422);

    const writing = await approve(await propose('Skrivende visning', 'skrivende'), {});
    expect(writing.status).toBe(422);
    expect(JSON.stringify(await json(writing))).toContain('read-only transaction');
    expect((await source.query('SELECT count(*)::int AS n FROM logg')).rows[0]).toEqual({ n: 0 });

    const wrong = await call(`/tenants/${digdir}/proposals/${proposal.id}/approve`, 'kari', {
      body: { reason, connection: { ...login, password: throwawayPassword(), tls: false } },
    });
    const wrongText = await wrong.text();
    expect(wrong.status).toBe(422);
    expect(wrongText).toContain('Fikk ikke lest fra databasen');
    expect(wrongText).toContain('"code":"auth"');
    expect(wrongText).not.toContain(throwawayPassword());

    expect((await source.query('SELECT count(*)::int AS n FROM saker')).rows[0]?.n).toBeGreaterThan(
      2,
    );
    expect(
      (await json<{ data: unknown[] }>(await call(`/tenants/${digdir}/connectors`, 'kari'))).data,
    ).toEqual([]);
    expect(JSON.stringify(await admin.audit(digdir))).not.toContain(throwawayPassword());
  });

  it('rolls back everything when the test-read fails, but keeps a valid connection whose first sync fails and marks it failed until a retry', async () => {
    const { call, propose } = await boot();
    const proposal = await propose('Saker som kan feile');
    const approve = (body: Record<string, unknown>) =>
      call(`/tenants/${digdir}/proposals/${proposal.id}/approve`, 'kari', {
        body: { reason, connection: { ...login, tls: false }, ...body },
      });
    const leftovers = async () => ({
      datasets: (
        await json<{ data: { id: string; editable: boolean }[] }>(
          await call(`/tenants/${digdir}/datasets`, 'kari'),
        )
      ).data.filter((d) => d.editable),
      secrets: (
        await json<{ data: { name: string }[] }>(
          await call(`/tenants/${digdir}/building-blocks/secrets`, 'kari'),
        )
      ).data.filter((s) => s.name.startsWith('connector-')),
      connectors: (
        await json<{ data: unknown[] }>(await call(`/tenants/${digdir}/connectors`, 'kari'))
      ).data,
    });

    const wrong = await approve({
      connection: { ...login, password: throwawayPassword(), tls: false },
    });
    expect(wrong.status).toBe(422);
    expect(await leftovers()).toEqual({ datasets: [], secrets: [], connectors: [] });
    expect(
      (
        await json<CatalogProposal>(
          await call(`/tenants/${digdir}/proposals/${proposal.id}`, 'kari'),
        )
      ).state,
    ).toBe('pending');

    const broken = await approve({
      source: { table: 'brutt', fields: { id: 'id', title: 'tittel', text: ['sammendrag'] } },
    });
    expect(broken.status).toBe(200);
    const [listed] = (
      await json<{ data: ConnectorView[] }>(await call(`/tenants/${digdir}/connectors`, 'kari'))
    ).data;
    const id = listed?.id ?? '';
    const failed = await settled(call, id);
    expect(failed).toMatchObject({
      status: 'failed',
      lastSync: { status: 'failed', error: expect.stringContaining('raden kan ikke leses') },
    });
    expect(JSON.stringify(failed)).not.toContain(login.password);
    const kept = await leftovers();
    expect(kept.datasets).toHaveLength(1);
    expect(kept.secrets).toEqual([expect.objectContaining({ name: `connector-${proposal.id}` })]);

    await source.query(
      "CREATE OR REPLACE FUNCTION brekk(int) RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'Lesbar sak' $$",
    );
    const rows = (await source.query('SELECT count(*)::int AS n FROM saker')).rows[0]?.n;
    const retried = await call(
      `/tenants/${digdir}/connectors/${encodeURIComponent(id)}/sync`,
      'kari',
      {
        body: {},
      },
    );
    expect(retried.status).toBe(202);
    expect(await settled(call, id)).toMatchObject({
      status: 'connected',
      lastSync: { status: 'succeeded', rows },
    });
  });

  it('answers the approval before the first sync has finished', async () => {
    const { call, propose } = await boot();
    const proposal = await propose('Saker uten venting', 'treg');

    const approved = await call(`/tenants/${digdir}/proposals/${proposal.id}/approve`, 'kari', {
      body: { reason, connection: { ...login, tls: false } },
    });

    expect(approved.status).toBe(200);
    const [view] = (
      await json<{ data: ConnectorView[] }>(await call(`/tenants/${digdir}/connectors`, 'kari'))
    ).data;
    expect(view?.status).toBe('syncing');
    expect(await settled(call, view?.id ?? '')).toMatchObject({ status: 'connected' });
  });

  it('records a connection without TLS on the connector and in the audit entry', async () => {
    const { admin, call, propose } = await boot();
    const proposal = await propose('Saker uten kryptering');
    const approved = await call(`/tenants/${digdir}/proposals/${proposal.id}/approve`, 'kari', {
      body: { reason, connection: { ...login, tls: false } },
    });
    expect(approved.status).toBe(200);
    const events = await admin.events(approved.headers.get('genai-task') ?? '');
    expect(events.find((e) => e.type === 'x.platform.change')?.data).toMatchObject({
      after: { connector: { host: '127.0.0.1', database: 'fagsystem', tls: false } },
    });
    const [view] = (
      await json<{ data: ConnectorView[] }>(await call(`/tenants/${digdir}/connectors`, 'kari'))
    ).data;
    expect(view?.connection).toMatchObject({ tls: false });
    await settled(call, view?.id ?? '');
  });

  it('the connector password is stored inside audited secret tasks, at approval and on rotation', async () => {
    const { admin, call, propose } = await boot();
    const proposal = await propose('Saker for revisjon');
    const approved = await call(`/tenants/${digdir}/proposals/${proposal.id}/approve`, 'kari', {
      body: { reason, connection: { ...login, tls: false } },
    });
    const [view] = (
      await json<{ data: ConnectorView[] }>(await call(`/tenants/${digdir}/connectors`, 'kari'))
    ).data;
    const rotated = await call(
      `/tenants/${digdir}/connectors/${encodeURIComponent(view?.id ?? '')}/credentials`,
      'kari',
      { method: 'PUT', body: { password: throwawayPassword() } },
    );

    const secrets = (await admin.audit(digdir)).filter((a) => a.action === 'platform.secrets.set');
    expect(approved.status).toBe(200);
    expect(secrets.map((a) => [a.outcome, a.task])).toEqual([
      ['applied', expect.any(String)],
      ['applied', rotated.headers.get('genai-task')],
    ]);
    await settled(call, view?.id ?? '');
  });

  it('a failed level-2 approval removes its secret inside an audited task', async () => {
    const { admin, call, propose } = await boot();
    const proposal = await propose('Saker uten søkemotor');
    const failed = await call(`/tenants/${digdir}/proposals/${proposal.id}/approve`, 'kari', {
      body: { reason, connection: { ...login, tls: false }, endpoint: 'finnes-ikke' },
    });

    expect(failed.status).not.toBe(200);
    const secrets = (
      await json<{ data: { name: string }[] }>(
        await call(`/tenants/${digdir}/building-blocks/secrets`, 'kari'),
      )
    ).data.filter((s) => s.name.startsWith('connector-'));
    expect(secrets).toEqual([]);
    const audit = (await admin.audit(digdir)).filter((a) =>
      a.action.startsWith('platform.secrets.'),
    );
    expect(audit.map((a) => [a.action, a.outcome, a.actor, a.target, a.reason])).toEqual([
      [
        'platform.secrets.set',
        'applied',
        expect.any(String),
        `secret:${digdir}/connector-${proposal.id}`,
        'Testendring',
      ],
      [
        'platform.secrets.delete',
        'applied',
        audit[0]?.actor,
        `secret:${digdir}/connector-${proposal.id}`,
        'Tilbakestilt: Testendring',
      ],
    ]);
  });

  it('keeps tenants apart and needs the right to sync', async () => {
    const { call, propose } = await boot();
    const proposal = await propose('Saker for innsyn');
    expect(
      (
        await call(`/tenants/${digdir}/proposals/${proposal.id}/approve`, 'kari', {
          body: { reason, connection: { ...login, tls: false } },
        })
      ).status,
    ).toBe(200);
    const id = (
      await json<{ data: ConnectorView[] }>(await call(`/tenants/${digdir}/connectors`, 'kari'))
    ).data[0]?.id;
    const path = `/tenants/${digdir}/connectors/${encodeURIComponent(id ?? '')}`;
    await settled(call, id ?? '');

    expect((await call(`/tenants/${digdir}/connectors`, 'ola')).status).toBe(404);
    expect((await call(`${path}/sync`, 'ola', { body: {} })).status).toBe(404);
    expect((await call(`${path}/sync`, 'erik', { body: {} })).status).toBe(403);
    expect((await call(`/tenants/${other}/connectors`, 'ola')).status).toBe(200);
    expect(
      (await json<{ data: unknown[] }>(await call(`/tenants/${other}/connectors`, 'ola'))).data,
    ).toEqual([]);

    expect(
      (
        await call(`/tenants/${other}/datasets`, 'ola', {
          body: { id: 'laan', name: 'Lånte saker', residency: 'norway', endpoint: 'platform-pg' },
        })
      ).status,
    ).toBe(201);
    const borrowed = await call(`/tenants/${other}/datasets/laan/pipelines`, 'ola', {
      body: {
        id: 'kobling',
        name: 'Lånte saker',
        chunking: { minimumLength: 1 },
        source: {
          kind: 'database',
          connection: {
            engine: 'postgres',
            host: '127.0.0.1',
            port: login.port,
            database: 'fagsystem',
            user: login.user,
            password: `secret://tenant/${digdir}/connector-${proposal.id}`,
            tls: false,
          },
          mapping: { table: 'saker', fields: { id: 'id', title: 'tittel', text: ['sammendrag'] } },
        },
      },
    });
    expect(borrowed.status).toBe(201);
    expect(
      (await call(`/tenants/${other}/datasets/laan/pipelines/kobling/execute`, 'ola', { body: {} }))
        .status,
    ).toBe(202);
    let run: { status: string; error?: string } | undefined;
    for (let i = 0; i < 300; i++) {
      run = (
        await json<{ data: { status: string; error?: string }[] }>(
          await call(`/tenants/${other}/datasets/laan/pipelines/kobling/executions`, 'ola'),
        )
      ).data[0];
      if (run && run.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(run).toMatchObject({
      status: 'failed',
      error: 'the database password must be a secret of the tenant that owns the dataset',
    });

    const sqlKey = await call(`/tenants/${other}/datasets/laan/pipelines/kobling`, 'ola', {
      method: 'PUT',
      body: {
        name: 'Lånte saker',
        source: {
          kind: 'database',
          connection: {
            engine: 'postgres',
            host: '127.0.0.1',
            database: 'fagsystem',
            user: login.user,
            password: `secret://tenant/${other}/egen`,
          },
          mapping: {
            table: 'saker',
            fields: { id: 'id', title: 'tittel', text: ['sammendrag'] },
            sql: 'SELECT * FROM saker',
          },
        },
      },
    });
    expect(sqlKey.status).toBe(400);
  });
});
