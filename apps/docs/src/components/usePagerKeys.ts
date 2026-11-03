import { useEffect } from 'react';
import { navigate, type Route } from '../router';

/**
 * Piltast venstre/høyre går til forrige/neste side, så man slipper å rulle ned til knappene.
 * Gjør ingenting mens en figur er i fullskjerm (figuren bruker tastene selv), i skjemafelt,
 * eller når noen annen allerede har håndtert tasten.
 */
export function usePagerKeys(prev: Route, next: Route) {
  const prevKey = JSON.stringify(prev);
  const nextKey = JSON.stringify(next);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (document.fullscreenElement || document.querySelector('.figure.is-full')) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      )
        return;
      e.preventDefault();
      navigate(
        e.key === 'ArrowLeft' ? (JSON.parse(prevKey) as Route) : (JSON.parse(nextKey) as Route),
      );
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [prevKey, nextKey]);
}
