// @vitest-environment jsdom
import { catalogueProblems } from '@genai/i18n';
import { InLocale } from '@genai/i18n/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CorpusChoice, type CorpusOption } from '../corpus/Corpus.js';
import { nb as sharedNb } from '../i18n.js';
import { Filter, narrowing, type FilterProps } from './Filter.js';
import { en, nb, translator } from './i18n.js';
import type { FilterField, FilterSelection } from './types.js';

// Ported from KA's FiltersView, FiltersView.unavailable, FiltersView.corpus and filterInThread
// tests. The host's part (fetching, the thread, the lock) is a harness here: data in, events out.

document.getAnimations ??= () => [];
afterEach(cleanup);

const types: FilterField = {
  id: 'type',
  label: 'Dokumenttyper',
  options: [
    { value: 'Årsrapport', count: 3 },
    { value: 'Tildelingsbrev', count: 2 },
  ],
};
const years: FilterField = {
  id: 'year',
  label: 'År',
  kind: 'year',
  options: ['2024', '2023'].map((value) => ({ value, count: 1 })),
};
const fields = [types, years];

const stored: FilterSelection = { type: ['Årsrapport'], year: ['2024'] };

/** The host: it keeps the selection and hands the filter what it has fetched. */
const Host = ({
  initial = {},
  seen = [],
  ...props
}: Partial<FilterProps> & { initial?: FilterSelection; seen?: FilterSelection[] }) => {
  const [selection, setSelection] = useState(initial);
  return (
    <Filter
      selection={selection}
      onChange={(next) => {
        seen.push(next);
        setSelection(next);
      }}
      {...props}
    />
  );
};

const draw = (props: Parameters<typeof Host>[0] = {}) => {
  const seen: FilterSelection[] = [];
  const view = render(<Host seen={seen} {...props} />);
  const region = () => view.container.querySelector('output')?.textContent;
  return { ...view, seen, region };
};

const chip = (value: string) => screen.getByRole('button', { name: `Fjern filter: ${value}` });

/** A field's text input, by its label. u-combobox labels its list with the same label. */
const fieldInput = (label: string) => {
  const input = screen.getAllByLabelText(label).find((e) => e instanceof HTMLInputElement);
  if (!input) throw new Error(`No field ${label}`);
  return input;
};

