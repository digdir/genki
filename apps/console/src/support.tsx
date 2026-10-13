import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ApiClient } from './api';
import { useT } from './i18n';
import type { SupportSession } from './types';

export interface ActiveSupport extends SupportSession {
  tenantName: string;
}

interface SupportState {
  session: ActiveSupport | undefined;
  notice: string | undefined;
  start: (
    tenant: string,
    tenantName: string,
    reason: string,
    minutes: number,
  ) => Promise<ActiveSupport>;
  end: (auto?: boolean) => Promise<void>;
  extend: (minutes: number, reason: string) => Promise<void>;
  expired: ActiveSupport | undefined;
  clearNotice: () => void;
  sessionFor: (tenant: string) => ActiveSupport | undefined;
}

const SupportContext = createContext<SupportState | undefined>(undefined);

export const SupportProvider = ({ api, children }: { api: ApiClient; children: ReactNode }) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [session, setSession] = useState<ActiveSupport | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [expired, setExpired] = useState<ActiveSupport | undefined>();
  const [, setTick] = useState(0);

  const start = useCallback(
    async (tenant: string, tenantName: string, reason: string, minutes: number) => {
      const opened = await api.openSupportSession(tenant, reason, minutes);
      const active = { ...opened, tenantName };
      setSession(active);
      setNotice(undefined);
      setExpired(undefined);
      return active;
    },
    [api],
  );

  const end = useCallback(
    async (auto = false) => {
      if (!session) return;
      setSession(undefined);
      setExpired(auto ? session : undefined);
      setNotice(tRef.current(auto ? 'support.expiredNotice' : 'support.endedNotice'));
      if (!auto)
        await api
          .endSupportSession(session.id, tRef.current('support.endedEarlyReason'))
          .catch(() => undefined);
    },
    [api, session],
  );

  const extend = useCallback(
    async (minutes: number, reason: string) => {
      if (!session) return;
      const extended = await api.extendSupportSession(session.id, minutes, reason);
      setSession({ ...session, expiresAt: extended.expiresAt });
    },
    [api, session],
  );

  useEffect(() => {
    if (!session) return;
    api.holdSupport(session.tenant, session.id);
    return () => api.holdSupport(session.tenant, undefined);
  }, [api, session]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const rows = await api.supportSessions(controller.signal);
      const me = api.actor();
      const mine = rows.find(
        (s) => s.status === 'active' && (!s.operatorName || !me || s.operatorName === me),
      );
      if (!mine || controller.signal.aborted) return;
      const tenants = await api.listTenants(controller.signal, { usage: false });
      const tenantName = tenants.find((x) => x.orgNumber === mine.tenant)?.name ?? mine.tenant;
      setSession((current) => current ?? { ...mine, tenantName });
    })().catch(() => undefined);
    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      if (Date.now() >= new Date(session.expiresAt).getTime()) void end(true);
      else setTick((n) => n + 1);
    }, 15000);
    return () => clearInterval(timer);
  }, [session, end]);

  const value = useMemo(
    () => ({
      session,
      notice,
      start,
      end,
      extend,
      expired,
      clearNotice: () => setNotice(undefined),
      sessionFor: (tenant: string) => (session?.tenant === tenant ? session : undefined),
    }),
    [session, notice, start, end, extend, expired],
  );
  return <SupportContext.Provider value={value}>{children}</SupportContext.Provider>;
};

export const useSupport = () => {
  const value = useContext(SupportContext);
  if (!value) throw new Error('useSupport outside SupportProvider');
  return value;
};
