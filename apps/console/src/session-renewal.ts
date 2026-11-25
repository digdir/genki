import { useEffect, useRef } from 'react';
import type { AuthClient } from './auth';
import type { OperatorSession } from './types';

export const renewBeforeMs = 60_000;

export const useSessionRenewal = (
  auth: AuthClient,
  session: OperatorSession | undefined,
  onRenewed: (session: OperatorSession) => void,
  onExpired: () => void,
  now: () => number = Date.now,
) => {
  const handlers = useRef({ onRenewed, onExpired });
  handlers.current = { onRenewed, onExpired };
  const expiresAt = session ? auth.expiresAt?.() : undefined;
  useEffect(() => {
    if (expiresAt === undefined || !auth.renew) return;
    let active = true;
    const renew = async (last: boolean) => {
      const renewed = await auth.renew?.().catch(() => undefined);
      if (!active) return;
      if (renewed) handlers.current.onRenewed(renewed);
      else if (last) handlers.current.onExpired();
    };
    const lifetime = expiresAt - now();
    const early = setTimeout(
      () => void renew(false),
      Math.max(0, Math.max(lifetime - renewBeforeMs, lifetime / 2)),
    );
    const end = setTimeout(() => void renew(true), Math.max(0, lifetime));
    return () => {
      active = false;
      clearTimeout(early);
      clearTimeout(end);
    };
  }, [auth, expiresAt, now]);
};