describe('the filter', () => {
  it('draws a field per facet, in the order the dataset gives, under «Filtrering»', () => {
    draw({ fields });
    expect(screen.getByRole('heading', { name: 'Filtrering', level: 2 })).toBeTruthy();
    expect(screen.getAllByRole('combobox').map((e) => e.getAttribute('placeholder'))).toEqual([
      'Søk i dokumenttyper',
      'Søk i år',
    ]);
  });

  it('says so when the dataset has no fields, instead of showing nothing', () => {
    const { container } = draw({ fields: [] });
    expect(
      screen.getByRole('heading', { name: 'Filtrering er ikke tilgjengelig ennå' }),
    ).toBeTruthy();
    expect(screen.getByText('Du kan stille spørsmål uten å avgrense dokumentene.')).toBeTruthy();
    // An empty list is not «still loading».
    expect(container.querySelector('.uib-filter-placeholder')).toBeNull();
  });

  it('holds the place of three fields while they load, and says so to a screen reader only', () => {
    const { container, region } = draw({ initial: stored });
    expect(container.querySelectorAll('.uib-filter-placeholder')).toHaveLength(3);
    expect(container.querySelector('.uib-filter')?.getAttribute('aria-busy')).toBe('true');
    expect(region()).toBe('Henter filtre');
    // Chips drawn for one request would flicker, and the fields are on their way.
    expect(screen.queryByRole('heading', { name: 'Avgrenset til' })).toBeNull();
  });

  it('draws the host’s documents under a line after the fields', () => {
    const { container } = draw({ fields, children: <p>Dokumentene</p> });
    const filter = container.querySelector('.uib-filter') as HTMLElement;
    const line = filter.querySelector('hr') as HTMLElement;
    expect(line.nextElementSibling?.textContent).toBe('Dokumentene');
  });

  it('draws the documents above the fields, in sight, and the reader’s own after them', () => {
    const { container } = draw({
      fields,
      documents: <p>Fra Kudos</p>,
      children: <p>Dine dokumenter</p>,
    });
    const documents = screen.getByText('Fra Kudos');
    const firstField = screen.getByRole('combobox', { name: 'Dokumenttyper' });
    const lastField = screen.getByRole('combobox', { name: 'År' });
    const own = screen.getByText('Dine dokumenter');
    // Designsystemet's line is hidden from the accessibility tree, so it is found as drawn.
    const lines = [...container.querySelectorAll('hr')];
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(documents, firstField)).toBe(true);
    expect(follows(lastField, own)).toBe(true);
    // A line between the documents and the fields, and one between the fields and the rest.
    expect(lines).toHaveLength(2);
    expect(follows(documents, lines[0] as Node) && follows(lines[0] as Node, firstField)).toBe(
      true,
    );
    expect(follows(lastField, lines[1] as Node) && follows(lines[1] as Node, own)).toBe(true);
  });

  it('draws no line above the fields without documents to put there', () => {
    const { container } = draw({ fields });
    expect(container.querySelector('hr')).toBeNull();
  });

  it('draws a field of kind year as periods only when the host asks for them', () => {
    const { unmount } = draw({ fields });
    expect(screen.getByPlaceholderText('Søk i år')).toBeTruthy();
    unmount();
    draw({ fields, yearPeriods: true });
    expect(screen.getByPlaceholderText('Skriv et år eller en periode')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Søk i år')).toBeNull();
  });

  it('speaks English when the reader does', () => {
    render(
      <InLocale locale="en">
        <Filter fields={fields} selection={{}} onChange={() => {}} />
      </InLocale>,
    );
    expect(screen.getByRole('heading', { name: 'Filter' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Select all dokumenttyper' })).toBeTruthy();
  });

  it('names every field’s list button in the reader’s language', () => {
    const { unmount } = render(<Filter fields={fields} selection={{}} onChange={() => {}} />);
    const nbNames = screen.getAllByRole('button', { name: 'Valg' }).length;
    expect(nbNames).toBeGreaterThan(0);
    unmount();
    render(
      <InLocale locale="en">
        <Filter fields={fields} selection={{}} onChange={() => {}} />
      </InLocale>,
    );
    expect(screen.getAllByRole('button', { name: 'Options' })).toHaveLength(nbNames);
    expect(screen.queryByRole('button', { name: 'Valg' })).toBeNull();
  });

  it('counts one year in the singular in English', () => {
    const t = translator('en');
    expect(t('filter.stateYears', { count: 1 })).toBe('1 year selected');
    expect(t('filter.stateYears', { count: 3 })).toBe('3 years selected');
  });

  it('has an English text for every Norwegian one', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });

  it("keeps the filter's words in its own catalogue, out of the shared one that Approach loads", () => {
    expect(Object.keys(nb)).toEqual(['filter']);
    expect(sharedNb).not.toHaveProperty('filter');
  });
});

describe('a chosen value no field can show', () => {
  describe('when the dataset brings no fields', () => {
    it('shows every value in force under «Avgrenset til», and says it can be removed', () => {
      draw({ fields: [], initial: stored });
      expect(screen.getByRole('heading', { name: 'Avgrenset til' })).toBeTruthy();
      expect(chip('Årsrapport')).toBeTruthy();
      expect(chip('2024')).toBeTruthy();
      expect(
        screen.getByText(
          'Filteret gjelder fortsatt for spørsmålene dine. Du kan fjerne det, men ikke endre det før filtrene kan hentes.',
        ),
      ).toBeTruthy();
    });

    it('still says filtering is not available, without claiming nothing is narrowed', () => {
      draw({ fields: [], initial: stored });
      expect(
        screen.getByRole('heading', { name: 'Filtrering er ikke tilgjengelig ennå' }),
      ).toBeTruthy();
      expect(screen.queryByText('Du kan stille spørsmål uten å avgrense dokumentene.')).toBeNull();
    });

    it('removes one value, keeps the rest, moves focus to the next chip and says what went', () => {
      const { seen, region } = draw({ fields: [], initial: stored });
      const first = chip('Årsrapport');
      first.focus();
      fireEvent.click(first);
      expect(seen.at(-1)).toEqual({ ...stored, type: [] });
      expect(document.activeElement).toBe(chip('2024'));
      expect(region()).toBe('Fjernet fra filteret: Årsrapport');
    });

    it('clears all it shows with «Tøm», and the empty state is back as it was', () => {
      const { seen, region } = draw({ fields: [], initial: stored });
      fireEvent.click(screen.getByRole('button', { name: 'Tøm avgrensningen' }));
      expect(seen.at(-1)).toEqual({ type: [], year: [] });
      expect(screen.queryByRole('heading', { name: 'Avgrenset til' })).toBeNull();
      expect(screen.getByText('Du kan stille spørsmål uten å avgrense dokumentene.')).toBeTruthy();
      expect(region()).toBe('Avgrensningen er fjernet.');
    });

    it('lands focus on the empty state when the last chip goes, not on the body', () => {
      draw({ fields: [], initial: { year: ['2024'] } });
      const last = chip('2024');
      last.focus();
      fireEvent.click(last);
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement?.textContent).toContain('Filtrering er ikke tilgjengelig ennå');
    });
  });

  describe('when the facets come back without its field', () => {
    const withOrganisation = { ...stored, organisation: ['Advokattilsynet'] };

    it('shows only that value, and says there is no field for it', () => {
      draw({ fields, initial: withOrganisation });
      expect(chip('Advokattilsynet')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Fjern filter: Årsrapport' })).toBeNull();
      expect(
        screen.getByText(
          'Det finnes ikke noe felt for dette, men det gjelder fortsatt for spørsmålene dine. Du kan fjerne det.',
        ),
      ).toBeTruthy();
      expect(screen.queryByText(/før filtrene kan hentes/)).toBeNull();
    });

    it('hands focus to the first field when the last chip goes, not to an empty region', () => {
      draw({ fields, initial: withOrganisation });
      const last = chip('Advokattilsynet');
      last.focus();
      fireEvent.click(last);
      expect(document.activeElement).toBe(fieldInput('Dokumenttyper'));
    });

    it('empties only what it shows with «Tøm», and leaves the fields alone', () => {
      const { seen } = draw({ fields, initial: withOrganisation });
      fireEvent.click(screen.getByRole('button', { name: 'Tøm avgrensningen' }));
      expect(seen.at(-1)).toEqual({ ...stored, organisation: [] });
    });

    it('draws nothing extra when every chosen field has its field', () => {
      draw({ fields, initial: stored });
      expect(screen.queryByRole('heading', { name: 'Avgrenset til' })).toBeNull();
    });
  });

  describe('when the fetch fails', () => {
    it('shows the error with the values in force beside it', () => {
      draw({ failed: true, onRetry: () => {}, initial: stored });
      expect(screen.getByText('Klarte ikke å hente filtrene.')).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Avgrenset til' })).toBeTruthy();
      expect(chip('2024')).toBeTruthy();
    });

    it('hands focus to «Prøv igjen» when the last chip goes', () => {
      draw({ failed: true, onRetry: () => {}, initial: { year: ['2024'] } });
      const last = chip('2024');
      last.focus();
      fireEvent.click(last);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Prøv igjen' }));
    });

    it('does not announce a removal again when «Prøv igjen» has loaded', () => {
      const Retrying = () => {
        const [state, setState] = useState<Partial<FilterProps>>({ failed: true });
        return (
          <Host
            initial={stored}
            {...state}
            onRetry={() => setState({ failed: false, fields: undefined })}
          />
        );
      };
      const { container, rerender } = render(<Retrying />);
      const region = () => container.querySelector('output')?.textContent;
      fireEvent.click(chip('2024'));
      expect(region()).toBe('Fjernet fra filteret: 2024');
      fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
      expect(region()).toBe('Henter filtre');
      rerender(<Retrying />);
      expect(region()).not.toContain('Fjernet');
    });

    it('draws nothing but the error when nothing is chosen', () => {
      draw({ failed: true });
      expect(screen.getByText('Klarte ikke å hente filtrene.')).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Avgrenset til' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Prøv igjen' })).toBeNull();
    });
  });
});

