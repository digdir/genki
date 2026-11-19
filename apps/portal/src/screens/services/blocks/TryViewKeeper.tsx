import type { AssistantLayout } from '@genai/ui-blocks/builder';
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ShapeSkeleton } from '../../../components/Skeleton';
import { useT } from '../../../i18n';
import { draftServiceOf, type RunProblem } from './draftService';
import type { ReportProblem, TryRun } from './TryView';

// The assistant and its blocks load with the first preview, not with the builder.
const TryView = lazy(() => import('./TryView'));

/** What the try view draws: the layout, on the draft. */
export interface TryShown {
  layout: AssistantLayout;
  run: TryRun;
}

interface Keeper {
  /** A ref for the element the try view is drawn in while it is on screen. */
  place: (element: HTMLElement | null) => (() => void) | undefined;
  /** What the try view draws now, or nothing. */
  show: (shown: TryShown | undefined) => void;
  /** «Start samtalen på nytt»: a new assistant on a new thread; answers on their way stop. */
  restart: () => void;
  /** Why the draft was refused, or why the answer of the thread on screen failed. */
  problem: RunProblem | undefined;
}

const Kept = createContext<Keeper | undefined>(undefined);

export const keptOutOfSightMs = 60_000;

/** Keeps the try view's assistant, answers and threads while the preview is drawn again. */
export const TryViewKeeper = ({ children }: { children: ReactNode }) => {
  const t = useT();
  const [shown, show] = useState<TryShown>();
  const [conversation, setConversation] = useState(0);
  // A refusal is the draft's, over every thread; a failed answer only over its own thread.
  const [refusal, setRefusal] = useState<RunProblem>();
  const [failures, setFailures] = useState<ReadonlyMap<string, RunProblem>>(() => new Map());
  const [thread, setThread] = useState<string>();
  // A changed draft is not the one refused; another service's draft has threads of its own.
  const draft = shown?.run.source?.definition;
  const service = draftServiceOf(shown?.run.source);
  const [problemsOf, setProblemsOf] = useState({ draft, service });
  if (draft !== problemsOf.draft) {
    setProblemsOf({ draft, service });
    setRefusal(undefined);
    if (service !== problemsOf.service) setFailures(new Map());
  }
  const report = useCallback<ReportProblem>((next, at) => {
    if (at === undefined) {
      setRefusal(next);
      return;
    }
    setFailures((all) => {
      if (!next && !all.has(at)) return all;
      const kept = new Map(all);
      if (next) kept.set(at, next);
      else kept.delete(at);
      return kept;
    });
  }, []);
  const problem = refusal ?? (thread === undefined ? undefined : failures.get(thread));
  // The assistant's own element, moved into the preview on screen.
  const [drawn] = useState(() => {
    const element = document.createElement('div');
    element.className = 'service-preview-try';
    return element;
  });
  // Where it waits while no preview is on screen: in the page, hidden.
  const away = useRef<HTMLDivElement>(null);
  const awayRef = useCallback(
    (element: HTMLDivElement | null) => {
      away.current = element;
      if (element && !drawn.parentNode) element.append(drawn);
    },
    [drawn],
  );
  // Out of sight for a while, the assistant goes; this visit's threads come back with it.
  const [parked, setParked] = useState(false);
  const parking = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(parking.current), []);
  // Where the reader had scrolled to, which an element taken out of the page loses.
  const scrolled = useRef<(readonly [Element, number])[]>([]);
  const place = useCallback(
    (element: HTMLElement | null) => {
      if (!element) return undefined;
      clearTimeout(parking.current);
      setParked(false);
      element.append(drawn);
      for (const [scroller, top] of scrolled.current) scroller.scrollTop = top;
      scrolled.current = [];
      return () => {
        if (drawn.parentNode !== element) return;
        scrolled.current = [...drawn.querySelectorAll('*')].flatMap((scroller) =>
          scroller.scrollTop > 0 ? [[scroller, scroller.scrollTop] as const] : [],
        );
        away.current?.append(drawn);
        parking.current = setTimeout(() => {
          scrolled.current = [];
          setParked(true);
        }, keptOutOfSightMs);
      };
    },
    [drawn],
  );
  const restart = useCallback(() => setConversation((n) => n + 1), []);
  const keeper = useMemo(() => ({ place, show, restart, problem }), [place, restart, problem]);
  return (
    <Kept.Provider value={keeper}>
      {children}
      <div hidden ref={awayRef} />
      {shown && !parked
        ? createPortal(
            <Suspense
              fallback={
                <div role="status" aria-label={t('builderBlocks.tryLoading')} aria-busy="true">
                  <ShapeSkeleton shape="list" rows={3} />
                </div>
              }
            >
              <TryView
                key={`${draftServiceOf(shown.run.source)}:${conversation}`}
                layout={shown.layout}
                run={shown.run}
                onProblem={report}
                onThreadChange={setThread}
              />
            </Suspense>,
            drawn,
          )
        : null}
    </Kept.Provider>
  );
};

/** The try view kept above, or one kept here for as long as this part of the page stays. */
export const KeepTryView = ({ children }: { children: ReactNode }) =>
  useContext(Kept) ? children : <TryViewKeeper>{children}</TryViewKeeper>;

export const useKeptTryView = () => {
  const keeper = useContext(Kept);
  if (!keeper) throw new Error('useKeptTryView is used outside a TryViewKeeper');
  return keeper;
};
