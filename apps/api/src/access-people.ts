import { randomBytes } from 'node:crypto';
import type { Principal } from '@genai/contracts';
import {
  altinnDirectory,
  altinnTokens,
  httpAltinnPeople,
  maskinportenTokens,
  peopleFromTestData,
  personKeys,
  type AltinnDirectory,
  type IdentityTestDataInput,
  type OrgPerson,
  withoutTrailingSlashes,
  type PersonKey,
} from '@genai/identity';
import type { Context } from 'hono';
import type { JWK } from 'jose';
import { enterTenant } from './access.js';
import { actorOf, type AdminHandler, type AdminOutcome } from './admin.js';
import { isDevMode } from './boot-guard.js';
import { appendVersion, serialized, type ConfigEntryStore } from './config-store.js';
import { changeReasonOf } from './http.js';
import type { PlatformModuleFactory } from './platform-modules.js';
import { rightRefused, type Right } from './rights.js';

export const serviceAccessKind = 'service-access';
export const serviceAccessAction = 'platform.service.access';

export interface Member {
  id: string;
  name: string;
}

export interface ServiceAccess {
  id: string;
  mode: 'all' | 'selected';
  members: Member[];
  by?: string;
  byName?: string;
  at?: string;
  reason?: string;
}

interface Spec {
  members: Member[];
  byName?: string;
}

export const serviceAccessOf = async (
  store: ConfigEntryStore,
  tenant: string,
  service: string,
): Promise<ServiceAccess> => {
  const latest = (await store.history(serviceAccessKind, tenant, service)).at(-1);
  if (!latest || latest.deleted) return { id: service, mode: 'all', members: [] };
  const spec = latest.spec as Spec;
  return {
    id: service,
    mode: 'selected',
    members: spec.members,
    by: latest.by,
    ...(spec.byName ? { byName: spec.byName } : {}),
    at: latest.at,
    ...(latest.reason ? { reason: latest.reason } : {}),
  };
};

/** The person ids a service is limited to, or undefined when everyone with use-services may call it. */
export const selectedPeople =
  (store: ConfigEntryStore) =>
  async (tenant: string, service: string): Promise<readonly string[] | undefined> => {
    const access = await serviceAccessOf(store, tenant, service);
    return access.mode === 'selected' ? access.members.map((m) => m.id) : undefined;
  };

export type PeopleSource =
  | { kind: 'test-data' | 'altinn'; directory: AltinnDirectory; key: PersonKey }
  | { kind: 'not-configured'; key: PersonKey };

const privateKeyOf = (raw: string): JWK => {
  const key = JSON.parse(raw) as JWK;
  if (!key.kty || !key.d) throw new Error('the Maskinporten key must be a private JWK in JSON');
  return key;
};

export const minKeySecretLength = 32;

export const altinnPeopleSettings = [
  'ALTINN_PEOPLE_URL',
  'ACCESS_PERSON_KEY_SECRET',
  'ALTINN_SUBSCRIPTION_KEY',
  'MASKINPORTEN_ISSUER',
] as const;

const systemUserDetails = (org: string) => [
  {
    type: 'urn:altinn:systemuser',
    systemuser_org: { authority: 'iso6523-actorid-upis', ID: `0192:${org}` },
  },
];

