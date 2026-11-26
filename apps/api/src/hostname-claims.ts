import { randomBytes, randomUUID } from 'node:crypto';
import type { Principal } from '@genai/contracts';
import type { DefinitionStore, ServiceDefinition } from '@genai/definitions';
import { isHostname, maxHostnames, type ClientStore, type StoredClient } from '@genai/identity';
import {
  bindingRetryMs,
  heldClaimStates,
  hostTargetFrom,
  type BinderStep,
  type HostTarget,
  type ClaimWrite,
  type HostnameClaim,
  type HostnameClaimState,
  type HostnameClaimStore,
} from '@genai/kernel';
import type { Context, Env, Hono, Schema } from 'hono';
import { enterTenant, tenantAccess } from './access.js';
import { actorOf, platformActor, type Admin, type AdminHandler } from './admin.js';
import type { ConfigEntryStore } from './config-store.js';
import { saveClient, type FrontendDeps } from './frontends.js';
import { hostnameNotAllowed, openedTo, type HostingRules } from './hosts.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { isBinder, type BinderTrust } from './binder-token.js';
import { isHiddenService } from './internal-services.js';
import { isOperator, rightRefused, type Right } from './rights.js';
import { environmentsOf, pointerOf, productionEnvironment } from './service-environments.js';

export const hostnameAddAction = 'platform.client.hostnames.add';
export const hostnameRemoveAction = 'platform.client.hostnames.remove';
export const serviceAddressAction = 'platform.service.address';
export const hostnameBindAction = 'platform.client.hostnames.bind';

export const hostnameLimitCode = 'hostname_limit';
export const notVerifiedCode = 'not_verified';
export const bindFailedCode = 'bind_failed';
export const expiredCode = 'expired';

export const maxHostnamesPerTenant = 20;
export const maxPendingPerTenant = 5;
export const defaultHostnameLimit = 200;

export const defaultReservedLabels = [
  'login',
  'assistant',
  'kunnskap',
  'api',
  'portal',
  'console',
  'workspace',
  'www',
  'auth',
  'bff',
  'admin',
  'apps',
  'status',
  'docs',
  'mail',
];

export interface HostnameSetup {
  claims: HostnameClaimStore;
  zone?: string | undefined;
  target: HostTarget;
  limit: number;
  reservedLabels: readonly string[];
}

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const hostnameSetupFrom = (
  env: NodeJS.ProcessEnv,
  claims: HostnameClaimStore,
  rules: Pick<HostingRules, 'hostnames'>,
): HostnameSetup => {
  const zone = env.GENAI_DNS_ZONE?.trim().toLowerCase();
  const limit = Number(env.GENAI_HOSTNAME_LIMIT ?? defaultHostnameLimit);
  const zoneOk = zone !== undefined && isHostname(zone);
  const takenLabels = zoneOk
    ? [...rules.hostnames.keys()].flatMap((h) => {
        const suffix = `.apps.${zone}`;
        return h.endsWith(suffix) ? [h.slice(0, -suffix.length)] : [];
      })
    : [];
  return {
    claims,
    zone: zoneOk ? zone : undefined,
    target: hostTargetFrom(env),
    limit: Number.isInteger(limit) && limit > 0 ? limit : defaultHostnameLimit,
    reservedLabels: [...defaultReservedLabels, ...takenLabels],
  };
};

export interface DnsRecord {
  type: 'TXT' | 'CNAME' | 'A';
  name: string;
  value: string;
}

export const challengeName = (hostname: string) => `_genki-challenge.${hostname}`;
export const asuidName = (hostname: string) => `asuid.${hostname}`;

export const recordsOf = (claim: HostnameClaim, target: HostTarget): DnsRecord[] =>
  claim.assigned
    ? []
    : [
        { type: 'TXT', name: challengeName(claim.hostname), value: claim.token },
        { type: 'TXT', name: asuidName(claim.hostname), value: target.verificationId ?? '' },
        claim.apex
          ? { type: 'A', name: claim.hostname, value: target.staticIp ?? '' }
          : { type: 'CNAME', name: claim.hostname, value: target.fqdn ?? '' },
      ];

