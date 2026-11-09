// @vitest-environment jsdom
import { catalogueProblems } from '@genai/i18n';
import { InLocale } from '@genai/i18n/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en, nb } from './i18n.js';
import { propsMissingFromPage } from '../sources/fixtures/docsProps.js';
import type { SourceCitation } from '../sources/pairing.js';
import { Sources } from '../sources/Sources.js';
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
  it('is marked, scrolled to the top and focused, and Escape goes back', async () => {
    const scrolled: Element[] = [];
    const scroll = vi.fn(function (this: Element, options?: ScrollIntoViewOptions) {
      if (options?.block === 'start') scrolled.push(this);
    });
    Element.prototype.scrollIntoView = scroll;
    const onReturn = vi.fn();
    draw({ target: { chunkId: 'kudos::2021-3' }, citations: cite('kudos::2021-3'), onReturn });
    await frame();
    const part = passageOf(/internkontroll/);
    expect(marked()).toEqual([part]);
    expect(scrolled).toEqual([part]);
    expect(document.activeElement).toBe(part);
    fireEvent.keyDown(part, { key: 'Escape' });
    expect(onReturn).toHaveBeenCalledOnce();
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  it('never marks a passage of the next document by the last one’s place, not even for a render', async () => {
    const other: SourceDocument = {
      title: 'Tildelingsbrev 2022',
      documentId: 'kudos::2022',
      excerpts: [
        { chunkId: 'kudos::2022-1', text: 'Første del av brevet.', position: 1 },
        { chunkId: 'kudos::2022-4', text: 'Andre del av brevet.', position: 4 },
        { chunkId: 'kudos::2022-7', text: 'Tredje del av brevet.', position: 7 },
      ],
    };
    const { rerender, container } = render(
      <DocumentView sources={[report, other]} target={{ chunkId: 'kudos::2021-3' }} />,
    );
    await frame();
    const records: MutationRecord[] = [];
    const changes = new MutationObserver((list) => records.push(...list));
    changes.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-current'],
      attributeOldValue: true,
    });
    rerender(<DocumentView sources={[report, other]} target={{ chunkId: 'kudos::2022-7' }} />);
    await frame();
    records.push(...changes.takeRecords());
    const unmarked = records
      .filter((r) => r.attributeName === 'data-current' && r.oldValue === 'true')
      .map((r) => r.target.textContent);
    changes.disconnect();
    // Only the old document's mark went away; no passage of the new one had it and lost it.
    expect(unmarked.filter((text) => text?.includes('brevet'))).toEqual([]);
    expect(marked()).toEqual([passageOf(/Tredje del/)]);
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
    draw({ onReturn, onAsk: () => {}, citations: cite('kudos::2021-2') });
    fireEvent.keyDown(screen.getByRole('button', { name: /^Utdrag 1/ }), { key: 'Escape' });
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

describe('«Utdrag i svaret»: jumping straight to a cited excerpt', () => {
  const jumps = () => screen.queryByRole('group', { name: 'Utdrag i svaret:' });
  const chips = () =>
    within(jumps() as HTMLElement)
      .getAllByRole('button')
      .map((chip) => chip.getAttribute('aria-label'));

  it('has one chip per cited excerpt, by its «Utdrag N» number, and none for what nothing cites', () => {
    draw({ citations: cite('kudos::2021-3', 'kudos::2021-2', 'kudos::2021-3') });
    expect(chips()).toEqual(['Utdrag 1', 'Utdrag 2, side 12']);
    expect(screen.getByRole('heading', { name: 'Utdrag 1: Internkontroll' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Utdrag 2: Ressursbruk' })).toBeTruthy();
    // «måloppnåelsen» is cited by nothing: reached by scrolling, in the document's order.
    expect(passageOf(/måloppnåelsen/).textContent).toContain('Ikke vist til i svaret');
  });

  it('jumps straight to the excerpt, marks it and lands focus on it, named by its title', async () => {
    draw({
      target: { chunkId: 'kudos::2021-3' },
      citations: cite('kudos::2021-3', 'kudos::2021-2'),
    });
    await frame();
    const chip = within(jumps() as HTMLElement).getByRole('button', { name: /^Utdrag 2/ });
    fireEvent.click(chip);
    await frame();
    const part = passageOf(/594,2/);
    expect(marked()).toEqual([part]);
    expect(chip.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(part);
    expect(screen.getByRole('group', { name: 'Utdrag 2: Ressursbruk' })).toBe(part);
  });

  it('says the page on a chip only when the excerpt has one, and never makes one up', () => {
    draw({ citations: cite('kudos::2021-3', 'kudos::2021-2') });
    const [first, second] = within(jumps() as HTMLElement).getAllByRole('button');
    expect(first?.textContent).toBe('1');
    expect(second?.textContent).toBe('2s. 12');
  });

  it('opens a cited excerpt in another of the answer’s documents, and says which document', async () => {
    draw({
      target: { chunkId: 'kudos::2021-2' },
      citations: cite('attached:abc:0', 'kudos::2021-2'),
    });
    await frame();
    fireEvent.click(screen.getByRole('button', { name: 'Utdrag 1, i Internt notat' }));
    await frame();
    expect(screen.getByRole('heading', { level: 3, name: memo.title })).toBeTruthy();
    expect(document.activeElement).toBe(passageOf(/rutinen/));
    expect(document.querySelector('output')?.textContent).toBe('Viser dokumentet Internt notat.');
    expect(screen.getByRole('button', { name: 'Utdrag 1' }).getAttribute('aria-current')).toBe(
      'true',
    );
  });

  it('leads a run of chips into another document with its name in sight, and a run back into this one too, without reading either twice', () => {
    draw({
      target: { chunkId: 'kudos::2021-2' },
      citations: cite('attached:abc:0', 'kudos::2021-2'),
    });
    const row = jumps() as HTMLElement;
    expect(row.textContent).toBe('Utdrag i svaret:i Internt notat:1i dette dokumentet:2s. 12');
    for (const lead of row.querySelectorAll('.uib-document-view-jump-doc'))
      expect(lead.getAttribute('aria-hidden')).toBe('true');
    // The names say where each chip goes, and the one into another document has it on hover too.
    expect(chips()).toEqual(['Utdrag 1, i Internt notat', 'Utdrag 2, side 12']);
    expect(within(row).getByRole('button', { name: /^Utdrag 1/ }).title).toBe(
      'Utdrag 1, i Internt notat',
    );
  });

  it('leads no chip when every cited excerpt is in the document open', () => {
    draw({ citations: cite('kudos::2021-3', 'kudos::2021-2') });
    expect((jumps() as HTMLElement).querySelector('.uib-document-view-jump-doc')).toBeNull();
  });

  it('lets a new target from the host win over an excerpt the reader jumped to', async () => {
    const citations = cite('attached:abc:0', 'kudos::2021-2');
    const { rerender } = render(
      <DocumentView
        sources={[report, memo]}
        target={{ chunkId: 'kudos::2021-2' }}
        citations={citations}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Utdrag 1, i Internt notat' }));
    expect(screen.getByRole('heading', { level: 3, name: memo.title })).toBeTruthy();
    rerender(
      <DocumentView
        sources={[report, memo]}
        target={{ chunkId: 'kudos::2021-3' }}
        citations={citations}
      />,
    );
    await frame();
    expect(screen.getByRole('heading', { level: 3, name: report.title })).toBeTruthy();
    expect(marked()).toEqual([passageOf(/internkontroll/)]);
  });

  it('draws no chips, no stepper and no count when the footnotes name only documents', async () => {
    draw({ target: { chunkId: 'kudos::2021-3' }, citations: [{ index: 1 }] });
    await frame();
    expect(jumps()).toBeNull();
    expect(screen.queryByRole('button', { name: /Neste|Forrige/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d av \d/);
    // It opens at the passage the reader came from, and marks it.
    expect(marked()).toEqual([passageOf(/internkontroll/)]);
    expect(document.activeElement).toBe(passageOf(/internkontroll/));
  });

  it('stops an excerpt landed on under the row, measured before the scroll, however tall the row is drawn', async () => {
    const observers: (() => void)[] = [];
    // A resize is reported a frame after the landing's scroll, or never.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly report: () => void) {
          observers.push(() => this.report());
        }
        observe() {}
        disconnect() {}
      },
    );
    const height = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ height: 76 } as DOMRect);
    const room = () =>
      screen
        .getByRole('region', { name: 'Dokumentvisning' })
        .style.getPropertyValue('--_scroll-room');
    let atScroll = '';
    Element.prototype.scrollIntoView = () => {
      atScroll = room();
    };
    draw({
      target: { chunkId: 'kudos::2021-2' },
      citations: cite('kudos::2021-3', 'kudos::2021-2'),
    });
    await frame();
    expect(atScroll).toBe('calc(76px + var(--ds-size-2))');
    // Two lines of chips at a narrow width: the room follows.
    height.mockReturnValue({ height: 120 } as DOMRect);
    act(() => observers.forEach((report) => report()));
    expect(room()).toBe('calc(120px + var(--ds-size-2))');
    height.mockRestore();
    vi.unstubAllGlobals();
    delete (Element.prototype as Partial<Element>).scrollIntoView;
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

  it('forgets a question written about one document when another opens', async () => {
    const { rerender } = render(
      <DocumentView
        sources={[report, memo]}
        target={{ chunkId: 'kudos::2021-3' }}
        onAsk={() => {}}
      />,
    );
    const field = () => screen.getByRole('textbox', { name: 'Spør om dette dokumentet' });
    fireEvent.change(field(), { target: { value: 'Hva sier rapporten om DFØ?' } });
    rerender(
      <DocumentView
        sources={[report, memo]}
        target={{ chunkId: 'attached:abc:0' }}
        onAsk={() => {}}
      />,
    );
    await frame();
    expect((field() as HTMLInputElement).value).toBe('');
  });

  it('keeps the question while the reader jumps between excerpts of the same document', async () => {
    draw({ onAsk: () => {}, citations: cite('kudos::2021-3', 'kudos::2021-2') });
    const field = screen.getByRole('textbox', { name: 'Spør om dette dokumentet' });
    fireEvent.change(field, { target: { value: 'Hva sier rapporten om DFØ?' } });
    fireEvent.click(screen.getByRole('button', { name: /^Utdrag 2/ }));
    await frame();
    expect((field as HTMLInputElement).value).toBe('Hva sier rapporten om DFØ?');
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

describe('shared with Sources', () => {
  it('titles and links an excerpt exactly as Sources does, from the same parts', async () => {
    const citations = cite('kudos::2021-2');
    const named = (root: HTMLElement) => ({
      titles: within(root)
        .getAllByRole('heading', { level: 4 })
        .map((h) => h.getAttribute('aria-label') ?? h.textContent),
      pageLink: within(root)
        .getByRole('link', { name: /^Les side 12/ })
        .getAttribute('aria-label'),
    });
    const inSources = render(
      <Sources
        sources={[report]}
        citations={citations}
        corpus="Kudos"
        target={{ chunkId: 'kudos::2021-2' }}
      />,
    );
    await frame();
    const fromSources = named(inSources.container);
    cleanup();
    const inView = render(
      <DocumentView
        sources={[report]}
        citations={citations}
        corpus="Kudos"
        target={{ chunkId: 'kudos::2021-2' }}
      />,
    );
    const fromView = named(inView.container);
    expect(fromView.pageLink).toBe(fromSources.pageLink);
    expect(fromView.titles.toSorted()).toEqual(fromSources.titles.toSorted());
  });
});

describe('the link to the original', () => {
  it('reads «Les dokumentet på Kudos», named apart by the title, in a new tab', () => {
    draw();
    const link = screen.getByRole('link', { name: /^Les dokumentet på Kudos/ });
    expect(link.getAttribute('aria-label')).toBe(
      `Les dokumentet på Kudos, ${report.title} (åpnes i ny fane)`,
    );
    expect(link.querySelector('.ds-sr-only')).toBeNull();
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

  it('names the page link in one piece, so no browser reads a space before the comma', () => {
    draw();
    const link = within(passageOf(/594,2/)).getByRole('link', { name: /^Les side 12/ });
    expect(link.getAttribute('aria-label')).toBe(
      `Les side 12 på Kudos, utdrag fra Ressursbruk, ${report.title} (åpnes i ny fane)`,
    );
    expect(link.querySelector('.ds-sr-only')).toBeNull();
  });
});

describe('with no document to show', () => {
  it('says how to open one before anything is chosen, with no way back to nowhere', () => {
    render(<DocumentView sources={[report]} onReturn={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Ingen dokument er åpnet' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Tilbake/ })).toBeNull();
    expect(passages()).toEqual([]);
  });

  it('names the control that opens a document where the host has it: in Sources, or a footnote', () => {
    const hint = () => document.querySelector('.uib-document-view-empty p')?.textContent;
    const { rerender } = render(<DocumentView sources={[report]} opensFrom="sources" />);
    expect(hint()).toBe(
      'Åpne et utdrag i kildene og velg «Vis i dokumentet», så vises dokumentet her.',
    );
    rerender(<DocumentView sources={[report]} opensFrom="answer" />);
    expect(hint()).toBe('Velg en fotnote i svaret, så vises dokumentet her.');
    rerender(<DocumentView sources={[report]} />);
    expect(hint()).toMatch(/«Vis i dokumentet», eller velg en fotnote i svaret/);
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

  it('follow the host’s colour family, but for the marks of the excerpt the reader is on and the chips’ numbers (accent) and the quiet notes (neutral)', () => {
    const pinned = [
      ...css.matchAll(
        /var\(\s?(--genai-[a-z-]+),\s?var\(--ds-color-(accent|neutral|brand\d|success|warning|danger|info)-/g,
      ),
    ].map((match) => `${match[1]} ${match[2]}`);
    expect([...new Set(pinned)].sort()).toEqual([
      '--genai-document-view-jump-current-background accent',
      '--genai-document-view-jump-current-border-color accent',
      '--genai-document-view-jump-current-number-background accent',
      '--genai-document-view-jump-current-number-color accent',
      '--genai-document-view-jump-number-background accent',
      '--genai-document-view-jump-number-color accent',
      '--genai-document-view-note-color neutral',
      '--genai-document-view-passage-current-background accent',
      '--genai-document-view-passage-current-marker-color accent',
    ]);
  });

  it('keep «Utdrag i svaret» in reach while the document scrolls, and what is scrolled to clear of it', () => {
    const row = css.match(/\.uib-document-view-jumps \{([^}]*)\}/)?.[1] ?? '';
    expect(row).toContain('position: sticky');
    const passage = css.match(/\.uib-document-view-passage \{([^}]*)\}/)?.[1] ?? '';
    expect(passage).toMatch(
      /scroll-margin-block-start: var\(\s?--genai-document-view-passage-scroll-margin,\s?var\(--_scroll-room\)\s?\)/,
    );
  });

  it('flow «Utdrag i svaret» as one line of text that wraps, so a document’s long name shares its line with its chips', () => {
    const rule = (selector: string) =>
      css.match(new RegExp(`${selector.replace(/\./g, '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
    // No flex box on the way: each would put a name that wraps on a line of its own.
    expect(rule('.uib-document-view-jumps')).not.toContain('display');
    expect(rule('.uib-document-view-jump-list')).toContain('display: inline;');
    expect(rule('.uib-document-view-jump-item')).toContain('display: inline;');
    expect(rule('.uib-document-view-jump')).toContain('display: inline-flex;');
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