export const peopleSourceFrom = (
  env: Record<string, string | undefined>,
  testData: IdentityTestDataInput,
  resource: string,
  fetchFn: typeof fetch = fetch,
): PeopleSource => {
  const secret = env.ACCESS_PERSON_KEY_SECRET;
  if (!env.ALTINN_PEOPLE_URL) {
    if (!isDevMode(env))
      return { kind: 'not-configured', key: personKeys(secret ?? randomBytes(32).toString('hex')) };
    const key = personKeys(secret ?? 'local-dev-person-key');
    return {
      kind: 'test-data',
      key,
      directory: altinnDirectory(peopleFromTestData(testData, { resource, key })),
    };
  }
  const clientId =
    env.ALTINN_PEOPLE_MASKINPORTEN_CLIENT_ID ?? env.ALTINN_PDP_MASKINPORTEN_CLIENT_ID;
  const rawKey = env.ALTINN_PEOPLE_MASKINPORTEN_KEY ?? env.ALTINN_PDP_MASKINPORTEN_KEY;
  const missing = [
    ...altinnPeopleSettings.filter((name) => !env[name]),
    ...(clientId ? [] : ['ALTINN_PEOPLE_MASKINPORTEN_CLIENT_ID']),
    ...(rawKey ? [] : ['ALTINN_PEOPLE_MASKINPORTEN_KEY']),
  ];
  if (missing.length > 0)
    throw new Error(`ALTINN_PEOPLE_URL is set, but these are missing: ${missing.join(', ')}`);
  const baseURL = withoutTrailingSlashes(env.ALTINN_PEOPLE_URL as string);
  if (!baseURL.startsWith('https://')) throw new Error('ALTINN_PEOPLE_URL must use HTTPS');
  if ((env.ACCESS_PERSON_KEY_SECRET as string).length < minKeySecretLength)
    throw new Error(`ACCESS_PERSON_KEY_SECRET must be at least ${minKeySecretLength} characters`);
  const privateKey = privateKeyOf(rawKey as string);
  const perOrg = new Map<string, { token(): Promise<string> }>();
  const tokenFor = (org: string) => {
    let tokens = perOrg.get(org);
    if (!tokens) {
      tokens = altinnTokens({
        baseURL,
        fetch: fetchFn,
        maskinporten: maskinportenTokens({
          issuer: env.MASKINPORTEN_ISSUER as string,
          ...(env.MASKINPORTEN_TOKEN_URL ? { tokenEndpoint: env.MASKINPORTEN_TOKEN_URL } : {}),
          clientId: clientId as string,
          scope:
            env.ALTINN_PEOPLE_MASKINPORTEN_SCOPE ??
            'altinn:accessmanagement/enduser:connections:toothers.read',
          privateKey,
          authorizationDetails: systemUserDetails(org),
          fetch: fetchFn,
        }),
      });
      perOrg.set(org, tokens);
    }
    return tokens.token();
  };
  const key = personKeys(env.ACCESS_PERSON_KEY_SECRET as string);
  return {
    kind: 'altinn',
    key,
    directory: altinnDirectory(
      httpAltinnPeople({
        baseURL,
        resource,
        key,
        fetch: fetchFn,
        headers: async (org) => ({
          authorization: `Bearer ${await tokenFor(org)}`,
          'ocp-apim-subscription-key': env.ALTINN_SUBSCRIPTION_KEY as string,
        }),
      }),
    ),
  };
};

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 503,
  title: string,
  errors: { path: string; message: string }[] = [],
  code?: string,
) =>
  c.json({ type: 'about:blank', title, status, errors, ...(code ? { code } : {}) }, status, {
    'content-type': 'application/problem+json',
  });

const failed = (target: string, path: string, message: string): AdminOutcome => ({
  ok: false,
  errors: [{ path, message }],
  target,
});

const forTenant = (principal: Principal, tenant: string) =>
  principal.tenant === tenant && (principal.kind !== 'operator' || principal.actor !== undefined);

export const staleListMaxHours = 24;

