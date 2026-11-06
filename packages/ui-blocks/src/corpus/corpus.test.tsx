// @vitest-environment jsdom
import { InLocale } from '@genai/i18n/react';
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FilterField } from '../filter/types.js';
import {
  CorpusChoice,
  CorpusLine,
  corpusName,
  useCorpusText,
  type CorpusLineProps,
  type CorpusOption,
} from './Corpus.js';

// Ported from KA's corpusText, CorpusLine and FiltersView.corpus tests.

document.getAnimations ??= () => [];
afterEach(cleanup);

/** KA's plurals for Kudos's types: no generic rule gets «tildelingsbrev» right. */
const typePlurals = {
  Evaluering: 'evalueringer',
  'Proposisjon til Stortinget': 'proposisjoner til Stortinget',
  Statusrapport: 'statusrapporter',
  Tildelingsbrev: 'tildelingsbrev',
  Årsrapport: 'årsrapporter',
};

const types = (...values: [string, number?][]): FilterField => ({
  id: 'type',
  label: 'Dokumenttyper',
  options: values.map(([label, count]) => ({ value: label.toLowerCase(), label, count })),
});

const years = (...values: number[]): FilterField => ({
  id: 'year',
  label: 'År',
  kind: 'year',
  options: values.map((year) => ({ value: String(year) })),
});

/** A label written for a row in a chooser, with a count of its own. */
const kudos: CorpusOption = { key: 'kudos', label: 'Kudos, 938 dokumenter' };
const norquad: CorpusOption = {
  key: 'norquad-docs',
  label: 'Wikipedia (NorQuAD)',
  description: '351 artikler fra Wikipedia, brukt til å prøve ut spørsmål og svar.',
};

const line = (
  fields: readonly FilterField[] | undefined,
  corpus: CorpusOption | undefined = kudos,
  locale: 'nb' | 'en' = 'nb',
) =>
  renderHook(() => useCorpusText({ fields, corpus, typeField: 'type', typePlurals }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <InLocale locale={locale}>{children}</InLocale>
    ),
  }).result.current;

describe('the corpus line’s text', () => {
  it('names the source, the size, the types and the years', () => {
    expect(
      line([
        types(['Årsrapport', 500], ['Evaluering', 300], ['Tildelingsbrev', 138]),
        years(2020, 2024, 2027),
      ]),
    ).toEqual({
      source: 'Dokumenter fra Kudos',
      detail: '938 dokumenter, årsrapporter, evalueringer og tildelingsbrev, 2020–2027',
    });
  });

  it('says where the documents come from alone when there is nothing to count', () => {
    expect(line([])).toEqual({ source: 'Dokumenter fra Kudos' });
    expect(line(undefined)).toEqual({ source: 'Dokumenter fra Kudos' });
  });

  it('drops the count rather than adding up a partial one', () => {
    expect(line([types(['Årsrapport', 500], ['Evaluering']), years(2020, 2024)])).toEqual({
      source: 'Dokumenter fra Kudos',
      detail: 'årsrapporter og evalueringer, 2020–2024',
    });
  });

  it('keeps a type it has no plural for, in lower case, rather than inventing one', () => {
    expect(line([types(['Strategi/plan', 12])])).toEqual({
      source: 'Dokumenter fra Kudos',
      detail: '12 dokumenter, strategi/plan',
    });
  });

  it('names a sixth type rather than saying «med flere» about one', () => {
    expect(
      line([
        types(
          ['Årsrapport', 6],
          ['Evaluering', 5],
          ['Tildelingsbrev', 4],
          ['Statusrapport', 3],
          ['Proposisjon til Stortinget', 2],
          ['Strategi/plan', 1],
        ),
      ]).detail,
    ).toBe(
      '21 dokumenter, årsrapporter, evalueringer, tildelingsbrev, statusrapporter, proposisjoner til Stortinget og strategi/plan',
    );
  });

  it('stops naming types once there are more than one over the cap', () => {
    expect(
      line([
        types(
          ['Årsrapport', 7],
          ['Evaluering', 6],
          ['Tildelingsbrev', 5],
          ['Statusrapport', 4],
          ['Proposisjon til Stortinget', 3],
          ['Strategi/plan', 2],
          ['Høringsnotat', 1],
        ),
      ]).detail,
    ).toBe(
      '28 dokumenter, årsrapporter, evalueringer, tildelingsbrev, statusrapporter og proposisjoner til Stortinget med flere',
    );
  });

  it('names the biggest types first, not the facet order', () => {
    expect(line([types(['Evaluering', 10], ['Årsrapport', 900])]).detail).toBe(
      '910 dokumenter, årsrapporter og evalueringer',
    );
  });

  it('writes one year without a range, and a thousand with a space', () => {
    expect(line([years(2024)]).detail).toBe('2024');
    expect(line([types(['Årsrapport', 10064])]).detail).toBe('10 064 dokumenter, årsrapporter');
  });

  it('says the collection’s own words when there is nothing to count', () => {
    const own = { source: 'Dokumenter fra Wikipedia (NorQuAD)', detail: norquad.description };
    expect(line(undefined, norquad)).toEqual(own);
    expect(line([], norquad)).toEqual(own);
  });

  it('uses the name before a comma, and leaves a name with brackets whole', () => {
    expect(line([types(['Årsrapport', 12])]).source).toBe('Dokumenter fra Kudos');
    expect(line([types(['Årsrapport', 3])], norquad).source).toBe(
      'Dokumenter fra Wikipedia (NorQuAD)',
    );
    expect(corpusName({ key: 'x', label: ' , ' })).toBeUndefined();
  });

  it('names no collection it does not know', () => {
    const { result } = renderHook(() =>
      useCorpusText({ fields: [types(['Årsrapport', 4])], typeField: 'type', typePlurals }),
    );
    expect(result.current).toEqual({
      source: 'Dokumenter fra standardsamlingen',
      detail: '4 dokumenter, årsrapporter',
    });
  });

  it('speaks English when the reader does', () => {
    expect(line([types(['Annual report', 2], ['Evaluation', 1])], kudos, 'en')).toEqual({
      source: 'Documents from Kudos',
      detail: '3 documents, annual report and evaluation',
    });
  });
});

