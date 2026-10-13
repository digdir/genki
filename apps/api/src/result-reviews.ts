import type { Part, Principal, Task } from '@genai/contracts';
import type { Context, Env, Hono, Schema } from 'hono';
import { enterTenant, refusedRight } from './access.js';
import { actorOf, AdminRefused, refusedBy, routeOnlyActions } from './admin.js';
import {
  appendVersion,
  VersionConflict,
  type ConfigEntry,
  type ConfigEntryStore,
} from './config-store.js';
import { actorNameOf, changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';

export const resultReviewKind = 'task-result-review';
const tableMime = 'application/vnd.genai.table+json';

export interface CellEdit {
  row: number;
  column: string;
  value: string;
}

export interface ResultReview {
  task: string;
  edits: CellEdit[];
  approved: boolean;
  changedBy?: string;
}

type Status = 400 | 401 | 403 | 404 | 409;

const problem = (c: Context, status: Status, title: string, errors: unknown[] = []) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface TableShape {
  columns: { key: string }[];
  rows: { cells: Record<string, unknown> }[];
}

const tableOf = (parts: Part[] | undefined) => {
  const part = parts?.find((p) => p.mime === tableMime && p.body.kind === 'json');
  const json = part?.body.kind === 'json' ? part.body.json : undefined;
  if (!isRecord(json) || !Array.isArray(json.columns) || !Array.isArray(json.rows))
    return undefined;
  return json as unknown as TableShape & Record<string, unknown>;
};

const csvOf = (parts: Part[] | undefined) => {
  const part = parts?.find((p) => p.mime === 'text/csv' && p.body.kind === 'text');
  return part?.body.kind === 'text' ? part.body.text : undefined;
};

const originalOf = (table: TableShape, edit: CellEdit) => {
  const cell = table.rows[edit.row]?.cells[edit.column];
  return isRecord(cell) && 'value' in cell ? cell.value : cell;
};

const editsFrom = (raw: unknown, table: TableShape) => {
  const errors: { path: string; message: string }[] = [];
  if (!Array.isArray(raw)) return { errors: [{ path: 'edits', message: 'a list of edits' }] };
  const columns = new Set(table.columns.map((c) => c.key));
  const edits: CellEdit[] = [];
  raw.forEach((e, i) => {
    if (
      !isRecord(e) ||
      !Number.isInteger(e.row) ||
      typeof e.column !== 'string' ||
      typeof e.value !== 'string'
    ) {
      errors.push({ path: `edits[${i}]`, message: 'row, column and value are required' });
      return;
    }
    const row = e.row as number;
    if (row < 0 || row >= table.rows.length)
      errors.push({ path: `edits[${i}].row`, message: 'no such row' });
    if (!columns.has(e.column))
      errors.push({ path: `edits[${i}].column`, message: 'no such column' });
    edits.push({ row, column: e.column, value: e.value.slice(0, 4000) });
  });
  const unique = new Map(edits.map((e) => [`${e.row}/${e.column}`, e]));
  return { errors, edits: [...unique.values()] };
};

const startedBy = (task: Task, principal: Principal) =>
  task.principal.id === JSON.stringify([principal.issuer, principal.subject]);

export const resultReviews = (store: ConfigEntryStore) => ({
  history: (tenant: string, task: string) =>
    store.history(resultReviewKind, tenant, task) as Promise<ConfigEntry<ResultReview>[]>,
  save: (
    tenant: string,
    review: ResultReview,
    principal: Principal,
    reason: string,
    ifVersion: number,
  ) =>
    appendVersion<ResultReview>(store, {
      kind: resultReviewKind,
      scope: tenant,
      id: review.task,
      spec: review,
      deleted: false,
      by: actorOf(principal.actor ?? principal),
      reason,
      ifVersion,
    }),
});

const runControls = new Set(['query', 'history', 'overrides', 'document']);

const formInputOf = async (events: MountDeps['events'] | undefined, task: string) => {
  if (!events) return undefined;
  for await (const event of events(task)) {
    if (event.type !== 'kernel.task.input') continue;
    const data = (event.data as { input?: { data?: unknown } } | undefined)?.input?.data;
    if (!isRecord(data)) return undefined;
    const values = Object.entries(data).filter(([key]) => !runControls.has(key));
    return values.length ? Object.fromEntries(values) : undefined;
  }
  return undefined;
};

const view = (
  task: Task,
  history: ConfigEntry<ResultReview>[],
  input?: Record<string, unknown>,
) => {
  const table = tableOf(task.result);
  const csv = csvOf(task.result);
  const latest = history.at(-1);
  const approvedAt = latest?.spec.approved ? latest : undefined;
  const lastEdit = [...history].reverse().find((e) => !e.spec.approved);
  return {
    task: task.id,
    service: task.service.capability.id,
    status: task.status,
    createdAt: task.createdAt,
    ...(input ? { input } : {}),
    table: table ?? null,
    ...(csv ? { csv } : {}),
    edits: (latest?.spec.edits ?? []).map((e) => ({
      ...e,
      original: table ? (originalOf(table, e) ?? null) : null,
      ...(lastEdit ? { by: lastEdit.by, at: lastEdit.at } : {}),
      ...(lastEdit?.spec.changedBy ? { byName: lastEdit.spec.changedBy } : {}),
    })),
    approval: approvedAt
      ? {
          status: 'approved' as const,
          by: approvedAt.by,
          ...(approvedAt.spec.changedBy ? { byName: approvedAt.spec.changedBy } : {}),
          at: approvedAt.at,
          reason: approvedAt.reason,
        }
      : { status: 'draft' as const },
    version: latest?.version ?? 0,
  };
};

export const resultReviewActions = [
  'platform.task.review.edit',
  'platform.task.review.approve',
] as const;

export const resultReviewsModule: PlatformModuleFactory = (deps) => {
  const reviews = resultReviews(deps.configEntries);
  return {
    id: 'result-reviews',
    handlers: routeOnlyActions(resultReviewActions),
    mount: <E extends Env, S extends Schema, B extends string>(
      app: Hono<E, S, B>,
      mountDeps: MountDeps,
    ) => {
      const base = '/tenants/:tenant/tasks/:task/review';

      const enter = async (c: Context, changing: boolean) => {
        const principal = await mountDeps.authenticate(c.req.raw);
        if (!principal) return { response: problem(c, 401, 'Du er ikke logget inn') };
        const tenant = c.req.param('tenant') ?? '';
        const entered = enterTenant(
          c,
          mountDeps.access,
          principal,
          tenant,
          changing ? 'use-services' : undefined,
        );
        if ('response' in entered) return { response: entered.response };
        const task = await mountDeps.task(c.req.param('task') ?? '');
        if (!task || task.tenant !== tenant)
          return { response: problem(c, 404, 'Fant ikke kjøringen') };
        if (!startedBy(task, entered.principal)) {
          if (changing)
            return {
              response: problem(c, 403, 'Bare den som startet kjøringen kan endre og godkjenne'),
            };
          const lacking = refusedRight(c, entered.principal, tenant, 'manage-services');
          if (lacking) return { response: lacking };
        }
        return { principal: entered.principal, tenant, task };
      };

      const reasonFor = (c: Context) => {
        const reason = changeReasonOf(c)?.trim() ?? '';
        return isReasonLongEnough(reason) ? reason : undefined;
      };

      const recorded = async (
        c: Context,
        guard: { principal: Principal; tenant: string; task: Task },
        action: (typeof resultReviewActions)[number],
        reason: string,
        expected: number,
        save: () => Promise<unknown>,
      ) => {
        try {
          const done = await mountDeps.admin.within(
            guard.principal,
            action,
            { tenant: guard.tenant, reason, task: guard.task.id },
            async () => ({ value: await save(), target: `task-review:${guard.task.id}` }),
          );
          c.header('genai-task', done.task);
          return undefined;
        } catch (error) {
          const current = (await reviews.history(guard.tenant, guard.task.id)).at(-1)?.version ?? 0;
          if (error instanceof VersionConflict || current !== expected)
            return problem(c, 409, 'Endret et annet sted', [
              { path: 'version', message: `oppføringen er på versjon ${current}` },
            ]);
          if (error instanceof AdminRefused) return refusedBy(c, error);
          throw error;
        }
      };

      app.get(base, async (c) => {
        const guard = await enter(c, false);
        if (guard.response) return guard.response;
        return c.json(
          view(
            guard.task,
            await reviews.history(guard.tenant, guard.task.id),
            await formInputOf(mountDeps.events, guard.task.id),
          ),
        );
      });

      app.put(`${base}/edits`, async (c) => {
        const guard = await enter(c, true);
        if (guard.response) return guard.response;
        const reason = reasonFor(c);
        if (!reason)
          return problem(c, 400, reasonTooShort, [
            { path: 'change-reason', message: reasonTooShort },
          ]);
        const table = tableOf(guard.task.result);
        if (!table) return problem(c, 409, 'Kjøringen har ikke laget en tabell');
        const history = await reviews.history(guard.tenant, guard.task.id);
        if (history.at(-1)?.spec.approved)
          return problem(c, 409, 'Tabellen er godkjent og kan ikke endres');
        const body = (await c.req.json().catch(() => ({}))) as { edits?: unknown };
        const parsed = editsFrom(body.edits, table);
        if (parsed.errors.length || !parsed.edits)
          return problem(c, 400, 'Ugyldige endringer', parsed.errors);
        const name = actorNameOf(c);
        const edits = parsed.edits;
        const expected = history.at(-1)?.version ?? 0;
        const saved = await recorded(c, guard, 'platform.task.review.edit', reason, expected, () =>
          reviews.save(
            guard.tenant,
            {
              task: guard.task.id,
              edits,
              approved: false,
              ...(name ? { changedBy: name } : {}),
            },
            guard.principal,
            reason,
            expected,
          ),
        );
        if (saved) return saved;
        return c.json(view(guard.task, await reviews.history(guard.tenant, guard.task.id)));
      });

      app.post(`${base}/approve`, async (c) => {
        const guard = await enter(c, true);
        if (guard.response) return guard.response;
        const reason = reasonFor(c);
        if (!reason)
          return problem(c, 400, reasonTooShort, [
            { path: 'change-reason', message: reasonTooShort },
          ]);
        if (guard.task.status !== 'completed')
          return problem(c, 409, 'Vent til kjøringen er ferdig før du godkjenner den');
        if (!tableOf(guard.task.result))
          return problem(c, 409, 'Kjøringen har ikke laget en tabell');
        const history = await reviews.history(guard.tenant, guard.task.id);
        const latest = history.at(-1);
        if (latest?.spec.approved) return problem(c, 409, 'Tabellen er allerede godkjent');
        const name = actorNameOf(c);
        const expected = latest?.version ?? 0;
        const saved = await recorded(
          c,
          guard,
          'platform.task.review.approve',
          reason,
          expected,
          () =>
            reviews.save(
              guard.tenant,
              {
                task: guard.task.id,
                edits: latest?.spec.edits ?? [],
                approved: true,
                ...(name ? { changedBy: name } : {}),
              },
              guard.principal,
              reason,
              expected,
            ),
        );
        if (saved) return saved;
        return c.json(view(guard.task, await reviews.history(guard.tenant, guard.task.id)));
      });
    },
  };
};