export const createAccessPeopleModule =
  (source: PeopleSource, now: () => number = Date.now): PlatformModuleFactory =>
  (deps) => {
    const entries = deps.configEntries;
    const writes = serialized();
    const directory = 'directory' in source ? source.directory : undefined;

    const peopleOf = async (tenant: string) => {
      if (!directory) return undefined;
      try {
        return await directory.read(tenant);
      } catch {
        return undefined;
      }
    };

    const handlers: Record<string, AdminHandler> = {
      [serviceAccessAction]: (input, principal) =>
        writes(async () => {
          const tenant = String(input.tenant ?? '');
          const id = String(input.id ?? '');
          const target = `service:${tenant}/${id}`;
          if (!forTenant(principal, tenant))
            return failed(target, 'principal', 'only the tenant limits who may use its services');
          if (!(await deps.definitions.get('Service', tenant, id)))
            return failed(target, 'id', `no service ${id}`);
          const mode = input.mode;
          if (mode !== 'all' && mode !== 'selected')
            return failed(target, 'mode', 'mode must be all or selected');
          const before = await serviceAccessOf(entries, tenant, id);
          const wanted = Array.isArray(input.members)
            ? [...new Set(input.members.filter((m): m is string => typeof m === 'string'))]
            : [];
          let members: Member[] = [];
          if (mode === 'selected') {
            if (wanted.length === 0) return failed(target, 'members', 'choose at least one person');
            const known = new Map<string, OrgPerson | Member>(before.members.map((m) => [m.id, m]));
            const view = await peopleOf(tenant);
            const usable =
              view && (!view.stale || now() - Date.parse(view.at) <= staleListMaxHours * 3_600_000);
            for (const person of usable ? view.people : []) known.set(person.id, person);
            const unknown = wanted.filter((m) => !known.has(m));
            if (unknown.length > 0)
              return failed(target, 'members', 'only people in the organisation can be chosen');
            members = wanted.map((m) => ({ id: m, name: (known.get(m) as Member).name }));
          }
          const actor = principal.actor ?? principal;
          await appendVersion<Spec>(entries, {
            kind: serviceAccessKind,
            scope: tenant,
            id,
            spec: { members, ...(actor.name ? { byName: actor.name } : {}) },
            deleted: mode === 'all',
            by: actorOf(actor),
            reason: String(input.reason ?? ''),
          });
          const ids = (list: Member[]) => list.map((m) => m.id);
          return {
            ok: true,
            value: { id, mode },
            target,
            audit: {
              before: { mode: before.mode, members: ids(before.members) },
              after: { mode, members: ids(members) },
            },
          } as AdminOutcome;
        }),
    };

    return {
      id: 'access-people',
      handlers,
      mount: (app, mounted) => {
        const entered = async (c: Context, right?: Right) => {
          const principal = await mounted.authenticate(c.req.raw);
          if (!principal) return { response: problem(c, 401, 'Unauthorized') };
          const tenant = c.req.param('tenant') ?? '';
          const result = enterTenant(c, mounted.access, principal, tenant, right);
          return 'response' in result ? result : { principal: result.principal, tenant };
        };

        app.get('/tenants/:tenant/access/people', async (c) => {
          const guard = await entered(c);
          if ('response' in guard) return guard.response;
          if (!directory)
            return problem(c, 503, 'Altinn is not connected', [], 'altinn_not_configured');
          const view = await peopleOf(guard.tenant);
          if (!view) return problem(c, 503, 'Altinn did not answer', [], 'altinn_unavailable');
          return c.json({ ...view, source: source.kind });
        });

        app.get('/tenants/:tenant/access/services', async (c) => {
          const guard = await entered(c);
          if ('response' in guard) return guard.response;
          const limited = (await entries.latest({ kind: serviceAccessKind, scope: guard.tenant }))
            .filter((e) => !e.deleted)
            .map((e) => e.id)
            .sort();
          return c.json({
            services: await Promise.all(
              limited.map((id) => serviceAccessOf(entries, guard.tenant, id)),
            ),
          });
        });

        app.put('/tenants/:tenant/access/services/:service', async (c) => {
          const guard = await entered(c, 'manage-services');
          if ('response' in guard) return guard.response;
          const body = (await c.req.json().catch(() => ({}))) as {
            mode?: unknown;
            members?: unknown;
          };
          const id = c.req.param('service') ?? '';
          const result = await mounted.admin.perform(guard.principal, serviceAccessAction, {
            tenant: guard.tenant,
            id,
            mode: body.mode,
            members: body.members,
            reason: changeReasonOf(c)?.trim() ?? '',
          });
          c.header('genai-task', result.task);
          if (!result.ok) {
            if (result.problem) return rightRefused(c, result.problem);
            const paths = new Set(result.errors.map((e) => e.path));
            if (paths.has('principal')) return problem(c, 403, 'Forbidden', result.errors);
            if (paths.has('id')) return problem(c, 404, 'Not found', result.errors);
            return problem(c, 400, 'Invalid request', result.errors);
          }
          return c.json(await serviceAccessOf(entries, guard.tenant, id));
        });
      },
    };
  };
