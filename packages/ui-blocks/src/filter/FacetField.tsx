import {
  Button,
  EXPERIMENTAL_Suggestion as Suggestion,
  Field,
  Label,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useImperativeHandle, useRef, type Ref } from 'react';
import { renderChip, removedDrawnChip, valuesAfter, withDrawnChips } from './drawnChips.js';
import { useT } from './i18n.js';
import { chosenFirst, useChosenFirst, useListFollowsField } from './listBehaviour.js';
import type { FilterField } from './types.js';

/** What the filter may do with a field from outside: put the keyboard in it. */
export interface FieldHandle {
  focus: () => void;
}

export interface FieldProps {
  ref?: Ref<FieldHandle> | undefined;
  field: FilterField;
  /** Chosen option values. Empty is no narrowing. */
  selected: readonly string[];
  /** `said` is for the filter's live region: the change, where u-combobox says nothing. With the
   * values as they were, it is all there is to tell. */
  onChange: (values: string[], said?: string) => void;
  /** One chip for all, or for `compactFrom` or more, chosen values. */
  compact: boolean;
  /** Most values a field may send. */
  max: number;
}

/** Chosen values from which `compact` draws one chip instead of one per value. All chosen
 * always does. */
const COMPACT_FROM = 6;

/** The texts u-combobox reads for the chosen values, which Designsystemet leaves in English. Keys
 * are u-combobox's observed attributes; an empty value falls back to English. */
export const useComboboxTexts = () => {
  const t = useT();
  return {
    'data-sr-items': t('filter.srItems'),
    'data-sr-empty': t('filter.srEmpty'),
    'data-sr-found': t('filter.srFound'),
    'data-sr-added': t('filter.srAdded'),
    'data-sr-removed': t('filter.srRemoved'),
    'data-sr-invalid': t('filter.srInvalid'),
    'data-sr-of': t('filter.srOf'),
  };
};

/** A field's label inside a sentence: «Velg alle dokumenttyper». */
export const useInSentence = () => {
  const t = useT();
  return (label: string) => label.toLocaleLowerCase(t.locale);
};

/** Designsystemet's Suggestion with `multiple`, whose chips show the selection.
 * `data-overscroll` lifts its inline width lock so the CSS can widen the list. Its Clear clears
 * only typed text, hence «Tøm». */
