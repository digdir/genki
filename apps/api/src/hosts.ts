import type { DefinitionStore, ServiceDefinition, ServiceInterface } from '@genai/definitions';
import {
  isHostname,
  type ClientDefinition,
  type ClientIssue,
  type ClientStore,
} from '@genai/identity';
import type { Context, Env, Hono, Schema } from 'hono';
import type { ConfigEntryStore } from './config-store.js';
import { t } from './i18n/index.js';
import { isHiddenService } from './internal-services.js';
import { environmentsOf, pointerOf } from './service-environments.js';
import { lifecycleOf } from './service-lifecycle.js';

/** The hostnames an operator has opened to hosting, each for one tenant: `host=tenant,host=tenant`. */
export const hostedHostnamesFrom = (env: NodeJS.ProcessEnv): Map<string, string> =>
  new Map(
    (env.GENAI_HOSTED_HOSTNAMES ?? '')
      .split(',')
      .map((pair) => pair.trim().split('='))
      .flatMap(([host, tenant]) =>
        host && tenant && isHostname(host.trim().toLowerCase()) && /^\d{9}$/.test(tenant.trim())
          ? [[host.trim().toLowerCase(), tenant.trim()] as const]
          : [],
      ),
  );

export const defaultReservedDomains = [
  'genki.digdir.cloud',
  'genki-test.digdir.cloud',
  'azurecontainerapps.io',
];

