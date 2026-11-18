import { ExpandIcon, ShrinkIcon } from '@navikt/aksel-icons';
import { createContext, useContext } from 'react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { DocsSiteRoot, useScheme } from './Root';

/** Status for rammen rundt en figur, så figuren selv kan ta over piltastene i fullskjerm. */
export const FigureContext = createContext<{
  isFull: boolean;
  keyboardNav: boolean;
}>({ isFull: false, keyboardNav: false });
export const useFigure = () => useContext(FigureContext);

/**
 * Ramme rundt en figur med knapp for fullskjerm. Bruker nettleserens fullskjerm-API på selve rammen,
 * så det er nøyaktig samme figur med samme lenker som vises stort. Uten støtte faller den tilbake til
 * et lag som dekker hele vinduet. Knappen vises bare på enheter med mus og bred skjerm (CSS).
 */
/** `fit`: rammen krymper til tegningen (brukes når figuren er smalere enn spalten), så knappen ligger i figurens hjørne. */
export function Figure({
  children,
  label,
  className,
  hint,
  fit = false,
  onFullChange,
  keyboardNav,
}: {
  /** Innhold, eller en funksjon som får vite om figuren vises i fullskjerm, for å vise mer der. */
  children: ReactNode | ((isFull: boolean) => ReactNode);
  label: string;
  className?: string;
  hint?: string;
  fit?: boolean;
  onFullChange?: (isFull: boolean) => void;
  /**
   * Piltaster i fullskjerm. "focus": rammen flytter fokus mellom boksene (Enter åpner).
   * "figure": figuren eier markeringen selv og lytter på tastene; rammen gjør ingenting.
   */
  keyboardNav?: 'focus' | 'figure';
}) {
  const t = useT();
  const scheme = useScheme();
  const ref = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [fallback, setFallback] = useState(false);
  const supported =
    typeof document !== 'undefined' &&
    typeof document.documentElement.requestFullscreen === 'function';

  const opener = useRef<HTMLElement | null>(null);
  const scrollAtOpen = useRef(0);

  const restoreScroll = useRef(false);
  useEffect(() => {
    if (full || !restoreScroll.current) return;
    restoreScroll.current = false;
    const y = scrollAtOpen.current;
    const timer = window.setTimeout(() => window.scrollTo?.(0, y), 50);
    return () => window.clearTimeout(timer);
  }, [full]);

  useEffect(() => {
    const onChange = () => {
      const isOpen = document.fullscreenElement === ref.current;
      if (!isOpen && !document.fullscreenElement) restoreScroll.current = true;
      setFull(isOpen);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const open = useCallback(() => {
    opener.current = document.activeElement as HTMLElement | null;
    scrollAtOpen.current = window.scrollY;
    if (supported && ref.current) {
      // Noen innebygde nettlesere lar forespørselen henge uten svar. Da bruker vi overlegget i stedet.
      const timer = window.setTimeout(() => {
        if (!document.fullscreenElement) setFallback(true);
      }, 700);
      ref.current.requestFullscreen().then(
        () => window.clearTimeout(timer),
        () => {
          window.clearTimeout(timer);
          setFallback(true);
        },
      );
    } else {
      setFallback(true);
    }
  }, [supported]);

  const close = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    setFallback(false);
  }, []);

  // Fallback-laget lukkes med Esc; ekte fullskjerm håndterer Esc selv.
  useEffect(() => {
    if (!fallback) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setFallback(false);
      if (e.key !== 'Tab' || !ref.current) return;
      const focusable = Array.from(
        ref.current.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]'),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const inside = ref.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const trigger = opener.current;
    if (!ref.current?.contains(document.activeElement))
      ref.current?.querySelector<HTMLElement>('.figure-btn')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      const back =
        trigger?.isConnected && trigger !== document.body
          ? trigger
          : ref.current?.querySelector<HTMLElement>('.figure-btn');
      back?.focus();
    };
  }, [fallback]);

  const isFull = full || fallback;
  useEffect(() => {
    onFullChange?.(isFull);
  }, [isFull, onFullChange]);

  // Piltastnavigasjon i fullskjerm: flytt fokus mellom de klikkbare boksene, i figurens rekkefølge.
  useEffect(() => {
    if (keyboardNav !== 'focus' || !isFull) return;
    // Rekkefølge: data-nav når figuren setter den, ellers DOM-rekkefølgen.
    const targets = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>('[role="button"], [role="link"]') ?? [],
      ).sort((a, b) => Number(a.dataset.nav ?? 0) - Number(b.dataset.nav ?? 0));
    const first = targets()[0];
    first?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
      if (!keys.includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.defaultPrevented) return; // figuren håndterte tasten selv
      const list = targets();
      if (list.length === 0) return;
      e.preventDefault();
      const cur = list.indexOf(document.activeElement as HTMLElement);
      const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? list.length - 1
            : forward
              ? cur < 0
                ? 0
                : (cur + 1) % list.length
              : cur < 0
                ? list.length - 1
                : (cur - 1 + list.length) % list.length;
      list[next].focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [keyboardNav, isFull]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === 'f' || e.key === 'F') && !isFull && e.target === e.currentTarget) {
      e.preventDefault();
      open();
    }
  };

  const node = (
    <div
      ref={ref}
      className={`figure${className ? ` ${className}` : ''}${fit ? ' figure-fit' : ''}${fallback ? ' is-full' : ''}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label={label}
      {...(fallback ? { role: 'dialog', 'aria-modal': true } : { role: 'group' })}
    >
      <FigureContext.Provider value={{ isFull, keyboardNav: keyboardNav === 'figure' }}>
        {typeof children === 'function' ? children(isFull) : children}
      </FigureContext.Provider>
      <button
        type="button"
        className="figure-btn"
        onClick={isFull ? close : open}
        aria-label={isFull ? t('docsFigure.close') : t('docsFigure.open')}
        title={isFull ? t('docsFigure.closeTitle') : t('docsFigure.openTitle')}
      >
        {isFull ? <ShrinkIcon aria-hidden /> : <ExpandIcon aria-hidden />}
      </button>
      {isFull && hint !== '' && (
        <p className="figure-hint" aria-hidden>
          {hint ?? t('docsFigure.hintDefault')}
        </p>
      )}
    </div>
  );

  // Fallback-laget legges rett på body, så transformasjoner på siden ikke forskyver det.
  return fallback
    ? createPortal(<DocsSiteRoot scheme={scheme}>{node}</DocsSiteRoot>, document.body)
    : node;
}
