import { randomUUID } from 'node:crypto';
import type { Principal } from '@genai/contracts';
import { boundService, type KeyPolicy, type LegacyKeyScope } from '@genai/identity';
import type { Context } from 'hono';
import { enterTenant } from './access.js';
import type { AdminHandler, AdminOutcome } from './admin.js';
import { changeReasonOf, isReasonLongEnough, minimumReasonLength } from './http.js';
import { t } from './i18n/index.js';
import { carriesAltinnActions, type Right, rights, rightsOf } from './rights.js';
import type { PlatformModuleFactory } from './platform-modules.js';
import type { KeyPolicyStore, TenantApiKeys, TenantKeyPolicy } from './routes/portal-routes.js';

export const keyPolicySaveAction = 'platform.keypolicy.save';
export const keyPolicyDeleteAction = 'platform.keypolicy.delete';
export const keyPolicyAttachAction = 'platform.keypolicy.attach';

const grantPattern = /^[A-Za-z0-9*][A-Za-z0-9._:/*-]{0,199}$/;
const configKeyPattern = /^(platform|runtime|dataset):[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const maxEntries = 200;
const maxNameLength = 100;

export interface KeyPoliciesDeps {
  policies: KeyPolicyStore;
  keys: TenantApiKeys;
}

type Field = 'name' | 'scopes' | 'datasets' | 'agents' | 'modes' | 'allowedConfigKeys';

const list = (value: unknown, pattern: RegExp): string[] | undefined => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxEntries) return undefined;
  if (!value.every((v) => typeof v === 'string' && pattern.test(v))) return undefined;
  return [...new Set(value as string[])];
};

const readPolicy = (
  input: Record<string, unknown>,
): { ok: true; value: Omit<TenantKeyPolicy, 'id' | 'createdAt'> } | { ok: false; field: Field } => {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > maxNameLength) return { ok: false, field: 'name' };
  const chosenScopes = list(input.scopes, /^(query|ingest|admin)$/);
  if (!chosenScopes) return { ok: false, field: 'scopes' };
  const datasets = list(input.datasets, grantPattern);
  if (!datasets) return { ok: false, field: 'datasets' };
  const agents = list(input.agents, grantPattern);
  if (!agents) return { ok: false, field: 'agents' };
  const modes = list(input.modes, grantPattern);
  if (!modes) return { ok: false, field: 'modes' };
  const allowedConfigKeys = list(input.allowedConfigKeys, configKeyPattern);
  if (!allowedConfigKeys) return { ok: false, field: 'allowedConfigKeys' };
  return {
    ok: true,
    value: {
      name,
      scopes: chosenScopes as LegacyKeyScope[],
      datasets,
      agents,
      skillGraphs: modes,
      allowedConfigKeys,
    },
  };
};

const fieldProblem = (field: Field) => {
  if (field === 'name') return t('problems.keyPolicyName', { max: maxNameLength });
  if (field === 'scopes') return t('problems.keyPolicyScopes');
  if (field === 'allowedConfigKeys') return t('problems.keyPolicyConfigKeys');
  return t('problems.keyPolicyList');
};

export const policyView = (policy: TenantKeyPolicy, keyIds: string[]) => ({
  id: policy.id,
  name: policy.name,
  scopes: policy.scopes ?? [],
  datasets: policy.datasets ?? [],
  agents: policy.agents ?? [],
  modes: policy.skillGraphs ?? [],
  allowedConfigKeys: policy.allowedConfigKeys ?? [],
  keyIds,
  createdAt: policy.createdAt,
});

const grantsOf = (policy: KeyPolicy) => ({
  scopes: policy.scopes ?? [],
  datasets: policy.datasets ?? [],
  agents: policy.agents ?? [],
  modes: policy.skillGraphs ?? [],
  allowedConfigKeys: policy.allowedConfigKeys ?? [],
});

const failed = (target: string, path: string, message: string): AdminOutcome => ({
  ok: false,
  errors: [{ path, message }],
  target,
});

const tenantOnly = (principal: Principal, tenant: string) =>
  principal.kind !== 'operator' && !principal.actor && principal.tenant === tenant;

const impliedRights = (scopes: readonly string[]): readonly Right[] =>
  scopes.includes('admin') ? rights : scopes.includes('ingest') ? ['manage-datasets'] : [];

const rightBeyondHolder = (principal: Principal, tenant: string, scopes: readonly string[]) => {
  if (!carriesAltinnActions(principal)) return undefined;
  const held = rightsOf(principal, tenant);
  return impliedRights(scopes).find((r) => !held.has(r));
};

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409,
  title: string,
  errors: { path: string; message: string }[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

export const createKeyPoliciesModule =
  (input: KeyPoliciesDeps): PlatformModuleFactory =>
  () => {
    const { policies, keys } = input;
    const inUse = async (tenant: string, id: string) =>
      (await keys.list(tenant)).filter((k) => k.policy?.id === id);
    const idsOf = async (tenant: string, id: string) => (await inUse(tenant, id)).map((k) => k.id);

    const handlers: Record<string, AdminHandler> = {
      [keyPolicySaveAction]: async (data, principal) => {
        const tenant = data.tenant;
        const id = typeof data.id === 'string' && data.id ? data.id : randomUUID();
        const target = `api-key-policy:${tenant}/${id}`;
        if (!tenantOnly(principal, tenant))
          return failed(target, 'principal', t('problems.keyPolicyOnlyTenant'));
        const read = readPolicy(data);
        if (!read.ok) return failed(target, read.field, fieldProblem(read.field));
        const beyond = rightBeyondHolder(principal, tenant, read.value.scopes ?? []);
        if (beyond)
          return failed(
            target,
            'principal',
            t('problems.keyPolicyBeyondRights', { right: beyond }),
          );
        const before = (await policies.listPolicies(tenant)).find((p) => p.id === id);
        if (data.create === true && before)
          return { ...failed(target, 'id', t('problems.keyPolicyExists')), conflict: true };
        if (data.create !== true && !before)
          return failed(target, 'id', t('problems.keyPolicyNoSuch'));
        const policy: TenantKeyPolicy = {
          ...read.value,
          id,
          createdAt: before?.createdAt ?? new Date(String(data.at)).toISOString(),
        };
        if (!(await policies.savePolicy(tenant, policy)))
          return failed(target, 'id', t('problems.keyPolicyNoSuch'));
        return {
          ok: true,
          value: policyView(policy, await idsOf(tenant, id)),
          target,
          audit: {
            ...(before ? { before: { name: before.name, ...grantsOf(before) } } : {}),
            after: { name: policy.name, ...grantsOf(policy) },
          },
        };
      },
      [keyPolicyDeleteAction]: async (data, principal) => {
        const tenant = data.tenant;
        const id = String(data.id ?? '');
        const target = `api-key-policy:${tenant}/${id}`;
        if (!tenantOnly(principal, tenant))
          return failed(target, 'principal', t('problems.keyPolicyOnlyTenant'));
        const before = (await policies.listPolicies(tenant)).find((p) => p.id === id);
        if (!before) return failed(target, 'id', t('problems.keyPolicyNoSuch'));
        const using = await inUse(tenant, id);
        if (using.length > 0)
          return {
            ...failed(target, 'id', t('problems.keyPolicyInUse', { count: using.length })),
            conflict: true,
          };
        await policies.deletePolicy(tenant, id);
        return {
          ok: true,
          value: { id },
          target,
          audit: { before: { name: before.name, ...grantsOf(before) } },
        };
      },
      [keyPolicyAttachAction]: async (data, principal) => {
        const tenant = data.tenant;
        const keyId = String(data.keyId ?? '');
        const policyId = typeof data.policyId === 'string' ? data.policyId : undefined;
        const target = `api-key:${tenant}/${keyId}`;
        if (!tenantOnly(principal, tenant))
          return failed(target, 'principal', t('problems.keyPolicyOnlyTenant'));
        const key = (await keys.list(tenant)).find((k) => k.id === keyId);
        if (!key) return failed(target, 'keyId', t('problems.keyPolicyNoKey'));
        if (boundService(key)) return failed(target, 'key', t('problems.keyPolicyBoundKey'));
        const chosen =
          policyId === undefined
            ? undefined
            : (await policies.listPolicies(tenant)).find((p) => p.id === policyId);
        if (policyId !== undefined && !chosen)
          return failed(target, 'policyId', t('problems.keyPolicyNoSuch'));
        const beyond = chosen && rightBeyondHolder(principal, tenant, chosen.scopes ?? []);
        if (beyond)
          return failed(
            target,
            'principal',
            t('problems.keyPolicyBeyondRights', { right: beyond }),
          );
        await policies.setKeyPolicy(tenant, keyId, policyId);
        return {
          ok: true,
          value: { keyId, policy: policyId ?? null },
          target,
          audit: {
            before: { policy: key.policy?.id ?? null },
            after: { policy: policyId ?? null },
          },
        };
      },
    };

    return {
      id: 'key-policies',
      handlers,
      mount: (app, mounted) => {
        const base = '/tenants/:tenant/api-key-policies';
        const entered = async (c: Context) => {
          const principal = await mounted.authenticate(c.req.raw);
          if (!principal) return { response: problem(c, 401, t('problems.unauthorized')) };
          const tenant = c.req.param('tenant') ?? '';
          const result = enterTenant(c, mounted.access, principal, tenant, 'manage-services');
          return 'response' in result ? result : { principal: result.principal, tenant };
        };
        const perform = async (
          c: Context,
          principal: Principal,
          action: string,
          data: Record<string, unknown> & { tenant: string },
        ): Promise<
          { response: Response; value?: undefined } | { value: unknown; response?: undefined }
        > => {
          const reason = changeReasonOf(c)?.trim() ?? '';
          if (!isReasonLongEnough(reason))
            return {
              response: problem(c, 400, t('problems.invalidRequest'), [
                {
                  path: 'change-reason',
                  message: t('problems.reasonTooShort', { count: minimumReasonLength }),
                },
              ]),
            };
          const result = await mounted.admin.perform(principal, action, { ...data, reason });
          c.header('genai-task', result.task);
          if (result.ok) return { value: result.value };
          if (result.problem) return { response: problem(c, 403, t('problems.forbiddenEn')) };
          const paths = new Set(result.errors.map((e) => e.path));
          const status = paths.has('principal')
            ? 403
            : result.conflict
              ? 409
              : paths.has('id') || paths.has('keyId')
                ? 404
                : 400;
          const title =
            status === 403
              ? t('problems.forbiddenEn')
              : status === 409
                ? t('problems.conflict')
                : status === 404
                  ? t('problems.notFound')
                  : t('problems.invalidRequest');
          return { response: problem(c, status, title, result.errors) };
        };
        const body = async (c: Context) => {
          const parsed = (await c.req.json().catch(() => ({}))) as unknown;
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
        };
        const viewOf = async (tenant: string, id: string) => {
          const found = (await policies.listPolicies(tenant)).find((p) => p.id === id);
          return found && policyView(found, await idsOf(tenant, id));
        };

        app.get(base, async (c) => {
          const guard = await entered(c);
          if ('response' in guard) return guard.response;
          const all = await keys.list(guard.tenant);
          const found = await policies.listPolicies(guard.tenant);
          return c.json({
            data: found.map((p) =>
              policyView(
                p,
                all.filter((k) => k.policy?.id === p.id).map((k) => k.id),
              ),
            ),
          });
        });

        app.post(base, async (c) => {
          const guard = await entered(c);
          if ('response' in guard) return guard.response;
          const done = await perform(c, guard.principal, keyPolicySaveAction, {
            ...(await body(c)),
            tenant: guard.tenant,
            id: randomUUID(),
            create: true,
            at: new Date().toISOString(),
          });
          if (done.response) return done.response;
          return c.json(done.value, 201);
        });

        app.put(`${base}/:id`, async (c) => {
          const guard = await entered(c);
          if ('response' in guard) return guard.response;
          const done = await perform(c, guard.principal, keyPolicySaveAction, {
            ...(await body(c)),
            tenant: guard.tenant,
            id: c.req.param('id') ?? '',
            at: new Date().toISOString(),
          });
          if (done.response) return done.response;
          return c.json(await viewOf(guard.tenant, c.req.param('id') ?? ''));
        });

        app.delete(`${base}/:id`, async (c) => {
          const guard = await entered(c);
          if ('response' in guard) return guard.response;
          const done = await perform(c, guard.principal, keyPolicyDeleteAction, {
            tenant: guard.tenant,
            id: c.req.param('id') ?? '',
          });
          return done.response ?? c.body(null, 204);
        });

        app.put('/tenants/:tenant/api-keys/:id/policy', async (c) => {
          const guard = await entered(c);
          if ('response' in guard) return guard.response;
          const chosen = (await body(c)).policyId;
          const done = await perform(c, guard.principal, keyPolicyAttachAction, {
            tenant: guard.tenant,
            keyId: c.req.param('id') ?? '',
            ...(typeof chosen === 'string' ? { policyId: chosen } : {}),
          });
          return done.response ?? c.json(done.value);
        });

        app.delete('/tenants/:tenant/api-keys/:id/policy', async (c) => {
          const guard = await entered(c);
          if ('response' in guard) return guard.response;
          const done = await perform(c, guard.principal, keyPolicyAttachAction, {
            tenant: guard.tenant,
            keyId: c.req.param('id') ?? '',
          });
          return done.response ?? c.json(done.value);
        });
      },
    };
  };
