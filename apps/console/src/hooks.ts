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
  return [state, retry] as const;
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

export const splitRoute = (hash: string) => {
  const [path = '/', query = ''] = hash.split('?');
  return { path, params: new URLSearchParams(query) };
};

export const navigate = (path: string, params?: Record<string, string>) => {
  const query = params ? new URLSearchParams(params).toString() : '';
  window.location.hash = query ? `${path}?${query}` : path;
};
