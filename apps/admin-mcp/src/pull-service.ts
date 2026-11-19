import { isDeepStrictEqual, parseArgs } from 'node:util';
import {
  GenkiError,
  genkiClient,
  isLoopback,
  requireSafeUrl,
  segment,
  tenantPath,
  type GenkiClient,
  type TokenSource,
} from './client.js';

export const knownSources: Record<string, string> = {
  'genki-test': 'https://api.genki-test.digdir.cloud',
};

export const localTenantDefault = '991825827';

export interface ReadOnlySource {
  tenant: string;
  get<T>(path: string): Promise<T>;
}

export const readOnly = (client: GenkiClient): ReadOnlySource => ({
  tenant: client.tenant,
  get: <T>(path: string) => client.request<T>('GET', path),
});

interface Published {
  version: number;
  definition: Record<string, unknown>;
  files: Record<string, string>;
}

interface Overview {
  latest: Published;
}

export interface PullOptions {
  source: ReadOnlySource;
  sourceName: string;
  local: GenkiClient;
  service: string;
  version?: number;
  now?: () => Date;
}

export interface References {
  datasets: string[];
  tools: string[];
  skills: string[];
}

export interface PullOutcome {
  state: 'published' | 'unchanged';
  service: string;
  sourceTenant: string;
  pulledVersion: number;
  localTenant: string;
  localVersion: number;
  references: References;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const refOf = (value: unknown, key: string) =>
  typeof value === 'string' ? value : String(record(value)[key] ?? '');

export const referencesOf = (definition: Record<string, unknown>): References => {
  const spec = record(definition.spec);
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  const named = (values: string[]) => [...new Set(values.filter(Boolean))];
  return {
    datasets: named(list(record(spec.knowledge).datasets).map((d) => refOf(d, 'dataset'))),
    tools: named(list(spec.tools).map((t) => refOf(t, 'use'))),
    skills: named(list(spec.skills).map((s) => refOf(s, 'use'))),
  };
};

const sharingKeys = ['availableTo', 'visibility'] as const;

const withoutConfirmer = (value: unknown) => {
  const confirmation = { ...record(value) };
  delete confirmation.by;
  delete confirmation.at;
  return confirmation;
};

export const forLocal = (
  pulled: Record<string, unknown>,
  localTenant: string,
  current: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  const metadata: Record<string, unknown> = { ...record(pulled.metadata), tenant: localTenant };
  delete metadata.version;
  const kept = record(current?.spec);
  const spec = Object.fromEntries([
    ...Object.entries(record(pulled.spec)).filter(([key]) => !sharingKeys.includes(key as never)),
    ...sharingKeys.flatMap((key) => (kept[key] === undefined ? [] : [[key, kept[key]] as const])),
  ]);
  if (spec.riskConfirmation !== undefined) {
    const confirmation = withoutConfirmer(spec.riskConfirmation);
    const local = kept.riskConfirmation;
    spec.riskConfirmation =
      local !== undefined && isDeepStrictEqual(withoutConfirmer(local), confirmation)
        ? local
        : confirmation;
  }
  return { ...pulled, metadata, spec };
};

const servicePath = (tenant: string, id: string) =>
  `${tenantPath(tenant)}/definitions/services/${segment(id)}`;

const localLatest = async (local: GenkiClient, id: string) => {
  try {
    return (await local.request<Overview>('GET', servicePath(local.tenant, id))).latest;
  } catch (error) {
    if (error instanceof GenkiError && error.status === 404) return undefined;
    throw error;
  }
};

export const pullService = async (options: PullOptions): Promise<PullOutcome> => {
  const { source, local, service } = options;
  const pulled =
    options.version === undefined
      ? (await source.get<Overview>(servicePath(source.tenant, service))).latest
      : await source.get<Published>(
          `${servicePath(source.tenant, service)}/versions/${options.version}`,
        );
  const current = await localLatest(local, service);
  const definition = forLocal(pulled.definition, local.tenant, current?.definition);
  const now = options.now ?? (() => new Date());
  const bundle = {
    format: 'genai-tenant-export/v1',
    tenant: local.tenant,
    exportedAt: now().toISOString(),
    definitions: [{ definition, files: pulled.files }],
    settings: { values: {}, pins: {} },
  };
  const imported = await local.request<{ plan: { action: string }[] }>(
    'POST',
    `${tenantPath(local.tenant)}/import`,
    {
      body: bundle,
      query: { onConflict: 'overwrite' },
      reason: `Pulled version ${pulled.version} of ${service} from ${options.sourceName}`,
    },
  );
  const after = await localLatest(local, service);
  if (!after) throw new Error(`${service} is not in the local genki after the import`);
  return {
    state: imported.plan.some((p) => p.action === 'create' || p.action === 'update')
      ? 'published'
      : 'unchanged',
    service,
    sourceTenant: source.tenant,
    pulledVersion: pulled.version,
    localTenant: local.tenant,
    localVersion: after.version,
    references: referencesOf(pulled.definition),
  };
};

export const resolveSourceTenant = async (
  client: GenkiClient,
  service: string,
): Promise<string> => {
  const fail = () =>
    new Error(`could not find the organisation of ${service}; pass --tenant <organisation number>`);
  try {
    const found = await client.request<{ tenant?: string; service?: string }>(
      'GET',
      `/services/by-name/${segment(service)}`,
    );
    if (found.service !== service || !found.tenant) throw fail();
    return found.tenant;
  } catch (error) {
    if (error instanceof GenkiError && error.status === 404) throw fail();
    throw error;
  }
};

export const personalToken = (token: string): TokenSource => {
  if (token.split('.').length !== 3 || /[^\w.-]/.test(token))
    throw new Error(
      'GENKI_SOURCE_TOKEN must be your own login token (a JWT), never an API key or a shared key',
    );
  return { get: async () => token };
};

export interface PullArgs {
  service: string;
  sourceName: string;
  sourceUrl: string;
  localUrl: string;
  sourceTenant?: string;
  localTenant: string;
  version?: number;
}

const orgNumber = (name: string, value: string) => {
  if (!/^\d{9}$/.test(value)) throw new Error(`${name} must be an organisation number`);
  return value;
};

export const pullUsage =
  'usage: npm run service:pull -- <service> [--from genki-test] [--version <n>] [--tenant <org>] [--local-tenant <org>] [--to <local api url>]';

export const parsePullArgs = (argv: string[]): PullArgs => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      from: { type: 'string', default: 'genki-test' },
      to: { type: 'string', default: 'http://localhost:8080' },
      version: { type: 'string' },
      tenant: { type: 'string' },
      'local-tenant': { type: 'string', default: localTenantDefault },
    },
  });
  const [service, ...rest] = positionals;
  if (!service || rest.length > 0) throw new Error(pullUsage);
  segment(service);
  if (!Object.hasOwn(knownSources, values.from))
    throw new Error(`--from must be one of: ${Object.keys(knownSources).join(', ')}\n${pullUsage}`);
  const sourceUrl = requireSafeUrl('--from', knownSources[values.from] as string);
  const localUrl = requireSafeUrl('--to', values.to);
  if (!isLoopback(localUrl))
    throw new Error('--to must be a genki on this machine (localhost or 127.0.0.1)');
  if (new URL(sourceUrl).origin === new URL(localUrl).origin)
    throw new Error('--from and --to are the same genki');
  const version = values.version === undefined ? undefined : Number(values.version);
  if (version !== undefined && (!Number.isInteger(version) || version < 1))
    throw new Error('--version must be a whole number, 1 or more');
  return {
    service,
    sourceName: values.from,
    sourceUrl,
    localUrl,
    ...(values.tenant ? { sourceTenant: orgNumber('--tenant', values.tenant) } : {}),
    localTenant: orgNumber('--local-tenant', values['local-tenant']),
    ...(version ? { version } : {}),
  };
};

