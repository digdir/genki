import type { Principal } from '@genai/contracts';
import { privateNetworkEntry } from '@genai/providers-mcp-client';
import {
  databaseConnection,
  rowMapping,
  SourceCheckError,
  tableQuery,
  type DatabaseConnection,
  type RowMapping,
} from '@genai/ingest';
import type { ConnectorSource } from '@genai/strategy-builder';
import type { Context, Env, Hono, Schema } from 'hono';
import { z } from 'zod';
import { actorOf, type AdminHandler } from './admin.js';
import { t } from './i18n/index.js';
import {
  appendVersion,
  serialized,
  type ConfigEntry,
  type ConfigEntryStore,
} from './config-store.js';
import { ingestionTarget } from './config-routes.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import type { Execution } from './ingestion.js';
import type { ModuleDeps, MountDeps, PlatformModuleFactory } from './platform-modules.js';
import { requireRight, rightRefused, type Right } from './rights.js';

export const connectorMappingKind = 'connector-mapping';
export const connectorPipeline = 'kobling';
export const defaultConnectorEndpoint = 'platform-pg';

export interface ConnectorLink {
  dataset: string;
  pipeline: string;
  connection: DatabaseConnection;
  source: RowMapping;
}

export const privateNetworkKind = 'private-networks';
const privateNetworkId = 'database';
const maxPrivateNetworks = 50;

export interface PrivateNetworksView {
  tenant: string;
  entries: string[];
  changedBy?: string;
  changedAt?: string;
  reason?: string;
}

export const privateNetworkRegistry = (store: ConfigEntryStore) => ({
  get: async (tenant: string): Promise<PrivateNetworksView> => {
    const latest = (await store.history(privateNetworkKind, tenant, privateNetworkId)).at(-1);
    if (!latest || latest.deleted) return { tenant, entries: [] };
    return {
      tenant,
      entries: (latest.spec as { entries: string[] }).entries,
      changedBy: latest.by,
      changedAt: latest.at,
      reason: latest.reason,
    };
  },
});

export type ConnectorNetwork = 'public' | 'private' | 'blocked' | 'unknown';

export const networkRefusal = (host: string, network: ConnectorNetwork) =>
  network === 'blocked'
    ? `${host} kan ikke brukes. Plattformens egne adresser, lokale adresser og metadata-adresser er alltid stengt.`
    : `${host} ligger på et privat nettverk som ikke er åpnet for virksomheten. Digdir kan åpne adressen. Be Digdir om å legge den til i listen over tillatte private nettverk.`;

export type ConnectorStatus = 'not_connected' | 'not_synced' | 'syncing' | 'connected' | 'failed';

const approvalBody = z.object({
  connection: z.strictObject({
    host: z.string().min(1).optional(),
    port: z.number().int().optional(),
    database: z.string().min(1).optional(),
    user: z.string().min(1),
    password: z.string().min(1).max(1000),
    tls: z.boolean().optional(),
  }),
  source: z
    .strictObject({
      engine: z.literal('postgres').optional(),
      host: z.string().optional(),
      database: z.string().optional(),
      schema: z.string().optional(),
      table: z.string(),
      fields: z.strictObject({
        id: z.string(),
        title: z.string(),
        text: z.array(z.string()),
        url: z.string().optional(),
        date: z.string().optional(),
        metadata: z.array(z.string()).optional(),
      }),
      filter: z.array(z.record(z.string(), z.unknown())).optional(),
      maxRows: z.number().int().optional(),
    })
    .optional(),
  endpoint: z.string().min(1).optional(),
});

