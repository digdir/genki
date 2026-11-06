import { Alert, Button, Divider, Heading, Paragraph } from '@digdir/designsystemet-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n.js';
import { AnnounceContext, freshText } from './announce.js';
import { FacetField, type FieldHandle } from './FacetField.js';
import {
  ActiveFilter,
  FieldPlaceholder,
  LockedFilter,
  NewThreadLink,
  type NewThreadLinkProps,
} from './FilterStates.js';
import { chosenValues, sameSelection, valuesWithoutField } from './selection.js';
import type { FilterField, FilterSelection } from './types.js';
import { YearRangeField } from './YearRangeField.js';

export type * from './types.js';
export { isEmptySelection, narrowing } from './selection.js';

export interface FilterProps {
  /** The dataset's filter fields with their facet values, in the order to draw them. Undefined
   * while they load. An empty list says filtering is not available. */
  fields?: readonly FilterField[] | undefined;
  /** What the reader chose. The fields show it, and a value no field shows is listed so it can
   * be removed. */
  selection: FilterSelection;
  /** Called only when the selection changes. Ask with `narrowing(selection, fields)`. */
  onChange: (selection: FilterSelection) => void;
  /** The fields could not be fetched. */
  failed?: boolean | undefined;
  /** «Prøv igjen» with the error. */
  onRetry?: (() => void) | undefined;
  /** The thread on screen is locked to this filter, so the fields are not drawn. */
  locked?: FilterSelection | undefined;
  /** The id of the thread on screen, undefined for a new one. A change in a thread that is not
   * locked shows a note, since the thread keeps no filter of its own. */
  thread?: string | undefined;
  /**
   * A plain click on «Ny tråd», in the lock and in the note; a click for a new tab is the
   * browser's. Without it neither link is drawn.
   */
  onNewThread?: ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
  /** Where «Ny tråd» leads in a new tab. A plain click calls `onNewThread` instead. */
  newThreadHref?: string | undefined;
  /** A field of kind `year` takes periods, and years in a row show as one chip. */
  yearPeriods?: boolean | undefined;
  /** One chip for a field with all, or six or more, values chosen. */
  compactChips?: boolean | undefined;
  /** The most values a field can send; more shows a warning. */
  maxValues?: number | undefined;
  /** The heading, «Filtrering» by default. `false` leaves it to the host. */
  title?: ReactNode | false | undefined;
  headingLevel?: 2 | 3 | 4 | 5 | undefined;
  /** Over the fields, under the heading, such as `CorpusChoice`. It shares the live region. */
  head?: ReactNode;
  /**
   * Where the heading and `head` are drawn instead, such as the shell's pinned region (its panel's
   * `pinnedRef`), so they stay in sight while the fields scroll, as kunnskapsassistenten pins
   * them. They keep the filter's live region. `null` while that element is not there yet draws
   * no head; undefined draws it over the fields.
   */
  pinIn?: Element | null | undefined;
  /**
   * Before the fields, over a line, such as `Documents`: the documents behind the answer, in sight
   * without scrolling past the fields. kunnskapsassistenten keeps its documents list apart from
   * the reader's own «so the view can show them above the facets, in sight».
   */
  documents?: ReactNode;
  /** Under a line after the fields, such as the reader's own documents. */
  children?: ReactNode;
  /** Designsystemet's `data-color` for the block, set only when given. */
  color?: string | undefined;
  className?: string | undefined;
}

/** An error the reader needs to see. Always rendered: `role="alert"` only announces content
 * added to a region that already exists. The region also catches focus when a retry clears the
 * error, so focus does not fall to `<body>`. */
