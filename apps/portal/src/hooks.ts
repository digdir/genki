import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { markPageLoad, onRefreshed } from './api/cache';

export type AsyncState<T> =
  { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; data: T };

export interface AsyncOptions {
  /** While this stays the same, a reload keeps the last data on screen and reports it as pending. */
  keepPreviousFor?: unknown;
}

const none = Symbol('none');

export const useAsync = <T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  { keepPreviousFor = none }: AsyncOptions = {},
) => {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [refreshed, setRefreshed] = useState(0);
  const silent = useRef(false);
  const shownFor = useRef<unknown>(none);
  useLayoutEffect(() => {
    const keep = keepPreviousFor !== none && shownFor.current === keepPreviousFor;
    shownFor.current = keepPreviousFor;
    const controller = new AbortController();
    const quiet = silent.current;
    markPageLoad(controller.signal, quiet);
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
      // An answer from the cache arrives before the next paint; flushing it then skips the spinner.
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
      // A remount right after (Suspense, StrictMode) joins the same request before it is aborted.
      setTimeout(() => controller.abort(), 0);
    };
  }, [...deps, keepPreviousFor, attempt, refreshed]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return [state, retry, pending] as const;
};

export interface Route {
  path: string;
  segments: string[];
  query: URLSearchParams;
}

const decoded = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

export const parseRoute = (hash: string): Route => {
  const raw = hash.replace(/^#/, '') || '/';
  const [pathPart = '/', search = ''] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean).map(decoded);
  return { path: `/${segments.join('/')}`, segments, query: new URLSearchParams(search) };
};

export const navigate = (path: string) => {
  window.location.hash = path;
};

const scrollPositions = new Map<number, number>();
let highestEntry = 0;
let restoring: number | undefined;
let traversal = false;

const entryIndex = () => {
  const state: unknown = window.history.state;
  return state && typeof state === 'object' && 'idx' in state && typeof state.idx === 'number'
    ? state.idx
    : undefined;
};

/** True when the last navigation went back or forward, so the page returns to where it was left. */
export const restoringScroll = () => traversal;

const restoreScroll = (top: number) => {
  let frames = 0;
  const stop = () => {
    restoring = undefined;
    window.removeEventListener('wheel', stop);
    window.removeEventListener('touchstart', stop);
    window.removeEventListener('keydown', stop);
  };
  const attempt = () => {
    if (restoring !== top) return;
    const room = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo?.(0, Math.min(top, Math.max(room, 0)));
    if (room >= top || ++frames > 60) stop();
    else requestAnimationFrame(attempt);
  };
  window.addEventListener('wheel', stop, { once: true });
  window.addEventListener('touchstart', stop, { once: true });
  window.addEventListener('keydown', stop, { once: true });
  attempt();
};

export const useRoute = () => {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    window.history.scrollRestoration = 'manual';
    let current = entryIndex() ?? 0;
    if (entryIndex() === undefined) window.history.replaceState({ idx: current }, '');
    highestEntry = Math.max(highestEntry, current);
    const update = () => {
      scrollPositions.set(current, window.scrollY);
      const idx = entryIndex();
      if (idx === undefined) {
        current = ++highestEntry;
        window.history.replaceState({ idx: current }, '');
        restoring = undefined;
        traversal = false;
      } else {
        current = idx;
        restoring = scrollPositions.get(idx) ?? 0;
        traversal = true;
      }
      setRoute(parseRoute(window.location.hash));
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useLayoutEffect(() => {
    if (restoring !== undefined) restoreScroll(restoring);
  }, [route]);
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