export const reservedDomainsFrom = (env: NodeJS.ProcessEnv): string[] => [
  ...defaultReservedDomains,
  ...(env.GENAI_RESERVED_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
];

const under = (hostname: string, domain: string) =>
  hostname === domain || hostname.endsWith(`.${domain}`);

export const genkiZones = ['genki.digdir.cloud', 'genki-test.digdir.cloud'];

/** One label under `apps.` in genki's own zone: a name genki assigns to a service. */
export const isAssignedName = (hostname: string) =>
  genkiZones.some((zone) => {
    const suffix = `.apps.${zone}`;
    return hostname.endsWith(suffix) && !hostname.slice(0, -suffix.length).includes('.');
  });

export interface HostingRules {
  /** Hostname to the tenant it is opened for. */
  hostnames: ReadonlyMap<string, string>;
  reservedDomains: readonly string[];
}

export const hostnameNotAllowed = 'hostname_not_allowed';

/** A name opened to another tenant reads as one opened to none. */
export const hostnameProblems = (
  definition: ClientDefinition,
  tenantClients: readonly { definition: ClientDefinition }[],
  rules: HostingRules,
): ClientIssue[] => {
  const { tenant, id } = definition.metadata;
  return (definition.spec.hostnames ?? []).flatMap(({ hostname }, i): ClientIssue[] => {
    const path = `spec.hostnames.${i}.hostname`;
    if (
      (!isAssignedName(hostname) &&
        rules.reservedDomains.some((domain) => under(hostname, domain))) ||
      rules.hostnames.get(hostname) !== tenant
    )
      return [
        { path, message: `${hostnameNotAllowed}: ${hostname} is not open to this organisation` },
      ];
    const holder = tenantClients.find(
      (c) =>
        c.definition.metadata.id !== id &&
        (c.definition.spec.hostnames ?? []).some((n) => n.hostname === hostname),
    );
    return holder
      ? [{ path, message: `${hostname} belongs to the client ${holder.definition.metadata.id}` }]
      : [];
  });
};

type Text = string | { nb: string; en: string };

type HostLanguage = 'nb' | 'en';

const hostLanguages: readonly HostLanguage[] = ['nb', 'en'];

/** The service's languages the host's own words come in, in the service's order; bokmål when none do. */
export const languagesOf = (service: readonly string[] | undefined): HostLanguage[] => {
  const shared = (service ?? hostLanguages).filter((l): l is HostLanguage =>
    hostLanguages.includes(l as HostLanguage),
  );
  return shared.length > 0 ? shared : ['nb'];
};

export interface HostView {
  hostname: string;
  tenant: string;
  service: string;
  environment: string;
  name: Text;
  login: { issuer: string | null; clientId: string };
  languages: HostLanguage[];
  /** Designsystemet's default (Digdir) theme until a service's own is built (ADR 0063). */
  theme: null;
  menu: ({ label: Text; page: string } | { label: Text; href: string })[];
  pages: { id: string; title: Text }[];
}

export interface HostDeps {
  clients: ClientStore;
  definitions: DefinitionStore;
  configEntries: ConfigEntryStore;
  rules: HostingRules;
  issuer?: string | undefined;
}

const resolve = async (
  deps: HostDeps,
  asked: string,
): Promise<{ view: HostView; shown: ServiceInterface } | undefined> => {
  const hostname = asked.toLowerCase();
  if (!isHostname(hostname)) return undefined;
  if (deps.rules.reservedDomains.some((domain) => under(hostname, domain))) return undefined;
  const tenant = deps.rules.hostnames.get(hostname);
  if (!tenant) return undefined;
  const client = (await deps.clients.list(tenant)).find(
    (c) =>
      c.definition.metadata.tenant === tenant &&
      c.definition.spec.hosted === true &&
      (c.definition.spec.hostnames ?? []).some((n) => n.hostname === hostname),
  )?.definition;
  const claim = client?.spec.hostnames?.find((n) => n.hostname === hostname);
  if (!client || !claim || !client.spec.oidc) return undefined;
  const service = client.spec.service;
  if (await isHiddenService(deps.definitions, tenant, service)) return undefined;
  if ((await lifecycleOf(deps.configEntries, tenant, service)).state === 'archived')
    return undefined;
  const pointer = pointerOf(
    await environmentsOf(deps.configEntries, tenant, service),
    claim.environment,
  );
  if (!pointer) return undefined;
  const found = await deps.definitions.get('Service', tenant, service, pointer.version);
  if (!found || found.definition.kind !== 'Service') return undefined;
  if (pointer.version !== undefined && found.version !== pointer.version) return undefined;
  const definition = found.definition as ServiceDefinition;
  const shown: ServiceInterface | undefined = definition.spec.interface;
  if (!shown?.layout) return undefined;
  const view: HostView = {
    hostname,
    tenant,
    service,
    environment: claim.environment,
    name: shown.layout.profile?.assistantName ?? definition.metadata.name ?? service,
    login: { issuer: deps.issuer ?? null, clientId: client.spec.oidc.clientId },
    languages: languagesOf(definition.spec.languages),
    theme: null,
    menu: (shown.menu ?? []).map((item) =>
      'page' in item
        ? { label: item.label, page: item.page }
        : { label: item.label, href: item.href },
    ),
    pages: (shown.pages ?? []).map((p) => ({ id: p.id, title: p.title })),
  };
  return { view, shown };
};

/** What the host draws on `hostname` before anyone logs in, or nothing for a name that is not active. */
export const hostView = async (deps: HostDeps, asked: string) => (await resolve(deps, asked))?.view;

export const hostPage = async (deps: HostDeps, asked: string, id: string) =>
  (await resolve(deps, asked))?.shown.pages?.find((p) => p.id === id);

export const hostCacheSeconds = 60;

export const hostNotFoundType = 'urn:genai:problem:host-not-found';

export const registerHostRoutes = <E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  deps: HostDeps,
) => {
  const notFound = (c: Context) =>
    c.json({ type: hostNotFoundType, title: t('problems.hostNotFoundTitle'), status: 404 }, 404, {
      'content-type': 'application/problem+json',
      'cache-control': 'no-store',
    });
  const cached = { 'cache-control': `public, max-age=${hostCacheSeconds}` };
  app.get('/v1/hosts/:hostname', async (c) => {
    const found = await hostView(deps, c.req.param('hostname') ?? '');
    return found ? c.json(found, 200, cached) : notFound(c);
  });
  app.get('/v1/hosts/:hostname/pages/:id', async (c) => {
    const page = await hostPage(deps, c.req.param('hostname') ?? '', c.req.param('id') ?? '');
    return page ? c.json(page, 200, cached) : notFound(c);
  });
};
