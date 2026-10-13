import { useEffect, useState } from 'react';
import type { Session } from './types';

export const warnBeforeMs = 5 * 60_000;
const longestTimer = 2_147_483_647;

const after = (ms: number, run: () => void) =>
  ms > longestTimer ? undefined : setTimeout(run, Math.max(0, ms));

interface Renewable {
  expiresAt?(): number | undefined;
  refresh?(): Promise<Session | undefined>;
}

export const useSessionTimer = (
  auth: Renewable,
  session: Session | undefined,
  onRenewed: (session: Session) => void,
  onExpired: () => void,
  now: () => number = Date.now,
) => {
  const [warnAt, setWarnAt] = useState<number>();
  const token = session?.token;
  useEffect(() => {
    setWarnAt(undefined);
    const expiresAt = token ? auth.expiresAt?.() : undefined;
    if (expiresAt === undefined) return;
    let active = true;
    const renew = async () => {
      const renewed = await auth.refresh?.().catch(() => undefined);
      if (!active) return;
      if (renewed) onRenewed(renewed);
      else setWarnAt(expiresAt);
    };
    const warn = after(expiresAt - warnBeforeMs - now(), () => void renew());
    const end = after(expiresAt - now(), () => active && onExpired());
    return () => {
      active = false;
      clearTimeout(warn);
      clearTimeout(end);
    };
  }, [auth, token]);
  return warnAt;
};
