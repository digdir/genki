import { useCallback, useEffect, useRef, useState } from 'react';
import { markPageLoad, onRefreshed } from './api/cache';

export type AsyncState<T> =
  { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; data: T };

export const useAsync = <T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]) => {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [refreshed, setRefreshed] = useState(0);
  const silent = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    markPageLoad(controller.signal, silent.current);
    if (silent.current) silent.current = false;
    else setState({ status: 'loading' });
    load(controller.signal).then(
      (data) => !controller.signal.aborted && setState({ status: 'ready', data }),
      (error: unknown) => !controller.signal.aborted && setState({ status: 'error', error }),
    );
    const stop = onRefreshed(controller.signal, () => {
      silent.current = true;
      setRefreshed((n) => n + 1);
    });
    return () => {
      stop();
      controller.abort();
    };
  }, [...deps, attempt, refreshed]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return [state, retry] as const;
};

export interface Route {
  path: string;
  segments: string[];
  query: URLSearchParams;
}

export const parseRoute = (hash: string): Route => {
  const raw = hash.replace(/^#/, '') || '/';
  const [pathPart = '/', search = ''] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  return { path: `/${segments.join('/')}`, segments, query: new URLSearchParams(search) };
};

export const navigate = (path: string) => {
  window.location.hash = path;
};

export const useRoute = () => {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
};

export const NARROW_QUERY = '(max-width: 759px)';

const isNarrow = () =>
  typeof window.matchMedia === 'function'
    ? window.matchMedia(NARROW_QUERY).matches
    : window.innerWidth < 760;

export const useNarrow = () => {
  const [narrow, setNarrow] = useState(isNarrow);
  useEffect(() => {
    const update = () => setNarrow(isNarrow());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return narrow;
};

export const useEscape = (active: boolean, onEscape: () => void) => {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onEscape]);
};
