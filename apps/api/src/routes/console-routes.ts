import type { Principal } from '@genai/contracts';
import { defaultPlatformTenant } from '@genai/composition';
import type { DefinitionStore, PluginSchemas, ValidationError } from '@genai/definitions';
import {
  judgeAgreement,
  runState,
  type EvalRunStore,
  type JudgeLabel,
  type LabelStore,
} from '@genai/eval';
import type { Residency } from '@genai/port-model';
import type { Context, Env, Hono, Schema } from 'hono';
import { z } from 'zod';
import type { ActorNames } from '../actor-names.js';
import { actorOf, type Admin, type AdminHandler, type SupportSession } from '../admin.js';
import { blockUsage } from '../block-usage.js';
import { orgNumberValid } from '../extensions.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from '../http.js';
import type { OperationsOverview } from '../operations.js';
import type { Organization } from '../organizations.js';

export const consoleActions = [
  'platform.service.share',
  'platform.judge.label',
  'platform.support.end',
  'platform.support.extend',
  'platform.task.cancel',
  'platform.audit.export',
] as const;

export interface TraceStatus {
  endpoint: string;
  content: boolean;
  residency?: Residency;
  sampleRate?: number;
  stats?: { exported: number; dropped: number; failed: number; sampledOut: number };
}

export interface SupportDirectory {
  list(): (SupportSession & { endedAt?: string })[];
  end(
    id: string,
    at: Date,
  ):
    | Promise<(SupportSession & { endedAt?: string }) | undefined>
    | (SupportSession & { endedAt?: string })
    | undefined;
  extend?(id: string, minutes: number, at: Date): Promise<SupportSession | undefined>;
}

export interface RunningTask {
  task: string;
  tenant: string;
  status: string;
  at: string;
}

export interface TaskDetails {
  service?: string;
  capability?: string;
}

export interface ConsoleDeps {
  store: DefinitionStore;
  lifecycle?(tenant: string, service: string): Promise<{ state: string }>;
  pluginUsage?(): Promise<Map<string, string[]>>;
  plugins: PluginSchemas;
  blocks?: { describe(): { ref: string; description?: string }[] };
  tenants(): Promise<string[]> | string[];
  runs: EvalRunStore;
  labels: LabelStore;
  traces(): TraceStatus | undefined;
  support: SupportDirectory;
  tasks(): RunningTask[] | Promise<RunningTask[]>;
  taskDetails(task: string): Promise<TaskDetails | undefined>;
  cancel(task: string): Promise<void>;
  quality?(): Promise<Record<string, unknown>>;
  operations?(): Promise<OperationsOverview>;
  organization?(orgNumber: string): Promise<Organization | undefined>;
  names?: Pick<ActorNames, 'namesOf'>;
  now?: () => Date;
}

export interface ConsoleRouteDeps extends ConsoleDeps {
  admin: Pick<Admin, 'perform'> & Partial<Pick<Admin, 'audit'>>;
  authenticate(request: Request): Promise<Principal | undefined>;
  platformTenant?: string;
}

const maxExtensionMinutes = 60;

const refused = (target: string, message: string) => ({
  ok: false as const,
  errors: [{ path: 'principal', message }],
  target,
  audit: { scope: 'platform' },
});

const invalid = (target: string, errors: ValidationError[]) => ({
  ok: false as const,
  errors,
  target,
});

const availableTo = z
  .union([z.literal('*'), z.array(z.string().regex(/^\d{9}$/)).min(1)])
  .nullable();
const humanLabel = z.strictObject({
  item: z.string().min(1),
  judge: z.string().min(1),
  judgeLabel: z.string().min(1),
  humanLabel: z.enum(['good', 'bad']),
});

