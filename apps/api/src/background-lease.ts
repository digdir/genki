import { randomUUID } from 'node:crypto';
import { serialized } from './config-store.js';

export const restartMessage = 'Avbrutt fordi plattformen ble startet på nytt';

export interface Leased {
  owner?: string;
  heartbeatAt?: string;
}

export interface LeaseOptions {
  instance?: string;
  heartbeatMs?: number;
  staleAfterMs?: number;
  now?: () => Date;
}

export const backgroundLeases = (options: LeaseOptions = {}) => {
  const instance = options.instance ?? randomUUID();
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const staleAfterMs = options.staleAfterMs ?? 2 * 60_000;
  const now = options.now ?? (() => new Date());
  const live = new Set<string>();

  const stamp = (): Required<Leased> => ({ owner: instance, heartbeatAt: now().toISOString() });

  const abandoned = (key: string, spec: Leased, startedAt: string) => {
    if (live.has(key)) return false;
    if (spec.owner === instance) return true;
    const last = new Date(spec.heartbeatAt ?? startedAt).getTime();
    return now().getTime() - last > staleAfterMs;
  };

  const hold = <T extends Leased>(
    key: string,
    first: T,
    save: (spec: T, reason: string) => Promise<unknown>,
  ) => {
    live.add(key);
    const write = serialized();
    let current = first;
    const update = (next: (spec: T) => T, reason: string) =>
      write(async () => {
        current = { ...next(current), ...stamp() };
        await save(current, reason);
        return current;
      });
    const beat = setInterval(() => {
      void update((spec) => spec, 'Kjører fortsatt').catch(() => undefined);
    }, heartbeatMs);
    beat.unref?.();
    const release = () => {
      clearInterval(beat);
      live.delete(key);
    };
    return { update, release };
  };

  return { instance, now, stamp, abandoned, hold };
};

export type BackgroundLeases = ReturnType<typeof backgroundLeases>;
