import type { Principal } from '@genai/contracts';
import { flags as registry, isFlagKey, type FlagKey } from '@genai/contracts/flags';
import { flagPersonOf, type FlagPerson } from '@genai/composition';
import type { Context, Env, Hono, MiddlewareHandler, Schema } from 'hono';
import { z } from 'zod';
import { enterTenant } from './access.js';
import { actorOf, AdminRefused, refusedBy, routeOnlyActions } from './admin.js';
import { actorNames } from './actor-names.js';
import { changeReasonOf, isReasonLongEnough, problem, reasonTooShort } from './http.js';
import { t } from './i18n/index.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';

export const flagActions = ['platform.flag.person', 'platform.flag.tenant'] as const;
type FlagAction = (typeof flagActions)[number];

export const flagOperatorOnlyType = 'urn:genai:problem:flag-operator-only';

export const requireFlag =
  (
    deps: Pick<MountDeps, 'flags' | 'authenticate' | 'access' | 'platformTenant'>,
    key: FlagKey,
  ): MiddlewareHandler =>
  async (c, next) => {
    const principal = await deps.authenticate(c.req.raw);
    const path = c.req.param('tenant');
    const tenant = path ?? principal?.tenant ?? deps.platformTenant;
    const acting = principal && (path ? deps.access(principal, tenant, c.req.raw) : principal);
    if (acting && (await deps.flags.on({ principal: acting, tenant }, key))) return next();
    return problem(c, 404, 'Not found');
  };

const Change = z.strictObject({ on: z.boolean().nullable() });
const OperatorChange = Change.extend({
  tenant: z.string().regex(/^\d{9}$/),
  person: z.strictObject({ issuer: z.string().min(1), subject: z.string().min(1) }).optional(),
});

const invalid = (c: Context, issues: z.ZodIssue[]) =>
  problem(c, 400, t('problems.invalidRequest'), {
    errors: issues.map((i) => ({
      path: i.path.join('.') || 'on',
      message: i.path[0] === 'on' ? t('problems.flagInvalidChange') : i.message,
    })),
  });

const targetOf = (key: FlagKey, person?: FlagPerson) =>
  person ? `flag:${key}:person:${person.issuer}:${person.subject}` : `flag:${key}`;

