import type { ContentRoute } from '@genai/docs-content';
import { useEffect, useLayoutEffect, useState } from 'react';

export type Route = ContentRoute;
type Page = Route['page'];
type Path = Exclude<Page, 'oversikt' | 'ikke-funnet'>;

export interface Routing {
  prefix: string;
  segments: Record<Path, string>;
  query: { part: string; step: string; use: string; setup: string };
  liveModels: boolean;
  siteName: string;
}

const routing: Routing = {
  prefix: '#',
  segments: {
    malbilde: 'malbilde',
    byggeklosser: 'byggeklosser',
    tjenester: 'tjenester',
    sok: 'sok',
    typer: 'typer',
    status: 'status',
    'kom-i-gang': 'kom-i-gang',
  },
  query: { part: 'del', step: 'steg', use: 'bruk', setup: 'oppsett' },
  liveModels: true,
  siteName: 'Genki',
};

export const configureRouting = (next: Partial<Routing>) => {
  Object.assign(routing, next);
};

export const routingOptions = (): Readonly<Routing> => routing;

const pageFor = (segment: string | undefined): Page | undefined =>
  (Object.keys(routing.segments) as Path[]).find((page) => routing.segments[page] === segment);

const decoded = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export function parseHash(hash: string): Route {
  const prefix = routing.prefix.replace(/\/$/, '');
  if (!hash.startsWith(prefix) || (hash.length > prefix.length && hash[prefix.length] !== '/'))
    return { page: 'oversikt' };
  const [pathPart = '', query = ''] = hash.slice(prefix.length).replace(/^\/?/, '').split('?');
  const params = new URLSearchParams(query);
  const [head, id, sub] = pathPart.replace(/\/$/, '').split('/');
  if (head === 'flyt' && routing.segments.tjenester === 'tjenester')
    return { page: 'tjenester', id: 'kunnskapsassistenten' };
  switch (pageFor(head)) {
    case 'byggeklosser':
      return { page: 'byggeklosser', id: id || undefined, sub: sub || undefined };
    case 'tjenester': {
      const part = params.get(routing.query.part);
      const step = Number(params.get(routing.query.step));
      return {
        page: 'tjenester',
        id: id || undefined,
        del:
          part === routing.query.setup
            ? 'oppsett'
            : part === routing.query.use
              ? 'bruk'
              : undefined,
        steg: Number.isFinite(step) && step > 0 ? step : undefined,
      };
    }
    case 'sok':
      return { page: 'sok', q: params.get('q') || undefined };
    case 'typer':
      return { page: 'typer', id: id || undefined };
    case 'status':
      return { page: 'status', id: id ? decoded(id) : undefined };
    case 'malbilde':
      return { page: 'malbilde' };
    case 'kom-i-gang':
      return { page: 'kom-i-gang' };
    default:
      return head ? { page: 'ikke-funnet' } : { page: 'oversikt' };
  }
}

export function href(route: Route): string {
  const base = routing.prefix.replace(/\/$/, '');
  const at = (page: Path, ...rest: (string | undefined)[]) =>
    [`${base}/${routing.segments[page]}`, ...rest.filter(Boolean)].join('/');
  switch (route.page) {
    case 'oversikt':
    case 'ikke-funnet':
      return base === '#' ? '#/' : base;
    case 'byggeklosser':
      return at('byggeklosser', route.id, route.id ? route.sub : undefined);
    case 'typer':
      return at('typer', route.id);
    case 'status':
      return at('status', route.id ? encodeURIComponent(route.id) : undefined);
    case 'tjenester': {
      if (!route.id) return at('tjenester');
      const qs = new URLSearchParams();
      if (route.del)
        qs.set(
          routing.query.part,
          route.del === 'oppsett' ? routing.query.setup : routing.query.use,
        );
      if (route.steg) qs.set(routing.query.step, String(route.steg));
      const q = qs.toString();
      return `${at('tjenester', route.id)}${q ? `?${q}` : ''}`;
    }
    case 'sok':
      return route.q ? `${at('sok')}?q=${encodeURIComponent(route.q)}` : at('sok');
    default:
      return at(route.page);
  }
}

export function navigate(route: Route) {
  const go = () => {
    window.location.hash = href(route);
  };
  if (document.fullscreenElement) {
    document.exitFullscreen().then(go, go);
  } else {
    go();
  }
}

// Back and forward restore the saved scroll position; a new navigation scrolls to the top.
const scrollPositions = new Map<number, number>();
let highestEntry = 0;
let pendingScroll: number | null = null;

function entryIndex(): number | undefined {
  const state: unknown = window.history.state;
  if (
    typeof state === 'object' &&
    state !== null &&
    'idx' in state &&
    typeof state.idx === 'number'
  ) {
    return state.idx;
  }
  return undefined;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    window.history.scrollRestoration = 'manual';
    const initial = entryIndex();
    let current: number = initial ?? 0;
    if (initial === undefined) window.history.replaceState({ idx: current }, '');
    highestEntry = Math.max(highestEntry, current);
    const onChange = () => {
      scrollPositions.set(current, window.scrollY);
      const idx = entryIndex();
      if (idx === undefined) {
        current = ++highestEntry;
        window.history.replaceState({ idx: current }, '');
        pendingScroll = 0;
      } else {
        current = idx;
        pendingScroll = scrollPositions.get(idx) ?? 0;
      }
      setRoute(parseHash(window.location.hash));
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  useLayoutEffect(() => {
    if (pendingScroll === null) return;
    window.scrollTo({ top: pendingScroll });
    pendingScroll = null;
  }, [route]);
  return route;
}
