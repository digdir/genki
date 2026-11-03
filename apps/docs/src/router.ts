import { useEffect, useLayoutEffect, useState } from 'react';

export type Route =
  | { page: 'oversikt' }
  | { page: 'malbilde' }
  | { page: 'byggeklosser'; id?: string; sub?: string }
  | { page: 'tjenester'; id?: string; del?: 'bruk' | 'oppsett'; steg?: number }
  | { page: 'sok'; q?: string }
  | { page: 'typer'; id?: string }
  | { page: 'status'; id?: string }
  | { page: 'kom-i-gang' };

export function parseHash(hash: string): Route {
  const [pathPart, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  const path = pathPart.replace(/\/$/, '');
  const [head, id, sub] = path.split('/');
  switch (head) {
    case 'byggeklosser':
      return { page: 'byggeklosser', id: id || undefined, sub: sub || undefined };
    case 'tjenester': {
      const del = params.get('del');
      const steg = Number(params.get('steg'));
      return {
        page: 'tjenester',
        id: id || undefined,
        del: del === 'oppsett' ? 'oppsett' : del === 'bruk' ? 'bruk' : undefined,
        steg: Number.isFinite(steg) && steg > 0 ? steg : undefined,
      };
    }
    case 'sok':
      return { page: 'sok', q: params.get('q') || undefined };
    case 'flyt':
      return { page: 'tjenester', id: 'kunnskapsassistenten' };
    case 'typer':
      return { page: 'typer', id: id || undefined };
    case 'status':
      return { page: 'status', id: id ? decodeURIComponent(id) : undefined };
    case 'malbilde':
      return { page: 'malbilde' };
    case 'kom-i-gang':
      return { page: 'kom-i-gang' };
    default:
      return { page: 'oversikt' };
  }
}

export function href(route: Route): string {
  switch (route.page) {
    case 'oversikt':
      return '#/';
    case 'byggeklosser':
      if (!route.id) return '#/byggeklosser';
      return route.sub ? `#/byggeklosser/${route.id}/${route.sub}` : `#/byggeklosser/${route.id}`;
    case 'typer':
      return route.id ? `#/typer/${route.id}` : '#/typer';
    case 'status':
      return route.id ? `#/status/${encodeURIComponent(route.id)}` : '#/status';
    case 'tjenester': {
      if (!route.id) return '#/tjenester';
      const qs = new URLSearchParams();
      if (route.del) qs.set('del', route.del);
      if (route.steg) qs.set('steg', String(route.steg));
      const q = qs.toString();
      return `#/tjenester/${route.id}${q ? `?${q}` : ''}`;
    }
    case 'sok':
      return route.q ? `#/sok?q=${encodeURIComponent(route.q)}` : '#/sok';
    default:
      return `#/${route.page}`;
  }
}

export function navigate(route: Route) {
  const go = () => {
    window.location.hash = href(route);
  };
  // Lukk fullskjerm først, ellers bytter siden under fullskjermen med et hopp.
  if (document.fullscreenElement) {
    document.exitFullscreen().then(go, go);
  } else {
    go();
  }
}

// Hver historikkoppføring får et løpenummer i history.state, så vi kan skille en ny navigasjon
// (ingen nummer ennå: scroll til toppen) fra tilbake og fram (nummeret finnes: gjenopprett
// scrollposisjonen vi lagret da brukeren forlot siden). Nettleseren klarer ikke dette selv,
// fordi forsiden rendres på nytt etter at den har prøvd å gjenopprette posisjonen.
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