export const FacetField = ({
  ref,
  field,
  selected,
  onChange,
  compact: compactChips,
  max,
}: FieldProps) => {
  const t = useT();
  const texts = useComboboxTexts();
  const name = useInSentence()(field.label);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDataListElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);
  const first = useChosenFirst(selected, listRef);
  useListFollowsField(selected, listRef, inputRef);
  const total = field.options.length;
  const chosen = selected.length;
  // Every listed value ticked, the rule a question leaves the field out by (`narrowing`). Not
  // `chosen === total`: a field with all ticked is not sent, so the facets are counted without
  // it and may list fewer values than are ticked.
  const everyListed = (values: readonly string[]) =>
    total > 0 && field.options.every((option) => values.includes(option.value));
  const allChosen = everyListed(selected);
  const labelOf = (value: string) =>
    field.options.find((option) => option.value === value)?.label ?? value;

  // With all or many chosen, one chip («Alle dokumenttyper», «12 virksomheter») instead of
  // hundreds, drawn over the chip per value (drawnChips.tsx), so the list still ticks them.
  const isCompact = (values: readonly string[]) =>
    compactChips && values.length > 0 && (everyListed(values) || values.length >= COMPACT_FROM);
  const compact = isCompact(selected);
  const drawn = compact
    ? [
        {
          key: 'chosen',
          label: allChosen
            ? t('filter.compactAll', { field: name })
            : t('filter.compactSome', { count: chosen, field: name }),
          values: selected,
        },
      ]
    : [];

  // `{ label, value }`, not bare strings: Suggestion's `sanitizeItems` makes a bare string both,
  // and the chip would show the key, not the name.
  const selectedItems = withDrawnChips(
    selected.map((value) => ({ value, label: labelOf(value) })),
    drawn,
  );

  // u-combobox names a chip `label` + `data-sr-remove` («Årsrapport, Trykk for å fjerne»). With
  // chips in several fields, the field has to be in it. Under the drawn chip, back from the field
  // reaches only that chip, which takes all; and u-combobox would count it as one more chosen,
  // so the count is ours.
  const screenReaderTexts = {
    ...texts,
    ...(compact && { 'data-sr-found': t('filter.srFoundAll', { count: chosen }) }),
    'data-sr-remove': compact
      ? t('filter.srRemoveAll', { field: name })
      : t('filter.srRemove', { field: name }),
  };

  // The state goes in the description: a label that changes with the value fails screen
  // readers. None and all must read differently; all chosen is no narrowing and is not sent.
  const state =
    chosen === 0
      ? t('filter.stateNone')
      : allChosen
        ? t('filter.stateAll', { total })
        : t('filter.stateSome', { count: chosen, total });

  // The question would be turned away. The way out is in the message: fewer, or all.
  const overLimit = chosen > max && !allChosen;

  // Picking a value leaves its key in the input (u-combobox restores the typed text only on the
  // native datalist path), so the next open would show «Ingen treff». Dispatched, because
  // u-combobox and Suggestion's filtering both go stale on `value` alone.
  const clearQuery = () => {
    const input = inputRef.current;
    if (!input || input.value === '') return;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const change = (values: string[], said?: string) => {
    clearQuery();
    onChange(values, said);
  };

  // u-combobox reads out a change itself only when exactly one chip comes or goes. The chips are
  // a value's own, and the drawn one, which comes or goes across COMPACT_FROM. Otherwise `said`
  // goes to the filter's live region; never both, or it is heard twice.
  const toldByCombobox = (next: readonly string[]) => {
    const added = next.filter((value) => !selected.includes(value)).length;
    const removed = selected.filter((value) => !next.includes(value)).length;
    return added + removed + (isCompact(next) !== compact ? 1 : 0) === 1;
  };

  // '' is «Ingen treff», which u-combobox chooses on Enter (its label is the typed text): not a
  // choice, so nothing changes. A '' already selected (a stored filter from before) goes with the
  // next change.
  const choose = (items: { value: string }[]) => {
    const values = [...new Set(valuesAfter(items, drawn))];
    if (values.includes('') && !selected.includes('')) return;
    const next = values.filter((value) => value !== '');

    // The drawn chip goes with focus on it, and every chip left is hidden: to the field, as from
    // the buttons below. All chips go at once, so u-combobox says nothing.
    if (removedDrawnChip(items, drawn)) {
      inputRef.current?.focus();
      change(next, t('filter.noneChosen', { field: name }));
      return;
    }

    // One value, which across COMPACT_FROM takes the drawn chip with it.
    const [added] = next.filter((value) => !selected.includes(value));
    const [removed] = selected.filter((value) => !next.includes(value));
    const said =
      toldByCombobox(next) || !(added ?? removed)
        ? undefined
        : added
          ? t('filter.added', { value: labelOf(added) })
          : t('filter.removed', { value: labelOf(removed ?? '') });
    change(next, said);
  };

  // «Velg alle» and «Tøm» vanish in the render they cause, so focus moves to the field first,
  // not to `<body>` (WCAG 2.4.3). Only from the buttons: `onSelectedChange` must not pull focus
  // out of the chips, where ArrowLeft and Enter walk and remove.
  const changeFromButton = (values: string[], said: string) => {
    inputRef.current?.focus();
    change(values, toldByCombobox(values) ? undefined : said);
  };

  return (
    <Field className="uib-filter-field">
      <div className="uib-filter-label-row">
        <Label>{field.label}</Label>

        <div className="uib-filter-field-actions">
          {!allChosen && total > 0 && (
            <Button
              variant="tertiary"
              // Pinned to neutral, as kunnskapsassistenten draws it: quiet beside the field.
              data-color="neutral"
              data-size="sm"
              aria-label={t('filter.selectAllIn', { field: name })}
              onClick={() =>
                // Adds, never removes: a ticked value not listed now stays.
                changeFromButton(
                  [...new Set([...selected, ...field.options.map((option) => option.value)])],
                  t('filter.allChosen', { total, field: name }),
                )
              }
            >
              {t('filter.selectAll')}
            </Button>
          )}
          {chosen > 0 && (
            <Button
              variant="tertiary"
              // Pinned to neutral, as kunnskapsassistenten draws it: quiet beside the field.
              data-color="neutral"
              data-size="sm"
              aria-label={t('filter.clearIn', { field: name })}
              onClick={() => changeFromButton([], t('filter.noneChosen', { field: name }))}
            >
              {t('filter.clear')}
            </Button>
          )}
        </div>
      </div>

      {/* Above the chips, not after: under a hundred chips it would be out of sight. `ds-field`
          links it to the input wherever it stands. */}
      {overLimit && (
        <ValidationMessage>{t('filter.overLimit', { max, count: chosen })}</ValidationMessage>
      )}

      <Suggestion
        multiple
        selected={selectedItems}
        onSelectedChange={choose}
        renderSelected={renderChip}
        {...screenReaderTexts}
      >
        {/* Names the field: several bare «Søk» read as one repeated control. */}
        <Suggestion.Input ref={inputRef} placeholder={t('filter.searchIn', { field: name })} />
        <Suggestion.Toggle aria-label={t('filter.listToggle')} />
        <Suggestion.Clear />
        <Suggestion.List ref={listRef} data-overscroll="contain">
          {chosenFirst(field.options, (option) => first.has(option.value)).map((option) => (
            // The count stays out of `label`, which the chip and the filtering use.
            <Suggestion.Option
              key={option.value}
              value={option.value}
              label={option.label ?? option.value}
            >
              {option.count === undefined
                ? (option.label ?? option.value)
                : `${option.label ?? option.value} (${option.count})`}
            </Suggestion.Option>
          ))}
          {/* After the values: Enter takes the FIRST option labelled with the text, and «Ingen
              treff» carries the text (see `choose`). CSS hides it whenever a value shows. */}
          <Suggestion.Empty>{t('filter.noMatches')}</Suggestion.Empty>
        </Suggestion.List>
      </Suggestion>

      <Field.Description>{state}</Field.Description>
    </Field>
  );
};
