import type { Principal } from '@genai/contracts';
import {
  builtinHooks,
  checkBuiltinConfig,
  hookPoints,
  hookSpec,
  parseHookId,
  refusalText,
  runHooks,
  type HookCall,
  type HookSpec,
} from '@genai/hooks';
import type { Context } from 'hono';
import { z } from 'zod';
import { enterTenant } from './access.js';
import { actorOf, type AdminHandler, type AdminOutcome } from './admin.js';
import { appendVersion, platformScope, serialized } from './config-store.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { documentHookRoutes } from './hooks-openapi.js';
import type { FeedbackGiven, MountDeps, PlatformModuleFactory } from './platform-modules.js';
import { entryId, hookDirectory, hookKind } from '@genai/composition';

export {
  createHookRuntime,
  egressHookSender,
  hookDirectory,
  hookKind,
  webhookHookSender,
  type HookDirectory,
  type HookRuntime,
  type HookSender,
  type HookView,
} from '@genai/composition';

const outcomeLabels: Record<string, string> = {
  allowed: 'slapp gjennom',
  annotated: 'merket',
  refused: 'stoppet',
  ignored: 'ville stoppe, men følger bare med',
  failed: 'svarte ikke',
};

const failed = (target: string, path: string, message: string): AdminOutcome => ({
  ok: false,
  errors: [{ path, message }],
  target,
});

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409,
  title: string,
  errors: { path: string; message: string }[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const isOperator = (principal: Principal) =>
  principal.kind === 'operator' || principal.actor?.kind === 'operator';

const sample: Record<(typeof hookPoints)[number], Record<string, unknown>> = {
  before_model: {
    model: 'eksempel/modell',
    messages: [{ role: 'user', content: 'Hei' }],
    tools: [],
  },
  after_model: { model: 'eksempel/modell', content: 'Hei!', toolCalls: [], finishReason: 'stop' },
  before_tool: { tool: 'eksempel.verktoy', input: { q: 'Hei' } },
  after_tool: { tool: 'eksempel.verktoy', isError: false, text: 'Fant 1 treff.' },
  task_completed: { task: 'eksempel', status: 'completed' },
  on_publish: { kind: 'Service', id: 'eksempel', definition: {} },
  before_search: { dataset: 'eksempel', query: 'Hei', limit: 5 },
  after_search: {
    dataset: 'eksempel',
    query: 'Hei',
    hits: [{ id: 'eksempel-1', score: 0.9, title: 'Eksempel', text: 'Hei fra kilden.' }],
  },
  on_feedback: { task: 'eksempel', rating: 'down', reasons: ['Feil svar'] },
};

const builtinCatalog = builtinHooks.map((h) => ({
  id: h.id,
  title: h.title,
  description: h.description,
  configSchema: z.toJSONSchema(h.config, { unrepresentable: 'any' }),
}));

export const hooksModule: PlatformModuleFactory = (deps) => {
  const runtime = deps.hookRuntime;
  const directory = runtime?.directory ?? hookDirectory(deps.configEntries);
  const writes = serialized();

  const handlers: Record<string, AdminHandler> = {
    'platform.hook.save': (input, principal) =>
      writes(async () => {
        const scope = String(input.scope ?? '');
        const id = String(input.id ?? '');
        const target = `hook:${scope}/${id}`;
        if (scope === platformScope && !isOperator(principal))
          return failed(target, 'principal', 'only operators manage platform hooks');
        if (scope !== platformScope && principal.tenant !== scope)
          return failed(target, 'principal', 'hooks belong to the tenant');
        if (!parseHookId(id).success)
          return failed(target, 'id', 'lowercase letters, digits and -, at most 63 characters');
        const parsed = hookSpec.safeParse(input.spec);
        if (!parsed.success)
          return {
            ok: false,
            errors: parsed.error.issues.map((i) => ({
              path: ['spec', ...i.path.map(String)].join('.'),
              message: i.message,
            })),
            target,
          };
        const spec = parsed.data;
        if (spec.handler.kind === 'builtin') {
          const checked = checkBuiltinConfig(spec.handler.id, spec.handler.config);
          if (!checked.ok) return failed(target, 'spec.handler', checked.message);
        }
        const before = await directory.find(scope, id);
        const ifVersion = typeof input.ifVersion === 'number' ? input.ifVersion : undefined;
        if (ifVersion !== undefined && (before?.version ?? 0) !== ifVersion)
          return { ...failed(target, 'if-match', 'the hook changed; reload'), conflict: true };
        const saved = await appendVersion(deps.configEntries, {
          kind: hookKind,
          scope,
          id: entryId(scope, id),
          spec,
          deleted: false,
          by: actorOf(principal.actor ?? principal),
          reason: String(input.reason ?? ''),
        });
        return {
          ok: true,
          value: { ...spec, id, scope, version: saved.version },
          target,
          audit: { before: before ?? null, after: spec },
        };
      }),
    'platform.hook.delete': (input, principal) =>
      writes(async () => {
        const scope = String(input.scope ?? '');
        const id = String(input.id ?? '');
        const target = `hook:${scope}/${id}`;
        if (scope === platformScope && !isOperator(principal))
          return failed(target, 'principal', 'only operators manage platform hooks');
        if (scope !== platformScope && principal.tenant !== scope)
          return failed(target, 'principal', 'hooks belong to the tenant');
        const before = await directory.find(scope, id);
        if (!before) return failed(target, 'hook', `no hook ${id}`);
        const spec = (await deps.configEntries.history(hookKind, scope, entryId(scope, id))).at(-1)
          ?.spec as HookSpec;
        await appendVersion(deps.configEntries, {
          kind: hookKind,
          scope,
          id: entryId(scope, id),
          spec,
          deleted: true,
          by: actorOf(principal.actor ?? principal),
          reason: String(input.reason ?? ''),
        });
        return { ok: true, value: { removed: id }, target, audit: { before } };
      }),
  };

  let audit: Pick<MountDeps['admin'], 'perform'> | undefined;
  handlers['platform.hook.publish-check'] = async (input) => {
    const target = String(input.target ?? 'hooks');
    return input.refused === true
      ? { ok: false, errors: [{ path: 'hooks', message: String(input.reason ?? '') }], target }
      : { ok: true, value: { records: input.records }, target };
  };

  const checkPublish = async (definition: unknown) => {
    if (!runtime) return [];
    const d = definition as {
      kind?: string;
      metadata?: { tenant?: string; id?: string; name?: string };
    };
    const tenant = d.metadata?.tenant;
    if (!tenant) return [];
    const hooks = await directory.forTenant(tenant);
    if (!hooks.some((h) => h.point === 'on_publish' && h.enabled)) return [];
    const call: HookCall = {
      point: 'on_publish',
      tenant,
      ...(d.metadata?.id ? { service: `${tenant}/${d.metadata.id}` } : {}),
      payload: { kind: d.kind, id: d.metadata?.id, name: d.metadata?.name, definition },
    };
    const outcome = await runHooks(hooks, call, runtime.invoke);
    if (outcome.records.length > 0)
      await audit?.perform(
        { kind: 'agency-system', issuer: 'platform', subject: 'hooks', tenant },
        'platform.hook.publish-check',
        {
          tenant,
          target: `${d.kind ?? 'Service'}:${d.metadata?.id ?? ''}`,
          records: outcome.records,
          refused: Boolean(outcome.refused),
          reason: `${d.kind ?? 'Service'} ${d.metadata?.id ?? ''}: ${outcome.records
            .map((r) => `${r.name} ${outcomeLabels[r.outcome]}${r.reason ? ` (${r.reason})` : ''}`)
            .join('; ')}`,
        },
      );
    return outcome.refused ? [{ path: 'hooks', message: refusalText(outcome.refused) }] : [];
  };

  handlers['platform.hook.feedback'] = async (input) => ({
    ok: true,
    value: { records: input.records },
    target: String(input.target ?? 'hooks'),
  });

  const onFeedback = async (feedback: FeedbackGiven) => {
    if (!runtime) return;
    const hooks = await directory.forTenant(feedback.tenant);
    if (!hooks.some((h) => h.point === 'on_feedback' && h.enabled)) return;
    const outcome = await runHooks(
      hooks,
      {
        point: 'on_feedback',
        tenant: feedback.tenant,
        task: feedback.task,
        service: feedback.service,
        payload: {
          task: feedback.task,
          rating: feedback.rating,
          ...(feedback.reasons ? { reasons: feedback.reasons } : {}),
          ...(feedback.comment ? { comment: feedback.comment } : {}),
        },
      },
      runtime.invoke,
    );
    if (outcome.records.length > 0)
      await audit?.perform(
        {
          kind: 'agency-system',
          issuer: 'platform',
          subject: 'hooks',
          tenant: feedback.tenant,
        },
        'platform.hook.feedback',
        {
          tenant: feedback.tenant,
          target: `task:${feedback.task}`,
          records: outcome.records,
          reason: `Tilbakemelding på ${feedback.task}: ${outcome.records
            .map((r) => `${r.name} ${outcomeLabels[r.outcome]}${r.reason ? ` (${r.reason})` : ''}`)
            .join('; ')}`,
        },
      );
  };

  return {
    id: 'hooks',
    handlers,
    checkPublish,
    onFeedback,
    mount: (app, mounted) => {
      audit = mounted.admin;
      documentHookRoutes(app);
      const operator = async (c: Context) => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal) return { response: problem(c, 401, 'Unauthorized') };
        if (principal.kind !== 'operator') return { response: problem(c, 403, 'Forbidden') };
        return { principal: { ...principal, tenant: deps.platformTenant } };
      };
      const tenantOf = async (c: Context, right: 'manage-services' | 'use-services') => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal) return { response: problem(c, 401, 'Unauthorized') };
        const tenant = c.req.param('tenant') ?? '';
        const result = enterTenant(c, mounted.access, principal, tenant, right);
        return 'response' in result ? result : { principal: result.principal, tenant };
      };
      const perform = async (
        c: Context,
        principal: Principal,
        action: 'platform.hook.save' | 'platform.hook.delete',
        data: Record<string, unknown> & { scope: string },
      ) => {
        const reason = changeReasonOf(c)?.trim() ?? '';
        if (!isReasonLongEnough(reason))
          return problem(c, 400, 'Invalid request', [
            { path: 'change-reason', message: reasonTooShort },
          ]);
        const tenant = data.scope === platformScope ? deps.platformTenant : data.scope;
        const result = await mounted.admin.perform(principal, action, { ...data, tenant, reason });
        c.header('genai-task', result.task);
        if (result.ok) return c.json(result.value as object, 200);
        const paths = new Set(result.errors.map((e) => e.path));
        if (paths.has('principal')) return problem(c, 403, 'Forbidden', result.errors);
        if (paths.has('hook')) return problem(c, 404, 'Not found', result.errors);
        if (paths.has('if-match')) return problem(c, 409, 'Conflict', result.errors);
        return problem(c, 400, 'Invalid request', result.errors);
      };
      const ifMatch = (c: Context) => {
        const raw = c.req.header('if-match');
        return raw && /^"?\d+"?$/.test(raw) ? Number(raw.replace(/"/g, '')) : undefined;
      };
      const describe = { points: hookPoints, builtins: builtinCatalog };

      const tryHook = async (c: Context, scope: string) => {
        const found = await directory.find(scope, c.req.param('id') ?? '');
        if (!found) return problem(c, 404, 'Not found');
        if (!runtime)
          return problem(c, 409, 'Conflict', [{ path: 'hook', message: 'hooks are off' }]);
        const tenant = scope === platformScope ? deps.platformTenant : scope;
        const outcome = await runHooks(
          [{ ...found, enabled: true, services: undefined }],
          {
            point: found.point,
            tenant,
            service: `${tenant}/eksempel`,
            payload: sample[found.point],
          },
          runtime.invoke,
        );
        return c.json({ ...outcome, payload: sample[found.point] });
      };

      app.get('/tenants/:tenant/hooks', async (c) => {
        const guard = await tenantOf(c, 'use-services');
        if ('response' in guard) return guard.response;
        return c.json({
          data: await directory.list(guard.tenant),
          platform: (await directory.list(platformScope)).filter((h) => h.enabled),
          ...describe,
        });
      });

      app.put('/tenants/:tenant/hooks/:id', async (c) => {
        const guard = await tenantOf(c, 'manage-services');
        if ('response' in guard) return guard.response;
        const ifVersion = ifMatch(c);
        return perform(c, guard.principal, 'platform.hook.save', {
          scope: guard.tenant,
          id: c.req.param('id'),
          spec: await c.req.json().catch(() => undefined),
          ...(ifVersion === undefined ? {} : { ifVersion }),
        });
      });

      app.delete('/tenants/:tenant/hooks/:id', async (c) => {
        const guard = await tenantOf(c, 'manage-services');
        if ('response' in guard) return guard.response;
        return perform(c, guard.principal, 'platform.hook.delete', {
          scope: guard.tenant,
          id: c.req.param('id'),
        });
      });

      app.post('/tenants/:tenant/hooks/:id/test', async (c) => {
        const guard = await tenantOf(c, 'manage-services');
        if ('response' in guard) return guard.response;
        return tryHook(c, guard.tenant);
      });

      app.get('/operator/hooks', async (c) => {
        const who = await operator(c);
        if (who.response) return who.response;
        return c.json({ data: await directory.list(platformScope), ...describe });
      });

      app.put('/operator/hooks/:id', async (c) => {
        const who = await operator(c);
        if (who.response) return who.response;
        const ifVersion = ifMatch(c);
        return perform(c, who.principal, 'platform.hook.save', {
          scope: platformScope,
          id: c.req.param('id'),
          spec: await c.req.json().catch(() => undefined),
          ...(ifVersion === undefined ? {} : { ifVersion }),
        });
      });

      app.delete('/operator/hooks/:id', async (c) => {
        const who = await operator(c);
        if (who.response) return who.response;
        return perform(c, who.principal, 'platform.hook.delete', {
          scope: platformScope,
          id: c.req.param('id'),
        });
      });

      app.post('/operator/hooks/:id/test', async (c) => {
        const who = await operator(c);
        if (who.response) return who.response;
        return tryHook(c, platformScope);
      });
    },
  };
};