export interface HostnameView {
  id: string | null;
  hostname: string;
  client: string;
  environment: string | null;
  redirectTo: string | null;
  apex: boolean;
  assigned: boolean;
  managed: boolean;
  state: HostnameClaimState;
  failure: string | null;
  records: DnsRecord[];
  checkedAt: string | null;
  createdAt: string | null;
}

export const claimView = (claim: HostnameClaim, target: HostTarget): HostnameView => ({
  id: claim.id,
  hostname: claim.hostname,
  client: claim.client,
  environment: claim.environment ?? null,
  redirectTo: claim.redirectTo ?? null,
  apex: claim.apex,
  assigned: claim.assigned,
  managed: false,
  state: claim.state,
  failure: claim.failure ?? null,
  records: recordsOf(claim, target),
  checkedAt: claim.check?.at ?? null,
  createdAt: claim.createdAt,
});

const under = (hostname: string, domain: string) =>
  hostname === domain || hostname.endsWith(`.${domain}`);

export const claimRefusal = (
  hostname: string,
  rules: HostingRules,
  zone?: string,
): string | undefined => {
  if (!isHostname(hostname)) return `${hostnameNotAllowed}: not a hostname that can be claimed`;
  if ([...rules.reservedDomains, ...(zone ? [zone] : [])].some((domain) => under(hostname, domain)))
    return `${hostnameNotAllowed}: ${hostname} is under a reserved domain`;
  if (rules.hostnames.has(hostname))
    return `${hostnameNotAllowed}: ${hostname} is opened by the platform`;
  return undefined;
};

const live = (claim: HostnameClaim) => claim.state !== 'removed';
const counted = (claim: HostnameClaim) => claim.state !== 'removed' && claim.state !== 'failed';

export const labelsFor = (service: string): string[] => {
  const base = service
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 61);
  const trimmed = base.replace(/^-+/, '').replace(/-+$/, '');
  const label = trimmed === '' ? 'tjeneste' : trimmed;
  return [label, ...Array.from({ length: 8 }, (_, i) => `${label.slice(0, 59)}-${i + 2}`)].filter(
    (l) => dnsLabel.test(l),
  );
};

export interface ClaimDeps {
  setup: HostnameSetup;
  rules: HostingRules;
  clients: ClientStore;
  definitions: DefinitionStore;
  configEntries: ConfigEntryStore;
  locked?: boolean;
  reservedClientIds?: string[];
  now?: () => Date;
  newId?: () => string;
  newToken?: () => string;
}

type Outcome = Awaited<ReturnType<AdminHandler>>;

const refused = (target: string, path: string, message: string): Outcome => ({
  ok: false,
  errors: [{ path, message }],
  target,
});

const forTenant = (principal: Principal, tenant: string) =>
  !principal.confinedTo &&
  principal.tenant === tenant &&
  (principal.kind !== 'operator' || principal.actor !== undefined);

const isPlatform = (principal: Principal) =>
  principal.kind === 'workload' && principal.issuer === 'platform';

const frontendDeps = (deps: ClaimDeps): FrontendDeps => ({
  clients: deps.clients,
  definitions: deps.definitions,
  hosting: deps.rules,
  ...(deps.reservedClientIds ? { reservedClientIds: deps.reservedClientIds } : {}),
  ...(deps.now ? { now: deps.now } : {}),
});

const freshClaim = (
  deps: ClaimDeps,
  fields: Pick<HostnameClaim, 'tenant' | 'client' | 'service' | 'hostname' | 'apex' | 'createdBy'> &
    Partial<HostnameClaim>,
): HostnameClaim => {
  const at = (deps.now?.() ?? new Date()).toISOString();
  return {
    id: deps.newId?.() ?? randomUUID(),
    assigned: false,
    token: deps.newToken?.() ?? randomBytes(24).toString('base64url'),
    state: 'pending-dns',
    step: 'add',
    stateSince: at,
    createdAt: at,
    updatedAt: at,
    version: 1,
    ...fields,
  };
};