const ErrorRegion = ({
  message,
  onRetry,
  retryRef,
}: {
  message: string | undefined;
  onRetry: (() => void) | undefined;
  retryRef: RefObject<HTMLButtonElement | null>;
}) => {
  const t = useT();
  const region = useRef<HTMLDivElement>(null);
  // True only between a retry click that held focus and the error clearing.
  const retryHeldFocus = useRef(false);

  useEffect(() => {
    if (message || !retryHeldFocus.current) return;
    retryHeldFocus.current = false;
    if (document.activeElement !== document.body && document.activeElement !== null) return;
    region.current?.focus();
  }, [message]);

  return (
    <div role="alert" className="uib-filter-error ds-focus" tabIndex={-1} ref={region}>
      {message ? (
        <Alert data-color="danger">
          <Paragraph variant="long">{message}</Paragraph>
          {onRetry ? (
            <Button
              variant="secondary"
              data-size="sm"
              ref={retryRef}
              onClick={() => {
                // Read before the state change unmounts the button. Safari does not focus a
                // button on click, so this is false there and focus is left alone.
                retryHeldFocus.current = region.current?.contains(document.activeElement) ?? false;
                onRetry();
              }}
            >
              {t('filter.retry')}
            </Button>
          ) : null}
        </Alert>
      ) : null}
    </div>
  );
};

/** The document filter: a field per facet of the dataset, what is in force where no field can
 * show it, a thread's lock, and a note when the filter changes in a thread under way. Data in,
 * events out: the host fetches the facets and keeps the selection. */
