// @vitest-environment jsdom
import { catalogueProblems } from '@genai/i18n';
import { InLocale } from '@genai/i18n/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en, nb } from '../i18n.js';
import { propsMissingFromPage } from '../sources/fixtures/docsProps.js';
import type { SourceCitation } from '../sources/pairing.js';
import type { SourceDocument } from '../sources/types.js';
import { DocumentView, type DocumentViewProps } from './DocumentView.js';

document.getAnimations ??= () => [];
afterEach(cleanup);

const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

// The service sends the cited chunk first, then the document's other retrieved chunks.
const report: SourceDocument = {
  index: 1,
  title: 'Årsrapport Nasjonal kommunikasjonsmyndighet 2021',
  url: 'https://kudos.dfo.no/dokument/2021',
  documentId: 'kudos::2021',
  publishedAt: '2022-03-01',
  excerpts: [
    {
      chunkId: 'kudos::2021-9',
      text: 'Ledelsen vurderer måloppnåelsen som **god**.',
      position: 9,
    },
    {
      chunkId: 'kudos::2021-2',
      text: 'Nkoms totale utgiftsbevilgning for 2021 var på 594,2 mill. kroner.',
      heading: 'Del III › Ressursbruk',
      page: 12,
      url: 'https://kudos.dfo.no/dokument/2021#page=12',
      position: 2,
    },
    {
      chunkId: 'kudos::2021-3',
      text: 'Arbeidet med internkontroll tar utgangspunkt i veilederne fra DFØ.',
      heading: 'Internkontroll',
      position: 3,
    },
  ],
};

const memo: SourceDocument = {
  index: 2,
  title: 'Internt notat',
  documentId: 'attached:abc',
  excerpts: [{ chunkId: 'attached:abc:0', text: 'Notatet beskriver rutinen.' }],
};

const cite = (...chunks: string[]): SourceCitation[] => chunks.map((chunkId) => ({ chunkId }));

const draw = (props: Partial<DocumentViewProps> = {}) =>
  render(
    <DocumentView
      sources={[report, memo]}
      target={{ documentId: 'kudos::2021' }}
      corpus="Kudos"
      {...props}
    />,
  );

const passages = () => [...document.querySelectorAll<HTMLElement>('.uib-document-view-passage')];
const passageOf = (text: RegExp) => {
  const found = passages().find((p) => text.test(p.textContent ?? ''));
  if (!found) throw new Error(`no excerpt with ${text}`);
  return found;
};
const marked = () => passages().filter((p) => p.dataset.current === 'true');