describe('the corpus line', () => {
  const fields = [types(['Årsrapport', 500], ['Evaluering', 438]), years(2020, 2027)];
  const detail = '938 dokumenter, årsrapporter og evalueringer, 2020–2027';
  const draw = (props: Partial<CorpusLineProps> = {}) =>
    render(
      <CorpusLine
        fields={fields}
        corpus={kudos}
        typeField="type"
        typePlurals={typePlurals}
        {...props}
      />,
    );

  it('shows the name, and keeps the rest closed behind a button that says what it is about', () => {
    draw();
    expect(screen.getByText('Dokumenter fra Kudos')).toBeTruthy();
    expect(screen.getByText(detail).hasAttribute('hidden')).toBe(true);
    const button = screen.getByRole('button', { name: 'Vis mer om dokumentsamlingen' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.textContent).toBe('Vis mer');
  });

  it('opens and closes the rest, and points the button at it', () => {
    draw();
    const button = screen.getByRole('button', { name: 'Vis mer om dokumentsamlingen' });
    expect(document.getElementById(button.getAttribute('aria-controls') ?? '')?.textContent).toBe(
      detail,
    );
    fireEvent.click(button);
    expect(screen.getByText(detail).hasAttribute('hidden')).toBe(false);
    const open = screen.getByRole('button', { name: 'Vis mindre om dokumentsamlingen' });
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(open.textContent).toBe('Vis mindre');
    fireEvent.click(open);
    expect(screen.getByText(detail).hasAttribute('hidden')).toBe(true);
  });

  it('draws no button when there is nothing more to show', () => {
    draw({ fields: undefined, corpus: { key: 'kudos-pilot', label: 'Kudos-pilot' } });
    expect(screen.getByText('Dokumenter fra Kudos-pilot')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('the corpus choice', () => {
  const options: CorpusOption[] = [kudos, norquad];

  it('is a select labelled «Dokumentsamling», standing on the collection searched', () => {
    render(<CorpusChoice options={options} value="norquad-docs" onChange={() => {}} />);
    const select = screen.getByRole('combobox', { name: 'Dokumentsamling' }) as HTMLSelectElement;
    expect(select.value).toBe('norquad-docs');
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Kudos, 938 dokumenter',
      'Wikipedia (NorQuAD)',
    ]);
  });

  it('holds one input in its field, so Designsystemet’s field has nothing to warn about', () => {
    const { container } = render(
      <CorpusChoice options={options} value="kudos" onChange={() => {}} />,
    );
    const field = container.querySelector('.uib-corpus-choice') as HTMLElement;
    const inputs = [...field.querySelectorAll('*')].filter(
      (element) => 'validity' in element && !(element instanceof HTMLButtonElement),
    );
    expect(inputs.map((element) => element.tagName)).toEqual(['SELECT']);
    expect(container.querySelector('output')).not.toBeNull();
  });

  it('asks the host to switch, and says which collection it became', () => {
    const onChange = vi.fn();
    const { container } = render(
      <CorpusChoice options={options} value="kudos" onChange={onChange} />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'norquad-docs' } });
    expect(onChange).toHaveBeenCalledWith('norquad-docs');
    expect(container.querySelector('output')?.textContent).toBe(
      'Dokumentsamling: Wikipedia (NorQuAD)',
    );
  });

  it('says the filter was reset when the host empties one on a switch', () => {
    const { container } = render(
      <CorpusChoice options={options} value="kudos" resetsFilter onChange={() => {}} />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'norquad-docs' } });
    expect(container.querySelector('output')?.textContent).toBe(
      'Dokumentsamling: Wikipedia (NorQuAD). Filteret er nullstilt fordi dokumentsamlingen ble byttet.',
    );
  });

  it('draws nothing when there is only one collection to search', () => {
    const { container } = render(
      <CorpusChoice options={[kudos]} value="kudos" onChange={() => {}} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
