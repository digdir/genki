import type { Principal } from '@genai/contracts';
import { defaultPlatformTenant } from '@genai/composition';
import {
  isInternalService,
  type DefinitionStore,
  type PluginSchemas,
  type ValidationError,
} from '@genai/definitions';
import {
  evaluatorOfJudge,
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
import { withFlagDetails } from '../flag-audit.js';
import { actorOf, type Admin, type AdminHandler } from '../admin.js';
import { blockUsage } from '../block-usage.js';
import { orgNumberValid } from '../extensions.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from '../http.js';
import type { OperationsOverview } from '../operations.js';
import type { Organization } from '../organizations.js';
import { SinkLabelsRefused, type SinkLabels } from '../sink-labels.js';
import { isOperator } from '../rights.js';
import { actsAsOperator } from '../content-reason.js';
import { AuditFilter, auditMatches } from '../audit-filter.js';

const OperatorAuditQuery = AuditFilter.extend({
  tenant: z
    .string()
    .regex(/^\d{9}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const consoleActions = [
  'platform.service.share',
  'platform.judge.label',
  'platform.judge.label.accept',
  'platform.judge.label.reject',
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
  /** Labels brought back from tenants' trace sinks, which an operator accepts or rejects. */
  sinkLabels?: SinkLabels;
  traces(): TraceStatus | undefined;
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
  admin: Pick<Admin, 'perform'> &
    Partial<Pick<Admin, 'audit' | 'events' | 'contentReason' | 'recordContentRead'>>;
  authenticate(request: Request): Promise<Principal | undefined>;
  platformTenant?: string;
}

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

/** The labels an operator was shown in a batch, by the sink's id and revision. */
const shownOf = (labels: unknown) =>
  Array.isArray(labels)
    ? labels.flatMap((l: unknown) =>
        l && typeof l === 'object' && 'id' in l && 'revision' in l
          ? [{ id: String(l.id), revision: String(l.revision) }]
          : [],
      )
    : undefined;

export const consoleAdminExtensions = (deps: ConsoleDeps): Record<string, AdminHandler> => {
  /** A batch of a sink's labels (one connection, one judge) accepted or rejected, with its reason. */
  const decided =
    (decision: 'accept' | 'reject'): AdminHandler =>
    async (input, principal) => {
      const target = `judge:${String(input.judge)}`;
      if (principal.kind !== 'operator' && !principal.actor)
        return refused(target, 'only operators decide which labels count');
      const agency = String(input.agency);
      const result = await deps.sinkLabels?.decide(
        agency,
        String(input.connection),
        String(input.judge),
        decision,
        actorOf(principal),
        String(input.reason),
        shownOf(input.labels),
      );
      if (!result || (result.accepted ?? result.rejected ?? 0) === 0)
        return invalid(target, [{ path: 'judge', message: 'no such batch of pending labels' }]);
      return { ok: true, value: result, target, audit: { scope: 'platform', tenant: agency } };
    };
  return {
    'platform.judge.label.accept': decided('accept'),
    'platform.judge.label.reject': decided('reject'),
    'platform.service.share': async (input, principal) => {
      const target = `service:${String(input.serviceTenant)}/${String(input.service)}`;
      if (!isOperator(principal)) return refused(target, 'only operators change what is shared');
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
      if (!isOperator(principal)) return refused(target, 'only operators label judge results');
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
    'platform.task.cancel': async (input, principal) => {
      const target = `task:${String(input.task)}`;
      if (!isOperator(principal)) return refused(target, 'only operators cancel tasks');
      const task = String(input.task);
      if (!(await deps.tasks()).some((t) => t.task === task))
        return invalid(target, [{ path: 'task', message: 'no running task with that id' }]);
      await deps.cancel(task);
      return { ok: true, value: { task, cancelled: true }, target, audit: { scope: 'platform' } };
    },
    'platform.audit.export': async (input, principal) => {
      const target = 'audit:export';
      if (!isOperator(principal)) return refused(target, 'only operators export the audit log');
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
  status: 400 | 401 | 403 | 404 | 409 | 502,
  title: string,
  errors: unknown[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const judgeVerdict = (value: number | null) =>
  value === null ? undefined : value >= 0.5 ? 'good' : 'bad';

export const registerConsoleRoutes = <E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  deps: ConsoleRouteDeps,
) => {
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
      const given = actsAsOperator(who.principal, tenant)
        ? deps.admin.contentReason?.(who.principal, tenant)
        : { reason: '' };
      let shown = false;
      for (const stored of await deps.runs.list({ tenant })) {
        const judges = new Set(stored.run.provenance.judges.map(evaluatorOfJudge));
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
              ...(given ? { reason: s.reason } : {}),
            });
            shown ||= Boolean(given?.reason && s.reason);
          }
        }
      }
      if (shown && given)
        await deps.admin.recordContentRead?.(
          who.principal,
          tenant,
          given.reason,
          'GET /operator/quality/label-queue',
        );
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

  app.get('/operator/quality/sink-labels', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const connections = [];
    const batches = [];
    for (const tenant of await deps.tenants()) {
      if (!deps.sinkLabels) break;
      connections.push(
        ...(await deps.sinkLabels.connections(tenant)).map((x) => ({ tenant, ...x })),
      );
      batches.push(...(await deps.sinkLabels.batches(tenant)));
    }
    return c.json({ connections, batches });
  });

  app.post('/operator/quality/sink-labels/fetch', async (c) => {
    const who = await operatorOf(c);
    if (who.response) return who.response;
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const tenant = typeof body?.tenant === 'string' ? body.tenant : '';
    const connection = typeof body?.connection === 'string' ? body.connection : '';
    if (!tenant || !connection)
      return problem(c, 400, 'Invalid request', [
        { path: 'body', message: 'tenant and connection are required' },
      ]);
    if (!deps.sinkLabels || !(await deps.tenants()).includes(tenant))
      return problem(c, 404, 'Not found');
    try {
      return c.json(await deps.sinkLabels.fetch(tenant, connection));
    } catch (error) {
      if (error instanceof SinkLabelsRefused)
        return problem(c, error.missing ? 404 : 409, error.missing ? 'Not found' : 'Conflict', [
          { path: 'connection', message: error.message },
        ]);
      // Langfuse refused or failed: nothing was changed, and the operator sees what it answered.
      return problem(c, 502, 'Bad gateway', [
        { path: 'connection', message: error instanceof Error ? error.message : String(error) },
      ]);
    }
  });

  for (const decision of ['accept', 'reject'] as const)
    app.post(`/operator/quality/sink-labels/${decision}`, async (c) => {
      const who = await operatorOf(c);
      if (who.response) return who.response;
      const body = (await c.req.json().catch(() => undefined)) as
        Record<string, unknown> | undefined;
      if (!body) return problem(c, 400, 'Invalid request', [{ path: 'body', message: 'required' }]);
      if (body.labels !== undefined && !Array.isArray(body.labels))
        return problem(c, 400, 'Invalid request', [
          {
            path: 'labels',
            message: 'labels must be a list of the labels shown, by id and revision',
          },
        ]);
      return applied(c, who.principal, `platform.judge.label.${decision}`, {
        agency: body.tenant,
        connection: body.connection,
        judge: body.judge,
        ...(body.labels === undefined ? {} : { labels: body.labels }),
      });
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

  const kinds = {
    services: 'Service',
    'step-flows': 'StepFlow',
    skills: 'Skill',
    blocks: 'Block',
  } as const;
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
          ...(isInternalService(latest?.definition) ? { internal: true } : {}),
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
    const query = OperatorAuditQuery.safeParse(c.req.query());
    if (!query.success)
      return problem(
        c,
        400,
        'Invalid request',
        query.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    const { tenant, limit, offset, ...filter } = query.data;
    const kept = (await read(tenant))
      .filter(auditMatches(filter))
      .sort((a, b) => b.at.localeCompare(a.at));
    const entries = await withFlagDetails(
      limit === undefined && offset === undefined
        ? kept
        : kept.slice(offset ?? 0, (offset ?? 0) + (limit ?? kept.length)),
      { events: deps.admin.events, names: deps.names },
    );
    const names = (await deps.names?.namesOf(entries.map((e) => e.actor))) ?? new Map();
    const data = entries.map((e) => {
      const actorName = names.get(e.actor);
      return actorName ? { ...e, actorName } : e;
    });
    return c.json({ data, total: kept.length });
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