export interface SourceLogin {
  token?: string;
  browser?: () => TokenSource;
}

export const sourceToken = (login: SourceLogin): TokenSource => {
  if (login.token) return personalToken(login.token);
  if (login.browser) return login.browser();
  throw new Error(
    'log in to the source first: set ADMIN_MCP_CLIENT_ID to log in in the browser, or GENKI_SOURCE_TOKEN to your own access token',
  );
};

export const describeOutcome = (args: PullArgs, outcome: PullOutcome) => {
  const pulled = `version ${outcome.pulledVersion} of ${outcome.service} (organisation ${outcome.sourceTenant}) from ${args.sourceName}`;
  const done =
    outcome.state === 'published'
      ? `Pulled ${pulled} and published it locally as version ${outcome.localVersion} for organisation ${outcome.localTenant}. It is in the playground's version picker.`
      : `Pulled ${pulled}. It is already the newest local version (${outcome.localVersion}) for organisation ${outcome.localTenant}, so nothing was published.`;
  const refs = [
    ['datasets', outcome.references.datasets],
    ['tools', outcome.references.tools],
    ['skills', outcome.references.skills],
  ] as const;
  const named = refs.filter(([, ids]) => ids.length > 0);
  return named.length
    ? `${done}\nReferenced, not copied (they must exist locally): ${named.map(([kind, ids]) => `${kind} ${ids.join(', ')}`).join('; ')}.`
    : done;
};

export interface PullDeps {
  login: SourceLogin;
  localToken: (localUrl: string) => TokenSource;
  fetch?: typeof fetch;
  now?: () => Date;
}

export const runPull = async (argv: string[], deps: PullDeps) => {
  const args = parsePullArgs(argv);
  const token = sourceToken(deps.login);
  const sourceClient = (tenant: string) =>
    genkiClient({
      apiBase: args.sourceUrl,
      tenant,
      token,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
  const sourceTenant =
    args.sourceTenant ?? (await resolveSourceTenant(sourceClient(''), args.service));
  const outcome = await pullService({
    source: readOnly(sourceClient(sourceTenant)),
    sourceName: args.sourceName,
    local: genkiClient({
      apiBase: args.localUrl,
      tenant: args.localTenant,
      token: deps.localToken(args.localUrl),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }),
    service: args.service,
    ...(args.version ? { version: args.version } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  return describeOutcome(args, outcome);
};
