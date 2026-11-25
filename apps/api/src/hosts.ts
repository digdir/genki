import type { DefinitionStore, ServiceDefinition, ServiceInterface } from '@genai/definitions';
import type { HostnameClaimStore } from '@genai/kernel';
import {
  isHostname,
  oidcAudienceOf,
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

export const assistantHostnameFrom = (env: NodeJS.ProcessEnv): string | undefined => {
  const name = env.GENAI_ASSISTANT_HOSTNAME?.trim().toLowerCase();
  return name && isHostname(name) ? name : undefined;
};

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
  /** genki's own assistant hostname, the one name in its zones a hosted Client may claim. */
  assistantHostname?: string | undefined;
  claims?: Pick<HostnameClaimStore, 'holder'> | undefined;
}

export interface HostnameOpening {
  tenant: string;
  client?: string;
  environment?: string;
  redirectTo?: string;
}

export const openingOf = async (
  rules: HostingRules,
  hostname: string,
): Promise<HostnameOpening | undefined> => {
  const tenant = openedTo(rules, hostname);
  if (tenant) return { tenant };
  const claim = await rules.claims?.holder(hostname);
  if (claim?.state !== 'active') return undefined;
  return {
    tenant: claim.tenant,
    client: claim.client,
    ...(claim.environment ? { environment: claim.environment } : {}),
    ...(claim.redirectTo ? { redirectTo: claim.redirectTo } : {}),
  };
};

/** The tenant a hostname is open to, when it is open to hosting at all. */
export const openedTo = (rules: HostingRules, hostname: string): string | undefined =>
  isAssignedName(hostname) ||
  hostname === rules.assistantHostname ||
  !rules.reservedDomains.some((domain) => under(hostname, domain))
    ? rules.hostnames.get(hostname)
    : undefined;

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
    if (openedTo(rules, hostname) !== tenant)
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
  login: {
    issuer: string | null;
    clientId: string;
    audience: string;
    altinnResource: string | null;
  };
  languages: HostLanguage[];
  /** Designsystemet's default (Digdir) theme until a service's own is built (ADR 0063). */
  theme: null;
  icon: string | null;
  menu: ({ label: Text; page: string } | { label: Text; href: string })[];
  pages: { id: string; title: Text }[];
}

export interface HostDeps {
  clients: ClientStore;
  definitions: DefinitionStore;
  configEntries: ConfigEntryStore;
  rules: HostingRules;
  issuer?: string | undefined;
  altinnResource?: string | undefined;
  /** genki's own login client, for a hosted Client without `oidc` (ADR 0061). */
  platformLogin?: { clientId: string; audience: string } | undefined;
}

export interface HostRedirect {
  hostname: string;
  redirectTo: string;
}

const hostedClient = async (
  deps: HostDeps,
  hostname: string,
  opening: HostnameOpening,
): Promise<{ client: ClientDefinition; environment: string } | undefined> => {
  const { tenant } = opening;
  if (opening.client) {
    const client = (await deps.clients.get(tenant, opening.client))?.definition;
    if (!client || client.metadata.tenant !== tenant || client.spec.hosted !== true)
      return undefined;
    return { client, environment: opening.environment ?? 'prod' };
  }
  const client = (await deps.clients.list(tenant)).find(
    (c) =>
      c.definition.metadata.tenant === tenant &&
      c.definition.spec.hosted === true &&
      (c.definition.spec.hostnames ?? []).some((n) => n.hostname === hostname),
  )?.definition;
  const named = client?.spec.hostnames?.find((n) => n.hostname === hostname);
  return client && named ? { client, environment: named.environment } : undefined;
};

const resolve = async (
  deps: HostDeps,
  asked: string,
): Promise<{ view: HostView; shown: ServiceInterface } | undefined> => {
  const hostname = asked.toLowerCase();
  if (!isHostname(hostname)) return undefined;
  const opening = await openingOf(deps.rules, hostname);
  if (!opening || opening.redirectTo) return undefined;
  const tenant = opening.tenant;
  const hosted = await hostedClient(deps, hostname, opening);
  if (!hosted) return undefined;
  const { client, environment } = hosted;
  const login = client.spec.oidc
    ? {
        clientId: client.spec.oidc.clientId,
        audience: oidcAudienceOf(client) ?? client.spec.oidc.clientId,
      }
    : deps.platformLogin;
  if (!login) return undefined;
  const service = client.spec.service;
  if (await isHiddenService(deps.definitions, tenant, service)) return undefined;
  if ((await lifecycleOf(deps.configEntries, tenant, service)).state === 'archived')
    return undefined;
  const pointer = pointerOf(await environmentsOf(deps.configEntries, tenant, service), environment);
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
    environment,
    name: shown.layout.profile?.assistantName ?? definition.metadata.name ?? service,
    login: {
      issuer: deps.issuer ?? null,
      clientId: login.clientId,
      audience: login.audience,
      altinnResource: deps.altinnResource ?? null,
    },
    languages: languagesOf(definition.spec.languages),
    theme: null,
    icon: shown.icon ?? null,
    menu: (shown.menu ?? []).map((item) =>
      'page' in item
        ? { label: item.label, page: item.page }
        : { label: item.label, href: item.href },
    ),
    pages: (shown.pages ?? []).map((p) => ({ id: p.id, title: p.title })),
  };
  return { view, shown };
};

const redirectOf = async (deps: HostDeps, asked: string): Promise<HostRedirect | undefined> => {
  const hostname = asked.toLowerCase();
  if (!isHostname(hostname)) return undefined;
  const opening = await openingOf(deps.rules, hostname);
  if (!opening?.redirectTo || !opening.client) return undefined;
  const target = await openingOf(deps.rules, opening.redirectTo);
  if (!target || target.tenant !== opening.tenant || target.redirectTo) return undefined;
  const served = await resolve(deps, opening.redirectTo);
  return served && served.view.tenant === opening.tenant
    ? { hostname, redirectTo: opening.redirectTo }
    : undefined;
};

/** What the host draws on `hostname` before anyone logs in, or nothing for a name that is not active. */
export const hostView = async (deps: HostDeps, asked: string) => (await resolve(deps, asked))?.view;

export const hostAnswer = async (
  deps: HostDeps,
  asked: string,
): Promise<HostView | HostRedirect | undefined> =>
  (await hostView(deps, asked)) ?? (await redirectOf(deps, asked));

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
    const found = await hostAnswer(deps, c.req.param('hostname') ?? '');
    return found ? c.json(found, 200, cached) : notFound(c);
  });
  app.get('/v1/hosts/:hostname/pages/:id', async (c) => {
    const page = await hostPage(deps, c.req.param('hostname') ?? '', c.req.param('id') ?? '');
    return page ? c.json(page, 200, cached) : notFound(c);
  });
};
