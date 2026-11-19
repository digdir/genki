// @vitest-environment jsdom
// «Filteret svaret bygger på» at the top of Fremgangsmåte (FilterBasis, dev-fremgangsmate-1).
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FilterBasis, type FilterBasisProps } from './Filter.js';
import type { FilterField } from './types.js';

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
  label: 'Publiseringsår',
  kind: 'year',
  options: ['2020', '2021', '2022', '2025'].map((value) => ({ value })),
};
const orgs: FilterField = {
  id: 'org',
  label: 'Virksomheter',
  heading: 'Virksomhet',
  options: [{ value: 'digdir', label: 'Digitaliseringsdirektoratet' }, { value: 'nav' }],
};

const draw = (props: Partial<FilterBasisProps> = {}) =>
  render(<FilterBasis selection={{}} fields={[types, years, orgs]} {...props} />);

/** Each row as «label: value», in order. */
const rows = () =>
  [...document.querySelectorAll('.uib-filter-basis dt')].map(
    (label) => `${label.textContent}: ${label.nextElementSibling?.textContent}`,
  );

describe('FilterBasis', () => {
  it('is a region named by its heading, with how many documents it read from and how many were used', () => {
    draw({ count: 214, used: 4 });
    const region = screen.getByRole('region', { name: 'Filteret svaret bygger på' });
    const lead = region.querySelector('.uib-filter-basis-lead');
    expect(lead?.textContent).toBe('Leste fra 214 dokumenter. 4 av dem er brukt i svaret.');
    expect(lead?.querySelector('strong')?.textContent).toBe('214 dokumenter');
  });

  it('leaves the lead out while the count is not known', () => {
    draw({ used: 4 });
    expect(document.querySelector('.uib-filter-basis-lead')).toBeNull();
  });

  it('names each field in its singular heading, «Alle» or «Alle år» when it narrowed nothing', () => {
    draw();
    expect(rows()).toEqual(['Dokumenttype: Alle', 'Publiseringsår: Alle år', 'Virksomhet: Alle']);
  });

  it('draws chosen values as Tags in their labels, and a year field’s years as periods in text', () => {
    draw({
      selection: {
        type: ['Evaluering', 'Årsrapport'],
        year: ['2020', '2021', '2022'],
        org: ['digdir'],
      },
    });
    expect(rows()).toEqual([
      'Dokumenttype: EvalueringÅrsrapport',
      'Publiseringsår: 2020–2022',
      'Virksomhet: Digitaliseringsdirektoratet',
    ]);
    const tags = [...document.querySelectorAll('dd .ds-tag')];
    expect(tags.map((tag) => tag.textContent)).toEqual([
      'Evaluering',
      'Årsrapport',
      'Digitaliseringsdirektoratet',
    ]);
    expect(tags.every((tag) => tag.getAttribute('data-color') === 'accent')).toBe(true);
  });

  it('reads every value of a field ticked as «Alle», since it narrows nothing', () => {
    draw({ selection: { type: ['Evaluering', 'Tilsynsrapport', 'Årsrapport'] } });
    expect(rows()[0]).toBe('Dokumenttype: Alle');
  });

  it('says what was added and taken out since the answer before, and nothing when it is the same', () => {
    const { rerender } = draw({
      selection: { type: ['Evaluering'] },
      previous: { type: ['Årsrapport'] },
    });
    expect(rows().at(-1)).toBe(
      'Endret siden forrige svar: Evaluering er lagt til og Årsrapport er tatt ut',
    );
    rerender(
      <FilterBasis
        selection={{ type: ['Evaluering'] }}
        fields={[types, years, orgs]}
        previous={{ type: ['Evaluering'] }}
      />,
    );
    expect(screen.queryByText('Endret siden forrige svar')).toBeNull();
  });

  it('names a chosen field the host gave no field for by its id', () => {
    render(<FilterBasis selection={{ tema: ['skatt'] }} fields={[]} />);
    expect(rows()).toEqual(['tema: skatt']);
  });
});
