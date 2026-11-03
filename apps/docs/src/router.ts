import { useEffect, useState } from 'react';

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

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
