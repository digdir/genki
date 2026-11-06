// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Documents,
  OwnDocuments,
  type DocumentItem,
  type OwnDocument,
  type OwnDocumentsProps,
} from './Documents.js';
import { fileSize, limitText } from './uploadText.js';

// Ported from KA's DocumentsList, DocumentsList.corpus, OwnDocuments and uploadText tests.

document.getAnimations ??= () => [];
afterEach(cleanup);

const kudos = { key: 'kudos', label: 'Kudos' };

const documents: DocumentItem[] = Array.from({ length: 7 }, (_, index) => ({
  id: `doc-${index}`,
  title: `Årsrapport Nasjonal kommunikasjonsmyndighet ${2018 + index}`,
  url: `https://kudos.dfo.no/dokument/nkom-${2018 + index}`,
  about: ['Årsrapport', 'Nasjonal kommunikasjonsmyndighet', String(2018 + index)],
}));

/** A file the reader uploaded: only `own` tells it apart. */
const ownFile: DocumentItem = { id: 'own-1', title: 'Årsrapport 2025.pdf', own: true };

const empty = 'Dokumentene som er relevante for søket ditt vises her.';

describe('the documents behind the answer', () => {
  it('keeps the sentence that says what comes here when no answer has sources, or none', () => {
    const { rerender } = render(<Documents corpus={kudos} />);
    expect(screen.getByText(empty)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Fra Kudos' })).toBeNull();
    rerender(<Documents corpus={kudos} documents={[]} />);
    expect(screen.getByText(empty)).toBeTruthy();
  });

  it('lists five of seven, and counts the rest', () => {
    render(<Documents corpus={kudos} documents={documents} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('Viser 5 av 7 dokumenter.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Vis flere dokumenter' })).toBeTruthy();
  });

  it('writes what the document is under the title, and links the title to it', () => {
    render(<Documents corpus={kudos} documents={documents} />);
    expect(screen.getByText('Årsrapport · Nasjonal kommunikasjonsmyndighet · 2018')).toBeTruthy();
    const link = screen.getByRole('link', {
      name: /^Årsrapport Nasjonal kommunikasjonsmyndighet 2018\s*\(åpnes i ny fane\)$/,
    });
    expect(link.getAttribute('href')).toBe('https://kudos.dfo.no/dokument/nkom-2018');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('writes the title as text without a public address, and says why', () => {
    const [first, ...rest] = documents;
    const linkless = { ...(first as DocumentItem), url: undefined };
    render(<Documents corpus={kudos} documents={[linkless, ...rest]} />);
    expect(
      screen.queryByRole('link', { name: /Årsrapport Nasjonal kommunikasjonsmyndighet 2018/ }),
    ).toBeNull();
    expect(
      screen.getByText('Årsrapport · Nasjonal kommunikasjonsmyndighet · 2018, uten lenke'),
    ).toBeTruthy();
    expect(screen.getByText('Årsrapport · Nasjonal kommunikasjonsmyndighet · 2019')).toBeTruthy();
  });

  it('says it alone when the document has nothing else to say either', () => {
    render(<Documents corpus={kudos} documents={[{ id: 'x', title: 'Notat uten data' }]} />);
    expect(screen.getByText('Uten lenke')).toBeTruthy();
  });

  it('shows the rest, drops the button, and leaves focus on the list, named by its heading', () => {
    render(<Documents corpus={kudos} documents={documents} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vis flere dokumenter' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    expect(screen.queryByRole('button', { name: 'Vis flere dokumenter' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('list', { name: 'Fra Kudos' }));
    expect(screen.queryByText(/^Viser /)).toBeNull();
  });

  it('lists everything and offers no button with five or fewer', () => {
    render(<Documents corpus={kudos} documents={documents.slice(0, 3)} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Vis flere dokumenter' })).toBeNull();
  });

  it('leaves an uploaded file to «Dine dokumenter», and does not count it', () => {
    const { rerender } = render(<Documents corpus={kudos} documents={[ownFile, ...documents]} />);
    expect(screen.queryByText('Årsrapport 2025.pdf')).toBeNull();
    expect(screen.getByText('Viser 5 av 7 dokumenter.')).toBeTruthy();
    rerender(<Documents corpus={kudos} documents={[ownFile]} />);
    expect(screen.getByText(empty)).toBeTruthy();
  });

  it('starts over at five when the next answer brings other documents', () => {
    const { rerender } = render(<Documents corpus={kudos} documents={documents} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vis flere dokumenter' }));
    rerender(<Documents corpus={kudos} documents={documents.map((item) => ({ ...item }))} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });

  it('names the list by the collection’s short name, or «standardsamlingen» when none is known', () => {
    const { rerender } = render(
      <Documents corpus={{ key: 'k', label: 'Kudos, 938 dokumenter' }} documents={documents} />,
    );
    expect(screen.getByRole('heading', { name: 'Fra Kudos', level: 4 })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Fra Kudos' })).toBeTruthy();
    rerender(<Documents documents={documents} />);
    expect(screen.getByRole('heading', { name: 'Fra standardsamlingen' })).toBeTruthy();
  });

  it('draws the host’s corpus line under «Dokumenter»', () => {
    render(<Documents corpus={kudos} corpusLine={<p>Dokumenter fra Kudos</p>} />);
    const heading = screen.getByRole('heading', { name: 'Dokumenter', level: 3 });
    expect(heading.nextElementSibling?.textContent).toBe('Dokumenter fra Kudos');
  });
});

const doc = (over: Partial<OwnDocument> = {}): OwnDocument => ({
  id: 'a',
  name: 'Årsrapport 2025.pdf',
  type: 'PDF',
  size: 2_400_000,
  status: 'ready',
  progress: 100,
  ...over,
});

const own = (props: Partial<OwnDocumentsProps> = {}) => (
  <OwnDocuments
    documents={[]}
    types={['PDF', '.docx']}
    maxBytes={20 * 1024 * 1024}
    accept=".pdf,.docx,application/pdf"
    {...props}
  />
);

describe('the reader’s own documents', () => {
  const upload = () => vi.fn(async () => {});

  it('invites a drop, says which types and how large in the zone’s own description', () => {
    render(own({ onUpload: upload() }));
    expect(screen.getByRole('heading', { name: 'Dine dokumenter' })).toBeTruthy();
    expect(screen.getByText('Ny')).toBeTruthy();
    expect(screen.getByText('Velg filer').hasAttribute('aria-disabled')).toBe(false);
    expect(
      screen.getByText(
        'Slipp filer her, eller velg dem selv. Kun PDF og .docx for øyeblikket, maks 20 MB.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('uploads the files chosen, one at a time', async () => {
    const onUpload = upload();
    render(own({ onUpload }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe('.pdf,.docx,application/pdf');
    const files = [new File(['a'], 'en.pdf'), new File(['b'], 'to.docx')];
    fireEvent.change(input, { target: { files } });
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    expect(onUpload.mock.calls.map((call) => (call as unknown as [File])[0].name)).toEqual([
      'en.pdf',
      'to.docx',
    ]);
  });

  it('tries every file when one fails, and takes the same file again when it is picked again', async () => {
    const onUpload = vi.fn(async (file: File) => {
      if (file.name === 'en.pdf') throw new Error('502');
    });
    render(own({ onUpload }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const first = new File(['a'], 'en.pdf');
    fireEvent.change(input, { target: { files: [first, new File(['b'], 'to.docx')] } });
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { files: [first] } });
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(3));
  });

  it('shows how far an upload has come, the type and size when ready, and why it failed', () => {
    const { rerender } = render(own({ documents: [doc({ status: 'uploading', progress: 40 })] }));
    expect(screen.getByText(/Laster opp … 40 %/)).toBeTruthy();
    rerender(own({ documents: [doc()] }));
    expect(screen.getByText('PDF · 2,4 MB')).toBeTruthy();
    rerender(own({ documents: [doc({ status: 'failed', error: 'too-large', size: 30_000_000 })] }));
    expect(screen.getByText('Filen er større enn 20 MB.')).toBeTruthy();
  });

  it('removes a file, with its name in the button’s name', () => {
    const onRemove = vi.fn();
    render(
      own({ onRemove, documents: [doc(), doc({ id: 'b', name: 'Notat.docx', type: 'DOCX' })] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Fjern Notat.docx' }));
    expect(onRemove).toHaveBeenCalledWith('b');
  });

  it('without upload: the zone stands, switched off, and says «Kommer snart» and what is coming', () => {
    render(own());
    expect(screen.getByText('Kommer snart')).toBeTruthy();
    expect(screen.queryByText('Ny')).toBeNull();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input?.disabled).toBe(true);
    expect(input?.closest('.uib-documents-own-zone')?.getAttribute('data-color')).toBe('neutral');
    expect(screen.getByText('Velg filer').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('Snart kan du laste opp PDF og .docx her, maks 20 MB.')).toBeTruthy();
    expect(screen.queryByText(/Slipp filer her/u)).toBeNull();
  });

  it('without upload: refuses a dropped file in words, and the browser does not open it', () => {
    const { container } = render(own());
    const section = container.querySelector('section') as HTMLElement;
    const dataTransfer = { types: ['Files'], files: [new File(['a'], 'en.pdf')] };
    expect(fireEvent.dragOver(section, { dataTransfer })).toBe(false);
    expect(fireEvent.drop(section, { dataTransfer })).toBe(false);
    const said = 'Opplasting er ikke tilgjengelig i denne tjenesten ennå.';
    expect(screen.getByText(said, { selector: 'p' })).toBeTruthy();
    expect(container.querySelector('output')?.textContent).toBe(said);
  });

  it('leaves a drop without files alone, and a drop where upload works', () => {
    const { container, unmount } = render(own());
    const text = { dataTransfer: { types: ['text/plain'], files: [] } };
    expect(fireEvent.drop(container.querySelector('section') as HTMLElement, text)).toBe(true);
    unmount();
    const { container: on } = render(own({ onUpload: upload() }));
    const files = { dataTransfer: { types: ['Files'], files: [] } };
    expect(fireEvent.dragOver(on.querySelector('section') as HTMLElement, files)).toBe(true);
  });

  it('tells a live region when a file comes in, is ready and fails, never the percentage', () => {
    const { container, rerender } = render(own());
    const region = container.querySelector('output') as HTMLElement;
    expect(region.textContent).toBe('');
    rerender(own({ documents: [doc({ status: 'uploading', progress: 0 })] }));
    expect(region.textContent).toBe('Laster opp Årsrapport 2025.pdf');
    rerender(own({ documents: [doc({ status: 'uploading', progress: 60 })] }));
    expect(region.textContent).toBe('Laster opp Årsrapport 2025.pdf');
    rerender(own({ documents: [doc({ status: 'ready' })] }));
    expect(region.textContent).toBe('Årsrapport 2025.pdf er lastet opp');
    rerender(own({ documents: [doc({ status: 'failed', error: 'failed' })] }));
    expect(region.textContent).toBe(
      'Årsrapport 2025.pdf ble ikke lastet opp. Opplastingen mislyktes. Prøv igjen.',
    );
  });

  it('says nothing about documents that were there when it was drawn', () => {
    const { container } = render(own({ documents: [doc(), doc({ id: 'b', name: 'Notat.docx' })] }));
    expect(container.querySelector('output')?.textContent).toBe('');
  });

  it('moves focus to the row below when a file is removed, else up, else to the picker', () => {
    const report = doc();
    const memo = doc({ id: 'b', name: 'Notat.docx' });
    const two = [report, memo];
    const props = { onRemove: () => {}, onUpload: upload() };
    const { rerender } = render(own({ ...props, documents: two }));
    fireEvent.click(screen.getByRole('button', { name: 'Fjern Årsrapport 2025.pdf' }));
    rerender(own({ ...props, documents: [memo] }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fjern Notat.docx' }));

    rerender(own({ ...props, documents: two }));
    fireEvent.click(screen.getByRole('button', { name: 'Fjern Notat.docx' }));
    rerender(own({ ...props, documents: [report] }));
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Fjern Årsrapport 2025.pdf' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fjern Årsrapport 2025.pdf' }));
    rerender(own({ ...props, documents: [] }));
    expect(document.activeElement).toBe(document.querySelector('input[type="file"]'));
  });
});

describe('sizes in words', () => {
  it('writes a size as a file manager does, in the largest unit under a thousand', () => {
    expect(fileSize(512, 'nb')).toBe('512 B');
    expect(fileSize(820_000, 'nb')).toBe('820 kB');
    expect(fileSize(2_400_000, 'nb')).toBe('2,4 MB');
    expect(fileSize(2_400_000, 'en')).toBe('2.4 MB');
    expect(fileSize(1_500_000_000, 'nb')).toBe('1,5 GB');
  });

  it('says nothing about a size that is not one, and gives a limit in the unit it is checked in', () => {
    expect(fileSize(Number.NaN, 'nb')).toBe('');
    expect(fileSize(-1, 'nb')).toBe('');
    expect(limitText(20 * 1024 * 1024)).toBe('20 MB');
  });
});