const passwordBody = z.strictObject({ password: z.string().min(1).max(1000) });

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422,
  title: string,
  errors: {
    path: string;
    message: string;
    code?: string;
    missing?: string[];
    known?: string[];
  }[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const issues = (prefix: string, error: z.ZodError) =>
  error.issues.map((i) => ({
    path: [prefix, ...i.path.map(String)].join('.'),
    message: i.message,
  }));

export const connectorSecretName = (proposal: string) =>
  `connector-${proposal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)}`;

const hidden = (message: string, secret: string) =>
  secret.length > 0 ? message.split(secret).join('***') : message;

type SourceInput = z.infer<typeof approvalBody>['source'] | ConnectorSource;

const mappingOf = (source: NonNullable<SourceInput>) =>
  rowMapping.safeParse({
    schema: source.schema ?? 'public',
    table: source.table,
    fields: { ...source.fields, metadata: source.fields.metadata ?? [] },
    filter: source.filter ?? [],
    ...('maxRows' in source && source.maxRows ? { maxRows: source.maxRows } : {}),
  });

interface Proposal {
  id: string;
  title?: string;
  item?: { name: string };
  forService: { id: string; name: string };
  source?: ConnectorSource;
}

export const connectOnApproval = async <E extends Env, S extends Schema, B extends string>(
  c: Context,
  app: Hono<E, S, B>,
  deps: MountDeps,
  tenant: string,
  proposal: Proposal,
  input: Record<string, unknown>,
  reason: string,
  principal: Principal,
): Promise<
  | { response: Response }
  | { link: ConnectorLink; rollback: () => Promise<void>; firstSync: () => Promise<void> }
> => {
  const database = deps.ingestSources?.database;
  if (!database || !deps.vault)
    return {
      response: problem(c, 409, 'Koblinger til databaser er ikke slått på i plattformen', [
        { path: 'connection', message: 'database sources are turned off on this platform' },
      ]),
    };
  const body = approvalBody.safeParse(input);
  if (!body.success)
    return {
      response: problem(
        c,
        422,
        'Fyll inn hvor databasen er og hvordan plattformen logger på',
        issues('body', body.error).map((e) => ({ ...e, path: e.path.replace(/^body\./, '') })),
      ),
    };
  const source: SourceInput = body.data.source ?? proposal.source;
  if (!source)
    return {
      response: problem(c, 422, 'Forslaget mangler tabell og felt', [
        { path: 'source', message: 'a table and the fields that become documents are needed' },
      ]),
    };
  const mapping = mappingOf(source);
  if (!mapping.success)
    return { response: problem(c, 422, 'Ugyldig kobling', issues('source', mapping.error)) };
  const secretRef = `secret://tenant/${tenant}/${connectorSecretName(proposal.id)}`;
  const given = body.data.connection;
  const connection = databaseConnection.safeParse({
    engine: 'postgres',
    host: given.host ?? source.host ?? proposal.source?.host,
    ...(given.port ? { port: given.port } : {}),
    database: given.database ?? source.database ?? proposal.source?.database,
    user: given.user,
    password: secretRef,
    ...(given.tls === undefined ? {} : { tls: given.tls }),
  });
  if (!connection.success)
    return {
      response: problem(c, 422, 'Ugyldig tilkobling', issues('connection', connection.error)),
    };
  const privateNetworks = (await database.privateNetworks?.(tenant)) ?? [];
  const reach = await database.network?.(connection.data.host, privateNetworks);
  if (reach && !reach.allowed && reach.network !== 'unknown')
    return {
      response: problem(
        c,
        422,
        reach.network === 'blocked'
          ? 'Adressen kan ikke brukes'
          : 'Databasen ligger på et privat nettverk',
        [{ path: 'connection.host', message: networkRefusal(connection.data.host, reach.network) }],
      ),
    };
  try {
    await database.reader.check(
      { ...connection.data, password: given.password, privateNetworks },
      tableQuery(mapping.data),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      response: problem(c, 422, 'Fikk ikke lest fra databasen', [
        {
          path: 'connection',
          message: hidden(message, given.password),
          ...(error instanceof SourceCheckError
            ? {
                code: error.problem,
                ...(error.problem === 'columns'
                  ? { missing: error.columns.missing, known: error.columns.known }
                  : {}),
              }
            : {}),
        },
      ]),
    };
  }

  const headers = new Headers(c.req.raw.headers);
  for (const name of ['content-length', 'change-reason']) headers.delete(name);
  headers.set('content-type', 'application/json');
  headers.set('change-reason', encodeURIComponent(reason));
  const call = (path: string, payload: unknown) =>
    app.request(`/tenants/${tenant}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  const vault = deps.vault;
  const secretName = connectorSecretName(proposal.id);
  const created: { dataset?: { id: string; fullId: string }; pipeline?: boolean } = {};
  const rollback = async () => {
    const { dataset } = created;
    const undo = { tenant, scope: tenant, reason: `Tilbakestilt: ${reason}` };
    if (dataset && created.pipeline)
      await deps.admin.perform(principal, 'platform.pipeline.delete', {
        ...undo,
        dataset: dataset.fullId,
        id: connectorPipeline,
      });
    if (dataset) {
      await dropGenerations(deps, dataset.fullId).catch(() => undefined);
      await deps.admin.perform(principal, 'platform.catalog.delete', {
        ...undo,
        kind: 'dataset',
        id: dataset.id,
      });
    }
    await deps.admin.performThen(
      principal,
      'platform.secrets.delete',
      { tenant, name: secretName, reason: undo.reason },
      () => vault.delete(tenant, secretName),
    );
  };
  const failed = async (response: Response) => {
    await rollback();
    return { response };
  };
  const passOn = async (response: Response) =>
    failed(
      c.json(await response.json().catch(() => ({})), response.status as 400, {
        'content-type': 'application/problem+json',
      }),
    );

  const secret = await deps.admin.performThen(
    principal,
    'platform.secrets.set',
    { tenant, name: secretName, reason },
    async () => {
      await vault.set(tenant, secretName, given.password);
    },
  );
  if (!secret.ok)
    return {
      response: problem(
        c,
        403,
        'Forbidden',
        secret.errors.map((e) => ({ ...e })),
      ),
    };
  const name =
    proposal.item?.name ??
    proposal.title ??
    t('services.connectorName', { service: proposal.forService.name });
  const embedding = deps.defaultEmbedding;
  const datasetResponse = await call('/datasets', {
    name,
    description: t('services.connectorDataset', {
      table: `${mapping.data.schema}.${mapping.data.table}`,
      service: proposal.forService.name,
    }),
    residency: embedding?.residency ?? 'norway',
    endpoint: body.data.endpoint ?? defaultConnectorEndpoint,
    ...(embedding
      ? { embedding: { model: embedding.model, dimensions: embedding.dimensions } }
      : {}),
  });
  if (datasetResponse.status !== 201) return passOn(datasetResponse);
  const dataset = (await datasetResponse.json()) as { id: string; fullId: string };
  created.dataset = dataset;
  const pipelineResponse = await call(`/datasets/${encodeURIComponent(dataset.id)}/pipelines`, {
    id: connectorPipeline,
    name,
    source: { kind: 'database', connection: connection.data, mapping: mapping.data },
    chunking: { minimumLength: 1 },
    schedule: 'none',
  });
  if (pipelineResponse.status !== 201) return passOn(pipelineResponse);
  created.pipeline = true;

  const firstSync = async () => {
    const pipeline = await deps.ingestion.get(tenant, dataset.fullId, connectorPipeline);
    const item = deps.catalog.get('dataset', dataset.fullId);
    if (!pipeline || !item) return;
    const started = await deps.ingestion.execute({
      pipeline,
      target: ingestionTarget(item),
      by: actorOf(principal.actor ?? principal),
      principal,
      tenant,
    });
    if (started.ok) void started.done.catch(() => undefined);
  };
  return {
    link: {
      dataset: dataset.fullId,
      pipeline: connectorPipeline,
      connection: connection.data,
      source: mapping.data,
    },
    rollback,
    firstSync,
  };
};

const dropGenerations = async (deps: MountDeps, dataset: string) => {
  if (!deps.writers.supports(dataset)) return;
  const route = deps.writers.open(dataset, { signal: new AbortController().signal });
  for (const run of await deps.ingestion.executions(dataset, connectorPipeline))
    await route.writer
      .drop(route.dataset, run.report?.generation ?? run.id, { force: true })
      .catch(() => undefined);
};

export interface ConnectorEntrySpec {
  service: string;
  proposal: string;
  name: string;
  connector?: ConnectorLink;
}

const statusOf = (link: ConnectorLink | undefined, last: Execution | undefined): ConnectorStatus =>
  !link
    ? 'not_connected'
    : !last
      ? 'not_synced'
      : last.status === 'running'
        ? 'syncing'
        : last.status === 'succeeded'
          ? 'connected'
          : 'failed';

const networkOf = async (deps: ModuleDeps, tenant: string, host: string) => {
  const database = deps.ingestSources?.database;
  if (!database?.network) return undefined;
  return database.network(host, (await database.privateNetworks?.(tenant)) ?? []);
};

const viewOf = async (deps: ModuleDeps, entry: ConfigEntry<ConnectorEntrySpec>) => {
  const spec = entry.spec;
  const link = spec.connector;
  const last = link ? (await deps.ingestion.executions(link.dataset, link.pipeline))[0] : undefined;
  const reach = link ? await networkOf(deps, entry.scope, link.connection.host) : undefined;
  return {
    id: entry.id,
    name: spec.name,
    service: spec.service,
    proposal: spec.proposal,
    approvedBy: entry.by,
    approvedAt: entry.at,
    status: statusOf(link, last),
    ...(link
      ? {
          dataset: link.dataset.slice(entry.scope.length + 1),
          connection: {
            engine: link.connection.engine,
            host: link.connection.host,
            port: link.connection.port,
            database: link.connection.database,
            user: link.connection.user,
            tls: link.connection.tls,
            credentials: 'stored' as const,
            ...(reach ? { network: reach.network, networkAllowed: reach.allowed } : {}),
          },
          source: link.source,
        }
      : {}),
    lastSync: last
      ? {
          status: last.status,
          startedAt: last.startedAt,
          ...(last.endedAt ? { endedAt: last.endedAt } : {}),
          ...(last.report ? { rows: last.report.stored, skipped: last.report.skipped } : {}),
          ...(last.error ? { error: last.error } : {}),
        }
      : null,
  };
};

export const createConnectorsModule = (): PlatformModuleFactory => (deps) => {
  const networks = privateNetworkRegistry(deps.configEntries);
  const writes = serialized();
  const handlers: Record<string, AdminHandler> = {
    'platform.private-networks.save': (input, principal) =>
      writes(async () => {
        const { tenant, reason } = input;
        const target = `private-networks:${tenant}`;
        const refuse = (path: string, message: string) => ({
          ok: false as const,
          errors: [{ path, message }],
          target,
        });
        if (principal.kind !== 'operator')
          return refuse('principal', 'Bare Digdir kan åpne private nettverk for en virksomhet');
        const given = Array.isArray(input.entries) ? input.entries : undefined;
        if (!given || given.some((e) => typeof e !== 'string'))
          return refuse('entries', 'a list of host names or CIDR ranges is required');
        if (given.length > maxPrivateNetworks)
          return refuse('entries', `at most ${maxPrivateNetworks} entries`);
        const entries: string[] = [];
        for (const [i, text] of (given as string[]).entries()) {
          const parsed = privateNetworkEntry(text);
          if (!parsed.ok) return refuse(`entries.${i}`, parsed.message);
          const value = text.trim().toLowerCase();
          if (!entries.includes(value)) entries.push(value);
        }
        const before = await networks.get(tenant);
        await appendVersion(deps.configEntries, {
          kind: privateNetworkKind,
          scope: tenant,
          id: privateNetworkId,
          spec: { entries },
          deleted: false,
          by: actorOf(principal),
          reason,
        });
        return {
          ok: true,
          value: { entries },
          target,
          audit: { before: { entries: before.entries }, after: { entries } },
        };
      }),
  };
  return {
    id: 'connectors',
    handlers,
    mount: (app, mounted) => mountRoutes(app, mounted),
  };
};

const mountRoutes = <E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  deps: MountDeps,
) => {
  const member = async (c: Context, right: Right) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return { response: problem(c, 401, 'Unauthorized') };
    const tenant = c.req.param('tenant') ?? '';
    const acting = deps.access(principal, tenant, c.req.raw);
    if (!acting) return { response: problem(c, 404, 'Not found') };
    const check = requireRight(acting, tenant, right);
    if (!check.ok) return { response: rightRefused(c, check.problem) };
    return { principal: acting as Principal, tenant };
  };

  const entries = async (tenant: string) =>
    (await deps.configEntries.latest({ kind: connectorMappingKind, scope: tenant }))
      .filter((e) => !e.deleted)
      .map((e) => e as ConfigEntry<ConnectorEntrySpec>);

  const found = async (tenant: string, id: string) =>
    (await entries(tenant)).find((e) => e.id === id);

  const base = '/tenants/:tenant/connectors';
  const networks = privateNetworkRegistry(deps.configEntries);

  const operator = async (c: Context) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return { response: problem(c, 401, 'Unauthorized') };
    if (principal.kind !== 'operator') return { response: problem(c, 403, 'Forbidden') };
    return { principal, tenant: c.req.param('tenant') ?? '' };
  };

  app.get('/tenants/:tenant/private-networks', async (c) => {
    const guard = await member(c, 'use-services');
    if (guard.response) return guard.response;
    return c.json(await networks.get(guard.tenant));
  });

  app.get('/operator/tenants/:tenant/private-networks', async (c) => {
    const guard = await operator(c);
    if (guard.response) return guard.response;
    return c.json(await networks.get(guard.tenant));
  });

  app.put('/operator/tenants/:tenant/private-networks', async (c) => {
    const guard = await operator(c);
    if (guard.response) return guard.response;
    const reason = changeReasonOf(c)?.trim() ?? '';
    if (!isReasonLongEnough(reason))
      return problem(c, 400, 'Invalid request', [
        { path: 'change-reason', message: reasonTooShort },
      ]);
    const body = (await c.req.json().catch(() => ({}))) as { entries?: unknown };
    const result = await deps.admin.perform(
      { ...guard.principal, tenant: guard.tenant },
      'platform.private-networks.save',
      {
        tenant: guard.tenant,
        reason,
        entries: body.entries,
      },
    );
    c.header('genai-task', result.task);
    if (!result.ok)
      return problem(
        c,
        result.errors.some((e) => e.path === 'principal') ? 403 : 400,
        'Invalid request',
        result.errors,
      );
    return c.json(await networks.get(guard.tenant));
  });

  app.get(`${base}/network`, async (c) => {
    const guard = await member(c, 'use-services');
    if (guard.response) return guard.response;
    const host = (c.req.query('host') ?? '').trim();
    if (!host)
      return problem(c, 400, 'Invalid request', [{ path: 'host', message: 'host is required' }]);
    const reach = (await networkOf(deps, guard.tenant, host)) ?? {
      network: 'unknown' as const,
      allowed: false,
    };
    return c.json({
      host,
      ...reach,
      ...(!reach.allowed && reach.network !== 'unknown'
        ? { message: networkRefusal(host, reach.network) }
        : {}),
    });
  });

  app.get(base, async (c) => {
    const guard = await member(c, 'use-services');
    if (guard.response) return guard.response;
    const data = await Promise.all((await entries(guard.tenant)).map((e) => viewOf(deps, e)));
    return c.json({ data: data.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt)) });
  });

  app.get(`${base}/:id`, async (c) => {
    const guard = await member(c, 'use-services');
    if (guard.response) return guard.response;
    const entry = await found(guard.tenant, c.req.param('id') ?? '');
    return entry ? c.json(await viewOf(deps, entry)) : problem(c, 404, 'Not found');
  });

  app.post(`${base}/:id/sync`, async (c) => {
    const guard = await member(c, 'manage-datasets');
    if (guard.response) return guard.response;
    const entry = await found(guard.tenant, c.req.param('id') ?? '');
    const link = entry?.spec.connector;
    if (!entry || !link) return problem(c, 404, 'Not found');
    const reason = changeReasonOf(c)?.trim() ?? '';
    const result = await deps.admin.perform(guard.principal, 'platform.pipeline.execute', {
      tenant: guard.tenant,
      scope: guard.tenant,
      dataset: link.dataset,
      id: link.pipeline,
      reason,
    });
    c.header('genai-task', result.task);
    if (!result.ok)
      return problem(
        c,
        result.errors.some((e) => e.path === 'principal') ? 403 : 409,
        'Synkroniseringen startet ikke',
        result.errors,
      );
    return c.json(await viewOf(deps, entry), 202);
  });

  app.put(`${base}/:id/credentials`, async (c) => {
    const guard = await member(c, 'manage-datasets');
    if (guard.response) return guard.response;
    const entry = await found(guard.tenant, c.req.param('id') ?? '');
    const link = entry?.spec.connector;
    if (!entry || !link || !deps.vault) return problem(c, 404, 'Not found');
    const body = passwordBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return problem(c, 400, 'Invalid request', issues('body', body.error));
    const name = connectorSecretName(entry.spec.proposal);
    const reason = changeReasonOf(c)?.trim() ?? '';
    const vault = deps.vault;
    const result = await deps.admin.performThen(
      guard.principal,
      'platform.secrets.set',
      { tenant: guard.tenant, name, reason },
      async () => {
        await vault.set(guard.tenant, name, body.data.password);
      },
    );
    c.header('genai-task', result.task);
    if (!result.ok) return problem(c, 403, 'Forbidden', result.errors);
    return c.json(await viewOf(deps, entry));
  });
};

export const connectorsModule: PlatformModuleFactory = createConnectorsModule();
