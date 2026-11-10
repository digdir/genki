import { useEffect, useState } from 'react';

export type Landing = 'old' | 'new';

export const landingStorageKey = 'genki:landing';

const storedLanding = (): Landing => {
  try {
    return window.localStorage.getItem(landingStorageKey) === 'new' ? 'new' : 'old';
  } catch {
    return 'old';
  }
};

const storeLanding = (landing: Landing) => {
  try {
    window.localStorage.setItem(landingStorageKey, landing);
  } catch {
    return;
  }
};

export const requestedLanding = (query: URLSearchParams): Landing | undefined => {
  const value = query.get('landing') ?? new URLSearchParams(window.location.search).get('landing');
  return value === 'new' || value === 'old' ? value : undefined;
};

export const useLanding = (query: URLSearchParams) => {
  const requested = requestedLanding(query);
  const [landing, setLanding] = useState<Landing>(() => requested ?? storedLanding());
  useEffect(() => {
    if (!requested) return;
    setLanding(requested);
    storeLanding(requested);
  }, [requested]);
  const choose = (next: Landing) => {
    setLanding(next);
    storeLanding(next);
  };
  return [landing, choose] as const;
};
