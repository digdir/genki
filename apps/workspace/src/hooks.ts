import { useCallback, useEffect, useState } from 'react';

export type AsyncState<T> =
  { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; data: T };

export const useAsync = <T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]) => {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    load(controller.signal).then(
      (data) => !controller.signal.aborted && setState({ status: 'ready', data }),
      (error: unknown) => !controller.signal.aborted && setState({ status: 'error', error }),
    );
    return () => controller.abort();
  }, [...deps, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return [state, retry, setState] as const;
};

const readHash = () => window.location.hash.replace(/^#/, '') || '/';

export const useHashRoute = () => {
  const [path, setPath] = useState(readHash);
  useEffect(() => {
    const update = () => setPath(readHash());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return path;
};

const narrowQuery = '(max-width: 759px)';

const isNarrow = () =>
  typeof window.matchMedia === 'function' && window.matchMedia(narrowQuery).matches;

export const useNarrow = () => {
  const [narrow, setNarrow] = useState(isNarrow);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(narrowQuery);
    const update = () => setNarrow(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
};