describe('a thread on screen', () => {
  it('locked: shows what it is limited to, draws no fields, and offers «Ny tråd»', () => {
    const onNewThread = vi.fn();
    draw({ fields, locked: { type: ['Årsrapport'] }, thread: 't1', onNewThread });
    expect(screen.getByRole('heading', { name: 'Avgrenset til' })).toBeTruthy();
    expect(screen.getByRole('list').textContent).toBe('Årsrapport');
    expect(
      screen.getByText(
        'Tråden er avgrenset til dette, og alle spørsmål i den bruker det. Vil du velge et annet filter, starter du en ny tråd.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Ny tråd' }));
    expect(onNewThread).toHaveBeenCalledOnce();
  });

  it('locked: hides an error, since the fields are not drawn anyway', () => {
    draw({ failed: true, locked: { type: ['Årsrapport'] }, thread: 't1' });
    expect(screen.queryByText('Klarte ikke å hente filtrene.')).toBeNull();
  });

  it('says so when the filter changes in a thread under way, with «Ny tråd», and tells a screen reader', () => {
    const onNewThread = vi.fn();
    const { region } = draw({ fields, thread: 't1', onNewThread, newThreadHref: '/' });
    fireEvent.click(screen.getByRole('button', { name: 'Velg alle dokumenttyper' }));
    const note =
      'Du har endret filteret i en tråd som er i gang. Nye spørsmål i tråden bruker det nye filteret.';
    expect(screen.getByText(`${note} Vil du heller starte en ny tråd med det?`)).toBeTruthy();
    expect(region()).toBe(`Alle 2 dokumenttyper er valgt. ${note}`);
    const link = screen.getByRole('link', { name: 'Ny tråd' });
    expect(link.getAttribute('href')).toBe('/');
    fireEvent.click(link);
    expect(onNewThread).toHaveBeenCalledOnce();
    expect(region()).toBe('');
  });

  it('starts over only on a plain click on «Ny tråd», and leaves a click for a new tab to the browser', () => {
    const onNewThread = vi.fn();
    draw({
      fields,
      locked: { type: ['Årsrapport'] },
      thread: 't1',
      onNewThread,
      newThreadHref: '/',
    });
    const link = screen.getByRole('link', { name: 'Ny tråd' });
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }])
      expect(fireEvent.click(link, modifier)).toBe(true);
    expect(fireEvent.click(link, { button: 1 })).toBe(true);
    expect(onNewThread).not.toHaveBeenCalled();
    expect(fireEvent.click(link)).toBe(false);
    expect(onNewThread).toHaveBeenCalledOnce();
  });

  it('takes the note away when the filter is changed back', () => {
    draw({ fields, thread: 't1' });
    fireEvent.click(screen.getByRole('button', { name: 'Velg alle dokumenttyper' }));
    expect(screen.getByText(/Du har endret filteret/, { selector: 'p' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tøm dokumenttyper' }));
    expect(screen.queryByText(/Du har endret filteret/, { selector: 'p' })).toBeNull();
  });

  it('says nothing about a change where no thread is going on', () => {
    draw({ fields });
    fireEvent.click(screen.getByRole('button', { name: 'Velg alle dokumenttyper' }));
    expect(screen.queryByText(/Du har endret filteret/)).toBeNull();
  });

  it('takes the filter a thread has when it comes on screen as where changes count from', () => {
    const { rerender } = render(
      <Filter fields={fields} selection={stored} thread="t1" onChange={() => {}} />,
    );
    rerender(<Filter fields={fields} selection={{}} thread="t2" onChange={() => {}} />);
    expect(screen.queryByText(/Du har endret filteret/)).toBeNull();
  });
});

describe('the live region', () => {
  it('speaks again when the same words come twice in a row', () => {
    const { region } = draw({
      fields: [types],
      initial: { type: ['Årsrapport', 'Tildelingsbrev'] },
    });
    const field = screen.getByPlaceholderText('Søk i dokumenttyper') as HTMLInputElement;
    const pick = (value: string) =>
      act(() => {
        field.value = value;
        field.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'insertReplacementText',
            data: value,
          }),
        );
      });
    fireEvent.click(screen.getByRole('button', { name: 'Tøm dokumenttyper' }));
    expect(region()).toBe('Ingen dokumenttyper er valgt.');
    // One at a time, so u-combobox tells them and the region keeps its words.
    pick('Årsrapport');
    pick('Tildelingsbrev');
    expect(region()).toBe('Ingen dokumenttyper er valgt.');
    fireEvent.click(screen.getByRole('button', { name: 'Tøm dokumenttyper' }));
    expect(region()).toBe('Ingen dokumenttyper er valgt. ');
  });

  it('says a period is already chosen without changing the selection, which would refetch', () => {
    const onChange = vi.fn();
    const { container } = render(
      <Filter
        fields={[years]}
        yearPeriods
        selection={{ year: ['2023', '2024'] }}
        onChange={onChange}
      />,
    );
    const field = screen.getByPlaceholderText('Skriv et år eller en periode') as HTMLInputElement;
    act(() => {
      field.value = '23-24';
      field.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '23-24' }),
      );
    });
    const value =
      screen.getByRole('option', { name: '2023–2024 (2)', hidden: true }).getAttribute('value') ??
      '';
    act(() => {
      field.value = value;
      field.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: value }),
      );
    });
    expect(container.querySelector('output')?.textContent).toBe('2023–2024 er alt valgt.');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('carries the corpus choice in its head, after «Henter filtre», with the reset said', () => {
    const corpora: CorpusOption[] = [
      { key: 'kudos', label: 'Kudos' },
      { key: 'norquad', label: 'Wikipedia (NorQuAD)' },
    ];
    const Switching = () => {
      const [corpus, setCorpus] = useState('kudos');
      const [selection, setSelection] = useState<FilterSelection>(stored);
      const [loaded, setLoaded] = useState<readonly FilterField[] | undefined>(fields);
      return (
        <>
          <Filter
            fields={loaded}
            selection={selection}
            onChange={setSelection}
            head={
              <CorpusChoice
                options={corpora}
                value={corpus}
                resetsFilter
                onChange={(key) => {
                  setCorpus(key);
                  setSelection({});
                  setLoaded(undefined);
                }}
              />
            }
          />
          <button type="button" onClick={() => setLoaded(fields)}>
            loaded
          </button>
        </>
      );
    };
    const { container } = render(<Switching />);
    const region = () => container.querySelectorAll('output');
    fireEvent.change(screen.getByRole('combobox', { name: 'Dokumentsamling' }), {
      target: { value: 'norquad' },
    });
    // One region: the choice has none of its own inside the filter.
    expect(region()).toHaveLength(1);
    expect(region()[0]?.textContent).toBe('Henter filtre');
    fireEvent.click(screen.getByRole('button', { name: 'loaded' }));
    expect(region()[0]?.textContent).toBe(
      'Dokumentsamling: Wikipedia (NorQuAD). Filteret er nullstilt fordi dokumentsamlingen ble byttet.',
    );
  });

  it('draws its heading and head in a pinned element when given one, still speaking through its region', () => {
    const pinned = document.createElement('div');
    document.body.append(pinned);
    const corpora: CorpusOption[] = [
      { key: 'kudos', label: 'Kudos' },
      { key: 'norquad', label: 'Wikipedia (NorQuAD)' },
    ];
    const { container } = render(
      <Filter
        fields={fields}
        selection={{}}
        onChange={() => {}}
        pinIn={pinned}
        head={<CorpusChoice options={corpora} value="kudos" onChange={() => {}} />}
      />,
    );
    expect(within(pinned).getByRole('heading', { name: 'Filtrering' })).toBeTruthy();
    const choice = within(pinned).getByRole('combobox', { name: 'Dokumentsamling' });
    expect(container.contains(choice)).toBe(false);
    fireEvent.change(choice, { target: { value: 'norquad' } });
    expect(container.querySelector('output')?.textContent).toBe(
      'Dokumentsamling: Wikipedia (NorQuAD)',
    );
    pinned.remove();
  });

  it('draws no head while the pinned element it is given is not there yet', () => {
    render(<Filter fields={fields} selection={{}} onChange={() => {}} pinIn={null} />);
    expect(screen.queryByRole('heading', { name: 'Filtrering' })).toBeNull();
  });
});

describe('what a question is asked with', () => {
  it('leaves out a field where every listed value is ticked, which narrows nothing', () => {
    expect(narrowing({ type: ['Årsrapport', 'Tildelingsbrev'], year: ['2024'] }, fields)).toEqual({
      type: [],
      year: ['2024'],
    });
  });

  it('is the same selection when nothing is left out', () => {
    const selection = { type: ['Årsrapport'] };
    expect(narrowing(selection, fields)).toBe(selection);
    expect(narrowing(selection, undefined)).toBe(selection);
  });
});