export const featureFlagsModule: PlatformModuleFactory = (deps) => ({
  id: 'feature-flags',
  handlers: routeOnlyActions(flagActions),
  mount: <E extends Env, S extends Schema, B extends string>(
    app: Hono<E, S, B>,
    mounted: MountDeps,
  ) => {
    const names = actorNames(deps.configEntries);

    const signedIn = async (c: Context) => {
      const principal = await mounted.authenticate(c.req.raw);
      return principal ? { principal } : { response: problem(c, 401, t('problems.notSignedIn')) };
    };

    const member = async (
      c: Context,
    ): Promise<{ response: Response } | { principal: Principal; tenant: string }> => {
      const found = await signedIn(c);
      if (!found.principal) return { response: found.response };
      const tenant = c.req.param('tenant') ?? '';
      const entered = enterTenant(c, mounted.access, found.principal, tenant);
      if ('response' in entered) return { response: entered.response };
      return { principal: entered.principal, tenant };
    };

    const knownKey = (c: Context) => {
      const key = c.req.param('key');
      return isFlagKey(key) ? key : undefined;
    };

    const change = async (
      c: Context,
      principal: Principal,
      action: FlagAction,
      input: { tenant: string; key: FlagKey; person?: FlagPerson; on: boolean | null },
      reason: string,
    ) => {
      try {
        const done = await mounted.admin.within(
          { ...principal, tenant: input.tenant },
          action,
          { tenant: input.tenant, reason, key: input.key, on: input.on },
          async () => {
            await deps.flags.set({ ...input, by: actorOf(principal.actor ?? principal), reason });
            return {
              value: null,
              target: targetOf(input.key, input.person),
              audit: { level: input.person ? 'person' : 'tenant', on: input.on },
            };
          },
        );
        c.header('genai-task', done.task);
        const states = await deps.flags.states(input.tenant, input.person);
        return c.json(states.find((s) => s.key === input.key));
      } catch (error) {
        if (error instanceof AdminRefused) return refusedBy(c, error);
        throw error;
      }
    };

    const operatorOnly = (c: Context) =>
      problem(c, 403, t('problems.flagOperatorOnly'), { type: flagOperatorOnlyType });

    app.get('/me/flags', async (c) => {
      const found = await signedIn(c);
      if ('response' in found) return found.response;
      const tenant = found.principal.tenant ?? deps.platformTenant;
      return c.json({
        data: await deps.flags.states(tenant, flagPersonOf(found.principal)),
      });
    });

    app.get('/tenants/:tenant/me/flags', async (c) => {
      const found = await member(c);
      if ('response' in found) return found.response;
      return c.json({
        data: await deps.flags.states(found.tenant, flagPersonOf(found.principal)),
      });
    });

    app.put('/tenants/:tenant/me/flags/:key', async (c) => {
      const found = await member(c);
      if ('response' in found) return found.response;
      const key = knownKey(c);
      if (!key) return problem(c, 404, t('problems.flagUnknown'));
      if (!registry[key].selfService) return operatorOnly(c);
      const parsed = Change.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) return invalid(c, parsed.error.issues);
      const reason = changeReasonOf(c)?.trim() || t('problems.flagPersonalReason');
      return change(
        c,
        found.principal,
        'platform.flag.person',
        {
          tenant: found.tenant,
          key,
          person: flagPersonOf(found.principal),
          on: parsed.data.on,
        },
        reason,
      );
    });

    app.put('/tenants/:tenant/flags/:key', async (c) => {
      const found = await member(c);
      if ('response' in found) return found.response;
      const key = knownKey(c);
      if (!key) return problem(c, 404, t('problems.flagUnknown'));
      if (!registry[key].selfService) return operatorOnly(c);
      const reason = changeReasonOf(c)?.trim() ?? '';
      if (!isReasonLongEnough(reason))
        return problem(c, 400, t('problems.invalidRequest'), {
          errors: [{ path: 'change-reason', message: reasonTooShort }],
        });
      const parsed = Change.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) return invalid(c, parsed.error.issues);
      return change(
        c,
        found.principal,
        'platform.flag.tenant',
        { tenant: found.tenant, key, on: parsed.data.on },
        reason,
      );
    });

    const operator = async (c: Context) => {
      const found = await signedIn(c);
      if ('response' in found) return found;
      if (found.principal.kind !== 'operator')
        return { response: problem(c, 403, t('problems.forbiddenEn')) };
      return found;
    };

    app.get('/operator/flags', async (c) => {
      const found = await operator(c);
      if ('response' in found) return found.response;
      const rows = await deps.flags.rows();
      const people = rows.flatMap((r) => (r.person ? [personActor(r.person)] : []));
      const known = await names.namesOf([...new Set([...rows.map((r) => r.by), ...people])]);
      const tenantNames = await mounted.admin.tenantNames();
      return c.json({
        data: Object.entries(registry).map(([key, spec]) => ({
          key,
          description: spec.description,
          owner: spec.owner,
          removeBy: spec.removeBy,
          selfService: spec.selfService,
          rows: rows
            .filter((r) => r.key === key)
            .sort((a, b) => b.at.localeCompare(a.at))
            .map((r) => {
              const personName = r.person && known.get(personActor(r.person));
              const tenantName = tenantNames.get(r.tenant);
              const byName = known.get(r.by);
              return {
                tenant: r.tenant,
                ...(tenantName ? { tenantName } : {}),
                ...(r.person ? { person: r.person } : {}),
                ...(personName ? { personName } : {}),
                on: r.on,
                by: r.by,
                ...(byName ? { byName } : {}),
                at: r.at,
                reason: r.reason,
              };
            }),
        })),
      });
    });

    app.put('/operator/flags/:key', async (c) => {
      const found = await operator(c);
      if ('response' in found) return found.response;
      const key = knownKey(c);
      if (!key) return problem(c, 404, t('problems.flagUnknown'));
      const reason = changeReasonOf(c)?.trim() ?? '';
      if (!isReasonLongEnough(reason))
        return problem(c, 400, t('problems.invalidRequest'), {
          errors: [{ path: 'change-reason', message: reasonTooShort }],
        });
      const parsed = OperatorChange.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) return invalid(c, parsed.error.issues);
      const { tenant, person, on } = parsed.data;
      return change(
        c,
        found.principal,
        person ? 'platform.flag.person' : 'platform.flag.tenant',
        { tenant, key, on, ...(person ? { person } : {}) },
        reason,
      );
    });
  },
});

const personActor = (person: FlagPerson) => `employee:${person.issuer}:${person.subject}`;
