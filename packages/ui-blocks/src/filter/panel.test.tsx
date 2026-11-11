// @vitest-environment jsdom
// The dev boards' filter (dev-filter-panel; «9 · Filtrering»): the panel variant, what an answer
// read from, the line under the field, and the words and counts the three share.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  documentCount,
  Filter,
  FilterNext,
  FilterRead,
  valueLabels,
  type FilterProps,
} from './Filter.js';
import { CHECKBOXES_UP_TO } from './FilterRows.js';
import type { FilterField, FilterSelection } from './types.js';

document.getAnimations ??= () => [];
afterEach(cleanup);

const types: FilterField = {
  id: 'type',
  label: 'Dokumenttyper',
  heading: 'Dokumenttype',
  options: [
    { value: 'Evaluering', count: 7577 },
    { value: 'Tilsynsrapport', count: 1204 },
    { value: 'Årsrapport', count: 2520 },
  ],
};
const years: FilterField = {
  id: 'year',
  label: 'År',
  heading: 'Publiseringsår',
  kind: 'year',
  options: ['2020', '2021', '2022', '2023', '2024', '2025'].map((value) => ({ value, count: 9 })),
};
const orgs: FilterField = {
  id: 'org',
  label: 'Virksomheter',
  heading: 'Virksomhet',
  options: Array.from({ length: CHECKBOXES_UP_TO + 1 }, (_, n) => ({
    value: `Virksomhet ${n + 1}`,
    count: n + 1,
  })),
};
const fields = [types, years, orgs];

const Host = ({
  initial = {},
  seen = [],
  ...props
}: Partial<FilterProps> & { initial?: FilterSelection; seen?: FilterSelection[] }) => {
  const [selection, setSelection] = useState(initial);
  return (
    <Filter
      variant="panel"
      fields={fields}
      title={false}
      selection={selection}
      onChange={(next) => {
        seen.push(next);
        setSelection(next);
      }}
      {...props}
    />
  );
};

const row = (name: RegExp) => screen.getByRole('button', { name });

describe('the panel variant', () => {
  it('draws each field as a row named by its heading and what is chosen, «Alle» when nothing is', () => {
    render(<Host initial={{ type: ['Evaluering', 'Tilsynsrapport'], year: ['2020', '2021'] }} />);
    expect(row(/^Dokumenttype/).textContent).toBe('DokumenttypeEvaluering, Tilsynsrapport');
    expect(row(/^Publiseringsår/).textContent).toBe('Publiseringsår2020–2021');
    expect(row(/^Virksomhet/).textContent).toBe('VirksomhetAlle');
  });

  it('opens the first row, and one row at a time', () => {
    render(<Host />);
    expect(row(/^Dokumenttype/).getAttribute('aria-expanded')).toBe('true');
    expect(row(/^Publiseringsår/).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(row(/^Publiseringsår/));
    expect(row(/^Publiseringsår/).getAttribute('aria-expanded')).toBe('true');
    expect(row(/^Dokumenttype/).getAttribute('aria-expanded')).toBe('false');
  });

  it('ticks a value per checkbox, each with its exact count, never «ca.»', () => {
    const seen: FilterSelection[] = [];
    render(<Host seen={seen} />);
    const box = screen.getByRole('checkbox', { name: /^Evaluering/ });
    expect(box.closest('.uib-filter-checkbox')?.textContent).toBe('Evaluering7 577');
    expect(document.body.textContent).not.toContain('ca.');
    fireEvent.click(box);
    expect(seen.at(-1)).toEqual({ type: ['Evaluering'] });
    expect(row(/^Dokumenttype/).textContent).toBe('DokumenttypeEvaluering');
  });

  it('opens a field with more values than it ticks to its list, named for screen readers', () => {
    render(<Host />);
    fireEvent.click(row(/^Virksomhet/));
    const body = document.getElementById(
      row(/^Virksomhet/).getAttribute('aria-controls') ?? '',
    ) as HTMLElement;
    expect(within(body).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(body).getByText('Virksomheter').className).toContain('ds-sr-only');
  });

  it('removes every filter with «Fjern alle filtre», drawn only when something is chosen', () => {
    const seen: FilterSelection[] = [];
    const { rerender } = render(<Host seen={seen} />);
    expect(screen.queryByRole('button', { name: 'Fjern alle filtre' })).toBeNull();
    rerender(<Host seen={seen} initial={{ type: ['Evaluering'] }} key="chosen" />);
    fireEvent.click(screen.getByRole('button', { name: 'Fjern alle filtre' }));
    expect(seen.at(-1)).toEqual({});
    expect(document.activeElement).toBe(row(/^Dokumenttype/));
    expect(screen.queryByRole('button', { name: 'Fjern alle filtre' })).toBeNull();
  });

  it('draws the fields as before without the variant', () => {
    render(<Host variant={undefined} />);
    expect(screen.queryByRole('button', { name: /^Dokumenttype/ })).toBeNull();
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
  });
});

describe('the words and the count the filter shares', () => {
  it('names values as the rows do, years in a row as one period, a field with all ticked as nothing', () => {
    expect(
      valueLabels({ type: ['Evaluering'], year: ['2020', '2021', '2022', '2025'] }, fields),
    ).toEqual(['Evaluering', '2020–2022', '2025']);
    expect(valueLabels({ type: ['Evaluering', 'Tilsynsrapport', 'Årsrapport'] }, fields)).toEqual(
      [],
    );
  });

  it('counts exactly over the type field: the chosen types, or all of them', () => {
    expect(documentCount(fields, {}, 'type')).toBe(11301);
    expect(documentCount(fields, { type: ['Evaluering', 'Tilsynsrapport'] }, 'type')).toBe(8781);
    expect(documentCount([{ ...types, options: [{ value: 'x' }] }], {}, 'type')).toBeUndefined();
  });
});

describe('the filter in the answer (FilterRead)', () => {
  it('says how many documents it read from, and the chosen values as a list of chips', () => {
    render(
      <FilterRead
        selection={{ type: ['Evaluering', 'Tilsynsrapport'], year: ['2020', '2021'] }}
        fields={fields}
        count={8781}
      />,
    );
    expect(document.querySelector('.uib-filter-read-lead')?.textContent).toBe(
      'Leste fra 8 781 dokumenter:',
    );
    const chips = screen.getByRole('list', { name: 'Filteret dette svaret bygger på' });
    expect(
      within(chips)
        .getAllByRole('listitem')
        .map((chip) => chip.textContent),
    ).toEqual(['Evaluering', 'Tilsynsrapport', '2020–2021']);
    expect(within(chips).queryByRole('button')).toBeNull();
  });

  it('says only the count when nothing narrows, and nothing when neither is known', () => {
    const { container, rerender } = render(<FilterRead selection={{}} count={11301} />);
    expect(container.textContent).toBe('Leste fra 11 301 dokumenter');
    rerender(<FilterRead selection={{}} />);
    expect(container.textContent).toBe('');
  });
});

describe('the line under the field (FilterNext)', () => {
  it('says what the next question reads from, and where to change it', () => {
    const { container } = render(
      <FilterNext
        selection={{ type: ['Evaluering'], year: ['2020', '2021'] }}
        fields={fields}
        count={7577}
      />,
    );
    expect(container.textContent).toBe(
      'Neste spørsmål leser fra 7 577 dokumenter · Evaluering · 2020–2021 – endres i filteret til venstre',
    );
  });

  it('is drawn only with a count', () => {
    const { container } = render(<FilterNext selection={{ type: ['Evaluering'] }} />);
    expect(container.textContent).toBe('');
  });
});
