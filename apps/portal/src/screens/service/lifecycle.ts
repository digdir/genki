import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api';
import { useAsync } from '../../hooks';
import type { ServiceLifecycleView } from '../../types';

export type LifecycleView = ServiceLifecycleView & { byName?: string };

const listeners = new Map<string, Set<() => void>>();
const keyOf = (tenant: string, id: string) => `${tenant}\u0000${id}`;

export const lifecycleChanged = (tenant: string, id: string) => {
  for (const listener of listeners.get(keyOf(tenant, id)) ?? []) listener();
};

export const useServiceLifecycle = (api: ApiClient, tenant: string, id: string, enabled = true) => {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const key = keyOf(tenant, id);
    const bump = () => setVersion((v) => v + 1);
    const set = listeners.get(key) ?? new Set();
    set.add(bump);
    listeners.set(key, set);
    return () => {
      set.delete(bump);
      if (set.size === 0) listeners.delete(key);
    };
  }, [tenant, id]);
  const [state] = useAsync(
    async (signal): Promise<LifecycleView | undefined> =>
      enabled ? api.serviceLifecycle(tenant, id, signal) : undefined,
    [api, tenant, id, enabled, version],
    { keepPreviousFor: keyOf(tenant, id) },
  );
  return state.status === 'ready' ? state.data : undefined;
};