describe('the document view', () => {
  it('shows the document the target names, under «Dokumentvisning» one level up', () => {
    draw();
    expect(screen.getByRole('heading', { level: 2, name: 'Dokumentvisning' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: report.title })).toBeTruthy();
    expect(screen.queryByText(memo.title)).toBeNull();
    cleanup();
    draw({ target: { chunkId: 'attached:abc:0' } });
    expect(screen.getByRole('heading', { level: 3, name: memo.title })).toBeTruthy();
  });

  it('reads the excerpts in the document’s own order, by position, not the service’s', () => {
    draw();
    expect(passages().map((p) => p.querySelector('.uib-document-view-quote')?.textContent)).toEqual(
      [
        'Nkoms totale utgiftsbevilgning for 2021 var på 594,2 mill. kroner.',
        'Arbeidet med internkontroll tar utgangspunkt i veilederne fra DFØ.',
        'Ledelsen vurderer måloppnåelsen som god.',
      ],
    );
  });

  it('says what it shows: the retrieved excerpts, and that the rest of the document is not here', () => {
    draw();
    expect(
      screen.getByText(
        'Her er de 3 utdragene som ble hentet fra dokumentet, i den rekkefølgen de står der. Resten av dokumentet er ikke med her.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/All tekst er sitater fra dokumentet/)).toBeTruthy();
  });

  it('marks where text is left out, from the positions, and claims nothing without them', () => {
    draw();
    const gaps = [...document.querySelectorAll('.uib-document-view-gap')];
    // Before part 2 (the document starts at 0), and between parts 3 and 9; 2 and 3 run on.
    expect(gaps).toHaveLength(2);
    expect(gaps.every((gap) => gap.textContent?.includes('Tekst som ikke er med'))).toBe(true);
    cleanup();
    const unordered = { ...report, excerpts: report.excerpts.map(({ position: _, ...e }) => e) };
    draw({ sources: [unordered] });
    expect(document.querySelectorAll('.uib-document-view-gap')).toHaveLength(0);
    expect(
      screen.getByText(/^Her er de 3 utdragene som ble hentet fra dokumentet\. Resten/),
    ).toBeTruthy();
  });

  it('cleans each excerpt as Sources does, and shows its section and page', () => {
    draw();
    const part = passageOf(/594,2/);
    expect(within(part).getByRole('heading', { name: 'Ressursbruk' })).toBeTruthy();
    expect(part.textContent).toContain('Del III › Ressursbruk');
    expect(part.textContent).toContain('side 12');
    expect(passageOf(/måloppnåelsen/).textContent).not.toContain('**');
  });
});

describe('the excerpt the reader came for', () => {
  it('is marked, scrolled to and focused, and Escape goes back', async () => {
    const onReturn = vi.fn();
    draw({ target: { chunkId: 'kudos::2021-3' }, citations: cite('kudos::2021-3'), onReturn });
    await frame();
    const part = passageOf(/internkontroll/);
    expect(marked()).toEqual([part]);
    expect(document.activeElement).toBe(part);
    fireEvent.keyDown(part, { key: 'Escape' });
    expect(onReturn).toHaveBeenCalledOnce();
  });

  it('is none when the target names only the document, which lands on the title', async () => {
    draw({ onReturn: () => {} });
    await frame();
    expect(marked()).toEqual([]);
    expect(document.activeElement?.textContent).toBe(report.title);
    expect(screen.getByRole('button', { name: /Tilbake til svaret/ })).toBeTruthy();
  });

  it('is followed once per target, so new sources with the target still held move no focus', async () => {
    const target = { chunkId: 'kudos::2021-3' };
    const { rerender } = render(<DocumentView sources={[report]} target={target} />);
    await frame();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    rerender(<DocumentView sources={[{ ...report }]} target={target} />);
    await frame();
    expect(document.activeElement).toBe(outside);
    rerender(<DocumentView sources={[{ ...report }]} target={{ chunkId: 'kudos::2021-2' }} />);
    await frame();
    expect(document.activeElement).toBe(passageOf(/594,2/));
    outside.remove();
  });

  it('goes back on Escape anywhere on the document, but not from the question field', () => {
    const onReturn = vi.fn();
    draw({ onReturn, onAsk: () => {} });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Neste utdrag' }), { key: 'Escape' });
    expect(onReturn).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(onReturn).toHaveBeenCalledOnce();
  });

  it('says «Tilbake til kildene» when the reader came from Sources', () => {
    const onReturn = vi.fn();
    draw({ onReturn, returnTo: 'sources' });
    fireEvent.click(screen.getByRole('button', { name: /Tilbake til kildene/ }));
    expect(onReturn).toHaveBeenCalledOnce();
  });
});

describe('stepping between excerpts', () => {
  it('moves the mark with «Forrige» and «Neste», and says where in a live region', async () => {
    draw({ target: { chunkId: 'kudos::2021-2' } });
    await frame();
    const steps = screen.getByRole('group', { name: 'Utdrag i dokumentet' });
    expect(steps.textContent).toContain('1 av 3');
    const next = within(steps).getByRole('button', { name: 'Neste utdrag' });
    next.focus();
    fireEvent.click(next);
    expect(marked()).toEqual([passageOf(/internkontroll/)]);
    expect(steps.textContent).toContain('2 av 3');
    expect(document.querySelector('output')?.textContent).toBe(
      'Internkontroll, 2 av 3 i dokumentet',
    );
    // Focus stays on the button, so the reader can press it again.
    expect(document.activeElement).toBe(next);
    fireEvent.click(within(steps).getByRole('button', { name: 'Forrige utdrag' }));
    expect(marked()).toEqual([passageOf(/594,2/)]);
  });

  it('counts every press, even two that come before the next render', () => {
    draw();
    const next = screen.getByRole('button', { name: 'Neste utdrag' });
    act(() => {
      next.click();
      next.click();
    });
    expect(marked()).toEqual([passageOf(/internkontroll/)]);
  });

  it('starts from the document’s first excerpt when nothing is marked yet', () => {
    draw();
    const steps = screen.getByRole('group', { name: 'Utdrag i dokumentet' });
    expect(steps.textContent).toContain('3 utdrag');
    fireEvent.click(within(steps).getByRole('button', { name: 'Neste utdrag' }));
    expect(marked()).toEqual([passageOf(/594,2/)]);
  });

  it('keeps the step at an end focusable but inert, so focus stays where the reader pressed', async () => {
    draw({ target: { chunkId: 'kudos::2021-9' } });
    await frame();
    const next = screen.getByRole('button', { name: 'Neste utdrag' });
    expect(next.getAttribute('aria-disabled')).toBe('true');
    expect(next.hasAttribute('disabled')).toBe(false);
    fireEvent.click(next);
    expect(marked()).toEqual([passageOf(/måloppnåelsen/)]);
  });

  it('draws no steps for a document with one excerpt', () => {
    draw({ target: { chunkId: 'attached:abc:0' } });
    expect(screen.queryByRole('group', { name: 'Utdrag i dokumentet' })).toBeNull();
  });
});

describe('numbers and links back, as in Sources', () => {
  it('numbers only cited excerpts «Utdrag N», by the whole answer’s footnotes', () => {
    // Footnote 1 cites the memo, so this document's first cited excerpt is «Utdrag 2».
    draw({ citations: cite('attached:abc:0', 'kudos::2021-9', 'kudos::2021-2') });
    expect(screen.getByRole('heading', { name: 'Utdrag 2' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Utdrag 3: Ressursbruk' })).toBeTruthy();
    const uncited = passageOf(/internkontroll/);
    expect(within(uncited).getByRole('heading').textContent).toBe('Internkontroll');
    expect(uncited.textContent).toContain('Ikke vist til i svaret');
  });

  it('puts every link back beside the cited excerpt’s title, and none on an uncited one', () => {
    const onShowUse = vi.fn();
    draw({ citations: cite('kudos::2021-2', 'kudos::2021-2'), onShowUse });
    const cited = passageOf(/594,2/);
    const links = within(cited).getAllByRole('link', { name: /fotnote/ });
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual([
      '1: fotnote 1, første sted i svaret',
      '2: fotnote 1, andre sted i svaret',
    ]);
    fireEvent.click(links[1] as HTMLElement);
    expect(onShowUse).toHaveBeenCalledWith(1, {
      source: report,
      excerpt: expect.objectContaining({ chunkId: 'kudos::2021-2' }),
    });
    expect(within(passageOf(/internkontroll/)).queryByRole('link')).toBeNull();
  });

  it('numbers nothing and links nothing back when the footnotes name only documents', () => {
    draw({ citations: [{ index: 1 }], onShowUse: () => {} });
    expect(document.body.textContent).not.toMatch(/Utdrag \d|Ikke vist til i svaret/);
    expect(screen.queryByRole('link', { name: /fotnote/ })).toBeNull();
  });
});

describe('asking about the document', () => {
  it('hands the question to the host with the document and the excerpt the reader stands on', async () => {
    const onAsk = vi.fn();
    draw({ target: { chunkId: 'kudos::2021-3' }, onAsk });
    await frame();
    const field = screen.getByRole('textbox', { name: 'Spør om dette dokumentet' });
    expect(field.getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.change(field, { target: { value: '  Hva sier rapporten om DFØ?  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Spør' }));
    expect(onAsk).toHaveBeenCalledWith({
      question: 'Hva sier rapporten om DFØ?',
      source: report,
      excerpt: expect.objectContaining({ chunkId: 'kudos::2021-3' }),
    });
    expect((field as HTMLInputElement).value).toBe('');
    expect(screen.getByText('Spørsmålet er sendt til tråden.')).toBeTruthy();
  });

  it('sends nothing while the field is empty, and keeps the button focusable', () => {
    const onAsk = vi.fn();
    draw({ onAsk });
    const button = screen.getByRole('button', { name: 'Spør' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(onAsk).not.toHaveBeenCalled();
  });

  it('draws no question field when the host takes no questions', () => {
    draw();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('the link to the original', () => {
  it('reads «Les dokumentet på Kudos», named apart by the title, in a new tab', () => {
    draw();
    const link = screen.getByRole('link', { name: /^Les dokumentet på Kudos/ });
    expect(link.textContent).toContain(report.title);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('href')).toBe(report.url);
  });

  it('says why the reader’s own document has none', () => {
    draw({ target: { documentId: 'attached:abc' } });
    expect(screen.queryByRole('link', { name: /Les dokumentet/ })).toBeNull();
    expect(screen.getByText(/Bare du har dette dokumentet/)).toBeTruthy();
  });

  it('links to the page when the address reaches it', () => {
    draw();
    expect(
      within(passageOf(/594,2/)).getByRole('link', { name: /^Les side 12 på Kudos/ }),
    ).toBeTruthy();
  });
});

describe('with no document to show', () => {
  it('says how to open one before anything is chosen, with no way back to nowhere', () => {
    render(<DocumentView sources={[report]} onReturn={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Ingen dokument er åpnet' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Tilbake/ })).toBeNull();
    expect(passages()).toEqual([]);
  });

  it('reports a target the sources do not hold, and says so', async () => {
    const onTargetMissing = vi.fn();
    draw({ target: { documentId: 'kudos::gone' }, onTargetMissing });
    await frame();
    expect(onTargetMissing).toHaveBeenCalledWith({ documentId: 'kudos::gone' });
    expect(screen.getByRole('heading', { name: 'Fant ikke dokumentet' })).toBeTruthy();
  });

  it('reports a footnote whose excerpt the document does not hold, and marks nothing', async () => {
    const onTargetMissing = vi.fn();
    draw({ target: { chunkId: 'kudos::gone' }, onTargetMissing });
    await frame();
    expect(onTargetMissing).toHaveBeenCalledWith({ chunkId: 'kudos::gone' });
    expect(marked()).toEqual([]);
  });
});

describe('the catalogue', () => {
  it('speaks English when the reader does', () => {
    render(
      <InLocale locale="en">
        <DocumentView
          sources={[report]}
          target={{ chunkId: 'kudos::2021-2' }}
          citations={cite('kudos::2021-2')}
          onAsk={() => {}}
        />
      </InLocale>,
    );
    expect(screen.getByRole('heading', { name: 'Document view' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Excerpt 1: Ressursbruk' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Ask about this document' })).toBeTruthy();
  });

  it('has an English text for every Norwegian one', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });
});

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');

describe('the document view styles', () => {
  const css = read('document-view.css').replace(/\s+/g, ' ');

  it('follow the host’s colour family, but for the current excerpt’s mark (accent) and the quiet notes (neutral)', () => {
    const pinned = [
      ...css.matchAll(
        /var\(\s?(--genai-[a-z-]+),\s?var\(--ds-color-(accent|neutral|brand\d|success|warning|danger|info)-/g,
      ),
    ].map((match) => `${match[1]} ${match[2]}`);
    expect([...new Set(pinned)].sort()).toEqual([
      '--genai-document-view-note-color neutral',
      '--genai-document-view-passage-current-background accent',
      '--genai-document-view-passage-current-marker-color accent',
    ]);
  });

  it('keep the steps between excerpts in reach while the document scrolls', () => {
    const steps = css.match(/\.uib-document-view-steps \{([^}]*)\}/)?.[1] ?? '';
    expect(steps).toContain('position: sticky');
  });
});

describe('the Document view page', () => {
  it('names every prop the block takes', () => {
    expect(
      propsMissingFromPage(
        read('DocumentView.tsx'),
        'DocumentViewProps',
        read('../../../../docs/components/document-view.html'),
      ),
    ).toEqual([]);
  });
});
