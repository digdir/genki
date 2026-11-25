import type { FlagKey, FlagState } from '@genai/contracts/flags';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ApiClient } from './api';

interface Flags {
  states: readonly FlagState[];
  reload: () => void;
}

const FlagsContext = createContext<Flags>({ states: [], reload: () => undefined });

export const FlagsProvider = ({
  api,
  tenant,
  children,
}: {
  api: Pick<ApiClient, 'flags'>;
  tenant: string;
  children: ReactNode;
}) => {
  const [loaded, setLoaded] = useState<{ tenant: string; states: readonly FlagState[] }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api.flags.mine(tenant, controller.signal).then(
      (found) => !controller.signal.aborted && setLoaded({ tenant, states: found }),
      () =>
        !controller.signal.aborted &&
        setLoaded((before) => (before?.tenant === tenant ? before : { tenant, states: [] })),
    );
    return () => controller.abort();
  }, [api, tenant, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const value = useMemo(
    () => ({ states: loaded?.tenant === tenant ? loaded.states : [], reload }),
    [loaded, tenant, reload],
  );
  return <FlagsContext.Provider value={value}>{children}</FlagsContext.Provider>;
};

export const FlagsOn = ({
  flags,
  children,
}: {
  flags: readonly FlagKey[];
  children: ReactNode;
}) => (
  <FlagsContext.Provider
    value={{
      states: flags.map((key) => ({
        key,
        on: true,
        source: 'person',
        selfService: true,
        person: true,
        tenant: null,
      })),
      reload: () => undefined,
    }}
  >
    {children}
  </FlagsContext.Provider>
);

export const useFlags = () => useContext(FlagsContext);

export const useFlag = (key: FlagKey) => useFlags().states.some((s) => s.key === key && s.on);