const limitProblem = async (
  deps: ClaimDeps,
  tenant: string,
  client: StoredClient | undefined,
  pending: boolean,
): Promise<string | undefined> => {
  const own = (await deps.setup.claims.list(tenant)).filter(counted);
  const ofClient = own.filter((c) => c.client === client?.definition.metadata.id);
  const claimedNames = new Set(ofClient.map((c) => c.hostname));
  const opened = (client?.definition.spec.hostnames ?? []).filter(
    (n) => !claimedNames.has(n.hostname),
  );
  if (ofClient.length + opened.length >= maxHostnames)
    return `${hostnameLimitCode}: at most ${maxHostnames} hostnames per client`;
  if (own.length >= maxHostnamesPerTenant)
    return `${hostnameLimitCode}: at most ${maxHostnamesPerTenant} hostnames per organisation`;
  if (pending && own.filter((c) => c.state === 'pending-dns').length >= maxPendingPerTenant)
    return `${hostnameLimitCode}: at most ${maxPendingPerTenant} hostnames waiting for DNS`;
  const held = await deps.setup.claims.inStates(heldClaimStates, deps.setup.limit + 1);
  if (held.length >= deps.setup.limit)
    return `${hostnameLimitCode}: the platform holds as many hostnames as it can`;
  return undefined;
};

const hostedClientOf = async (deps: ClaimDeps, tenant: string, id: string) => {
  const client = await deps.clients.get(tenant, id);
  return client?.definition.spec.hosted === true ? client : undefined;
};

const mayBeBound = new Set<HostnameClaimState>(['binding', 'active', 'removing', 'lapsed']);

export const nextAfterRemoval = (claim: HostnameClaim): HostnameClaimState =>
  mayBeBound.has(claim.state) ? 'removing' : 'removed';

export type ClaimPatch = { [K in keyof HostnameClaim]?: HostnameClaim[K] | undefined };

const moved = (
  deps: Pick<ClaimDeps, 'now'>,
  claim: HostnameClaim,
  patch: ClaimPatch,
): HostnameClaim => {
  const at = (deps.now?.() ?? new Date()).toISOString();
  const next = Object.fromEntries(
    Object.entries({ ...claim, ...patch, updatedAt: at, version: claim.version + 1 }).filter(
      ([, value]) => value !== undefined,
    ),
  ) as unknown as HostnameClaim;
  if (patch.state && patch.state !== claim.state) next.stateSince = at;
  return next;
};

const removeClaim = async (
  deps: Pick<ClaimDeps, 'setup' | 'now'>,
  claim: HostnameClaim,
): Promise<{ written: ClaimWrite; next: HostnameClaim }> => {
  if (claim.state === 'removing') return { written: 'ok', next: claim };
  const state = nextAfterRemoval(claim);
  const next = moved(deps, claim, { state, step: state === 'removing' ? 'unbind' : 'done' });
  const written = await deps.setup.claims.update(next);
  if (written !== 'taken') return { written, next };
  const removed = moved(deps, claim, { state: 'removed', step: 'done' });
  return { written: await deps.setup.claims.update(removed), next: removed };
};

type ClaimRelease = Pick<ClaimDeps, 'setup' | 'now'> & Partial<ClaimDeps>;

const releaseWhere = async (
  deps: ClaimRelease,
  tenant: string,
  which: (claim: HostnameClaim) => boolean,
) => {
  for (const claim of (await deps.setup.claims.list(tenant)).filter(
    (c) => which(c) && live(c) && c.state !== 'removing',
  ))
    await removeClaim(deps, claim);
};

export const releaseClientClaims = (deps: ClaimRelease, tenant: string, client: string) =>
  releaseWhere(deps, tenant, (c) => c.client === client);

export const releaseEnvironmentClaims = (
  deps: ClaimRelease,
  tenant: string,
  service: string,
  environment: string,
) => releaseWhere(deps, tenant, (c) => c.service === service && c.environment === environment);

const productionDefinition = async (deps: ClaimDeps, tenant: string, service: string) => {
  const pointer = pointerOf(
    await environmentsOf(deps.configEntries, tenant, service),
    productionEnvironment,
  );
  if (!pointer) return undefined;
  const found = await deps.definitions.get('Service', tenant, service, pointer.version);
  return found?.definition.kind === 'Service' ? (found.definition as ServiceDefinition) : undefined;
};

const addressChannels = ['openai', 'conversations', 'feedback', 'facets'] as const;