export const consoleAdminExtensions = (deps: ConsoleDeps): Record<string, AdminHandler> => {
  const now = deps.now ?? (() => new Date());
  return {
    'platform.service.share': async (input, principal) => {
      const target = `service:${String(input.serviceTenant)}/${String(input.service)}`;
      if (principal.kind !== 'operator' && !principal.actor)
        return refused(target, 'only operators change what is shared');
      const parsed = availableTo.safeParse(input.availableTo);
      if (!parsed.success)
        return invalid(target, [
          { path: 'availableTo', message: 'must be "*", org numbers or null' },
        ]);
      const current = await deps.store.get(
        'Service',
        String(input.serviceTenant),
        String(input.service),
      );
      if (!current) return invalid(target, [{ path: 'service', message: 'no such service' }]);
      const definition = structuredClone(current.definition) as {
        metadata: Record<string, unknown>;
        spec: Record<string, unknown>;
      };
      const before = definition.spec.availableTo ?? null;
      if (parsed.data === null) delete definition.spec.availableTo;
      else definition.spec.availableTo = parsed.data;
      delete definition.metadata.version;
      const published = await deps.store.publish(
        definition,
        actorOf(principal),
        input.reason,
        current.files,
      );
      if (!published.ok) return invalid(target, published.errors);
      return {
        ok: true,
        value: { version: published.version.version, availableTo: parsed.data },
        target,
        audit: { scope: 'platform', before, after: parsed.data },
      };
    },
    'platform.judge.label': async (input, principal) => {
      const target = `judge:${String(input.judge)}`;
      if (principal.kind !== 'operator' && !principal.actor)
        return refused(target, 'only operators label judge results');
      const parsed = humanLabel.safeParse({
        item: input.item,
        judge: input.judge,
        judgeLabel: input.judgeLabel,
        humanLabel: input.humanLabel,
      });
      if (!parsed.success)
        return invalid(
          target,
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
      const label: JudgeLabel = { ...parsed.data, labeller: actorOf(principal) };
      await deps.labels.add([label]);
      return { ok: true, value: label, target, audit: { scope: 'platform' } };
    },
    'platform.support.end': async (input, principal) => {
      const target = `support:${String(input.session)}`;
      if (principal.kind !== 'operator' && !principal.actor)
        return refused(target, 'only operators end support sessions');
      const ended = await deps.support.end(String(input.session), now());
      if (!ended)
        return invalid(target, [{ path: 'session', message: 'no active session with that id' }]);
      return { ok: true, value: ended, target, audit: { scope: 'platform', tenant: ended.tenant } };
    },
    'platform.support.extend': async (input, principal) => {
      const target = `support:${String(input.session)}`;
      if (principal.kind !== 'operator' && !principal.actor)
        return refused(target, 'only operators extend support sessions');
      const own = deps.support
        .list()
        .find((s) => s.id === String(input.session) && s.operator === actorOf(principal));
      const minutes = Number(input.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > maxExtensionMinutes)
        return invalid(target, [
          { path: 'minutes', message: `must be 1 to ${maxExtensionMinutes} minutes` },
        ]);
      const extended = own ? await deps.support.extend?.(own.id, minutes, now()) : undefined;
      if (!extended)
        return invalid(target, [
          { path: 'session', message: 'no active session of yours with that id' },
        ]);
      return {
        ok: true,
        value: extended,
        target,
        audit: { scope: 'platform', tenant: extended.tenant },
      };
    },
    'platform.task.cancel': async (input, principal) => {
      const target = `task:${String(input.task)}`;
      if (principal.kind !== 'operator' && !principal.actor)
        return refused(target, 'only operators cancel tasks');
      const task = String(input.task);
      if (!(await deps.tasks()).some((t) => t.task === task))
        return invalid(target, [{ path: 'task', message: 'no running task with that id' }]);
      await deps.cancel(task);
      return { ok: true, value: { task, cancelled: true }, target, audit: { scope: 'platform' } };
    },
    'platform.audit.export': async (input, principal) => {
      const target = 'audit:export';
      if (principal.kind !== 'operator' && !principal.actor)
        return refused(target, 'only operators export the audit log');
      const count = Number(input.count);
      return {
        ok: true,
        value: { count: Number.isFinite(count) ? count : 0 },
        target,
        audit: { scope: 'platform' },
      };
    },
  };
};

const jsonSchemaOf = (schema: unknown) => {
  try {
    return z.toJSONSchema(schema as z.ZodType);
  } catch {
    return undefined;
  }
};

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404,
  title: string,
  errors: unknown[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const sessionStatus = (s: SupportSession & { endedAt?: string }, at: Date) =>
  s.endedAt ? 'ended' : new Date(s.expiresAt).getTime() > at.getTime() ? 'active' : 'expired';

const judgeVerdict = (value: number | null) =>
  value === null ? undefined : value >= 0.5 ? 'good' : 'bad';

export const registerConsoleRoutes = <E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  deps: ConsoleRouteDeps,
) => {
  const now = deps.now ?? (() => new Date());
  const platformTenant = deps.platformTenant ?? defaultPlatformTenant;

  const operatorOf = async (c: Context) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return { response: problem(c, 401, 'Unauthorized') };
    if (principal.kind !== 'operator') return { response: problem(c, 403, 'Forbidden') };
    return { principal };
  };

  const applied = async (
    c: Context,
    principal: Principal,
    action: (typeof consoleActions)[number],
    data: Record<string, unknown>,
  ) => {
    const reason = changeReasonOf(c)?.trim() ?? '';
    if (!isReasonLongEnough(reason))
      return problem(c, 400, 'Invalid request', [
        { path: 'change-reason', message: reasonTooShort },
      ]);
    const result = await deps.admin.perform({ ...principal, tenant: platformTenant }, action, {
      ...data,
      tenant: platformTenant,
      reason,
    });
    c.header('genai-task', result.task);
    if (result.ok) return c.json(result.value as object, 200);
    const forbidden = result.errors.some((e) => e.path === 'principal');
    const missing = result.errors.some((e) => /no (such|active|running)/.test(e.message));
    return problem(
      c,
      forbidden ? 403 : missing ? 404 : 400,
      forbidden ? 'Forbidden' : missing ? 'Not found' : 'Invalid request',
      result.errors,
    );
  };

  app.get('/operator/shared-services', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const latest = new Map<
      string,
      {
        tenant: string;
        id: string;
        name: string;
        version: number;
        availableTo: string[] | '*' | null;
        publicNames: string[];
      }
    >();
    const states = new Map<string, string>();
    for (const compiled of await deps.store.capabilities()) {
      const key = `${compiled.service.tenant}/${compiled.service.id}`;
      const known = latest.get(key);
      if (known && known.version > compiled.service.version) continue;
      if (!states.has(key))
        states.set(
          key,
          (await deps.lifecycle?.(compiled.service.tenant, compiled.service.id))?.state ?? 'active',
        );
      if (states.get(key) === 'archived') continue;
      const shared = compiled.capability.descriptor.availableTo;
      const entry =
        known && known.version === compiled.service.version
          ? known
          : {
              tenant: compiled.service.tenant,
              id: compiled.service.id,
              name: compiled.capability.descriptor.title,
              version: compiled.service.version,
              availableTo: (shared ?? null) as string[] | '*' | null,
              publicNames: [] as string[],
            };
      entry.publicNames.push(compiled.publicName);
      latest.set(key, entry);
    }
    return c.json({ data: [...latest.values()].sort((a, b) => a.name.localeCompare(b.name)) });
  });

  app.put('/operator/shared-services/:tenant/:id', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const body = (await c.req.json().catch(() => undefined)) as
      { availableTo?: unknown } | undefined;
    if (!body || !('availableTo' in body))
      return problem(c, 400, 'Invalid request', [{ path: 'availableTo', message: 'required' }]);
    return applied(c, who.principal, 'platform.service.share', {
      serviceTenant: c.req.param('tenant'),
      service: c.req.param('id'),
      availableTo: body.availableTo,
    });
  });

  app.get('/operator/building-blocks', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const usage = await blockUsage({ store: deps.store, tenants: deps.tenants });
    const usedBy = (ref: string) => [...(usage.get(ref) ?? [])].sort();
    const pluginUsers = (await deps.pluginUsage?.()) ?? new Map<string, string[]>();
    const listed = (deps.blocks?.describe() ?? [...deps.plugins.blocks].map((ref) => ({ ref })))
      .map((b) => ({ ...b, usedBy: usedBy(b.ref) }))
      .concat([...pluginUsers].map(([ref, users]) => ({ ref, usedBy: users })));
    return c.json({
      strategies: [...deps.plugins.strategies.entries()]
        .map(([ref, schema]) => ({ ref, configSchema: jsonSchemaOf(schema), usedBy: usedBy(ref) }))
        .sort((a, b) => a.ref.localeCompare(b.ref)),
      blocks: listed.sort((a, b) => a.ref.localeCompare(b.ref)),
      tools: [...deps.plugins.tools.entries()]
        .map(([ref, schema]) => ({ ref, configSchema: jsonSchemaOf(schema), usedBy: usedBy(ref) }))
        .sort((a, b) => a.ref.localeCompare(b.ref)),
    });
  });

  app.get('/operator/quality', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const rows = [];
    for (const tenant of await deps.tenants()) {
      const runs = await deps.runs.list({ tenant });
      const groups = new Map<string, typeof runs>();
      for (const stored of runs.filter((s) => runState(s.run) === 'completed')) {
        const key = `${stored.service ?? stored.run.capability}|${stored.run.testSet.id}`;
        groups.set(key, [...(groups.get(key) ?? []), stored]);
      }
      for (const group of groups.values()) {
        const [latest, previous] = [...group].sort((a, b) =>
          b.run.endedAt.localeCompare(a.run.endedAt),
        );
        if (!latest) continue;
        const regressions = previous
          ? Object.entries(latest.run.metrics)
              .filter(([metric, m]) => {
                const before = previous.run.metrics[metric];
                return before !== undefined && m.ci[1] < before.ci[0];
              })
              .map(([metric]) => metric)
          : [];
        rows.push({
          tenant,
          service: latest.service ?? latest.run.capability,
          testSet: latest.run.testSet.id,
          run: latest.run.id,
          subject: latest.subject,
          endedAt: latest.run.endedAt,
          servedModels: latest.run.provenance.servedModels,
          metrics: latest.run.metrics,
          regressions,
        });
      }
    }
    const judges = judgeAgreement(await deps.labels.list()).map((a) => ({
      ...a,
      advisory: !a.blocking,
    }));
    return c.json({ services: rows, judges, ...(await deps.quality?.()) });
  });

  app.get('/operator/quality/label-queue', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const labelled = new Set((await deps.labels.list()).map((l) => `${l.judge}|${l.item}`));
    const items = [];
    for (const tenant of await deps.tenants()) {
      for (const stored of await deps.runs.list({ tenant })) {
        const judges = new Set(stored.run.provenance.judges);
        for (const result of stored.run.results) {
          for (const s of result.scores) {
            if (!judges.has(s.evaluator) || !s.applicable) continue;
            const verdict = judgeVerdict(s.value);
            const item = `${stored.run.id}:${result.case}:${result.repeat}`;
            if (!verdict || labelled.has(`${s.evaluator}|${item}`)) continue;
            items.push({
              item,
              judge: s.evaluator,
              judgeLabel: verdict,
              tenant,
              service: stored.service ?? stored.run.capability,
              case: result.case,
              reason: s.reason,
            });
          }
        }
      }
    }
    return c.json({ data: items.slice(0, 200), total: items.length });
  });

  app.post('/operator/quality/labels', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!body) return problem(c, 400, 'Invalid request', [{ path: 'body', message: 'required' }]);
    return applied(c, who.principal, 'platform.judge.label', body);
  });

  app.get('/operator/tracing', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const status = deps.traces();
    if (!status) return c.json({ enabled: false, source: 'environment' });
    const host = URL.canParse(status.endpoint)
      ? ((url) => `${url.protocol}//${url.host}${url.pathname}`)(new URL(status.endpoint))
      : 'invalid address';
    return c.json({
      enabled: true,
      source: 'environment',
      endpoint: host,
      content: status.content,
      ...(status.sampleRate === undefined ? {} : { sampleRate: status.sampleRate }),
      ...(status.stats ? { stats: status.stats } : {}),
    });
  });

  app.get('/operator/support-sessions', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const at = now();
    const data = deps.support
      .list()
      .map((s) => ({ ...s, status: sessionStatus(s, at) }))
      .sort((a, b) => b.openedAt.localeCompare(a.openedAt));
    return c.json({ data });
  });

  app.post('/operator/support-sessions/:id/end', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    return applied(c, who.principal, 'platform.support.end', { session: c.req.param('id') });
  });

  app.post('/operator/support-sessions/:id/extend', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const body = (await c.req.json().catch(() => ({}))) as { minutes?: unknown };
    return applied(c, who.principal, 'platform.support.extend', {
      session: c.req.param('id'),
      minutes: body.minutes ?? 15,
    });
  });

  app.get('/operator/running-tasks', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const tenant = c.req.query('tenant');
    const service = c.req.query('service');
    const data = [];
    for (const t of await deps.tasks()) {
      if (tenant && t.tenant !== tenant) continue;
      const details = (await deps.taskDetails(t.task)) ?? {};
      if (service && details.service !== service) continue;
      data.push({ ...t, ...details });
    }
    return c.json({ data: data.sort((a, b) => b.at.localeCompare(a.at)) });
  });

  app.post('/operator/tasks/:task/cancel', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    return applied(c, who.principal, 'platform.task.cancel', { task: c.req.param('task') });
  });

  const kinds = { services: 'Service', 'step-flows': 'StepFlow', skills: 'Skill' } as const;
  const kindOf = (segment: string) =>
    segment in kinds ? kinds[segment as keyof typeof kinds] : undefined;
  const summary = (v: {
    version: number;
    publishedBy: string;
    publishedAt: string;
    reason: string;
  }) => ({
    version: v.version,
    publishedBy: v.publishedBy,
    publishedAt: v.publishedAt,
    reason: v.reason,
  });

  app.get('/operator/tenants/:tenant/definitions', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const tenant = c.req.param('tenant') ?? '';
    const rows = await Promise.all(
      (await deps.store.list(tenant)).map(async ({ kind, id }) => {
        const latest = await deps.store.get(kind, tenant, id);
        const metadata = (latest?.definition.metadata ?? {}) as { name?: string };
        const state =
          kind === 'Service' ? ((await deps.lifecycle?.(tenant, id))?.state ?? 'active') : 'active';
        return {
          kind,
          id,
          state,
          name: metadata.name ?? id,
          latestVersion: latest?.version ?? 0,
          publishedAt: latest?.publishedAt ?? null,
          publishedBy: latest?.publishedBy ?? null,
        };
      }),
    );
    const names =
      (await deps.names?.namesOf(rows.flatMap((r) => (r.publishedBy ? [r.publishedBy] : [])))) ??
      new Map<string, string>();
    const named = rows.map((r) => {
      const publishedByName = r.publishedBy ? names.get(r.publishedBy) : undefined;
      return publishedByName ? { ...r, publishedByName } : r;
    });
    return c.json({ data: named.sort((a, b) => a.name.localeCompare(b.name)) });
  });

  app.get('/operator/tenants/:tenant/definitions/:kind/:id', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const kind = kindOf(c.req.param('kind') ?? '');
    if (!kind) return problem(c, 404, 'Not found');
    const tenant = c.req.param('tenant') ?? '';
    const id = c.req.param('id') ?? '';
    const history = await deps.store.versions(kind, tenant, id);
    const latest = history.at(-1);
    if (!latest) return problem(c, 404, 'Not found');
    const names =
      (await deps.names?.namesOf(history.map((v) => v.publishedBy))) ?? new Map<string, string>();
    const named = (v: (typeof history)[number]) => {
      const publishedByName = names.get(v.publishedBy);
      return publishedByName ? { ...summary(v), publishedByName } : summary(v);
    };
    return c.json({
      kind,
      tenant,
      id,
      latest: { ...named(latest), definition: latest.definition, files: latest.files },
      versions: history.map(named),
    });
  });

  app.get('/operator/tenants/:tenant/definitions/:kind/:id/versions/:version', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const kind = kindOf(c.req.param('kind') ?? '');
    const version = Number(c.req.param('version'));
    if (!kind || !Number.isInteger(version)) return problem(c, 404, 'Not found');
    const found = await deps.store.get(
      kind,
      c.req.param('tenant') ?? '',
      c.req.param('id') ?? '',
      version,
    );
    if (!found) return problem(c, 404, 'Not found');
    return c.json({ ...summary(found), definition: found.definition, files: found.files });
  });

  app.get('/operator/audit', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const read = deps.admin.audit;
    if (!read) return problem(c, 404, 'Not found');
    const entries = (await read()).sort((a, b) => b.at.localeCompare(a.at));
    const names = (await deps.names?.namesOf(entries.map((e) => e.actor))) ?? new Map();
    const data = entries.map((e) => {
      const actorName = names.get(e.actor);
      return actorName ? { ...e, actorName } : e;
    });
    return c.json({ data });
  });

  app.get('/operator/operations', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const overview: OperationsOverview = deps.operations
      ? await deps.operations()
      : {
          incidents: [],
          components: [{ name: 'API', status: 'normal' }],
          queueStats: [],
          queue: [],
          triggers: [],
        };
    return c.json(overview);
  });

  app.get('/operator/organizations/:orgNumber', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const orgNumber = c.req.param('orgNumber') ?? '';
    if (!orgNumberValid(orgNumber))
      return problem(c, 400, 'Invalid request', [
        { path: 'orgNumber', message: 'not a valid organisation number' },
      ]);
    const found = await deps.organization?.(orgNumber);
    if (!found) return problem(c, 404, 'Not found');
    return c.json(found);
  });

  app.post('/operator/audit/exports', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const body = (await c.req.json().catch(() => ({}))) as { count?: unknown };
    return applied(c, who.principal, 'platform.audit.export', { count: body.count });
  });
};
