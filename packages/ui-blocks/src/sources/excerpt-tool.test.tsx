// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceCitation } from './pairing.js';
import { Sources, type SourcesProps } from './Sources.js';
import type { SourceDocument } from './types.js';

document.getAnimations ??= () => [];
afterEach(cleanup);

const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

const r2021: SourceDocument = {
  index: 1,
  title: 'Årsrapport Nkom 2021',
  documentId: 'kudos::2021',
  publishedAt: '2022-03-01',
  excerpts: [
    {
      chunkId: 'kudos::2021-1',
      text: 'Nkoms totale utgiftsbevilgning for 2021 var på 594,2 mill. kroner.',
      heading: 'Del III › Ressursbruk og måloppnåelse',
      page: 32,
    },
    {
      chunkId: 'kudos::2021-2',
      text: 'Arbeidet med internkontroll tar utgangspunkt i veilederne fra DFØ.',
      heading: 'Internkontroll og risikovurdering',
      page: 41,
    },
  ],
};

const r2022: SourceDocument = {
  index: 2,
  title: 'Årsrapport Nkom 2022',
  documentId: 'kudos::2022',
  excerpts: [{ chunkId: 'kudos::2022-1', text: 'Se tabell 3.1.', heading: 'Ressursbruk' }],
};

const r2023: SourceDocument = {
  index: 3,
  title: 'Årsrapport Nkom 2023',
  documentId: 'kudos::2023',
  excerpts: [{ chunkId: 'kudos::2023-1', text: 'Et kapittel om ressursbruk.' }],
};

const cite = (...chunks: string[]): SourceCitation[] => chunks.map((chunkId) => ({ chunkId }));

// Footnotes 1 and 4 cite the same excerpt.
const citations = cite('kudos::2021-1', 'kudos::2022-1', 'kudos::2021-2', 'kudos::2021-1');

const Host = (props: Partial<SourcesProps> & { start?: number | undefined }) => {
  const { start, ...rest } = props;
  const [footnote, setFootnote] = useState<number | undefined>(start);
  return (
    <Sources
      variant="tool"
      title={false}
      disclaimer={false}
      sources={[r2021, r2022, r2023]}
      citations={citations}
      answerStatus="complete"
      footnote={footnote}
      onFootnoteChange={setFootnote}
      {...rest}
    />
  );
};

const cards = () =>
  within(screen.getByRole('list', { name: 'Utdrag i svaret' })).getAllByRole('button');

