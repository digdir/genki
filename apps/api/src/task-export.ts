import type { Event, Ref, Task } from '@genai/contracts';
import { retentionFor } from '@genai/jobs';
import { storeZip } from '@genai/port-blob';
import type { Context, Env, Hono, Schema } from 'hono';
import { enterTenant } from './access.js';
import { actorOf, type AdminHandler } from './admin.js';
import { stageAttribution } from './diagnostics.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { t } from './i18n/index.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';
import { resultReviews } from './result-reviews.js';

export const taskExportAction = 'platform.task.export';

type Status = 400 | 401 | 403 | 404 | 409;

const problem = (c: Context, status: Status, title: string, errors: unknown[] = []) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isRef = (v: unknown): v is Ref =>
  isRecord(v) && typeof v.kind === 'string' && typeof v.id === 'string';

const uniqueRefs = (refs: Ref[]) => {
  const seen = new Map<string, Ref>();
  for (const ref of refs) seen.set(JSON.stringify([ref.kind, ref.tenant ?? '', ref.id]), ref);
  return [...seen.values()];
};

const provenanceOf = (
  task: Task,
  events: Event[],
  approvals: { by: string; at: string; reason: string }[],
) => {
  const used = events.flatMap((e) =>
    e.type === 'kernel.resource.used' && isRecord(e.data) && isRef(e.data.ref)
      ? [{ port: String(e.data.port), ref: e.data.ref }]
      : [],
  );
  const metered = events.flatMap((e) =>
    e.type === 'kernel.usage' && isRecord(e.data) && isRef(e.data.model) ? [e.data.model] : [],
  );
  const responders = events.flatMap((e) =>
    e.type === 'kernel.interrupt.resolved' && isRecord(e.data) && isRef(e.data.responder)
      ? [{ by: e.data.responder, at: e.ts, interrupt: String(e.data.interrupt) }]
      : [],
  );
  return {
    task: task.id,
    service: task.service,
    models: uniqueRefs([...used.filter((u) => u.port === 'model').map((u) => u.ref), ...metered]),
    sources: uniqueRefs(used.filter((u) => u.port !== 'model').map((u) => u.ref)),
    documents: stageAttribution(events, Number.POSITIVE_INFINITY).displayed,
    approvals,
    responders,
  };
};

const json = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

export const taskExportModule: PlatformModuleFactory = (deps) => {
  const reviews = resultReviews(deps.configEntries);
  const recorded: AdminHandler = async (input) => ({
    ok: true,
    value: { task: String(input.task) },
    target: `task:${String(input.task)}`,
  });
  return {
    id: 'task-export',
    handlers: { [taskExportAction]: recorded },
    mount: <E extends Env, S extends Schema, B extends string>(
      app: Hono<E, S, B>,
      mountDeps: MountDeps,
    ) => {
      app.post('/tenants/:tenant/tasks/:task/export', async (c) => {
        const principal = await mountDeps.authenticate(c.req.raw);
        if (!principal) return problem(c, 401, t('problems.notSignedIn'));
        const tenant = c.req.param('tenant') ?? '';
        const entered = enterTenant(c, mountDeps.access, principal, tenant, 'manage-services');
        if ('response' in entered) return entered.response;
        const task = await mountDeps.task(c.req.param('task') ?? '');
        if (!task || task.tenant !== tenant)
          return problem(c, 404, t('problems.taskExportNotFound'));
        const reason = changeReasonOf(c)?.trim() ?? '';
        if (!isReasonLongEnough(reason))
          return problem(c, 400, reasonTooShort, [
            { path: 'change-reason', message: reasonTooShort },
          ]);

        const audit = await mountDeps.admin.perform(
          { ...entered.principal, tenant },
          taskExportAction,
          {
            tenant,
            task: task.id,
            reason,
          },
        );
        if (!audit.ok) return problem(c, 409, t('problems.taskExportNotRecorded'), audit.errors);

        const events: Event[] = [];
        for await (const e of mountDeps.events(task.id)) events.push(e);
        const approvals = (await reviews.history(tenant, task.id))
          .filter((e) => e.spec.approved)
          .map((e) => ({ by: e.by, at: e.at, reason: e.reason }));
        const compiled = (await mountDeps.definitions.capabilities()).find(
          (x) => x.capability.descriptor.id === task.service.capability.id,
        );
        const exported = {
          at: new Date().toISOString(),
          by: actorOf(entered.principal.actor ?? entered.principal),
          reason,
          audit: audit.task,
        };
        const archive = storeZip([
          { name: 'manifest.json', data: json({ task: task.id, tenant, exported }) },
          { name: 'task.json', data: json(task) },
          { name: 'events.json', data: json(events) },
          { name: 'result.json', data: json(task.result ?? []) },
          { name: 'artifacts.json', data: json(task.artifacts) },
          { name: 'provenance.json', data: json(provenanceOf(task, events, approvals)) },
          {
            name: 'retention.json',
            data: json(retentionFor(mountDeps.settings, tenant, compiled)),
          },
        ]);
        return c.body(archive.slice().buffer, 200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="task-${task.id}.zip"`,
          'genai-task': audit.task,
        });
      });
    },
  };
};