const addressClientIds = (service: string) => {
  const base = `${service.slice(0, 57)}-host`;
  return [base, ...Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`)];
};

/** The hosted Client genki made for the service's address, still set up as genki made it. */
export const isAddressClientOf = (
  client: StoredClient,
  service: string,
  claims: readonly HostnameClaim[],
) => {
  const { metadata, spec } = client.definition;
  return (
    addressClientIds(service).includes(metadata.id) &&
    spec.service === service &&
    spec.hosted === true &&
    spec.kind === 'browser' &&
    !spec.oidc &&
    !spec.webhook &&
    !spec.url &&
    !spec.environments?.length &&
    !spec.hostnames?.length &&
    spec.allowedOrigins.length === 0 &&
    spec.channels.length === addressChannels.length &&
    addressChannels.every((channel) => spec.channels.includes(channel)) &&
    claims.some((c) => c.client === metadata.id && c.service === service && c.assigned)
  );
};

export const liveHostnamesOf = (claims: readonly HostnameClaim[], client: string) =>
  claims.filter((c) => c.client === client && live(c)).map((c) => c.hostname);

const clientIdFor = (service: string, taken: ReadonlySet<string>) =>
  addressClientIds(service).find((id) => !taken.has(id));

export type AssignResult =
  | { ok: true; claim: HostnameClaim; client: StoredClient }
  | { ok: false; path: string; message: string };

export const assignAddress = async (
  deps: ClaimDeps,
  tenant: string,
  service: string,
  by: { actor: string; operator: boolean },
): Promise<AssignResult> => {
  const { zone } = deps.setup;
  if (!zone) return { ok: false, path: 'zone', message: 'no_zone: the platform assigns no names' };
  if (await isHiddenService(deps.definitions, tenant, service))
    return { ok: false, path: 'id', message: 'no such service' };
  const definition = await productionDefinition(deps, tenant, service);
  if (!definition)
    return {
      ok: false,
      path: 'service',
      message: 'not_published: the service has no published version',
    };
  if (!definition.spec.interface?.layout)
    return {
      ok: false,
      path: 'service',
      message: 'no_interface: the service has no assistant interface',
    };
  const claims = (await deps.setup.claims.list(tenant)).filter((c) => c.service === service);
  const listed = await deps.clients.list(tenant);
  const own = claims.find(
    (c) =>
      c.assigned && (c.state === 'binding' || c.state === 'active' || c.state === 'pending-dns'),
  );
  if (own) {
    const client = listed.find((c) => c.definition.metadata.id === own.client);
    if (client) return { ok: true, claim: own, client };
  }
  const hosted = listed.filter(
    (c) => c.definition.spec.service === service && c.definition.spec.hosted === true,
  );
  if (hosted.some((c) => (c.definition.spec.hostnames ?? []).length > 0))
    return {
      ok: false,
      path: 'service',
      message: 'has_address: the service has an address already',
    };
  let client = hosted.find((c) => !c.definition.spec.oidc) ?? hosted[0];
  const limit = await limitProblem(deps, tenant, client, false);
  if (limit) return { ok: false, path: 'hostname', message: limit };
  if (!client) {
    if (deps.locked && !by.operator)
      return {
        ok: false,
        path: 'principal',
        message: 'in lockdown only a platform operator marks a client hosted',
      };
    const id = clientIdFor(service, new Set(listed.map((c) => c.definition.metadata.id)));
    if (!id) return { ok: false, path: 'client', message: 'no free client id' };
    const saved = await saveClient(
      frontendDeps(deps),
      {
        apiVersion: 'genai/v1',
        kind: 'Client',
        metadata: { tenant, id, name: definition.metadata.name ?? service },
        spec: {
          service,
          kind: 'browser',
          channels: [...addressChannels],
          allowedOrigins: [],
          hosted: true,
          hostnames: [],
        },
      },
      by.actor,
    );
    if (!saved.ok)
      return {
        ok: false,
        path: saved.errors[0]?.path ?? 'client',
        message: saved.errors[0]?.message ?? '',
      };
    client = saved.client;
  }
  for (const label of labelsFor(service)) {
    if (deps.setup.reservedLabels.includes(label)) continue;
    const hostname = `${label}.apps.${zone}`;
    if (!isHostname(hostname) || deps.rules.hostnames.has(hostname)) continue;
    const claim = freshClaim(deps, {
      tenant,
      client: client.definition.metadata.id,
      service,
      hostname,
      environment: productionEnvironment,
      apex: false,
      assigned: true,
      zone,
      recordName: `${label}.apps`,
      state: 'binding',
      step: 'add',
      createdBy: by.actor,
    });
    if ((await deps.setup.claims.create(claim)) === 'ok') return { ok: true, claim, client };
  }
  return { ok: false, path: 'hostname', message: 'no free name under apps.' };
};

export const wantsAutoAddress = async (
  deps: ClaimDeps,
  tenant: string,
  service: string,
  by: { operator: boolean },
): Promise<boolean> => {
  if (!deps.setup.zone) return false;
  if ((await deps.setup.claims.list(tenant)).some((c) => c.service === service && c.assigned))
    return false;
  const hosted = (await deps.clients.list(tenant)).filter(
    (c) => c.definition.spec.service === service && c.definition.spec.hosted === true,
  );
  if (hosted.some((c) => (c.definition.spec.hostnames ?? []).length > 0)) return false;
  if (hosted.length === 0 && deps.locked && !by.operator) return false;
  const definition = await productionDefinition(deps, tenant, service);
  return Boolean(definition?.spec.interface?.layout);
};

export type BinderResult = {
  step: BinderStep;
  ok: boolean;
  message?: string;
  certificateId?: string;
};

const nextStep: Partial<Record<BinderStep, BinderStep>> = {
  add: 'certificate',
  certificate: 'enable',
};

export const afterBinderResult = (
  claim: HostnameClaim,
  result: BinderResult,
  now: Date,
): ClaimPatch | 'mismatch' => {
  const expected = claim.state === 'binding' || claim.state === 'removing';
  if (!expected || result.step !== claim.step) return 'mismatch';
  const kept = {
    ...(result.certificateId ? { certificateId: result.certificateId } : {}),
  };
  if (result.ok) {
    if (claim.state === 'removing')
      return { state: claim.failure ? 'failed' : 'removed', step: 'done', ...kept };
    const step = nextStep[claim.step];
    return step
      ? { step, message: undefined, ...kept }
      : { state: 'active', step: 'done', failure: undefined, message: undefined, ...kept };
  }
  const message = (result.message ?? 'failed').slice(0, 500);
  if (
    claim.state === 'binding' &&
    now.getTime() - new Date(claim.stateSince).getTime() >= bindingRetryMs
  )
    return claim.step === 'add'
      ? { state: 'failed', failure: `${bindFailedCode}: add`, message, ...kept }
      : {
          state: 'removing',
          step: 'unbind',
          failure: `${bindFailedCode}: ${claim.step}`,
          message,
          ...kept,
        };
  return { message, ...kept };
};

export const hostnameAdminHandlers = (deps: ClaimDeps): Record<string, AdminHandler> => ({
  [hostnameAddAction]: async (input, principal) => {
    const clientId = String(input.client ?? '');
    const target = `client:${input.tenant}/${clientId}`;
    if (!forTenant(principal, input.tenant))
      return refused(target, 'principal', 'only the tenant or an operator claims its hostnames');
    const client = await hostedClientOf(deps, input.tenant, clientId);
    if (!client) return refused(target, 'id', 'no such hosted client');
    const hostname = String(input.hostname ?? '')
      .trim()
      .toLowerCase();
    const refusal = claimRefusal(hostname, deps.rules, deps.setup.zone);
    if (refusal) return refused(target, 'hostname', refusal);
    const redirectTo =
      typeof input.redirectTo === 'string' ? input.redirectTo.trim().toLowerCase() : undefined;
    const environment =
      typeof input.environment === 'string' ? input.environment.trim() : undefined;
    if ((redirectTo === undefined) === (environment === undefined))
      return refused(target, 'environment', 'give either environment or redirectTo');
    if (environment !== undefined) {
      const allowed = client.definition.spec.environments?.length
        ? client.definition.spec.environments
        : [productionEnvironment];
      if (!allowed.includes(environment))
        return refused(target, 'environment', `the client may not use ${environment}`);
    }
    const claims = (await deps.setup.claims.list(input.tenant)).filter(live);
    if (redirectTo !== undefined) {
      const ofClient =
        (client.definition.spec.hostnames ?? []).some((n) => n.hostname === redirectTo) ||
        claims.some((c) => c.client === clientId && c.hostname === redirectTo && !c.redirectTo);
      if (!ofClient || redirectTo === hostname)
        return refused(target, 'redirectTo', 'redirectTo must be another hostname of the client');
    }
    if (
      claims.some((c) => c.hostname === hostname && c.state !== 'failed' && c.state !== 'lapsed') ||
      (client.definition.spec.hostnames ?? []).some((n) => n.hostname === hostname)
    )
      return refused(target, 'hostname', `${hostname} is claimed by this organisation already`);
    const limit = await limitProblem(deps, input.tenant, client, true);
    if (limit) return refused(target, 'hostname', limit);
    const apex = input.apex === true;
    if (apex && !deps.setup.target.staticIp)
      return refused(target, 'apex', 'apex names are not offered on this platform');
    const claim = freshClaim(deps, {
      tenant: input.tenant,
      client: clientId,
      service: client.definition.spec.service,
      hostname,
      apex,
      ...(environment !== undefined ? { environment } : {}),
      ...(redirectTo !== undefined ? { redirectTo } : {}),
      createdBy: actorOf(principal.actor ?? principal),
    });
    await deps.setup.claims.create(claim);
    return {
      ok: true,
      value: claimView(claim, deps.setup.target),
      target: `hostname:${input.tenant}/${hostname}`,
      audit: { after: { hostname, environment, redirectTo, apex, claim: claim.id } },
    };
  },
  [hostnameRemoveAction]: async (input, principal) => {
    const clientId = String(input.client ?? '');
    const hostname = String(input.hostname ?? '').toLowerCase();
    const target = `hostname:${input.tenant}/${hostname}`;
    if (!forTenant(principal, input.tenant))
      return refused(target, 'principal', 'only the tenant or an operator removes its hostnames');
    const named = (await deps.setup.claims.list(input.tenant)).filter(
      (c) => c.client === clientId && c.hostname === hostname && live(c),
    );
    const claim =
      named.find((c) => heldClaimStates.includes(c.state)) ??
      named.find((c) => c.state === 'pending-dns') ??
      named.at(-1);
    if (!claim) return refused(target, 'id', 'no such hostname');
    const { written, next } = await removeClaim(deps, claim);
    if (written !== 'ok')
      return refused(target, 'state', 'the hostname changed meanwhile; try again');
    return {
      ok: true,
      value: claimView(next, deps.setup.target),
      target,
      audit: { before: { state: claim.state }, after: { state: next.state } },
    };
  },
  [serviceAddressAction]: async (input, principal) => {
    const service = String(input.service ?? '');
    const target = `service:${input.tenant}/${service}`;
    const platform = isPlatform(principal);
    if (!platform && !forTenant(principal, input.tenant))
      return refused(target, 'principal', 'only the tenant or an operator gives an address');
    const result = await assignAddress(deps, input.tenant, service, {
      actor: platform
        ? String(input.by ?? actorOf(principal))
        : actorOf(principal.actor ?? principal),
      operator: platform ? input.byOperator === true : isOperator(principal),
    });
    if (!result.ok) return refused(target, result.path, result.message);
    return {
      ok: true,
      value: claimView(result.claim, deps.setup.target),
      target,
      audit: { after: { hostname: result.claim.hostname, client: result.claim.client } },
    };
  },
  [hostnameBindAction]: async (input, principal) => {
    const id = String(input.id ?? '');
    const target = `hostname-claim:${input.tenant}/${id}`;
    if (!isPlatform(principal) || principal.subject !== 'hostname-binder')
      return refused(target, 'principal', 'only the hostname binder reports results');
    const claim = await deps.setup.claims.get(input.tenant, id);
    if (!claim) return refused(target, 'id', 'no such claim');
    const result = input.result as BinderResult;
    const patch = afterBinderResult(claim, result, deps.now?.() ?? new Date());
    if (patch === 'mismatch')
      return refused(target, 'step', 'step_mismatch: the claim is at another step');
    const next = moved(deps, claim, patch);
    if ((await deps.setup.claims.update(next)) !== 'ok')
      return refused(target, 'state', 'the claim changed meanwhile');
    return {
      ok: true,
      value: { state: next.state, step: next.step },
      target: `hostname:${input.tenant}/${claim.hostname}`,
      audit: {
        before: { state: claim.state, step: claim.step },
        after: { state: next.state, step: next.step, ok: result.ok },
      },
    };
  },
});

export interface ClaimRouteDeps extends ClaimDeps {
  admin: Admin;
  authenticate(request: Request): Promise<Principal | undefined>;
  binder?: BinderTrust | undefined;
}

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409,
  title: string,
  errors: unknown[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const workItem = (claim: HostnameClaim) => ({
  id: claim.id,
  hostname: claim.hostname,
  apex: claim.apex,
  action: claim.state === 'removing' ? ('remove' as const) : ('bind' as const),
  step: claim.step,
  ...(claim.assigned && claim.zone && claim.recordName
    ? { zone: claim.zone, recordName: claim.recordName }
    : {}),
});

const binderSteps = new Set<string>(['add', 'certificate', 'enable', 'unbind', 'done']);

export const registerHostnameRoutes = <E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  deps: ClaimRouteDeps,
) => {
  const access = tenantAccess;
  const guard = async (c: Context, right?: Right) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Unauthorized');
    const tenant = c.req.param('tenant') ?? '';
    if (principal.confinedTo) return problem(c, 404, 'Not found');
    const entered = enterTenant(c, access, principal, tenant, right);
    if ('response' in entered) return entered.response;
    return { principal: entered.principal, tenant };
  };

  const perform = async (
    c: Context,
    principal: Principal,
    action: string,
    reason: string,
    data: Record<string, unknown> & { tenant: string },
  ) => {
    if (!isReasonLongEnough(reason))
      return problem(c, 400, 'Invalid request', [
        { path: 'change-reason', message: reasonTooShort },
      ]);
    const result = await deps.admin.perform(principal, action, { ...data, reason });
    c.header('genai-task', result.task);
    if (result.ok) return { value: result.value };
    if (result.problem) return rightRefused(c, result.problem);
    const forbidden = result.errors.some((e) => e.path === 'principal');
    if (!forbidden && result.errors.some((e) => e.path === 'id'))
      return problem(c, 404, 'Not found', result.errors);
    return problem(
      c,
      forbidden ? 403 : 400,
      forbidden ? 'Forbidden' : 'Invalid request',
      result.errors,
    );
  };

  const viewsOf = async (tenant: string, clients: StoredClient[]) => {
    const ids = new Set(clients.map((c) => c.definition.metadata.id));
    const claims = (await deps.setup.claims.list(tenant)).filter(
      (c) => ids.has(c.client) && live(c),
    );
    const claimed = new Set(claims.map((c) => c.hostname));
    const managed: HostnameView[] = clients.flatMap((c) =>
      (c.definition.spec.hostnames ?? [])
        .filter((n) => !claimed.has(n.hostname) && openedTo(deps.rules, n.hostname) === tenant)
        .map((n) => ({
          id: null,
          hostname: n.hostname,
          client: c.definition.metadata.id,
          environment: n.environment,
          redirectTo: null,
          apex: false,
          assigned: false,
          managed: true,
          state: 'active' as const,
          failure: null,
          message: null,
          records: [],
          checkedAt: null,
          createdAt: null,
        })),
    );
    return [...managed, ...claims.map((c) => claimView(c, deps.setup.target))];
  };

  app.get('/tenants/:tenant/clients/:client/hostnames', async (c) => {
    const g = await guard(c);
    if (g instanceof Response) return g;
    const client = await hostedClientOf(deps, g.tenant, c.req.param('client') ?? '');
    if (!client) return problem(c, 404, 'Not found');
    return c.json({ hostnames: await viewsOf(g.tenant, [client]) });
  });

  app.post('/tenants/:tenant/clients/:client/hostnames', async (c) => {
    const g = await guard(c, 'manage-services');
    if (g instanceof Response) return g;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const reason =
      changeReasonOf(c)?.trim() || (typeof body.reason === 'string' ? body.reason.trim() : '');
    const done = await perform(c, g.principal, hostnameAddAction, reason, {
      tenant: g.tenant,
      client: c.req.param('client') ?? '',
      hostname: body.hostname,
      ...(body.environment === undefined ? {} : { environment: body.environment }),
      ...(body.redirectTo === undefined ? {} : { redirectTo: body.redirectTo }),
      ...(body.apex === undefined ? {} : { apex: body.apex }),
    });
    if (done instanceof Response) return done;
    return c.json(done.value, 201);
  });

  app.delete('/tenants/:tenant/clients/:client/hostnames/:hostname', async (c) => {
    const g = await guard(c, 'manage-services');
    if (g instanceof Response) return g;
    const done = await perform(
      c,
      g.principal,
      hostnameRemoveAction,
      changeReasonOf(c)?.trim() ?? '',
      {
        tenant: g.tenant,
        client: c.req.param('client') ?? '',
        hostname: c.req.param('hostname') ?? '',
      },
    );
    if (done instanceof Response) return done;
    return c.json(done.value);
  });

  app.get('/tenants/:tenant/services/:service/hostnames', async (c) => {
    const g = await guard(c);
    if (g instanceof Response) return g;
    const service = c.req.param('service') ?? '';
    if (await isHiddenService(deps.definitions, g.tenant, service))
      return problem(c, 404, 'Not found');
    const hosted = (await deps.clients.list(g.tenant)).filter(
      (x) => x.definition.spec.service === service && x.definition.spec.hosted === true,
    );
    const hostnames = await viewsOf(g.tenant, hosted);
    return c.json({
      client: hosted[0]?.definition.metadata.id ?? null,
      hostnames,
      assigns: deps.setup.zone !== undefined,
      target: deps.setup.target,
    });
  });

  app.post('/tenants/:tenant/services/:service/address', async (c) => {
    const g = await guard(c, 'manage-services');
    if (g instanceof Response) return g;
    const done = await perform(
      c,
      g.principal,
      serviceAddressAction,
      changeReasonOf(c)?.trim() ?? '',
      { tenant: g.tenant, service: c.req.param('service') ?? '' },
    );
    if (done instanceof Response) return done;
    return c.json(done.value, 201);
  });

  const notFound = (c: Context) =>
    c.json({ type: 'about:blank', title: 'Not found', status: 404 }, 404, {
      'content-type': 'application/problem+json',
    });

  app.get('/internal/hostnames/work', async (c) => {
    if (!(await isBinder(deps.binder, c.req.header('authorization')))) return notFound(c);
    const items = await deps.setup.claims.inStates(['binding', 'removing'], deps.setup.limit);
    return c.json({ items: items.map(workItem) }, 200, { 'cache-control': 'no-store' });
  });

  app.post('/internal/hostnames/:id/result', async (c) => {
    if (!(await isBinder(deps.binder, c.req.header('authorization')))) return notFound(c);
    const claim = await deps.setup.claims.find(c.req.param('id') ?? '');
    if (!claim || (claim.state !== 'binding' && claim.state !== 'removing')) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (
      typeof body.step !== 'string' ||
      !binderSteps.has(body.step) ||
      typeof body.ok !== 'boolean'
    )
      return problem(c, 400, 'Invalid request', [{ path: 'step', message: 'give step and ok' }]);
    const result: BinderResult = {
      step: body.step as BinderStep,
      ok: body.ok,
      ...(typeof body.message === 'string' ? { message: body.message.slice(0, 500) } : {}),
      ...(typeof body.certificateId === 'string' && body.certificateId.length <= 512
        ? { certificateId: body.certificateId }
        : {}),
    };
    const patch = afterBinderResult(claim, result, deps.now?.() ?? new Date());
    if (patch === 'mismatch')
      return problem(c, 409, 'Conflict', [
        { path: 'step', message: 'step_mismatch: the claim is at another step' },
      ]);
    const changes =
      (patch.state !== undefined && patch.state !== claim.state) ||
      (patch.step !== undefined && patch.step !== claim.step) ||
      (!result.ok && claim.message === undefined);
    if (!changes) {
      const next = moved(deps, claim, patch);
      if ((await deps.setup.claims.update(next)) !== 'ok')
        return problem(c, 409, 'Conflict', [
          { path: 'state', message: 'the claim changed meanwhile' },
        ]);
      return c.json({ state: next.state, step: next.step });
    }
    const outcome = await deps.admin.perform<{ state: HostnameClaimState; step: BinderStep }>(
      platformActor('hostname-binder', claim.tenant),
      hostnameBindAction,
      {
        tenant: claim.tenant,
        id: claim.id,
        result,
        reason: `Binder ${result.step}: ${result.ok ? 'ok' : 'failed'}`,
      },
    );
    if (!outcome.ok) return problem(c, 409, 'Conflict', outcome.errors);
    return c.json(outcome.value);
  });
};
