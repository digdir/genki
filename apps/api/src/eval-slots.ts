export interface EvalSlotLimits {
  perInstance: number;
  perTenant: number;
  perRun: number;
}

export const defaultEvalSlotLimits: EvalSlotLimits = { perInstance: 8, perTenant: 4, perRun: 4 };

const positive = (value: string | undefined) => {
  const n = Number(value);
  return value !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
};

export const evalSlotLimitsFromEnv = (
  env: Record<string, string | undefined>,
): Partial<EvalSlotLimits> => {
  const perInstance = positive(env.EVAL_CASES_PER_INSTANCE);
  const perTenant = positive(env.EVAL_CASES_PER_TENANT);
  const perRun = positive(env.EVAL_CASES_PER_RUN);
  return {
    ...(perInstance ? { perInstance } : {}),
    ...(perTenant ? { perTenant } : {}),
    ...(perRun ? { perRun } : {}),
  };
};

interface Waiter {
  run: string;
  tenant: string;
  seq: number;
  grant: (release: () => void) => void;
}

export type QueueWatch = (place: number | undefined) => void;

export const evalSlots = (wanted: Partial<EvalSlotLimits> = {}) => {
  const perInstance = Math.max(1, wanted.perInstance ?? defaultEvalSlotLimits.perInstance);
  const perTenant = Math.min(
    perInstance,
    Math.max(1, wanted.perTenant ?? defaultEvalSlotLimits.perTenant),
  );
  const perRun = Math.min(perTenant, Math.max(1, wanted.perRun ?? defaultEvalSlotLimits.perRun));
  const limits: EvalSlotLimits = { perInstance, perTenant, perRun };

  let active = 0;
  let seq = 0;
  let queue: Waiter[] = [];
  const byTenant = new Map<string, number>();
  const byRun = new Map<string, number>();
  const lastServed = new Map<string, number>();
  const watchers = new Map<string, QueueWatch>();
  const places = new Map<string, number>();

  const count = (counts: Map<string, number>, key: string) => counts.get(key) ?? 0;
  const bump = (counts: Map<string, number>, key: string, by: number) => {
    const n = count(counts, key) + by;
    if (n > 0) counts.set(key, n);
    else counts.delete(key);
  };
  const turnOf = (w: Waiter) => lastServed.get(w.run) ?? -1;
  const inTurn = (a: Waiter, b: Waiter) => turnOf(a) - turnOf(b) || a.seq - b.seq;
  const fits = (w: Waiter) => count(byTenant, w.tenant) < perTenant && count(byRun, w.run) < perRun;

  const placeOf = (run: string) => places.get(run);

  const notify = () => {
    const waiting: string[] = [];
    for (const w of [...queue].sort(inTurn))
      if (count(byRun, w.run) === 0 && !waiting.includes(w.run)) waiting.push(w.run);
    for (const [run, watch] of watchers) {
      const index = waiting.indexOf(run);
      const place = index < 0 ? undefined : index + 1;
      if (places.get(run) === place) continue;
      if (place === undefined) places.delete(run);
      else places.set(run, place);
      watch(place);
    }
  };

  const dispatch = () => {
    while (active < perInstance) {
      const next = queue.filter(fits).sort(inTurn)[0];
      if (!next) break;
      queue = queue.filter((w) => w !== next);
      active += 1;
      bump(byTenant, next.tenant, 1);
      bump(byRun, next.run, 1);
      lastServed.set(next.run, ++seq);
      let released = false;
      next.grant(() => {
        if (released) return;
        released = true;
        active -= 1;
        bump(byTenant, next.tenant, -1);
        bump(byRun, next.run, -1);
        dispatch();
      });
    }
    notify();
  };

  const session = (run: string, tenant: string, watch?: QueueWatch) => {
    if (watch) watchers.set(run, watch);
    return {
      acquire: () =>
        new Promise<() => void>((resolve) => {
          queue.push({ run, tenant, seq: ++seq, grant: resolve });
          dispatch();
        }),
      end: () => {
        watchers.delete(run);
        places.delete(run);
        if (!queue.some((w) => w.run === run) && count(byRun, run) === 0) lastServed.delete(run);
      },
    };
  };

  return { limits, session, placeOf, inFlight: () => active };
};

export type EvalSlots = ReturnType<typeof evalSlots>;
