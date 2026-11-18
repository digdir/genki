// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readingOrder } from '../sources/pairing.js';
import type { SourceDocument } from '../sources/types.js';
import { Answer } from './Answer.js';
import type { AnswerMarker } from './citations.js';

vi.mock('../sources/pairing.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sources/pairing.js')>();
  return { ...actual, readingOrder: vi.fn(actual.readingOrder) };
});

document.getAnimations ??= () => [];
beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

const report: SourceDocument = {
  index: 1,
  title: 'Årsrapport Nasjonal kommunikasjonsmyndighet 2021',
  documentId: 'kudos::2021',
  excerpts: [
    { chunkId: 'kudos::2021-1', text: 'Nkoms totale utgiftsbevilgning var 594,2 mill. kroner.' },
    { chunkId: 'kudos::2021-2', text: 'Arbeidet med internkontroll tar utgangspunkt i DFØ.' },
  ],
};
const markers: AnswerMarker[] = [
  { marker: '1', chunkId: 'kudos::2021-2', documentId: 'kudos::2021' },
];
const text = 'Internkontrollen følger DFØ [1].';

describe('the answer as it renders', () => {
  it('reads its sources’ order again only when the sources or the footnotes change', () => {
    const calls = vi.mocked(readingOrder);
    const sources = [report];
    const { rerender } = render(<Answer text={text} sources={sources} markers={markers} />);
    const first = calls.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    // A render for anything else, as a streaming answer's parent renders many times a second.
    for (let i = 0; i < 3; i += 1)
      rerender(
        <Answer text={text} sources={sources} markers={markers} onOpenCitation={() => {}} />,
      );
    expect(calls.mock.calls.length).toBe(first);
    rerender(<Answer text={text} sources={[{ ...report }]} markers={markers} />);
    expect(calls.mock.calls.length).toBeGreaterThan(first);
  });
});