export const Filter = ({
  fields,
  selection,
  onChange,
  failed = false,
  onRetry,
  locked,
  thread,
  onNewThread,
  newThreadHref,
  yearPeriods = false,
  compactChips = false,
  maxValues = 100,
  title,
  headingLevel = 2,
  head,
  pinIn,
  documents,
  children,
  color,
  className,
}: FilterProps) => {
  const t = useT();
  const sub = Math.min(headingLevel + 1, 6) as 3 | 4 | 5 | 6;
  const [announcement, setAnnouncement] = useState('');
  const announce = useCallback(
    (text: string) => setAnnouncement((previous) => freshText(previous, text)),
    [],
  );

  // The note shows while an unlocked thread's filter differs from what it was when the thread
  // came on screen. Adjusted during render, so it is never drawn against the previous thread.
  const [baseline, setBaseline] = useState({ thread, selection });
  if (baseline.thread !== thread) setBaseline({ thread, selection });
  const inUnlockedThread = thread !== undefined && !locked;
  const changedInThread = inUnlockedThread && !sameSelection(selection, baseline.selection);
  const newThread: NewThreadLinkProps | undefined = onNewThread
    ? {
        href: newThreadHref,
        onNewThread: (event) => {
          // The note was about the thread that is now gone.
          setAnnouncement('');
          onNewThread(event);
        },
      }
    : undefined;

  /** Every change the reader makes, so the note is announced as it appears. `said` is a field's
   * own account of the change, told first. */
  const change = (next: FilterSelection, said?: string) => {
    const note =
      inUnlockedThread && !changedInThread && !sameSelection(next, baseline.selection)
        ? t('filter.changedInThread')
        : undefined;
    const text = [said, note].filter(Boolean).join(' ');
    if (text) announce(text);
    // A field may only tell, as of a period already chosen.
    if (!sameSelection(next, selection)) onChange(next);
  };

  const loading = !failed && fields === undefined;
  // None while loading: chips drawn for one request would flicker. A failed refetch keeps the
  // old fields, and they still show their values.
  const withoutField = loading ? [] : valuesWithoutField(selection, fields);

  const retryRef = useRef<HTMLButtonElement>(null);
  const unavailableRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<FieldHandle>(null);
  /** Set by ActiveFilter when it went away holding focus; read below. */
  const activeFilterLostFocus = useRef(false);
  const onActiveFilterLostFocus = useCallback(() => {
    activeFilterLostFocus.current = true;
  }, []);

  // After the active filter went away holding focus: «Prøv igjen», else the first field, else the
  // region. Not always the region: empty, it is 0 × 0 and hides the focus ring (WCAG 2.4.7). A
  // layout effect, so the new refs are set before paint.
  useLayoutEffect(() => {
    if (!activeFilterLostFocus.current) return;
    activeFilterLostFocus.current = false;
    (retryRef.current ?? firstFieldRef.current ?? unavailableRef.current)?.focus();
  });

  // The announcement goes with a retry: when «Henter filtre» gives way, the region would read
  // the old announcement a second time.
  const retry = onRetry
    ? () => {
        setAnnouncement('');
        onRetry();
      }
    : undefined;

  const headNode =
    title === false && !head ? null : (
      <div className="uib-filter-head" data-color={color}>
        {title === false ? null : (
          <Heading level={headingLevel} data-size="sm">
            {title ?? t('filter.title')}
          </Heading>
        )}
        {head}
      </div>
    );

  return (
    <AnnounceContext value={announce}>
      <div
        className={['uib-filter', className].filter(Boolean).join(' ')}
        data-color={color}
        aria-busy={loading || undefined}
      >
        {headNode === null
          ? null
          : pinIn === undefined
            ? headNode
            : pinIn && createPortal(headNode, pinIn)}

        {documents ? (
          <>
            {/* Above is about documents; below narrows the search. */}
            <div className="uib-filter-above">{documents}</div>
            <Divider className="uib-filter-divider" />
          </>
        ) : null}

        {/* While locked, the fields are not drawn, so a failure to fetch them can wait. */}
        <ErrorRegion
          message={failed && !locked ? t('filter.failed') : undefined}
          onRetry={retry}
          retryRef={retryRef}
        />

        {/* Always rendered: a live region only announces changes inside a region that already
            exists. The skeleton is aria-hidden, so this carries «Henter filtre». */}
        <output className="ds-sr-only">{loading ? t('filter.loading') : announcement}</output>

        {locked && (
          <LockedFilter values={chosenValues(locked, fields)} level={sub} newThread={newThread} />
        )}

        {/* Info, not an error. Not a live region: `change` announces it once, not per render. */}
        {changedInThread && (
          <Alert data-color="info" data-size="sm" className="uib-filter-changed">
            <Paragraph data-size="sm" variant="long">
              {t('filter.changedInThread')}
              {newThread ? ` ${t('filter.changedInThreadAsk')}` : ''}
            </Paragraph>
            {newThread ? <NewThreadLink {...newThread} /> : null}
          </Alert>
        )}

        {/* One per field the facets usually bring, so nothing below moves. */}
        {loading && !locked && ['a', 'b', 'c'].map((key) => <FieldPlaceholder key={key} />)}

        {/* Without fields a stored filter still narrows every question, so it is shown here.
            Always rendered and focusable: focus lands here when the last chip goes. */}
        <div ref={unavailableRef} tabIndex={-1} className="uib-filter-unavailable ds-focus">
          {/* A normal state, not an error. No hint while a filter is in force: «uten å avgrense»
              would not be true. */}
          {!locked && fields?.length === 0 && (
            <div className="uib-filter-empty">
              <Heading level={sub} data-size="2xs">
                {t('filter.unavailable')}
              </Heading>
              {withoutField.length === 0 ? (
                <Paragraph data-size="sm" variant="long">
                  {t('filter.unavailableHint')}
                </Paragraph>
              ) : null}
            </div>
          )}

          {!locked && withoutField.length > 0 && (
            <ActiveFilter
              selection={selection}
              chosen={withoutField}
              hasFields={(fields?.length ?? 0) > 0}
              level={sub}
              onChange={change}
              onFocusLost={onActiveFilterLostFocus}
              onAnnounce={announce}
            />
          )}
        </div>

        {!locked &&
          fields?.map((field, index) => {
            const Field = field.kind === 'year' && yearPeriods ? YearRangeField : FacetField;
            return (
              <Field
                key={field.id}
                ref={index === 0 ? firstFieldRef : undefined}
                field={field}
                selected={selection[field.id] ?? []}
                compact={compactChips}
                max={maxValues}
                onChange={(values, said) => change({ ...selection, [field.id]: values }, said)}
              />
            );
          })}

        {children ? (
          <>
            {/* Above narrows the search; below is about documents. */}
            <Divider className="uib-filter-divider" />
            <div className="uib-filter-below">{children}</div>
          </>
        ) : null}
      </div>
    </AnnounceContext>
  );
};
