import {
  Button,
  Chip,
  Heading,
  Input,
  Label,
  Link,
  Paragraph,
  Skeleton,
  Tag,
} from '@digdir/designsystemet-react';
import { useEffect, useId, useLayoutEffect, useRef, type MouseEvent } from 'react';
import { plainClick } from '../dom.js';
import { useT } from '../i18n.js';
import type { FilterSelection } from './types.js';

/** One chosen value, and the field it narrows. */
export interface ChosenValue {
  field: string;
  value: string;
  /** The option's label, when a field still lists it. */
  label?: string | undefined;
}

type Level = 3 | 4 | 5 | 6;

/** One key per chip. The same value could sit in two fields. */
const keyOf = ({ field, value }: ChosenValue) => `${field}\u0000${value}`;

export interface ActiveFilterProps {
  selection: FilterSelection;
  /** The values to show: those no field can. Never empty. */
  chosen: readonly ChosenValue[];
  /** Whether fields are drawn below. Then these values belong to a field the facets came
   * without, and waiting will not bring a field for them. */
  hasFields: boolean;
  level: Level;
  onChange: (selection: FilterSelection) => void;
  /** Called when the block goes with focus inside it (last value removed, «Tøm», or facets
   * arriving); the filter moves focus to what replaced it. Must keep its identity between
   * renders, or a new one is taken for an unmount. */
  onFocusLost: () => void;
  /** Tells the reader, through the filter's live region, what was removed. */
  onAnnounce: (text: string) => void;
}

/** The filter in force where no field shows it: the facets failed or lack this field. It still
 * narrows every question, so it must show and be removable. */
export const ActiveFilter = ({
  selection,
  chosen,
  hasFields,
  level,
  onChange,
  onFocusLost,
  onAnnounce,
}: ActiveFilterProps) => {
  const t = useT();
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement | null>());
  // The chip to focus after a removal; read in an effect, once React has drawn the selection
  // without the removed one.
  const focusAfterRemove = useRef<string | undefined>(undefined);

  // A pressed chip removes itself; focus goes to the next, else the previous, not to `<body>`
  // (WCAG 2.4.3). With none left, the cleanup below takes over.
  useEffect(() => {
    const target = focusAfterRemove.current;
    if (target === undefined) return;
    focusAfterRemove.current = undefined;
    chipRefs.current.get(target)?.focus();
  }, [selection]);

  // A reader on a chip would land on `<body>` however the block goes. A layout effect: its
  // cleanup runs while the chips are still in the document, the only moment `contains` can tell;
  // the filter moves focus in the same commit.
  useLayoutEffect(() => {
    const section = sectionRef.current;
    return () => {
      if (section?.contains(document.activeElement)) onFocusLost();
    };
  }, [onFocusLost]);

  const remove = (removed: ChosenValue) => {
    const index = chosen.findIndex((candidate) => keyOf(candidate) === keyOf(removed));
    const next = chosen[index + 1] ?? chosen[index - 1];
    focusAfterRemove.current = next ? keyOf(next) : undefined;
    chipRefs.current.delete(keyOf(removed));

    onAnnounce(t('filter.removedValue', { value: removed.label ?? removed.value }));
    onChange({
      ...selection,
      [removed.field]: (selection[removed.field] ?? []).filter((value) => value !== removed.value),
    });
  };

  // Only what is shown here: a field the reader can see keeps its values.
  const clear = () => {
    const next: Record<string, readonly string[]> = { ...selection };
    for (const { field } of chosen) next[field] = [];
    onAnnounce(t('filter.clearedLimit'));
    onChange(next);
  };

  return (
    <section ref={sectionRef} className="uib-filter-active" aria-labelledby={headingId}>
      {/* «Tøm» as on every field: a filter saved with «Velg alle» can hold every value, too many
          to remove chip by chip. */}
      <div className="uib-filter-active-head">
        <Heading level={level} data-size="2xs" id={headingId}>
          {t('filter.limitedTo')}
        </Heading>
        <Button
          variant="tertiary"
          // Pinned to neutral, as kunnskapsassistenten draws it: quiet beside the heading.
          data-color="neutral"
          data-size="sm"
          aria-label={t('filter.clearLimit')}
          onClick={clear}
        >
          {t('filter.clear')}
        </Button>
      </div>

      {/* Without facets the fields may come back; with fields on screen, this field is not among
          them, and waiting will not change that. */}
      <Paragraph data-size="sm" variant="long">
        {hasFields ? t('filter.noField') : t('filter.noFields')}
      </Paragraph>

      <div className="uib-filter-active-chips">
        {chosen.map((item) => (
          // `data-wrap`: the name is the information, so no ellipsis. The label says what
          // pressing does: the cross has no text.
          <Chip.Removable
            key={keyOf(item)}
            ref={(chip) => {
              chipRefs.current.set(keyOf(item), chip);
            }}
            data-wrap="wrap"
            aria-label={t('filter.removeValue', { value: item.label ?? item.value })}
            onClick={() => remove(item)}
          >
            {item.label ?? item.value}
          </Chip.Removable>
        ))}
      </div>
    </section>
  );
};

