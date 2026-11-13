// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FacetField } from './FacetField.js';
import type { FilterField } from './types.js';
import { YearRangeField } from './YearRangeField.js';

// Ported from KA's FacetField, yearRangesAndCompactChips, chosenFirst and listFollowsField tests.

document.getAnimations ??= () => [];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const types: FilterField = {
  id: 'type',
  label: 'Dokumenttype',
  options: [
    { value: 'arsrapport', label: 'Årsrapport', count: 3 },
    { value: 'tildelingsbrev', label: 'Tildelingsbrev', count: 2 },
  ],
};

const years: FilterField = {
  id: 'year',
  label: 'År',
  kind: 'year',
  options: [2024, 2023, 2022, 2021, 2020, 2019].map((year) => ({
    value: String(year),
    count: year - 2018,
  })),
};

const organisations: FilterField = {
  id: 'organisation',
  label: 'Virksomheter',
  options: Array.from({ length: 20 }, (_, index) => ({
    value: `Virksomhet ${index + 1}`,
    count: 1,
  })),
};

type Said = (string | undefined)[];

/** The selection lives above the field, as it does in the filter. */
const Harness = ({
  field = types,
  initial = [],
  seen,
  said,
  compact = false,
  periods = false,
}: {
  field?: FilterField;
  initial?: string[];
  seen?: string[][];
  said?: Said;
  compact?: boolean;
  periods?: boolean;
}) => {
  const [selected, setSelected] = useState<string[]>(initial);
  const Field = periods ? YearRangeField : FacetField;
  return (
    <Field
      field={field}
      selected={selected}
      compact={compact}
      max={100}
      onChange={(next, text) => {
        seen?.push(next);
        said?.push(text);
        setSelected(next);
      }}
    />
  );
};

const input = () => screen.getByRole('combobox') as HTMLInputElement;

/** The chips the reader sees: jsdom applies no filter.css, so a drawn chip hides none here. */
const chips = (container: HTMLElement) => {
  const all = [...container.querySelectorAll('ds-suggestion > data')];
  const drawn = all.filter((chip) => chip.querySelector('.uib-filter-drawn-chip'));
  return (drawn.length > 0 ? drawn : all).map((chip) => chip.textContent ?? '');
};

/** The options u-combobox has ticked. */
const ticked = (container: HTMLElement) =>
  [...container.querySelectorAll('u-datalist u-option[selected]')].map(
    (option) => option.getAttribute('value') ?? '',
  );

/** What the list offers, in order. */
const offered = (container: HTMLElement) =>
  [...container.querySelectorAll('u-datalist u-option')].map((option) => option.textContent ?? '');

/* Typing and choosing as the browser tells u-combobox: `insertText`, then a replacement. */
const type = (text: string) =>
  act(() => {
    input().value = text;
    input().dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
    );
  });

const choose = (name: string) => {
  const value = screen.getByRole('option', { name, hidden: true }).getAttribute('value') ?? '';
  act(() => {
    input().value = value;
    input().dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: value }),
    );
  });
};

const typeThenEnter = (text: string) => {
  type(text);
  fireEvent.keyDown(input(), { key: 'Enter' });
};

