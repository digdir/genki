import { useEffect, useState } from 'react';

const listeners = new Map<string, Set<() => void>>();
const keyOf = (tenant: string, id: string) => `${tenant}\u0000${id}`;

/** Tells an open service page that its server draft was changed from another part of the page. */
export const draftChanged = (tenant: string, id: string) => {
  for (const listener of listeners.get(keyOf(tenant, id)) ?? []) listener();
};

/** Counts the changes {@link draftChanged} reported for this service while it is open. */
export const useDraftChanges = (tenant: string, id: string) => {
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    const key = keyOf(tenant, id);
    const bump = () => setChanges((n) => n + 1);
    const set = listeners.get(key) ?? new Set();
    set.add(bump);
    listeners.set(key, set);
    return () => {
      set.delete(bump);
      if (set.size === 0) listeners.delete(key);
    };
  }, [tenant, id]);
  return changes;
};