export interface NewThreadLinkProps {
  /** Where the link leads in a new tab. A plain click calls `onNewThread` instead. */
  href?: string | undefined;
  onNewThread: (event: MouseEvent<HTMLAnchorElement>) => void;
}

/** «Ny tråd»: a link, as starting over is a place to go. */
export const NewThreadLink = ({ href, onNewThread }: NewThreadLinkProps) => {
  const t = useT();
  return (
    <Link
      data-size="sm"
      href={href ?? '#'}
      onClick={(event) => {
        // A click for a new tab or window is the browser's, as in the thread list. A plain click is
        // the host's, which starts over in this tab.
        if (!plainClick(event)) return;
        event.preventDefault();
        onNewThread(event);
      }}
    >
      {t('filter.newThread')}
    </Link>
  );
};

export interface LockedFilterProps {
  /** The values the thread on screen is locked to. */
  values: readonly ChosenValue[];
  level: Level;
  newThread?: NewThreadLinkProps | undefined;
}

/** The filter while the thread is locked. Every question is asked with the lock, so fields would
 * change nothing. `Tag`, not `Chip`: these cannot be removed; in a list, so a screen reader says
 * how many. */
export const LockedFilter = ({ values, level, newThread }: LockedFilterProps) => {
  const t = useT();
  const headingId = useId();
  return (
    <section className="uib-filter-locked" aria-labelledby={headingId}>
      <Heading level={level} data-size="2xs" id={headingId}>
        {t('filter.limitedTo')}
      </Heading>
      <ul className="uib-filter-locked-values">
        {values.map((item) => (
          <li key={keyOf(item)}>
            <Tag
              // Pinned to neutral, as kunnskapsassistenten draws it: what the thread is held to.
              data-color="neutral"
              data-size="sm"
            >
              {item.label ?? item.value}
            </Tag>
          </li>
        ))}
      </ul>
      <Paragraph data-size="sm" variant="long">
        {t('filter.locked')}
      </Paragraph>
      {newThread ? <NewThreadLink {...newThread} /> : null}
    </section>
  );
};

/** A field while the facets load, as tall as the real one, so nothing below moves. Skeletons
 * around real elements, which Designsystemet sizes to their children, so no height drifts from
 * the tokens. `inert` and `aria-hidden`: kept only for their size. */
export const FieldPlaceholder = () => {
  const t = useT();
  return (
    <div className="ds-field uib-filter-placeholder" aria-hidden="true" inert>
      <div className="uib-filter-label-row">
        <Skeleton>
          <Label>{t('filter.title')}</Label>
        </Skeleton>
        <Skeleton>
          <Button
            variant="tertiary"
            // Pinned to neutral, as kunnskapsassistenten draws it: a stand-in for «Velg alle».
            data-color="neutral"
            data-size="sm"
            tabIndex={-1}
          >
            {t('filter.selectAll')}
          </Button>
        </Skeleton>
      </div>
      <Skeleton className="uib-filter-placeholder-input">
        <Input readOnly tabIndex={-1} />
      </Skeleton>
      <Skeleton data-field="description">{t('filter.stateNone')}</Skeleton>
    </div>
  );
};
