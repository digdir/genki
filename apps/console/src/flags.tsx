import type { FlagKey, FlagState } from '@genai/contracts/flags';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const FlagsContext = createContext<readonly FlagState[]>([]);

export const FlagsProvider = ({
  load,
  children,
}: {
  load: (signal: AbortSignal) => Promise<FlagState[]>;
  children: ReactNode;
}) => {
  const [states, setStates] = useState<readonly FlagState[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (found) => !controller.signal.aborted && setStates(found),
      () => undefined,
    );
    return () => controller.abort();
  }, [load]);
  return <FlagsContext.Provider value={states}>{children}</FlagsContext.Provider>;
};

export const FlagsOn = ({
  flags,
  children,
}: {
  flags: readonly FlagKey[];
  children: ReactNode;
}) => (
  <FlagsContext.Provider
    value={flags.map((key) => ({
      key,
      on: true,
      source: 'person',
      selfService: true,
      person: true,
      tenant: null,
    }))}
  >
    {children}
  </FlagsContext.Provider>
);

export const useFlag = (key: FlagKey) =>
  useContext(FlagsContext).some((s) => s.key === key && s.on);