describe('the excerpts in Kilder (dev-kilder-hoyre)', () => {
  it('says how many excerpts from how many documents, and lists each cited excerpt once in footnote order', () => {
    render(<Host />);
    expect(
      screen.getByText('Viser 3 utdrag fra 2 dokumenter. Trykk på et utdrag for å lese hele.'),
    ).toBeTruthy();
    expect(cards().map((card) => card.getAttribute('aria-label'))).toEqual([
      'Fotnoter 1 og 4: Ressursbruk og måloppnåelse, Årsrapport Nkom 2021',
      'Fotnote 2: Ressursbruk, Årsrapport Nkom 2022',
      'Fotnote 3: Internkontroll og risikovurdering, Årsrapport Nkom 2021',
    ]);
    const first = cards()[0] as HTMLElement;
    expect(first.textContent).toContain('Årsrapport Nkom 2021 · s. 32');
  });

  it('draws no search and no fold of the sources nothing cites', () => {
    render(<Host />);
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByText(/Andre kilder som ble lest/)).toBeNull();
    expect(screen.queryByText('Årsrapport Nkom 2023')).toBeNull();
  });

  it('opens an excerpt whole from its card, at its first footnote, with the focus on its document', async () => {
    render(<Host />);
    fireEvent.click(cards()[0] as HTMLElement);
    await frame();
    expect(screen.getByText('1 av 4')).toBeTruthy();
    const title = screen.getByRole('heading', { level: 3, name: 'Årsrapport Nkom 2021' });
    expect(document.activeElement).toBe(title);
    expect(
      screen.getByRole('heading', { level: 4, name: 'Ressursbruk og måloppnåelse' }),
    ).toBeTruthy();
    expect(screen.getByText(/594,2 mill\. kroner/)).toBeTruthy();
  });

  it('steps through the footnotes, not the excerpts, and wraps at both ends', () => {
    render(<Host start={0} />);
    const next = screen.getByRole('button', { name: 'Neste fotnote' });
    const previous = screen.getByRole('button', { name: 'Forrige fotnote' });
    fireEvent.click(next);
    expect(screen.getByText('2 av 4')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Årsrapport Nkom 2022' })).toBeTruthy();
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByText('4 av 4')).toBeTruthy();
    expect(screen.getByText(/594,2 mill\. kroner/)).toBeTruthy();
    fireEvent.click(next);
    expect(screen.getByText('1 av 4')).toBeTruthy();
    fireEvent.click(previous);
    expect(screen.getByText('4 av 4')).toBeTruthy();
  });

  it('steps past a footnote whose excerpt never arrived', () => {
    render(<Host start={0} citations={cite('kudos::2021-1', 'kudos::lost', 'kudos::2022-1')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Neste fotnote' }));
    expect(screen.getByText('3 av 3')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Årsrapport Nkom 2022' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Forrige fotnote' }));
    expect(screen.getByText('1 av 3')).toBeTruthy();
  });

  it('goes back to all excerpts with the focus on the card it came from', async () => {
    render(<Host start={2} />);
    fireEvent.click(screen.getByRole('button', { name: 'Alle utdrag' }));
    await frame();
    expect(document.activeElement).toBe(cards()[2]);
  });

  it('gives the focus to the card it came from even after a step that had nowhere to go', async () => {
    render(<Host start={0} citations={cite('kudos::2021-1')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Neste fotnote' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alle utdrag' }));
    await frame();
    fireEvent.click(cards()[0] as HTMLElement);
    await frame();
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 3, name: 'Årsrapport Nkom 2021' }),
    );
  });

  it('gives the year a document was published as the Kildeliste does, in UTC', () => {
    const late = { ...r2021, publishedAt: '2021-12-31T23:30:00Z' };
    render(<Host start={0} sources={[late, r2022, r2023]} />);
    expect(screen.getByText(/2021 · s\. 32/)).toBeTruthy();
  });

  it('goes back to the answer on Escape', () => {
    const back = vi.fn();
    render(<Host start={1} onReturn={back} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Neste fotnote' }), { key: 'Escape' });
    expect(back).toHaveBeenCalledOnce();
  });

  it('offers «Åpne i dokumentvisning» only when the app can open the document', () => {
    const open = vi.fn();
    render(<Host start={1} onOpenDocument={open} />);
    fireEvent.click(screen.getByRole('button', { name: 'Åpne i dokumentvisning' }));
    expect(open).toHaveBeenCalledWith({ source: r2022, excerpt: r2022.excerpts[0] });
    cleanup();
    render(<Host start={1} />);
    expect(screen.queryByRole('button', { name: 'Åpne i dokumentvisning' })).toBeNull();
  });

  it('keeps the footnote shown when the same answer’s sources come again', () => {
    const { rerender } = render(<Host start={1} />);
    rerender(<Host start={1} sources={[{ ...r2021 }, { ...r2022 }, { ...r2023 }]} />);
    expect(screen.getByText('2 av 4')).toBeTruthy();
  });

  it('keeps the documents’ cards when the footnotes name only documents', () => {
    render(<Host citations={[{ index: 1, documentId: 'kudos::2021' }]} />);
    expect(screen.queryByRole('list', { name: 'Utdrag i svaret' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Årsrapport Nkom 2021' })).toBeTruthy();
  });

  it('keeps the documents’ cards for an app that does not hold the footnote shown', () => {
    render(
      <Sources
        variant="tool"
        sources={[r2021, r2022]}
        citations={citations}
        answerStatus="complete"
      />,
    );
    expect(screen.queryByRole('list', { name: 'Utdrag i svaret' })).toBeNull();
    expect(screen.getByRole('searchbox')).toBeTruthy();
  });
});