describe('a field', () => {
  it('tells no limit, all chosen and some chosen apart in its description', () => {
    render(<Harness />);
    expect(screen.getByText('Ingen avgrensning')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Velg alle dokumenttype' }));
    expect(screen.getByText('Alle 2 valgt, altså ingen avgrensning')).toBeTruthy();
    expect(screen.queryByText('Ingen avgrensning')).toBeNull();
  });

  it('counts a part chosen, and offers both «Velg alle» and «Tøm»', () => {
    render(<Harness initial={['arsrapport']} />);
    expect(screen.getByText('1 av 2 valgt')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Velg alle dokumenttype' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tøm dokumenttype' })).toBeTruthy();
  });

  it('names its search after the field, so several do not read as one control', () => {
    render(<Harness />);
    expect(screen.getByPlaceholderText('Søk i dokumenttype')).toBeTruthy();
  });

  it('says which field a chip is removed from', () => {
    const { container } = render(<Harness initial={['arsrapport']} />);
    expect(container.querySelector('ds-suggestion')?.getAttribute('data-sr-remove')).toBe(
      'Trykk for å fjerne fra dokumenttype',
    );
  });

  it('shows the label on a chip and the count only in the list', () => {
    const { container } = render(<Harness initial={['arsrapport']} />);
    expect(chips(container)).toEqual(['Årsrapport']);
    // «Ingen treff» stands last, for Enter on a text that names nothing; CSS hides it.
    expect(offered(container)).toEqual(['Årsrapport (3)', 'Tildelingsbrev (2)', 'Ingen treff']);
  });

  it('keeps focus in the field when «Velg alle» and «Tøm» remove themselves', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Velg alle dokumenttype' }));
    expect(screen.queryByRole('button', { name: 'Velg alle dokumenttype' })).toBeNull();
    expect(document.activeElement).toBe(input());

    fireEvent.click(screen.getByRole('button', { name: 'Tøm dokumenttype' }));
    expect(screen.queryByRole('button', { name: 'Tøm dokumenttype' })).toBeNull();
    expect(document.activeElement).toBe(input());
  });

  describe('over the limit of values a field can send', () => {
    const many: FilterField = {
      id: 'organisation',
      label: 'Virksomheter',
      options: Array.from({ length: 150 }, (_, index) => ({ value: `Virksomhet ${index + 1}` })),
    };
    const first = (count: number) => many.options.slice(0, count).map((option) => option.value);
    const warning = /^Høyst 100 kan brukes i ett felt/;
    const draw = (selected: string[]) =>
      render(
        <FacetField
          field={many}
          selected={selected}
          compact={false}
          max={100}
          onChange={() => {}}
        />,
      );

    it('says so, with the way out, when more than the limit are chosen', () => {
      draw(first(101));
      expect(
        screen.getByText(
          'Høyst 100 kan brukes i ett felt, og 101 er valgt. Fjern noen, eller velg alle.',
        ),
      ).toBeTruthy();
    });

    it('says nothing at the limit', () => {
      draw(first(100));
      expect(screen.queryByText(warning)).toBeNull();
    });

    it('says nothing when all are chosen, which is no narrowing and is not sent', () => {
      draw(first(150));
      expect(screen.queryByText(warning)).toBeNull();
      expect(screen.getByText('Alle 150 valgt, altså ingen avgrensning')).toBeTruthy();
    });
  });

  describe('when the list holds fewer values than are ticked', () => {
    const listed: FilterField = {
      id: 'organisation',
      label: 'Virksomheter',
      options: Array.from({ length: 136 }, (_, index) => ({ value: `Virksomhet ${index + 1}` })),
    };
    const tickedAll = Array.from({ length: 259 }, (_, index) => `Virksomhet ${index + 1}`);

    it('says all are chosen, as the question does, with no warning and no «Velg alle»', () => {
      render(
        <FacetField
          field={listed}
          selected={tickedAll}
          compact={false}
          max={100}
          onChange={() => {}}
        />,
      );
      expect(screen.getByText('Alle 136 valgt, altså ingen avgrensning')).toBeTruthy();
      expect(screen.queryByText(/^Høyst 100 kan brukes i ett felt/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Velg alle virksomheter' })).toBeNull();
    });

    it('keeps what is ticked and not listed when «Velg alle» adds the rest', () => {
      const seen: string[][] = [];
      render(
        <FacetField
          field={listed}
          selected={['Virksomhet 200', 'Virksomhet 1']}
          compact={false}
          max={100}
          onChange={(values) => seen.push(values)}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Velg alle virksomheter' }));
      expect(seen.at(-1)).toHaveLength(137);
      expect(seen.at(-1)).toContain('Virksomhet 200');
      expect(seen.at(-1)).toContain('Virksomhet 136');
    });
  });

  describe('Enter straight after typing', () => {
    it('chooses the value whose name the text is, whatever the case, and empties the text', () => {
      const seen: string[][] = [];
      const { container } = render(<Harness seen={seen} />);
      typeThenEnter('Årsrapport');
      expect(seen.at(-1)).toEqual(['arsrapport']);
      expect(chips(container)).toEqual(['Årsrapport']);
      expect(screen.getByText('1 av 2 valgt')).toBeTruthy();
      expect(input().value).toBe('');

      typeThenEnter('tildelingsbrev');
      expect(seen.at(-1)).toEqual(['arsrapport', 'tildelingsbrev']);
    });

    it('chooses nothing when the text names no value, and the text stays', () => {
      const seen: string[][] = [];
      const { container } = render(<Harness seen={seen} />);
      typeThenEnter('Års');
      expect(seen).toEqual([]);
      expect(chips(container)).toEqual([]);
      expect(input().value).toBe('Års');
    });

    it('drops an empty value stored from before at the next choice', () => {
      const seen: string[][] = [];
      render(<Harness initial={['']} seen={seen} />);
      typeThenEnter('Tildelingsbrev');
      expect(seen.at(-1)).toEqual(['tildelingsbrev']);
    });
  });
});

describe('a field with chosen values first in its list', () => {
  const four: FilterField = {
    id: 'type',
    label: 'Dokumenttyper',
    options: ['Årsrapport', 'Tildelingsbrev', 'Evaluering', 'Instruks'].map((label) => ({
      value: label.toLocaleLowerCase('nb-NO'),
      label,
      count: 1,
    })),
  };
  const order = () =>
    [...document.querySelectorAll('u-datalist u-option:not([data-empty])')]
      .filter((option) => !option.hasAttribute('disabled'))
      .map((option) => option.getAttribute('label') ?? '');
  /* u-datalist opens and shuts with `hidden`, which the field observes, hence the async act. */
  const open = async () => {
    fireEvent.click(input());
    await act(async () => {});
    expect(document.querySelector('u-datalist')?.hasAttribute('hidden')).toBe(false);
  };
  const shut = async () => {
    fireEvent.keyDown(input(), { key: 'Escape' });
    await act(async () => {});
    expect(document.querySelector('u-datalist')?.hasAttribute('hidden')).toBe(true);
  };
  const pick = (label: string) => choose(`${label} (1)`);

  it('puts what is chosen first, each part in the order given', () => {
    render(<Harness field={four} initial={['instruks', 'tildelingsbrev']} />);
    expect(order()).toEqual(['Tildelingsbrev', 'Instruks', 'Årsrapport', 'Evaluering']);
  });

  it('moves nothing while the list is open, and moves when it shuts', async () => {
    render(<Harness field={four} />);
    await open();
    pick('Evaluering');
    expect(order()).toEqual(['Årsrapport', 'Tildelingsbrev', 'Evaluering', 'Instruks']);
    await shut();
    expect(order()).toEqual(['Evaluering', 'Årsrapport', 'Tildelingsbrev', 'Instruks']);
  });

  it('shows «Tøm» with the list shut at the next opening', async () => {
    render(<Harness field={four} initial={['instruks']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tøm dokumenttyper' }));
    await open();
    expect(order()).toEqual(['Årsrapport', 'Tildelingsbrev', 'Evaluering', 'Instruks']);
  });

  it('puts the chosen matches first when something is typed', async () => {
    render(<Harness field={four} initial={['instruks']} />);
    await open();
    type('s');
    expect(order()).toEqual(['Instruks', 'Årsrapport', 'Tildelingsbrev']);
  });
});

describe('a field whose list follows it when it moves', () => {
  const list = () => document.querySelector('u-datalist') as HTMLElement;
  /* ds-suggestion places the list on the popover's `toggle`, a task of its own. */
  const open = async () => {
    fireEvent.click(input());
    await act(() => new Promise((resolve) => setTimeout(resolve)));
  };
  /** The field from `top` to `bottom` in a window 800 high, and the placements asked for. */
  const layout = (top: number, bottom: number) => {
    vi.spyOn(input(), 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: top, width: 300, height: bottom - top }),
    );
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800);
    const placed: unknown[] = [];
    list().addEventListener('ds-toggle-source', (event) =>
      placed.push((event as CustomEvent).detail),
    );
    return placed;
  };

  it('fits its height to the room below the field and is placed again after a choice', async () => {
    render(<Harness />);
    await open();
    const placed = layout(500, 548);
    list().setAttribute('data-floating', 'bottom');
    choose('Årsrapport (3)');
    await act(async () => {});
    // 800 − 548, less Designsystemet's 20 px.
    expect(list().style.maxHeight).toBe('232px');
    expect(placed).toEqual([input()]);
  });

  it('counts the room above the field when the list stands above it', async () => {
    render(<Harness />);
    await open();
    layout(500, 548);
    list().setAttribute('data-floating', 'top');
    choose('Årsrapport (3)');
    await act(async () => {});
    expect(list().style.maxHeight).toBe('480px');
  });

  it('leaves the list alone while it is shut', async () => {
    render(<Harness />);
    const placed = layout(500, 548);
    choose('Årsrapport (3)');
    await act(async () => {});
    expect(list().style.maxHeight).toBe('');
    expect(placed).toEqual([]);
  });
});

