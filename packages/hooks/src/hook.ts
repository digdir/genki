import { z } from 'zod';

export const hookPoints = [
  'before_model',
  'after_model',
  'before_tool',
  'after_tool',
  'task_completed',
  'on_publish',
  'before_search',
  'after_search',
  'on_feedback',
] as const;
export type HookPoint = (typeof hookPoints)[number];

export const hookModes = ['observe', 'annotate', 'enforce'] as const;
export type HookMode = (typeof hookModes)[number];

export const hookFailureModes = ['open', 'closed'] as const;
export type HookFailureMode = (typeof hookFailureModes)[number];

export const refusablePoints: readonly HookPoint[] = [
  'before_model',
  'after_model',
  'before_tool',
  'after_tool',
  'on_publish',
  'before_search',
  'after_search',
];

const hookId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and -');

export const hookHandler = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('webhook'),
    url: z.url({ protocol: /^https$/ }),
    secret: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'the name of a secret in the vault'),
  }),
  z.strictObject({
    kind: z.literal('builtin'),
    id: z.string().min(1),
    config: z.record(z.string(), z.unknown()).default({}),
  }),
]);

export const hookSpec = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    point: z.enum(hookPoints),
    mode: z.enum(hookModes).default('observe'),
    failure: z.enum(hookFailureModes).default('open'),
    timeoutMs: z.number().int().min(50).max(10_000).default(2000),
    order: z.number().int().min(0).max(1000).default(100),
    enabled: z.boolean().default(true),
    services: z.array(z.string().min(1)).optional(),
    handler: hookHandler,
  })
  .refine((h) => h.mode === 'enforce' || h.failure === 'open', {
    path: ['failure'],
    message: 'only an enforcing hook can fail closed',
  })
  .refine((h) => h.mode !== 'enforce' || refusablePoints.includes(h.point), {
    path: ['mode'],
    message: 'this point cannot be refused; use observe or annotate',
  });

export type HookSpec = z.output<typeof hookSpec>;
export type HookSpecInput = z.input<typeof hookSpec>;
export type HookHandler = z.output<typeof hookHandler>;

export interface HookConfig extends HookSpec {
  id: string;
  scope: string;
}

export const parseHookId = (id: unknown) => hookId.safeParse(id);

export interface HookCall {
  point: HookPoint;
  tenant: string;
  task?: string;
  service?: string;
  payload: Record<string, unknown>;
}

export interface HookVerdict {
  decision?: 'allow' | 'refuse';
  reason?: string;
  annotations?: Record<string, unknown>;
}

export type HookInvoker = (
  hook: HookConfig,
  call: HookCall,
  signal: AbortSignal,
) => Promise<HookVerdict>;

export type HookOutcomeKind = 'allowed' | 'annotated' | 'refused' | 'ignored' | 'failed';

export interface HookRecord {
  hook: string;
  name: string;
  scope: string;
  point: HookPoint;
  mode: HookMode;
  outcome: HookOutcomeKind;
  reason?: string;
  annotations?: Record<string, unknown>;
  ms: number;
}

export interface HookRun {
  refused?: { hook: string; name: string; reason: string };
  records: HookRecord[];
}

export class HookTimeout extends Error {
  constructor(ms: number) {
    super(`no answer within ${ms} ms`);
    this.name = 'HookTimeout';
  }
}

export const sortHooks = (hooks: HookConfig[], platformScope = 'platform') =>
  [...hooks].sort(
    (a, b) =>
      Number(b.scope === platformScope) - Number(a.scope === platformScope) ||
      a.order - b.order ||
      a.id.localeCompare(b.id),
  );

export const appliesTo = (hook: HookConfig, point: HookPoint, service?: string) =>
  hook.enabled &&
  hook.point === point &&
  (!hook.services ||
    (service !== undefined &&
      hook.services.some((s) => service === s || service.startsWith(`${s}/`))));

const withTimeout = async (
  hook: HookConfig,
  call: HookCall,
  invoke: HookInvoker,
  outer?: AbortSignal,
) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  outer?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      invoke(hook, call, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new HookTimeout(hook.timeoutMs));
        }, hook.timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', abort);
  }
};

const isAnnotations = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const runHooks = async (
  hooks: HookConfig[],
  call: HookCall,
  invoke: HookInvoker,
  signal?: AbortSignal,
): Promise<HookRun> => {
  const records: HookRecord[] = [];
  for (const hook of hooks) {
    if (!appliesTo(hook, call.point, call.service)) continue;
    const started = Date.now();
    const base = {
      hook: hook.id,
      name: hook.name,
      scope: hook.scope,
      point: call.point,
      mode: hook.mode,
    };
    let verdict: HookVerdict;
    try {
      verdict = await withTimeout(hook, call, invoke, signal);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      records.push({ ...base, outcome: 'failed', reason, ms: Date.now() - started });
      if (hook.failure === 'closed')
        return {
          refused: { hook: hook.id, name: hook.name, reason: `kroken svarte ikke: ${reason}` },
          records,
        };
      continue;
    }
    const ms = Date.now() - started;
    const annotations =
      hook.mode !== 'observe' && isAnnotations(verdict.annotations)
        ? verdict.annotations
        : undefined;
    const reason = typeof verdict.reason === 'string' ? verdict.reason.slice(0, 500) : undefined;
    if (verdict.decision === 'refuse') {
      if (hook.mode === 'enforce' && refusablePoints.includes(call.point)) {
        records.push({
          ...base,
          outcome: 'refused',
          ...(reason ? { reason } : {}),
          ...(annotations ? { annotations } : {}),
          ms,
        });
        return {
          refused: { hook: hook.id, name: hook.name, reason: reason ?? 'ingen begrunnelse' },
          records,
        };
      }
      records.push({ ...base, outcome: 'ignored', ...(reason ? { reason } : {}), ms });
      continue;
    }
    records.push({
      ...base,
      outcome: annotations ? 'annotated' : 'allowed',
      ...(annotations ? { annotations } : {}),
      ms,
    });
  }
  return { records };
};

export const refusalText = (refused: NonNullable<HookRun['refused']>) =>
  `Stoppet av kroken «${refused.name}»: ${refused.reason}`;
