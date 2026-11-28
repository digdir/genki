import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react';
import { flushSync } from 'react-dom';
import { markPageLoad, onRefreshed } from './response-cache';

export type AsyncState<T> =
  { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; data: T };

export const useAsync = <T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]) => {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [refreshed, setRefreshed] = useState(0);
  const silent = useRef(false);
  const retried = useRef(false);
  const shown = useRef(state);
  useLayoutEffect(() => {
    shown.current = state;
  });
  useLayoutEffect(() => {
    const again = retried.current;
    retried.current = false;
    const keep = again && shown.current.status === 'ready';
    const controller = new AbortController();
    const quiet = silent.current;
    if (!again) markPageLoad(controller.signal, quiet);
    silent.current = false;
    let active = true;
    let sameTask = true;
    const timer = setTimeout(() => {
      sameTask = false;
      if (!active || quiet) return;
      if (keep) setPending(true);
      else setState((s) => (s.status === 'loading' ? s : { status: 'loading' }));
    }, 0);
    const settle = (next: AsyncState<T>) => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      const apply = () => {
        setState(next);
        setPending(false);
      };
      if (sameTask) flushSync(apply);
      else apply();
    };
    load(controller.signal).then(
      (data) => settle({ status: 'ready', data }),
      (error: unknown) => settle({ status: 'error', error }),
    );
    const stop = onRefreshed(controller.signal, () => {
      silent.current = true;
      setRefreshed((n) => n + 1);
    });
    return () => {
      active = false;
      clearTimeout(timer);
      stop();
      setTimeout(() => controller.abort(), 0);
    };
  }, [...deps, attempt, refreshed]);
  const retry = useCallback(() => {
    retried.current = true;
    setAttempt((n) => n + 1);
  }, []);
  return [state, retry, pending] as const;
};

const readHash = () => window.location.hash.replace(/^#/, '') || '/';

export const useHashRoute = () => useNavigation()[0];

export const useNavigation = () => {
  const [path, setPath] = useState(readHash);
  const [pending, startNavigation] = useTransition();
  useEffect(() => {
    const update = () => {
      const next = readHash();
      startNavigation(() => setPath(next));
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return [path, pending] as const;
};

export const useDelayed = (active: boolean, delayMs: number) => {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && shown;
};

export const splitRoute = (hash: string) => {
  const [path = '/', query = ''] = hash.split('?');
  return { path, params: new URLSearchParams(query) };
};

export const navigate = (path: string, params?: Record<string, string>) => {
  const query = params ? new URLSearchParams(params).toString() : '';
  window.location.hash = query ? `${path}?${query}` : path;
};

export const Forward = ({ to, params }: { to: string; params?: Record<string, string> }) => {
  useEffect(() => navigate(to, params), [to, params]);
  return null;
};