describe('a year field with periods', () => {
  const Years = (props: {
    initial?: string[];
    seen?: string[][];
    said?: Said;
    field?: FilterField;
  }) => <Harness field={years} periods {...props} />;

  it('shows years in a row as one chip, and a gap as two', () => {
    const { container } = render(<Years initial={['2022', '2023', '2024', '2019']} />);
    expect(chips(container)).toEqual(['2019', '2022–2024']);
    expect(screen.getByText('4 år valgt')).toBeTruthy();
  });

  it('offers the period the text reads as, with the years in it that have documents', () => {
    render(<Years />);
    type('20-22');
    expect(
      screen.getByRole('option', { name: '2020–2022 (3 år med dokumenter)', hidden: true }),
    ).toBeTruthy();
  });

  it('offers a year with no documents with 0, and it can be chosen', () => {
    const seen: string[][] = [];
    const { container } = render(<Years seen={seen} />);
    type('2030');
    choose('2030 (0)');
    expect(seen.at(-1)).toEqual(['2030']);
    expect(chips(container)).toEqual(['2030']);
  });

  it('still sends a list of years, and joins a period to one it touches', () => {
    const seen: string[][] = [];
    const { container } = render(<Years initial={['2019', '2020']} seen={seen} />);
    type('21-23');
    choose('2021–2023 (3 år med dokumenter)');
    expect(seen.at(-1)).toEqual(['2019', '2020', '2021', '2022', '2023']);
    expect(chips(container)).toEqual(['2019–2023']);
  });

  it('chooses the period with Enter, straight from the text typed, and empties the text', () => {
    const seen: string[][] = [];
    const { container } = render(<Years seen={seen} />);
    typeThenEnter('23-24');
    expect(seen.at(-1)).toEqual(['2023', '2024']);
    expect(chips(container)).toEqual(['2023–2024']);
    expect(input().value).toBe('');
  });

  it('removes a period as one', () => {
    const seen: string[][] = [];
    const { container } = render(<Years initial={['2019', '2022', '2023', '2024']} seen={seen} />);
    fireEvent.click(screen.getByRole('option', { name: /^2022–2024, Trykk for å fjerne/u }));
    expect(seen.at(-1)).toEqual(['2019']);
    expect(chips(container)).toEqual(['2019']);
  });

  it('offers the years with documents while a year is typed, newest first', () => {
    const { container } = render(<Years />);
    type('202');
    expect(offered(container)).toEqual([
      '2024 (6)',
      '2023 (5)',
      '2022 (4)',
      '2021 (3)',
      '2020 (2)',
    ]);
  });

  it('offers the periods while the end is typed', () => {
    const { container } = render(<Years />);
    type('2020-2');
    expect(offered(container)).toEqual([
      '2020–2021 (2 år med dokumenter)',
      '2020–2022 (3 år med dokumenter)',
      '2020–2023 (4 år med dokumenter)',
      '2020–2024 (5 år med dokumenter)',
    ]);
  });

  it('leaves the text when Enter is pressed and nothing fits', () => {
    const seen: string[][] = [];
    render(<Years initial={['2024']} seen={seen} />);
    typeThenEnter('abc');
    expect(seen).toEqual([]);
    expect(input().value).toBe('abc');
  });

  it('gives a hint instead of a guess when the text is no period', () => {
    const hint =
      'Ikke et år eller en periode. Skriv et år eller en periode, som 2021 eller 2023–2028.';
    const { container } = render(<Years />);
    for (const text of ['abc', '3', '2019-1', 'fra 2015']) {
      type(text);
      expect(offered(container), text).toEqual([hint]);
    }
    type('2');
    expect(screen.queryByText(hint)).toBeNull();
  });

  it('shows the years with documents before anything is typed, with the hint over them for the eye only', () => {
    const field = { ...years, options: [...years.options, { value: '2018', count: 0 }] };
    const { container } = render(<Years field={field} />);
    expect(offered(container)).toEqual([
      '2024 (6)',
      '2023 (5)',
      '2022 (4)',
      '2021 (3)',
      '2020 (2)',
      '2019 (1)',
    ]);
    const hint = screen.getByText('Skriv et år eller en periode, som 2021 eller 2023–2028');
    expect(hint.closest('u-datalist')).toBeTruthy();
    expect(hint.getAttribute('aria-hidden')).toBe('true');
  });

  it('ticks the chosen years, also inside a period, and puts them first', () => {
    const { container } = render(<Years initial={['2020', '2022', '2023']} />);
    expect(chips(container)).toEqual(['2020', '2022–2023']);
    expect(ticked(container)).toEqual(['2023', '2022', '2020']);
    expect(offered(container)).toEqual([
      '2023 (5)',
      '2022 (4)',
      '2020 (2)',
      '2024 (6)',
      '2021 (3)',
      '2019 (1)',
    ]);
  });

  it('takes a year out of its period when it is chosen again, and says so', () => {
    const seen: string[][] = [];
    const said: Said = [];
    const { container } = render(
      <Years initial={['2022', '2023', '2024']} seen={seen} said={said} />,
    );
    choose('2023 (5)');
    expect(seen.at(-1)).toEqual(['2022', '2024']);
    expect(chips(container)).toEqual(['2022', '2024']);
    expect(said.at(-1)).toBe('Fjernet 2023');
  });

  it('says what was added, also when it joins a period', () => {
    const said: Said = [];
    render(<Years initial={['2022']} said={said} />);
    choose('2023 (5)');
    expect(said.at(-1)).toBe('Lagt til 2023');
    type('19-21');
    choose('2019–2021 (3 år med dokumenter)');
    expect(said.at(-1)).toBe('Lagt til 2019–2021');
  });

  it('changes nothing when a period already chosen is chosen again, but says so', () => {
    const seen: string[][] = [];
    const said: Said = [];
    render(<Years initial={['2020', '2021', '2022', '2023']} seen={seen} said={said} />);
    type('21-22');
    choose('2021–2022 (2 år med dokumenter)');
    expect(seen).toEqual([['2020', '2021', '2022', '2023']]);
    expect(said).toEqual(['2021–2022 er alt valgt.']);
    expect(input().value).toBe('');
  });

  it('takes only the years in a period that the field lists, not every calendar year', () => {
    const seen: string[][] = [];
    const field = { ...years, options: [...years.options, { value: '1950', count: 2 }] };
    const { container } = render(<Years field={field} seen={seen} />);
    type('1800-2020');
    choose('1800–2020 (3 år med dokumenter)');
    expect(seen.at(-1)).toEqual(['1950', '2019', '2020']);
    expect(chips(container)).toEqual(['1950', '2019–2020']);
  });

  it('keeps a long period under the limit of values a field can send', () => {
    const seen: string[][] = [];
    render(<Years seen={seen} />);
    typeThenEnter('1800-2200');
    expect(seen.at(-1)).toEqual(['2019', '2020', '2021', '2022', '2023', '2024']);
    expect(screen.queryByText(/Høyst 100/u)).toBeNull();
  });

  it('keeps a chosen year the list no longer has when a period is added', () => {
    const seen: string[][] = [];
    render(<Years initial={['2030']} seen={seen} />);
    type('23-24');
    choose('2023–2024 (2 år med dokumenter)');
    expect(seen.at(-1)).toEqual(['2023', '2024', '2030']);
  });

  it('counts a period in years with documents, never a sum that can pass the documents there are', () => {
    const { container } = render(<Years />);
    type('2019-2024');
    // The counts per year add up to 21, but a document with several years is in several.
    expect(offered(container)).toEqual(['2019–2024 (6 år med dokumenter)']);
  });

  it('says a period with no listed years has no documents, and chooses nothing on Enter', () => {
    const seen: string[][] = [];
    const { container } = render(<Years seen={seen} />);
    typeThenEnter('1700-1750');
    expect(offered(container)).toEqual(['Ingen dokumenter i 1700–1750.']);
    expect(seen).toEqual([]);
    expect(input().value).toBe('1700-1750');
  });

  it('counts the years for a screen reader, not the chips', () => {
    render(<Years initial={['2022', '2023', '2024']} />);
    expect(input().getAttribute('aria-description')).toBe('3 valgt, naviger bakover for å endre');
  });

  it('moves focus to the next period, then to the field, as periods are removed by keyboard', () => {
    const seen: string[][] = [];
    const said: Said = [];
    render(<Years initial={['2019', '2020', '2022', '2023']} seen={seen} said={said} />);
    act(() => input().focus());
    fireEvent.keyDown(input(), { key: 'ArrowLeft' });
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' });
    const first = screen.getByRole('option', { name: /^2019–2020, Trykk for å fjerne/u });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Backspace' });
    expect(seen.at(-1)).toEqual(['2022', '2023']);
    expect(said.at(-1)).toBe('Fjernet 2019–2020');
    const last = screen.getByRole('option', { name: /^2022–2023, Trykk for å fjerne/u });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(last, { key: 'Backspace' });
    expect(seen.at(-1)).toEqual([]);
    expect(document.activeElement).toBe(input());
  });

  it('says all are chosen when every listed year is, with a year outside the list too', () => {
    render(<Years initial={['2019', '2020', '2021', '2022', '2023', '2024', '2030']} />);
    expect(screen.getByText('Alle 6 valgt, altså ingen avgrensning')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Velg alle år' })).toBeNull();
  });

  it('has «Velg alle» and «Tøm» as the other fields, and tells them', () => {
    const seen: string[][] = [];
    const said: Said = [];
    const { container } = render(<Years initial={['2019', '2022']} seen={seen} said={said} />);
    fireEvent.click(screen.getByRole('button', { name: 'Velg alle år' }));
    expect(chips(container)).toEqual(['2019–2024']);
    expect(said.at(-1)).toBe('Alle 6 år er valgt.');
    fireEvent.click(screen.getByRole('button', { name: 'Tøm år' }));
    expect(seen.at(-1)).toEqual([]);
    expect(said.at(-1)).toBe('Ingen år er valgt.');
  });
});

describe('a field with compact chips', () => {
  const first = (count: number) => organisations.options.slice(0, count).map((o) => o.value);
  const Organisations = (props: {
    initial: string[];
    seen?: string[][];
    said?: Said;
    compact?: boolean;
  }) => <Harness field={organisations} compact {...props} />;

  it('shows a chip per value without them', () => {
    const { container } = render(<Organisations initial={first(12)} compact={false} />);
    expect(chips(container)).toHaveLength(12);
  });

  it('gathers many chosen values in one chip, and says «Alle» when all are', () => {
    const { container, unmount } = render(<Organisations initial={first(12)} />);
    expect(chips(container)).toEqual(['12 virksomheter']);
    unmount();
    const all = render(<Organisations initial={first(20)} />);
    expect(chips(all.container)).toEqual(['Alle virksomheter']);
  });

  it('leaves a few chosen values each on its own', () => {
    const { container } = render(<Organisations initial={first(5)} />);
    expect(chips(container)).toEqual(first(5));
  });

  it('counts the chosen values, never «Alle», when another field narrows the list to one of them', () => {
    const one: FilterField = { ...organisations, options: organisations.options.slice(0, 1) };
    const { container } = render(<Harness field={one} compact initial={first(6)} />);
    expect(chips(container)).toEqual(['6 virksomheter']);
  });

  it('removes the whole choice when the one chip is removed', () => {
    const seen: string[][] = [];
    const { container } = render(<Organisations initial={first(12)} seen={seen} />);
    fireEvent.click(screen.getByRole('option', { name: /^12 virksomheter, Trykk for å fjerne/u }));
    expect(seen.at(-1)).toEqual([]);
    expect(chips(container)).toEqual([]);
  });

  it('adds a new value to the choice behind the one chip, and ticks every value in the list', () => {
    const seen: string[][] = [];
    const { container } = render(<Organisations initial={first(12)} seen={seen} />);
    expect(ticked(container)).toEqual(first(12));
    choose('Virksomhet 13 (1)');
    expect(seen.at(-1)).toEqual(first(13));
    expect(chips(container)).toEqual(['13 virksomheter']);
  });

  it('counts the values, not the chips, for a screen reader', () => {
    render(<Organisations initial={first(12)} />);
    expect(input().getAttribute('aria-description')).toBe(
      '12 valgt, naviger bakover for å fjerne alle',
    );
  });

  it('tells the value that makes the chips one, and the one that splits them again', () => {
    const said: Said = [];
    render(<Organisations initial={first(5)} said={said} />);
    choose('Virksomhet 6 (1)');
    expect(said.at(-1)).toBe('Lagt til Virksomhet 6');
    choose('Virksomhet 7 (1)');
    expect(said.at(-1)).toBeUndefined();
    choose('Virksomhet 7 (1)');
    choose('Virksomhet 6 (1)');
    expect(said.at(-1)).toBe('Fjernet Virksomhet 6');
  });

  it('moves focus to the field and says so when the one chip is removed by keyboard', () => {
    const seen: string[][] = [];
    const said: Said = [];
    render(<Organisations initial={first(12)} seen={seen} said={said} />);
    act(() => input().focus());
    fireEvent.keyDown(input(), { key: 'ArrowLeft' });
    const chip = screen.getByRole('option', { name: /^12 virksomheter, Trykk for å fjerne alle/u });
    expect(document.activeElement).toBe(chip);
    fireEvent.keyDown(chip, { key: 'Backspace' });
    expect(seen.at(-1)).toEqual([]);
    expect(said.at(-1)).toBe('Ingen virksomheter er valgt.');
    expect(document.activeElement).toBe(input());
  });
});

describe('a field with every value it lists chosen, without compact chips', () => {
  const all = organisations.options.map((option) => option.value);
  const one: FilterField = { ...organisations, options: organisations.options.slice(0, 1) };

  it('shows one «Alle …» chip when every value in a field is chosen', async () => {
    const { container } = render(<Harness field={organisations} />);
    fireEvent.click(screen.getByRole('button', { name: 'Velg alle virksomheter' }));
    expect(chips(container)).toEqual(['Alle virksomheter']);
    // u-combobox ticks the options from the chips it observes, hence the async act.
    await act(async () => {});
    expect(ticked(container)).toEqual(all);
  });

  it("keeps a single chosen value's own chip", () => {
    for (const compact of [false, true]) {
      const { container, unmount } = render(
        <FacetField
          field={one}
          selected={all.slice(0, 1)}
          compact={compact}
          max={100}
          onChange={() => {}}
        />,
      );
      expect(chips(container)).toEqual(['Virksomhet 1']);
      unmount();
    }
  });

  it('clears the field when the «Alle …» chip is removed', () => {
    const seen: string[][] = [];
    const { container } = render(<Harness field={organisations} initial={all} seen={seen} />);
    fireEvent.click(
      screen.getByRole('option', { name: /^Alle virksomheter, Trykk for å fjerne alle/u }),
    );
    expect(seen.at(-1)).toEqual([]);
    expect(chips(container)).toEqual([]);
  });

  it('reaches the «Alle …» chip from the field by keyboard, and moves focus back when it goes', () => {
    const said: Said = [];
    render(<Harness field={organisations} initial={all} said={said} />);
    act(() => input().focus());
    fireEvent.keyDown(input(), { key: 'ArrowLeft' });
    const chip = screen.getByRole('option', {
      name: /^Alle virksomheter, Trykk for å fjerne alle/u,
    });
    expect(document.activeElement).toBe(chip);
    fireEvent.keyDown(chip, { key: 'Backspace' });
    expect(said.at(-1)).toBe('Ingen virksomheter er valgt.');
    expect(document.activeElement).toBe(input());
  });

  it('counts the values behind the «Alle …» chip for a screen reader, not the chip', () => {
    const { container } = render(<Harness field={organisations} initial={all} />);
    expect(input().getAttribute('aria-description')).toBe(
      '20 valgt, naviger bakover for å fjerne alle',
    );
    expect(container.querySelector('ds-suggestion')?.getAttribute('data-sr-remove')).toBe(
      'Trykk for å fjerne alle fra virksomheter',
    );
  });
});

describe('«Velg alle» and «Tøm» for a screen reader', () => {
  const all = organisations.options.map((option) => option.value);

  it('say what the buttons did when many values change', () => {
    const said: Said = [];
    render(<Harness field={organisations} said={said} />);
    fireEvent.click(screen.getByRole('button', { name: 'Velg alle virksomheter' }));
    expect(said.at(-1)).toBe('Alle 20 virksomheter er valgt.');
    fireEvent.click(screen.getByRole('button', { name: 'Tøm virksomheter' }));
    expect(said.at(-1)).toBe('Ingen virksomheter er valgt.');
  });

  it('leave it to u-combobox when «Tøm» removes one value, so it is not heard twice', () => {
    const said: Said = [];
    render(<Harness field={organisations} initial={all.slice(0, 1)} said={said} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tøm virksomheter' }));
    expect(said).toEqual([undefined]);
  });

  it('say «Velg alle» from all but one, since the «Alle …» chip comes as well', () => {
    const said: Said = [];
    render(<Harness field={organisations} initial={all.slice(1)} said={said} />);
    fireEvent.click(screen.getByRole('button', { name: 'Velg alle virksomheter' }));
    expect(said).toEqual(['Alle 20 virksomheter er valgt.']);
  });

  it('tell it when the one chip comes, even if only one value came', () => {
    const five: FilterField = { ...organisations, options: organisations.options.slice(0, 5) };
    const said: Said = [];
    render(<Harness field={five} compact initial={all.slice(0, 4)} said={said} />);
    fireEvent.click(screen.getByRole('button', { name: 'Velg alle virksomheter' }));
    expect(said).toEqual(['Alle 5 virksomheter er valgt.']);
  });
});
